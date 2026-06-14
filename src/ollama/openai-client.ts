import { ollamaUnreachable, ollamaInferenceError } from '../errors.js';
import type {
  OllamaChatParams,
  OllamaChatResponse,
  OllamaMessage,
  OllamaModel,
} from './types.js';

/**
 * OpenAI-compatible inference client (vLLM, etc.).
 *
 * Implements the subset of the OllamaClient surface the codebase uses
 * (chat, chatStream, isAvailable, listModels) by translating between
 * Ollama's request/response shape and the OpenAI /v1/chat/completions shape.
 *
 * Key translations:
 * - options.{temperature,top_p,num_predict} → top-level temperature/top_p/max_tokens
 * - tool_calls arguments: OpenAI returns a JSON *string*, Ollama expects an *object* → JSON.parse
 * - tool result messages: OpenAI requires tool_call_id → stitched from the preceding assistant call
 * - usage.{prompt_tokens,completion_tokens} → prompt_eval_count/eval_count
 */
export class OpenAICompatClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  /** Translate Ollama-shape messages to OpenAI, stitching tool_call_ids. */
  private toOpenAIMessages(messages: OllamaMessage[]): unknown[] {
    const out: any[] = [];
    let pendingToolCallIds: string[] = [];

    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const toolCalls = m.tool_calls.map((tc, i) => ({
          id: `call_${out.length}_${i}`,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {}),
          },
        }));
        pendingToolCallIds = toolCalls.map(t => t.id);
        out.push({ role: 'assistant', content: m.content ?? '', tool_calls: toolCalls });
      } else if (m.role === 'tool') {
        const id = pendingToolCallIds.shift() ?? `call_${out.length}_0`;
        out.push({ role: 'tool', content: m.content, tool_call_id: id });
      } else {
        const msg: any = { role: m.role, content: m.content };
        if (m.images?.length) {
          // OpenAI vision format (in case a multimodal model is served here)
          msg.content = [
            { type: 'text', text: m.content },
            ...m.images.map(img => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } })),
          ];
        }
        out.push(msg);
      }
    }
    return out;
  }

  /** Build the OpenAI request body from Ollama-shape params. */
  private toRequestBody(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>, stream: boolean): Record<string, unknown> {
    const o = params.options ?? {};
    const body: Record<string, unknown> = {
      model: params.model,
      messages: this.toOpenAIMessages(params.messages),
      stream,
    };
    if (o.temperature !== undefined) body.temperature = o.temperature;
    if (o.top_p !== undefined) body.top_p = o.top_p;
    if (o.num_predict !== undefined) body.max_tokens = o.num_predict;
    if (o.stop !== undefined) body.stop = o.stop;
    // vLLM OpenAI server accepts these as extensions
    if (o.top_k !== undefined) body.top_k = o.top_k;
    if (o.repeat_penalty !== undefined) body.repetition_penalty = o.repeat_penalty;
    if (params.tools?.length) body.tools = params.tools;
    return body;
  }

  /** Translate an OpenAI tool_calls array (string args) to Ollama shape (object args). */
  private parseToolCalls(toolCalls: any[] | undefined): OllamaMessage['tool_calls'] {
    if (!toolCalls?.length) return undefined;
    return toolCalls.map(tc => {
      let args: Record<string, unknown> = {};
      try {
        args = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments || '{}')
          : (tc.function?.arguments ?? {});
      } catch { /* leave empty on malformed args */ }
      return { function: { name: tc.function?.name ?? '', arguments: args } };
    });
  }

  async chat(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>): Promise<OllamaChatResponse> {
    const data = await this.post<any>('/v1/chat/completions', this.toRequestBody(params, false));
    const choice = data.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    return {
      model: data.model ?? params.model,
      message: {
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: this.parseToolCalls(msg.tool_calls),
      },
      done: true,
      eval_count: data.usage?.completion_tokens,
      prompt_eval_count: data.usage?.prompt_tokens,
    } as OllamaChatResponse;
  }

  async chatStream(
    params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>,
    onDelta: (text: string) => void,
  ): Promise<OllamaChatResponse> {
    const body = this.toRequestBody(params, true);

    const MAX_ATTEMPTS = 4;
    let res: Response | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw ollamaInferenceError('Stream request timed out');
        }
        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn('[OpenAI] Stream connection failed, retrying in 2s...');
          await new Promise(r => setTimeout(r, 2_000));
          continue;
        }
        throw ollamaUnreachable(this.baseUrl, err);
      }
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const delay = 600 * 2 ** attempt;
        console.warn(`[OpenAI] 429 rate limited on stream, backing off ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      break;
    }
    if (!res) throw ollamaUnreachable(this.baseUrl, new Error('Connection failed after retry'));
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw ollamaInferenceError('No response body for streaming');

    const decoder = new TextDecoder();
    let fullContent = '';
    let model = params.model;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const toolCallAcc: Record<number, { name: string; args: string }> = {};
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newlines; lines start with "data: "
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          model = chunk.model ?? model;
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (delta.content) {
            fullContent += delta.content;
            onDelta(delta.content);
          }
          // Accumulate streamed tool-call fragments by index
          for (const tc of (delta.tool_calls ?? [])) {
            const idx = tc.index ?? 0;
            const slot = (toolCallAcc[idx] ??= { name: '', args: '' });
            if (tc.function?.name) slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        } catch { /* skip malformed frame */ }
      }
    }

    const toolCalls = Object.values(toolCallAcc).filter(t => t.name);
    return {
      model,
      message: {
        role: 'assistant',
        content: fullContent,
        tool_calls: toolCalls.length
          ? this.parseToolCalls(toolCalls.map(t => ({ function: { name: t.name, arguments: t.args } })))
          : undefined,
      },
      done: true,
      eval_count: completionTokens,
      prompt_eval_count: promptTokens,
    } as OllamaChatResponse;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaModel[]> {
    try {
      const data = await this.get<{ data: Array<{ id: string }> }>('/v1/models');
      return (data.data ?? []).map(m => ({ name: m.id, model: m.id, modified_at: '', size: 0, digest: '' } as OllamaModel));
    } catch {
      return [];
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 300_000): Promise<T> {
    const jsonBody = JSON.stringify(body);
    let lastErr: unknown;
    const MAX_ATTEMPTS = 4;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: this.headers(),
          body: jsonBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw ollamaInferenceError(`Request to ${path} timed out after ${timeoutMs}ms`);
        }
        lastErr = err;
        if (attempt < MAX_ATTEMPTS - 1) {
          console.warn('[OpenAI] Connection failed, retrying in 2s...');
          await new Promise(r => setTimeout(r, 2_000));
          continue;
        }
        throw ollamaUnreachable(this.baseUrl, err);
      }
      // 429 — transient rate limit. Exponential backoff and retry.
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const delay = 600 * 2 ** attempt;
        console.warn(`[OpenAI] 429 rate limited on ${path}, backing off ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
      }
      return res.json() as Promise<T>;
    }
    throw ollamaUnreachable(this.baseUrl, lastErr);
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw ollamaUnreachable(this.baseUrl, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

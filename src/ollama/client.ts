import { ollamaUnreachable, ollamaInferenceError } from '../errors.js';
import type {
  OllamaChatParams,
  OllamaChatResponse,
  OllamaGenerateParams,
  OllamaGenerateResponse,
  OllamaModel,
  OllamaEmbedParams,
  OllamaEmbedResponse,
} from './types.js';

export class OllamaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly keepAlive: string = '30m',
  ) {}

  async chat(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>): Promise<OllamaChatResponse> {
    const body: OllamaChatParams = {
      ...params,
      stream: false,
      keep_alive: this.keepAlive,
    };
    return this.post<OllamaChatResponse>('/api/chat', body);
  }

  /**
   * Streaming chat — yields text deltas via callback, returns final response.
   * If the model calls tools, falls back to collecting the full response (no streaming).
   */
  async chatStream(
    params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>,
    onDelta: (text: string) => void,
  ): Promise<OllamaChatResponse> {
    const body: OllamaChatParams = {
      ...params,
      stream: true,
      keep_alive: this.keepAlive,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw ollamaInferenceError('Stream request timed out');
      }
      throw ollamaUnreachable(this.baseUrl, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw ollamaInferenceError('No response body for streaming');

    const decoder = new TextDecoder();
    let fullContent = '';
    let lastChunk: OllamaChatResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const chunk = JSON.parse(line) as OllamaChatResponse;
          lastChunk = chunk;

          if (chunk.message?.content) {
            fullContent += chunk.message.content;
            onDelta(chunk.message.content);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Build final response
    return {
      model: lastChunk?.model ?? params.model,
      message: {
        role: 'assistant',
        content: fullContent,
        tool_calls: lastChunk?.message?.tool_calls,
      },
      done: true,
    } as OllamaChatResponse;
  }

  async generate(params: Omit<OllamaGenerateParams, 'stream' | 'keep_alive'>): Promise<OllamaGenerateResponse> {
    const body: OllamaGenerateParams = {
      ...params,
      stream: false,
      keep_alive: this.keepAlive,
    };
    return this.post<OllamaGenerateResponse>('/api/generate', body);
  }

  async embed(input: string | string[], model = 'qwen3-embedding:8b'): Promise<number[][]> {
    const body: OllamaEmbedParams = { model, input, keep_alive: this.keepAlive };
    const res = await this.post<OllamaEmbedResponse>('/api/embed', body);
    return res.embeddings;
  }

  async listModels(): Promise<OllamaModel[]> {
    const data = await this.get<{ models: OllamaModel[] }>('/api/tags');
    return data.models ?? [];
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 300_000): Promise<T> {
    const jsonBody = JSON.stringify(body);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw ollamaInferenceError(`Request to ${path} timed out after ${timeoutMs}ms`);
      }
      throw ollamaUnreachable(this.baseUrl, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw ollamaInferenceError(`${res.status} ${res.statusText}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(10_000),
      });
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

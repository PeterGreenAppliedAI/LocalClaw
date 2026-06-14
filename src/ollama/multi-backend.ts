import { OllamaClient } from './client.js';
import { OpenAICompatClient } from './openai-client.js';
import type { OllamaChatParams, OllamaChatResponse } from './types.js';

export interface VllmBackendConfig {
  /** OpenAI-compatible base URL, e.g. http://10.0.0.15:8000 */
  url: string;
  /** Optional bearer token */
  apiKey?: string;
  /** Exact model ids served by this backend, e.g. ["cyankiwi/MiniMax-M2.7-AWQ-4bit"] */
  models: string[];
}

/**
 * Routing inference client. Extends OllamaClient so it's a drop-in replacement
 * everywhere `client: OllamaClient` is expected — purely additive.
 *
 * chat/chatStream route to an OpenAI-compatible backend (vLLM) when the request
 * model matches a configured backend; otherwise they fall through to the
 * Ollama/gateway behavior. embed/generate/listModels always use the Ollama path
 * (embeddings + small models stay on the gateway).
 */
export class MultiBackendClient extends OllamaClient {
  private readonly routes = new Map<string, OpenAICompatClient>();

  constructor(ollamaUrl: string, keepAlive: string | undefined, backends: VllmBackendConfig[]) {
    super(ollamaUrl, keepAlive);
    for (const b of backends) {
      const client = new OpenAICompatClient(b.url, b.apiKey);
      for (const model of b.models) {
        this.routes.set(model, client);
        console.log(`[Inference] Route: "${model}" → vLLM ${b.url}`);
      }
    }
  }

  override async chat(params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>): Promise<OllamaChatResponse> {
    const route = this.routes.get(params.model);
    return route ? route.chat(params) : super.chat(params);
  }

  override async chatStream(
    params: Omit<OllamaChatParams, 'stream' | 'keep_alive'>,
    onDelta: (text: string) => void,
  ): Promise<OllamaChatResponse> {
    const route = this.routes.get(params.model);
    return route ? route.chatStream(params, onDelta) : super.chatStream(params, onDelta);
  }
}

/**
 * Build the inference client from config. Returns a MultiBackendClient when
 * OpenAI-compatible backends are configured, otherwise a plain OllamaClient.
 * Both satisfy the OllamaClient type, so callers are unchanged.
 */
export function createInferenceClient(
  ollamaUrl: string,
  keepAlive: string | undefined,
  backends: VllmBackendConfig[] | undefined,
): OllamaClient {
  if (backends?.length) {
    return new MultiBackendClient(ollamaUrl, keepAlive, backends);
  }
  return new OllamaClient(ollamaUrl, keepAlive);
}

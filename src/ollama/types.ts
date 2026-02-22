export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

/** Ollama tool definition (OpenAI-compatible format) */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export interface OllamaChatParams {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  options?: {
    temperature?: number;
    num_predict?: number;
    stop?: string[];
  };
  keep_alive?: string;
  stream?: boolean;
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage & { tool_calls?: OllamaToolCall[] };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface OllamaGenerateParams {
  model: string;
  prompt: string;
  system?: string;
  options?: {
    temperature?: number;
    num_predict?: number;
    stop?: string[];
  };
  keep_alive?: string;
  stream?: false;
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaEmbedParams {
  model: string;
  input: string | string[];
  keep_alive?: string;
}

export interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
}

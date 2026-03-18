export type ErrorCode =
  | 'ROUTER_TIMEOUT'
  | 'ROUTER_PARSE_FAILURE'
  | 'REACT_MAX_ITERATIONS'
  | 'REACT_PARSE_FAILURE'
  | 'TOOL_EXECUTION_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'OLLAMA_UNREACHABLE'
  | 'OLLAMA_INFERENCE_ERROR'
  | 'CONFIG_INVALID'
  | 'CHANNEL_CONNECT_ERROR'
  | 'CHANNEL_SEND_ERROR'
  | 'SSRF_BLOCKED'
  | 'SESSION_IO_ERROR'
  | 'PIPELINE_STAGE_ERROR'
  | 'PIPELINE_EXTRACT_FAILURE';

export class LocalClawError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LocalClawError';
  }
}

// Factory functions — single choke point per AI_principles §8
export function routerTimeout(ms: number): LocalClawError {
  return new LocalClawError('ROUTER_TIMEOUT', `Router timed out after ${ms}ms`);
}

export function routerParseFailure(raw: string): LocalClawError {
  return new LocalClawError('ROUTER_PARSE_FAILURE', `Could not parse router output: "${raw}"`);
}

export function reactMaxIterations(max: number): LocalClawError {
  return new LocalClawError('REACT_MAX_ITERATIONS', `ReAct loop hit max iterations (${max})`);
}

export function reactParseFailure(raw: string): LocalClawError {
  return new LocalClawError('REACT_PARSE_FAILURE', `Could not parse ReAct response: "${raw}"`);
}

export function toolExecutionError(tool: string, cause: unknown): LocalClawError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new LocalClawError('TOOL_EXECUTION_ERROR', `Tool "${tool}" failed: ${msg}`, cause);
}

export function toolNotFound(name: string): LocalClawError {
  return new LocalClawError('TOOL_NOT_FOUND', `Tool "${name}" not found in registry`);
}

export function ollamaUnreachable(url: string, cause?: unknown): LocalClawError {
  return new LocalClawError('OLLAMA_UNREACHABLE', `Cannot reach Ollama at ${url}`, cause);
}

export function ollamaInferenceError(msg: string, cause?: unknown): LocalClawError {
  return new LocalClawError('OLLAMA_INFERENCE_ERROR', `Ollama inference error: ${msg}`, cause);
}

export function configInvalid(details: string): LocalClawError {
  return new LocalClawError('CONFIG_INVALID', `Invalid config: ${details}`);
}

export function channelConnectError(id: string, cause?: unknown): LocalClawError {
  return new LocalClawError('CHANNEL_CONNECT_ERROR', `Channel "${id}" failed to connect`, cause);
}

export function channelSendError(id: string, cause?: unknown): LocalClawError {
  return new LocalClawError('CHANNEL_SEND_ERROR', `Channel "${id}" failed to send`, cause);
}

export function ssrfBlocked(url: string): LocalClawError {
  return new LocalClawError('SSRF_BLOCKED', `SSRF blocked: "${url}" resolves to private/blocked address`);
}

export function sessionIoError(msg: string, cause?: unknown): LocalClawError {
  return new LocalClawError('SESSION_IO_ERROR', `Session I/O error: ${msg}`, cause);
}

export function pipelineStageError(stage: string, cause?: unknown): LocalClawError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new LocalClawError('PIPELINE_STAGE_ERROR', `Pipeline stage "${stage}" failed: ${msg}`, cause);
}

export function pipelineExtractFailure(stage: string, raw: string): LocalClawError {
  return new LocalClawError('PIPELINE_EXTRACT_FAILURE', `Pipeline extraction at "${stage}" returned unparseable output: "${raw.slice(0, 100)}"`);
}

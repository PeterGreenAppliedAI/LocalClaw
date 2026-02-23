import { estimateTokens } from './tokens.js';

export interface ContextBudget {
  totalTokens: number;       // model context window (e.g., 32768)
  systemTokens: number;      // system prompt + workspace context
  outputReserve: number;     // specialist's maxTokens (num_predict)
  historyBudget: number;     // remaining for conversation history
}

const SAFETY_MARGIN = 256;

/**
 * Compute how the model's context window should be divided.
 *
 * historyBudget = contextSize - systemTokens - currentMessageTokens - outputReserve - safetyMargin
 */
export function computeBudget(params: {
  contextSize: number;
  systemPrompt: string;
  workspaceContext: string;
  currentMessage: string;
  outputReserve: number;
}): ContextBudget {
  const systemTokens = estimateTokens(params.systemPrompt) + estimateTokens(params.workspaceContext);
  const currentMessageTokens = estimateTokens(params.currentMessage);

  const historyBudget = Math.max(
    0,
    params.contextSize - systemTokens - currentMessageTokens - params.outputReserve - SAFETY_MARGIN,
  );

  return {
    totalTokens: params.contextSize,
    systemTokens,
    outputReserve: params.outputReserve,
    historyBudget,
  };
}

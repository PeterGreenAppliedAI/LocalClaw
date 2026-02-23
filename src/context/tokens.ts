import type { OllamaMessage } from '../ollama/types.js';

/**
 * Estimate token count from text using chars/3.5 heuristic.
 * Intentionally overestimates — safer to compact early than overflow.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate total token cost of a message array.
 * Adds 4 tokens per-message overhead (role marker, framing).
 */
export function estimateMessagesTokens(messages: OllamaMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content ?? '');
    total += 4; // per-message overhead
  }
  return total;
}

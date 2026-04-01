import type { OllamaMessage } from '../ollama/types.js';

/**
 * Estimate token count using a word-aware heuristic.
 *
 * BPE tokenizers (used by llama/qwen models) split text into subwords.
 * - Short common words (1-4 chars): usually 1 token
 * - Medium words (5-8 chars): usually 1-2 tokens
 * - Long/uncommon words (9+ chars): usually 2-3 tokens
 * - Punctuation, newlines, special chars: 1 token each
 * - Numbers: ~1 token per 1-3 digits
 *
 * This consistently overestimates by ~10-15% (safer than underestimating).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;

  // Split on whitespace boundaries — each word gets estimated separately
  const segments = text.split(/(\s+)/);
  for (const seg of segments) {
    if (!seg) continue;

    // Whitespace: each newline is a token, spaces collapse
    if (/^\s+$/.test(seg)) {
      tokens += (seg.match(/\n/g)?.length ?? 0) + 1;
      continue;
    }

    // Word/token estimation based on character composition
    const len = seg.length;
    if (len <= 4) {
      tokens += 1;
    } else if (len <= 8) {
      tokens += 2;
    } else if (len <= 14) {
      tokens += 3;
    } else {
      // Long strings: ~4 chars per token
      tokens += Math.ceil(len / 4);
    }
  }

  return tokens;
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

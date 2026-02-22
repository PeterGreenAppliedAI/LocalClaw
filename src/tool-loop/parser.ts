import JSON5 from 'json5';
import type { ParsedReActResponse } from './types.js';

/**
 * Parse a ReAct-format LLM response.
 *
 * Handles:
 *   Action: tool_name[{"param": "value"}]
 *   Final Answer: ...
 *   Fallback: treat as answer
 *
 * Includes JSON5 repair layer per ChatGPT feedback:
 * local models often forget quotes, emit trailing commas, mix single quotes.
 * JSON5 handles all of these gracefully.
 */
export function parseReActResponse(text: string): ParsedReActResponse {
  if (!text || !text.trim()) {
    return { type: 'fallback', content: '' };
  }

  const thought = extractThought(text);

  // Check for Action: tool_name[{...}]
  const actionMatch = text.match(/Action:\s*(\w+)\s*\[/);
  if (actionMatch) {
    const tool = actionMatch[1];
    const afterBracket = text.slice(text.indexOf(actionMatch[0]) + actionMatch[0].length);
    const params = extractJsonParams(afterBracket);
    return { type: 'action', thought, tool, params, raw: text };
  }

  // Also support Action: tool_name({...}) format from react-loop.js
  const parenMatch = text.match(/Action:\s*(\w+)\s*\(/);
  if (parenMatch) {
    const tool = parenMatch[1];
    const afterParen = text.slice(text.indexOf(parenMatch[0]) + parenMatch[0].length);
    const params = extractJsonParams(afterParen);
    return { type: 'action', thought, tool, params, raw: text };
  }

  // Check for Final Answer
  const finalMatch = text.match(/Final Answer:\s*([\s\S]+)/i);
  if (finalMatch) {
    return { type: 'final_answer', thought, answer: finalMatch[1].trim() };
  }

  // Fallback: strip "Thought:" prefix, treat as answer
  let content = text.trim();
  const thoughtOnly = content.match(/^Thought:\s*([\s\S]+)/i);
  if (thoughtOnly) {
    content = thoughtOnly[1].trim();
  }
  return { type: 'fallback', content };
}

function extractThought(text: string): string {
  const match = text.match(/Thought:\s*(.+?)(?=\n(?:Action:|Final Answer:)|$)/is);
  return match ? match[1].trim() : '';
}

/**
 * Extract JSON params using brace-matching, then parse with JSON5 repair layer.
 */
function extractJsonParams(text: string): Record<string, unknown> {
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return {};

  let depth = 0;
  let jsonEnd = -1;
  for (let i = jsonStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth--;
    if (depth === 0) {
      jsonEnd = i;
      break;
    }
  }

  if (jsonEnd === -1) return {};

  const raw = text.slice(jsonStart, jsonEnd + 1);

  // Try strict JSON first, then JSON5 repair layer
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      return JSON5.parse(raw) as Record<string, unknown>;
    } catch {
      // Deterministic sanitizer: quote unquoted keys, fix trailing commas
      try {
        const sanitized = sanitizeJson(raw);
        return JSON.parse(sanitized) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
  }
}

/**
 * Last-resort JSON sanitizer for common local model mistakes:
 * - Unquoted keys
 * - Trailing commas
 * - Single quotes → double quotes
 */
function sanitizeJson(raw: string): string {
  let s = raw;
  // Single quotes to double quotes (outside of already double-quoted strings)
  s = s.replace(/'/g, '"');
  // Quote unquoted keys: { key: → { "key":
  s = s.replace(/(\{|,)\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

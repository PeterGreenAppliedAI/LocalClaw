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

  // Strip model thinking blocks before parsing — Gemma 4 and Qwen emit these
  // and they can be misinterpreted as final answers
  let cleanText = text
    .replace(/<\|channel>thought\n[\s\S]*?<channel\|>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]{0,500}?<\/think>/g, '')
    // DeepSeek narrates tool calls in its own DSML dialect when no native tools were passed:
    //   <｜DSML｜invoke name="t"><｜DSML｜parameter name="x" string="true">v</｜DSML｜parameter></｜DSML｜invoke>
    // Strip the `｜DSML｜` (U+FF5C) markers so it normalizes to the <invoke>/<parameter> form handled below.
    .replace(/｜DSML｜/g, '')
    .trim();
  // If stripping left nothing, the model only produced thinking — treat as empty
  if (!cleanText) return { type: 'fallback', content: '' };

  const thought = extractThought(cleanText);

  // XML tool calls emitted as TEXT instead of the native tool_calls field. Different models use
  // different dialects, all normalized to <invoke>/<parameter> here:
  //   MiniMax/Anthropic: <minimax:tool_call><invoke name="document"><parameter name="action">create</parameter></invoke>
  //   DeepSeek:          <｜DSML｜invoke name="t"><｜DSML｜parameter name="x" string="true">v</｜DSML｜parameter></｜DSML｜invoke>
  //                      (the ｜DSML｜ markers are stripped above)
  const invokeMatch = cleanText.match(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/i);
  if (invokeMatch) {
    const tool = invokeMatch[1];
    const params: Record<string, unknown> = {};
    // `[^>]*` tolerates extra attributes like DeepSeek's string="true".
    const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(invokeMatch[2])) !== null) {
      params[pm[1]] = coerceParamValue(pm[2]);
    }
    return { type: 'action', thought, tool, params, raw: cleanText };
  }

  // Check for Action: tool_name[{...}]
  const actionMatch = cleanText.match(/Action:\s*(\w+)\s*\[/);
  if (actionMatch) {
    const tool = actionMatch[1];
    const afterBracket = cleanText.slice(cleanText.indexOf(actionMatch[0]) + actionMatch[0].length);
    const params = extractJsonParams(afterBracket);
    return { type: 'action', thought, tool, params, raw: cleanText };
  }

  // Also support Action: tool_name({...}) format from react-loop.js
  const parenMatch = cleanText.match(/Action:\s*(\w+)\s*\(/);
  if (parenMatch) {
    const tool = parenMatch[1];
    const afterParen = cleanText.slice(cleanText.indexOf(parenMatch[0]) + parenMatch[0].length);
    const params = extractJsonParams(afterParen);
    return { type: 'action', thought, tool, params, raw: cleanText };
  }

  // Check for Final Answer
  const finalMatch = cleanText.match(/Final Answer:\s*([\s\S]+)/i);
  if (finalMatch) {
    return { type: 'final_answer', thought, answer: finalMatch[1].trim() };
  }

  // Fallback: strip "Thought:" prefix, treat as answer
  let content = cleanText.trim();
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

/** Coerce an XML <parameter> value: bool/number/JSON when it clearly is one, else the string. */
function coerceParamValue(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { /* fall through to string */ }
  }
  return t;
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

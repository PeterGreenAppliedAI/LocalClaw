import type { OllamaClient } from '../ollama/client.js';
import { pipelineExtractFailure } from '../errors.js';

interface FieldSchema {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
}

/**
 * Build a focused extraction prompt from a schema definition.
 * The LLM returns ONLY a JSON object — no reasoning, no explanation.
 */
export function buildExtractionPrompt(
  schema: Record<string, FieldSchema>,
  userMessage: string,
  examples?: Array<{ input: string; output: Record<string, unknown> }>,
): { system: string; user: string } {
  const fields = Object.entries(schema)
    .map(([name, field]) => {
      let line = `- "${name}" (${field.type}${field.required ? ', required' : ', optional'}): ${field.description}`;
      if (field.enum) line += ` — one of: ${field.enum.join(', ')}`;
      return line;
    })
    .join('\n');

  let system = `Extract the following parameters from the user's message as a JSON object.\n\n${fields}\n\nReturn ONLY a valid JSON object. No explanation, no markdown, no extra text.`;

  if (examples && examples.length > 0) {
    const exLines = examples
      .map(ex => `Input: "${ex.input}"\nOutput: ${JSON.stringify(ex.output)}`)
      .join('\n\n');
    system += `\n\nExamples:\n${exLines}`;
  }

  return { system, user: userMessage };
}

/**
 * Call the LLM to extract structured params, parse the JSON response.
 * Retries once with a repair prompt on parse failure.
 */
export async function extractParams(
  client: OllamaClient,
  model: string,
  schema: Record<string, FieldSchema>,
  userMessage: string,
  examples?: Array<{ input: string; output: Record<string, unknown> }>,
): Promise<Record<string, unknown>> {
  const { system, user } = buildExtractionPrompt(schema, userMessage, examples);

  const response = await client.chat({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    options: { temperature: 0.1, num_predict: 256 },
  });

  const raw = response.message?.content ?? '';
  const parsed = tryParseJson(raw);
  if (parsed) return parsed;

  // Retry with repair prompt
  const repairResponse = await client.chat({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: raw },
      { role: 'user', content: 'That was not valid JSON. Return ONLY a JSON object like {"key": "value"}, nothing else.' },
    ],
    options: { temperature: 0.1, num_predict: 256 },
  });

  const repairRaw = repairResponse.message?.content ?? '';
  const repairParsed = tryParseJson(repairRaw);
  if (repairParsed) return repairParsed;

  throw pipelineExtractFailure('extract', repairRaw);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  // Try direct parse
  try {
    const obj = JSON.parse(text);
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) return obj;
  } catch { /* fall through */ }

  // Try extracting JSON from markdown fences or surrounding text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) return obj;
    } catch { /* fall through */ }
  }

  return null;
}

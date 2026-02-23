import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ReasoningConfig } from '../config/types.js';

export function createReasonTool(client: OllamaClient, config: ReasoningConfig): LocalClawTool {
  return {
    name: 'reason',
    description: 'Send a problem to the reasoning model for deep analysis, planning, or content formatting. The reasoning model thinks carefully but cannot call tools — use this after gathering information. Good for: writing articles, analyzing data, planning approaches, formatting reports.',
    parameterDescription: 'prompt (required): What to reason about or produce. context (optional): Supporting data, search results, or prior findings to reason over.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to reason about or produce' },
        context: { type: 'string', description: 'Supporting data, search results, or prior findings to reason over' },
      },
      required: ['prompt'],
    },
    category: 'reasoning',

    async execute(params: Record<string, unknown>): Promise<string> {
      const prompt = params.prompt as string;
      if (!prompt) return 'Error: prompt parameter is required';

      const context = params.context as string | undefined;
      const userContent = context ? `${prompt}\n\n---\nContext:\n${context}` : prompt;

      const response = await client.chat({
        model: config.model,
        messages: [
          {
            role: 'system',
            content: `You are a reasoning specialist. Think carefully and provide well-structured responses. You cannot call tools — work only with the information provided.

Formatting rules (your output will be displayed in a chat platform):
- Use short paragraphs, bullet points, and bold (**text**) for emphasis.
- Do NOT use markdown tables — they don't render in chat. Use bullet lists instead.
- Do NOT use horizontal rules (---).
- Be thorough but information-dense — no filler or repetition.
- Use headers (## Section) sparingly — no more than 3-4 sections.
- Lead with the most important information first.
- Always end with a **Sources** section listing the URLs and source names found in the provided context.`,
          },
          { role: 'user', content: userContent },
        ],
        options: { temperature: config.temperature, num_predict: config.maxTokens },
      });

      return response.message?.content ?? 'Reasoning produced no output.';
    },
  };
}

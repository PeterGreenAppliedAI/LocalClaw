import type { PipelineDefinition } from '../types.js';

/**
 * Detect memory sub-intent: save vs recall.
 */
function detectMemoryIntent(message: string): string {
  const m = message.toLowerCase();
  if (/\b(remember|save|store|note|record|keep)\b/.test(m)) return 'save';
  return 'recall';
}

export const memoryPipeline: PipelineDefinition = {
  name: 'memory',
  stages: [
    {
      name: 'route',
      type: 'branch',
      decide: (ctx) => detectMemoryIntent(ctx.userMessage),
      branches: {
        // --- SAVE ---
        save: [
          {
            name: 'extract_save',
            type: 'extract',
            schema: {
              content: {
                type: 'string',
                description: 'The fact or information to save to memory',
                required: true,
              },
              category: {
                type: 'string',
                description: 'Fact category',
                enum: ['stable', 'context', 'decision', 'question'],
              },
            },
            examples: [
              { input: 'remember that I prefer dark mode', output: { content: 'User prefers dark mode', category: 'stable' } },
              { input: 'save that the meeting is on Thursday', output: { content: 'Meeting is on Thursday', category: 'context' } },
              { input: 'note that we decided to use React', output: { content: 'Decided to use React for the frontend', category: 'decision' } },
            ],
          },
          {
            name: 'save',
            type: 'tool',
            tool: 'memory_save',
            resolveParams: (ctx) => {
              const p: Record<string, unknown> = { content: ctx.params.content };
              if (ctx.params.category) p.category = ctx.params.category;
              return p;
            },
          },
          {
            name: 'confirm_save',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.save as string;
            },
          },
        ],

        // --- RECALL ---
        recall: [
          {
            name: 'extract_recall',
            type: 'extract',
            schema: {
              query: {
                type: 'string',
                description: 'What to search for in memory',
                required: true,
              },
            },
            examples: [
              { input: 'what do you know about me', output: { query: 'user preferences information' } },
              { input: 'what did I say about the project', output: { query: 'project' } },
              { input: 'do you remember my favorite color', output: { query: 'favorite color' } },
            ],
          },
          {
            name: 'search',
            type: 'tool',
            tool: 'memory_search',
            resolveParams: (ctx) => ({ query: ctx.params.query }),
          },
          {
            name: 'format_results',
            type: 'llm',
            temperature: 0.3,
            maxTokens: 1024,
            buildPrompt: (ctx) => ({
              system: 'You are a helpful assistant answering a question from memory. Use the search results to answer naturally. If nothing relevant was found, say so honestly. Do not make up information.',
              user: `User asked: "${ctx.userMessage}"\n\nMemory search results:\n${ctx.stageResults.search as string}`,
            }),
          },
        ],
      },
    },
  ],
};

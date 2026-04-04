import type { PipelineDefinition } from '../types.js';

const MEMORY_CLASSIFY_PROMPT = `You are a memory intent classifier. Given the user's message, decide if they want to SAVE, RECALL, or FORGET something in memory.

- "save" — the user wants to STORE new information (e.g., "remember that I like dark mode", "save this", "note that the meeting is Thursday")
- "recall" — the user wants to RETRIEVE or ASK about stored information (e.g., "what do you know about me", "do you remember my favorite color", "what did I say about the project")
- "forget" — the user wants to REMOVE or CORRECT wrong information (e.g., "forget that I'm taking a course", "that's wrong, remove it", "delete the fact about my job", "I'm not a student, fix that")`;

export const memoryPipeline: PipelineDefinition = {
  name: 'memory',
  stages: [
    {
      name: 'route',
      type: 'llm_branch',
      prompt: MEMORY_CLASSIFY_PROMPT,
      options: ['save', 'recall', 'forget'],
      fallback: 'recall',
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
            stream: true,
            temperature: 0.3,
            maxTokens: 1024,
            buildPrompt: (ctx) => ({
              system: 'You are a helpful assistant answering a question from memory. Use the search results to answer naturally. If nothing relevant was found, say so honestly. Do not make up information.',
              user: `User asked: "${ctx.userMessage}"\n\nMemory search results:\n${ctx.stageResults.search as string}`,
            }),
          },
        ],

        // --- FORGET ---
        forget: [
          {
            name: 'extract_forget',
            type: 'extract',
            schema: {
              query: {
                type: 'string',
                description: 'Text to match against stored facts — matching facts will be removed',
                required: true,
              },
            },
            examples: [
              { input: 'forget that I\'m taking an AI course', output: { query: 'taking a beginners AI course' } },
              { input: 'that\'s wrong, I don\'t work at Google', output: { query: 'work at Google' } },
              { input: 'remove the fact about my job title', output: { query: 'job title' } },
            ],
          },
          {
            name: 'forget',
            type: 'tool',
            tool: 'memory_forget',
            resolveParams: (ctx) => ({ query: ctx.params.query }),
          },
          {
            name: 'confirm_forget',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.forget as string;
            },
          },
        ],
      },
    },
  ],
};

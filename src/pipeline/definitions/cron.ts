import type { PipelineDefinition } from '../types.js';

/**
 * Detect cron sub-intent from user message.
 */
function detectCronIntent(message: string): string {
  const m = message.toLowerCase();
  if (/\b(remove|delete|cancel|stop)\b/.test(m)) return 'remove';
  if (/\b(edit|change|update|modify|reschedule)\b/.test(m)) return 'edit';
  if (/\b(add|create|schedule|set\s*up|every|daily|weekly|hourly)\b/.test(m)) return 'add';
  return 'list';
}

export const cronPipeline: PipelineDefinition = {
  name: 'cron',
  stages: [
    {
      name: 'route',
      type: 'branch',
      decide: (ctx) => detectCronIntent(ctx.userMessage),
      branches: {
        // --- ADD ---
        add: [
          {
            name: 'extract_add',
            type: 'extract',
            schema: {
              name: { type: 'string', description: 'Job name', required: true },
              schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *" for daily at 9am)', required: true },
              category: {
                type: 'string',
                description: 'Specialist category to handle the job',
                required: true,
                enum: ['chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi'],
              },
              message: { type: 'string', description: 'The prompt to run when triggered', required: true },
              channel: { type: 'string', description: 'Delivery channel (e.g., "discord", "telegram")', required: true },
              target: { type: 'string', description: 'Channel ID for results', required: true },
            },
            examples: [
              {
                input: 'schedule a daily web search for AI news at 9am',
                output: {
                  name: 'Daily AI News',
                  schedule: '0 9 * * *',
                  category: 'web_search',
                  message: 'Search for the latest AI news and summarize top stories',
                  channel: 'discord',
                  target: '',
                },
              },
            ],
          },
          {
            name: 'fill_defaults',
            type: 'code',
            execute: (ctx) => {
              // Use source context for channel/target if not extracted
              if (!ctx.params.channel && ctx.sourceContext?.channel) {
                ctx.params.channel = ctx.sourceContext.channel;
              }
              if (!ctx.params.target && ctx.sourceContext?.channelId) {
                ctx.params.target = ctx.sourceContext.channelId;
              }
            },
          },
          {
            name: 'add',
            type: 'tool',
            tool: 'cron_add',
            resolveParams: (ctx) => ({
              name: ctx.params.name,
              schedule: ctx.params.schedule,
              category: ctx.params.category,
              message: ctx.params.message,
              channel: ctx.params.channel,
              target: ctx.params.target,
            }),
          },
          {
            name: 'confirm_add',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.add as string;
            },
          },
        ],

        // --- LIST ---
        list: [
          {
            name: 'list',
            type: 'tool',
            tool: 'cron_list',
            resolveParams: () => ({}),
          },
          {
            name: 'format_list',
            type: 'llm',
            stream: true,
            temperature: 0.2,
            maxTokens: 1024,
            buildPrompt: (ctx) => ({
              system: 'Format the cron job list into a clear, readable response. Be concise. Include job names, schedules, and status.',
              user: `User asked: "${ctx.userMessage}"\n\nCron jobs:\n${ctx.stageResults.list as string}`,
            }),
          },
        ],

        // --- REMOVE ---
        remove: [
          {
            name: 'extract_remove',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'The job ID to remove', required: true },
            },
            examples: [
              { input: 'remove cron job abc123', output: { id: 'abc123' } },
              { input: 'delete the daily news schedule', output: { id: '' } },
            ],
          },
          {
            name: 'remove',
            type: 'tool',
            tool: 'cron_remove',
            resolveParams: (ctx) => ({ id: ctx.params.id }),
          },
          {
            name: 'confirm_remove',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.remove as string;
            },
          },
        ],

        // --- EDIT ---
        edit: [
          {
            name: 'extract_edit',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'Job ID to edit', required: true },
              name: { type: 'string', description: 'New name' },
              schedule: { type: 'string', description: 'New cron expression' },
              category: {
                type: 'string',
                description: 'New specialist category',
                enum: ['chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi'],
              },
              message: { type: 'string', description: 'New prompt/message' },
              enabled: { type: 'string', description: '"true" or "false"' },
            },
            examples: [
              { input: 'change cron job abc to run at 10am', output: { id: 'abc', schedule: '0 10 * * *' } },
              { input: 'disable job xyz', output: { id: 'xyz', enabled: 'false' } },
            ],
          },
          {
            name: 'edit',
            type: 'tool',
            tool: 'cron_edit',
            resolveParams: (ctx) => {
              const p: Record<string, unknown> = { id: ctx.params.id };
              for (const key of ['name', 'schedule', 'category', 'message', 'enabled']) {
                if (ctx.params[key]) p[key] = ctx.params[key];
              }
              return p;
            },
          },
          {
            name: 'confirm_edit',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.edit as string;
            },
          },
        ],
      },
    },
  ],
};

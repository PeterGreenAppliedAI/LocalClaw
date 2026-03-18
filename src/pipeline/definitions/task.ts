import type { PipelineDefinition } from '../types.js';

/**
 * Detect task sub-intent from user message using keywords.
 * Falls back to 'list' if nothing matches.
 */
function detectTaskIntent(message: string): string {
  const m = message.toLowerCase();

  // "done" / "complete" / "finish" / "mark X done"
  if (/\b(done|complete[d]?|finish|mark.+done)\b/.test(m)) return 'done';
  // "remove" / "delete"
  if (/\b(remove|delete|drop)\b/.test(m)) return 'remove';
  // "update" / "change" / "edit" / "set" / "move" / "reassign"
  if (/\b(update|change|edit|modify|set|move|reassign|reschedule)\b/.test(m)) return 'update';
  // "add" / "create" / "new task" / "remind me"
  if (/\b(add|create|new\s+task|remind\s+me|todo)\b/.test(m)) return 'add';
  // Default to list
  return 'list';
}

export const taskPipeline: PipelineDefinition = {
  name: 'task',
  stages: [
    {
      name: 'route',
      type: 'branch',
      decide: (ctx) => detectTaskIntent(ctx.userMessage),
      branches: {
        // --- ADD ---
        add: [
          {
            name: 'extract_add',
            type: 'extract',
            schema: {
              title: { type: 'string', description: 'Task title or description', required: true },
              priority: { type: 'string', description: 'Priority level', enum: ['low', 'medium', 'high'] },
              dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
              assignee: { type: 'string', description: 'Who is responsible' },
              tags: { type: 'string', description: 'Comma-separated tags' },
              details: { type: 'string', description: 'Additional details or notes' },
            },
            examples: [
              { input: 'add a task: review PR by Friday', output: { title: 'Review PR', dueDate: '2026-03-20', priority: 'medium' } },
              { input: 'create high priority task to fix login bug', output: { title: 'Fix login bug', priority: 'high' } },
            ],
          },
          {
            name: 'add',
            type: 'tool',
            tool: 'task_add',
            resolveParams: (ctx) => {
              const p: Record<string, unknown> = { title: ctx.params.title };
              if (ctx.params.priority) p.priority = ctx.params.priority;
              if (ctx.params.dueDate) p.dueDate = ctx.params.dueDate;
              if (ctx.params.assignee) p.assignee = ctx.params.assignee;
              if (ctx.params.tags) p.tags = ctx.params.tags;
              if (ctx.params.details) p.details = ctx.params.details;
              return p;
            },
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
            name: 'extract_list',
            type: 'extract',
            schema: {
              status: { type: 'string', description: 'Filter by status', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
              assignee: { type: 'string', description: 'Filter by assignee' },
              tag: { type: 'string', description: 'Filter by tag' },
            },
            examples: [
              { input: 'show my tasks', output: {} },
              { input: 'what tasks are done', output: { status: 'done' } },
            ],
          },
          {
            name: 'list',
            type: 'tool',
            tool: 'task_list',
            resolveParams: (ctx) => {
              const p: Record<string, unknown> = {};
              if (ctx.params.status) p.status = ctx.params.status;
              if (ctx.params.assignee) p.assignee = ctx.params.assignee;
              if (ctx.params.tag) p.tag = ctx.params.tag;
              return p;
            },
          },
          {
            name: 'format_list',
            type: 'llm',
            temperature: 0.2,
            maxTokens: 1024,
            buildPrompt: (ctx) => ({
              system: 'Format the task list into a clear, readable response. Be concise. Use the data exactly as provided — do not invent tasks.',
              user: `User asked: "${ctx.userMessage}"\n\nTask data:\n${ctx.stageResults.list as string}`,
            }),
          },
        ],

        // --- DONE ---
        done: [
          {
            name: 'extract_done',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'The task ID to mark as done', required: true },
            },
            examples: [
              { input: 'mark task abc123 done', output: { id: 'abc123' } },
              { input: 'complete task 5', output: { id: '5' } },
            ],
          },
          {
            name: 'done',
            type: 'tool',
            tool: 'task_done',
            resolveParams: (ctx) => ({ id: ctx.params.id }),
          },
          {
            name: 'confirm_done',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.done as string;
            },
          },
        ],

        // --- UPDATE ---
        update: [
          {
            name: 'extract_update',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'Task ID to update', required: true },
              title: { type: 'string', description: 'New title' },
              status: { type: 'string', description: 'New status', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
              priority: { type: 'string', description: 'New priority', enum: ['low', 'medium', 'high'] },
              assignee: { type: 'string', description: 'New assignee' },
              dueDate: { type: 'string', description: 'New due date in YYYY-MM-DD format' },
              details: { type: 'string', description: 'New details' },
              tags: { type: 'string', description: 'New comma-separated tags' },
            },
            examples: [
              { input: 'change task abc to high priority', output: { id: 'abc', priority: 'high' } },
              { input: 'reschedule task 5 to next Monday', output: { id: '5', dueDate: '2026-03-23' } },
            ],
          },
          {
            name: 'update',
            type: 'tool',
            tool: 'task_update',
            resolveParams: (ctx) => {
              const p: Record<string, unknown> = { id: ctx.params.id };
              for (const key of ['title', 'status', 'priority', 'assignee', 'dueDate', 'details', 'tags']) {
                if (ctx.params[key]) p[key] = ctx.params[key];
              }
              return p;
            },
          },
          {
            name: 'confirm_update',
            type: 'code',
            execute: (ctx) => {
              ctx.answer = ctx.stageResults.update as string;
            },
          },
        ],

        // --- REMOVE ---
        remove: [
          {
            name: 'extract_remove',
            type: 'extract',
            schema: {
              id: { type: 'string', description: 'The task ID to remove', required: true },
            },
            examples: [
              { input: 'remove task abc123', output: { id: 'abc123' } },
              { input: 'delete task 7', output: { id: '7' } },
            ],
          },
          {
            name: 'remove',
            type: 'tool',
            tool: 'task_remove',
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
      },
    },
  ],
};

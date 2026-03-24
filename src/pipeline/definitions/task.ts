import type { PipelineDefinition } from '../types.js';

const TASK_CLASSIFY_PROMPT = `You are a task intent classifier. Given the user's message, decide what they want to do with their task list.

- "add" — the user wants to CREATE a new task (e.g., "add a task to review the PR", "remind me to call Bob")
- "list" — the user wants to VIEW or CHECK tasks, or is asking a QUESTION about tasks (e.g., "what's on my task list", "is that it?", "check my tasks", "is it done?")
- "done" — the user wants to MARK a specific task as completed (e.g., "mark task abc123 done", "complete the review task")
- "update" — the user wants to CHANGE a task's details like date, priority, or title (e.g., "change the due date", "reschedule task X")
- "remove" — the user wants to DELETE a task entirely (e.g., "remove task abc123", "delete that task")

IMPORTANT: Questions like "is it done?", "is that it?", "are there more?" are ALWAYS "list" — they are asking for information, not performing an action.`;

export const taskPipeline: PipelineDefinition = {
  name: 'task',
  stages: [
    {
      name: 'route',
      type: 'llm_branch',
      prompt: TASK_CLASSIFY_PROMPT,
      options: ['add', 'list', 'done', 'update', 'remove'],
      fallback: 'list',
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
            stream: true,
            temperature: 0.2,
            maxTokens: 1024,
            buildPrompt: (ctx) => ({
              system: `You are a task list formatter. Your ONLY job is to present the task data below in a clear, readable format.

RULES:
- Display ONLY the tasks from the data provided. Do NOT invent, create, or add any tasks.
- Do NOT say "Created task" or "Added task" — you are READING, not writing.
- If the data says "No tasks found", say exactly that.
- Be concise and use bullet points or a clean list format.`,
              user: `User asked: "${ctx.userMessage}"\n\nTask data:\n${ctx.stageResults.list as string}`,
            }),
          },
        ],

        // --- DONE ---
        done: [
          {
            name: 'fetch_tasks_for_done',
            type: 'tool',
            tool: 'task_list',
            resolveParams: () => ({}),
          },
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
            context: (ctx) => `Current tasks:\n${ctx.stageResults.fetch_tasks_for_done as string ?? 'No tasks found'}`,
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
            name: 'fetch_tasks_for_update',
            type: 'tool',
            tool: 'task_list',
            resolveParams: () => ({}),
          },
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
            context: (ctx) => `Current tasks:\n${ctx.stageResults.fetch_tasks_for_update as string ?? 'No tasks found'}`,
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
            name: 'fetch_tasks_for_remove',
            type: 'tool',
            tool: 'task_list',
            resolveParams: () => ({}),
          },
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
            context: (ctx) => `Current tasks:\n${ctx.stageResults.fetch_tasks_for_remove as string ?? 'No tasks found'}`,
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

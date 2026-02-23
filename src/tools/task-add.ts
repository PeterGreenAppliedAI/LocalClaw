import type { LocalClawTool } from './types.js';
import type { TaskStore } from '../tasks/store.js';

export function createTaskAddTool(taskStore: TaskStore): LocalClawTool {
  return {
    name: 'task_add',
    description: 'Create a new task on the task board. Returns the created task with its ID.',
    parameterDescription: 'title (required): Task title. details (optional): Additional details. priority (optional): low, medium, or high (default medium). assignee (optional): Who is responsible (e.g., "user", "bot"). dueDate (optional): Due date in YYYY-MM-DD format. tags (optional): Comma-separated tags.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        details: { type: 'string', description: 'Additional details or description' },
        priority: { type: 'string', description: 'Priority level: low, medium, or high', enum: ['low', 'medium', 'high'] },
        assignee: { type: 'string', description: 'Who is responsible (e.g., "user", "bot")' },
        dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
        tags: { type: 'string', description: 'Comma-separated tags (e.g., "work, urgent")' },
      },
      required: ['title'],
    },
    category: 'task',

    async execute(params: Record<string, unknown>): Promise<string> {
      const title = params.title as string;
      if (!title) return 'Error: title parameter is required';

      const priority = params.priority as string | undefined;
      if (priority && !['low', 'medium', 'high'].includes(priority)) {
        return `Error: Invalid priority "${priority}". Must be low, medium, or high.`;
      }

      const tags = params.tags
        ? (params.tags as string).split(',').map(t => t.trim()).filter(Boolean)
        : undefined;

      const task = taskStore.add(
        {
          title,
          details: params.details as string | undefined,
          priority: (priority as 'low' | 'medium' | 'high') ?? undefined,
          assignee: params.assignee as string | undefined,
          dueDate: params.dueDate as string | undefined,
          tags,
        },
        'bot',
      );

      return `Created task "${task.title}" (${task.id}) — priority: ${task.priority}, status: ${task.status}${task.assignee ? `, assignee: ${task.assignee}` : ''}${task.dueDate ? `, due: ${task.dueDate}` : ''}`;
    },
  };
}

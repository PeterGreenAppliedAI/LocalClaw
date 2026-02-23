import type { LocalClawTool } from './types.js';
import type { TaskStore } from '../tasks/store.js';

export function createTaskListTool(taskStore: TaskStore): LocalClawTool {
  return {
    name: 'task_list',
    description: 'List tasks from the task board. By default shows todo and in-progress tasks.',
    parameterDescription: 'status (optional): Filter by status (todo, in_progress, done, cancelled). assignee (optional): Filter by assignee. tag (optional): Filter by tag.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
        assignee: { type: 'string', description: 'Filter by assignee' },
        tag: { type: 'string', description: 'Filter by tag' },
      },
    },
    category: 'task',

    async execute(params: Record<string, unknown>): Promise<string> {
      const tasks = taskStore.list({
        status: params.status as any,
        assignee: params.assignee as string | undefined,
        tag: params.tag as string | undefined,
      });

      if (tasks.length === 0) return 'No tasks found matching the criteria.';

      return tasks
        .map(t => {
          const parts = [`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`];
          if (t.priority === 'high') parts.push('**HIGH**');
          if (t.dueDate) parts.push(`(due: ${t.dueDate})`);
          if (t.assignee) parts.push(`@${t.assignee}`);
          if (t.tags?.length) parts.push(`[${t.tags.join(', ')}]`);
          parts.push(`\`${t.id}\``);
          parts.push(`(${t.status})`);
          return parts.join(' ');
        })
        .join('\n');
    },
  };
}

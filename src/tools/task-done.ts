import type { LocalClawTool } from './types.js';
import type { TaskStore } from '../tasks/store.js';

export function createTaskDoneTool(taskStore: TaskStore): LocalClawTool {
  return {
    name: 'task_done',
    description: 'Mark a task as done. Convenience shortcut — only needs the task ID.',
    parameterDescription: 'id (required): The task ID to mark as done.',
    example: 'task_done[{"id": "t_abc123"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to mark as done' },
      },
      required: ['id'],
    },
    category: 'task',

    async execute(params: Record<string, unknown>): Promise<string> {
      const id = params.id as string;
      if (!id) return 'Error: id parameter is required';

      const updated = taskStore.update(id, { status: 'done' });
      if (!updated) return `Task ${id} not found`;

      return `Marked task "${updated.title}" (${updated.id}) as done.`;
    },
  };
}

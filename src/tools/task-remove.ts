import type { LocalClawTool } from './types.js';
import type { TaskStore } from '../tasks/store.js';

export function createTaskRemoveTool(taskStore: TaskStore): LocalClawTool {
  return {
    name: 'task_remove',
    description: 'Permanently delete a task from the task board.',
    parameterDescription: 'id (required): The task ID to remove.',
    example: 'task_remove[{"id": "t_abc123"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to remove' },
      },
      required: ['id'],
    },
    category: 'task',

    async execute(params: Record<string, unknown>): Promise<string> {
      const id = params.id as string;
      if (!id) return 'Error: id parameter is required';

      const removed = taskStore.remove(id);
      return removed ? `Removed task ${id}` : `Task ${id} not found`;
    },
  };
}

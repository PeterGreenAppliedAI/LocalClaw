import type { LocalClawTool } from './types.js';
import type { TaskStore } from '../tasks/store.js';

export function createTaskUpdateTool(taskStore: TaskStore): LocalClawTool {
  return {
    name: 'task_update',
    description: 'Update an existing task. Change its title, details, status, priority, assignee, due date, or tags.',
    parameterDescription: 'id (required): Task ID. title (optional): New title. details (optional): New details. status (optional): New status (todo, in_progress, done, cancelled). priority (optional): New priority (low, medium, high). assignee (optional): New assignee. dueDate (optional): New due date (YYYY-MM-DD). tags (optional): New comma-separated tags.',
    example: 'task_update[{"id": "t_abc123", "status": "in_progress", "priority": "high"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to update' },
        title: { type: 'string', description: 'New task title' },
        details: { type: 'string', description: 'New task details' },
        status: { type: 'string', description: 'New status', enum: ['todo', 'in_progress', 'done', 'cancelled'] },
        priority: { type: 'string', description: 'New priority', enum: ['low', 'medium', 'high'] },
        assignee: { type: 'string', description: 'New assignee' },
        dueDate: { type: 'string', description: 'New due date (YYYY-MM-DD)' },
        tags: { type: 'string', description: 'New comma-separated tags' },
      },
      required: ['id'],
    },
    category: 'task',

    async execute(params: Record<string, unknown>): Promise<string> {
      const id = params.id as string;
      if (!id) return 'Error: id parameter is required';

      const changes: Record<string, unknown> = {};

      if (params.title !== undefined) changes.title = params.title;
      if (params.details !== undefined) changes.details = params.details;
      if (params.assignee !== undefined) changes.assignee = params.assignee;
      if (params.dueDate !== undefined) changes.dueDate = params.dueDate;

      if (params.status !== undefined) {
        const status = params.status as string;
        if (!['todo', 'in_progress', 'done', 'cancelled'].includes(status)) {
          return `Error: Invalid status "${status}". Must be todo, in_progress, done, or cancelled.`;
        }
        changes.status = status;
      }

      if (params.priority !== undefined) {
        const priority = (params.priority as string).toLowerCase();
        if (!['low', 'medium', 'high'].includes(priority)) {
          return `Error: Invalid priority "${priority}". Must be low, medium, or high.`;
        }
        changes.priority = priority;
      }

      if (params.tags !== undefined) {
        changes.tags = (params.tags as string).split(',').map(t => t.trim()).filter(Boolean);
      }

      if (Object.keys(changes).length === 0) {
        return 'Error: No changes provided. Specify at least one field to update.';
      }

      const updated = taskStore.update(id, changes);
      if (!updated) return `Task ${id} not found`;

      return `Updated task "${updated.title}" (${updated.id}): status=${updated.status}, priority=${updated.priority}${updated.assignee ? `, assignee=${updated.assignee}` : ''}${updated.dueDate ? `, due=${updated.dueDate}` : ''}`;
    },
  };
}

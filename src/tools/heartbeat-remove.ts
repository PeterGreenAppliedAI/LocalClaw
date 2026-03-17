import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';

export function createHeartbeatRemoveTool(cronService: CronService): LocalClawTool {
  return {
    name: 'heartbeat_remove',
    description: 'Remove a heartbeat task by ID.',
    parameterDescription: 'id (required): The heartbeat task ID to remove.',
    example: 'heartbeat_remove[{"id": "hb_abc123"}]',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The heartbeat task ID to remove' },
      },
      required: ['id'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const id = params.id as string;
      if (!id) return 'Error: id parameter is required';

      const jobs = cronService.listByType('heartbeat', true);
      const isHeartbeat = jobs.some(j => j.id === id);
      if (!isHeartbeat) return `Heartbeat task ${id} not found. (Use cron_remove for regular cron jobs.)`;

      const removed = cronService.remove(id);
      return removed ? `Removed heartbeat task ${id}` : `Heartbeat task ${id} not found`;
    },
  };
}

import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';

export function createCronRemoveTool(cronService: CronService): LocalClawTool {
  return {
    name: 'cron_remove',
    description: 'Remove a scheduled job',
    parameterDescription: 'id (required): The job ID to remove.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The job ID to remove' },
      },
      required: ['id'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const id = params.id as string;
      if (!id) return 'Error: id parameter is required';

      const removed = cronService.remove(id);
      return removed ? `Removed job ${id}` : `Job ${id} not found`;
    },
  };
}

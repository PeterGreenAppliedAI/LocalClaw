import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';

export function createHeartbeatListTool(cronService: CronService): LocalClawTool {
  return {
    name: 'heartbeat_list',
    description: 'List all heartbeat tasks. These run autonomously on the shared heartbeat schedule.',
    parameterDescription: 'includeDisabled (optional): Show disabled tasks too (default false).',
    example: 'heartbeat_list[{}]',
    parameters: {
      type: 'object',
      properties: {
        includeDisabled: { type: 'string', description: 'Show disabled tasks too (default false)' },
      },
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const includeDisabled = params.includeDisabled === true || params.includeDisabled === 'true';
      const jobs = cronService.listByType('heartbeat', includeDisabled);

      if (jobs.length === 0) return 'No heartbeat tasks configured.';

      return jobs
        .map(j => `- ${j.name} (${j.id}): "${j.message.slice(0, 80)}" [${j.enabled ? 'enabled' : 'disabled'}]${j.lastRunAt ? ` (last run: ${j.lastRunAt})` : ''}`)
        .join('\n');
    },
  };
}

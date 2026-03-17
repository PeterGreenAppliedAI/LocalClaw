import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';

export function createCronListTool(cronService: CronService): LocalClawTool {
  return {
    name: 'cron_list',
    description: 'List all scheduled jobs',
    parameterDescription: 'includeDisabled (optional): Show disabled jobs too (default false).',
    example: 'cron_list[{"includeDisabled": "true"}]',
    parameters: {
      type: 'object',
      properties: {
        includeDisabled: { type: 'string', description: 'Show disabled jobs too (default false)' },
      },
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const includeDisabled = (params.includeDisabled as boolean) ?? false;
      const jobs = cronService.list(includeDisabled);

      if (jobs.length === 0) return 'No scheduled jobs';

      return jobs
        .map(j => `- [${j.type ?? 'cron'}] ${j.name} (${j.id}): "${j.schedule}" → ${j.category}: "${j.message.slice(0, 60)}" [${j.enabled ? 'enabled' : 'disabled'}]${j.lastRunAt ? ` (last run: ${j.lastRunAt})` : ''}`)
        .join('\n');
    },
  };
}

import type { LocalClawTool } from './types.js';
import type { CronService } from '../cron/service.js';
import type { HeartbeatConfig } from '../config/types.js';

export function createHeartbeatAddTool(
  cronService: CronService,
  heartbeatConfig: HeartbeatConfig,
): LocalClawTool {
  return {
    name: 'heartbeat_add',
    description: 'Add a task to the periodic heartbeat. Heartbeat tasks run on a shared schedule and are executed autonomously with full tool access.',
    parameterDescription: 'name (required): Task name. message (required): What the heartbeat should do (e.g., "Check the task board for overdue items").',
    example: 'heartbeat_add[{"name": "overdue-check", "message": "Check the task board for overdue items and notify the user"}]',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name' },
        message: { type: 'string', description: 'What to do during heartbeat (the instruction/prompt)' },
      },
      required: ['name', 'message'],
    },
    category: 'cron',

    async execute(params: Record<string, unknown>): Promise<string> {
      const name = params.name as string;
      const message = params.message as string;

      if (!name || !message) {
        return 'Error: name and message are required';
      }

      const job = cronService.add({
        name,
        type: 'heartbeat',
        schedule: heartbeatConfig.schedule,
        category: 'multi',
        message,
        delivery: {
          channel: heartbeatConfig.delivery.channel,
          target: heartbeatConfig.delivery.target,
        },
      });

      return `Added heartbeat task "${job.name}" (${job.id}). It will run on the heartbeat schedule (${heartbeatConfig.schedule}).`;
    },
  };
}

export interface CronJob {
  id: string;
  name: string;
  type: 'cron' | 'heartbeat';
  schedule: string;    // cron expression
  category: string;    // specialist category
  message: string;     // prompt to run
  delivery: {
    channel: string;
    target: string;    // channelId to send result to
  };
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}

export interface CronJobCreate {
  name: string;
  type?: 'cron' | 'heartbeat';
  schedule: string;
  category: string;
  message: string;
  delivery: { channel: string; target: string };
}

export interface CronJobUpdate {
  name?: string;
  schedule?: string;
  category?: string;
  message?: string;
  enabled?: boolean;
}

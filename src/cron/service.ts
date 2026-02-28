import { Cron } from 'croner';
import { CronStore } from './store.js';
import type { CronJob, CronJobCreate, CronJobUpdate } from './types.js';

export interface CronServiceDeps {
  store: CronStore;
  onTrigger: (job: CronJob) => Promise<void>;
  timezone?: string;
}

export class CronService {
  private store: CronStore;
  private onTrigger: (job: CronJob) => Promise<void>;
  private timezone: string;
  private schedulers = new Map<string, Cron>();
  private running = false;

  constructor(deps: CronServiceDeps) {
    this.store = deps.store;
    this.onTrigger = deps.onTrigger;
    this.timezone = deps.timezone ?? 'America/New_York';
  }

  async start(): Promise<void> {
    this.running = true;
    this.scheduleAll();
    console.log(`[Cron] Started with ${this.store.listByType('cron').length} cron job(s), ${this.store.listByType('heartbeat').length} heartbeat task(s)`);
  }

  stop(): void {
    this.running = false;
    for (const cron of this.schedulers.values()) {
      cron.stop();
    }
    this.schedulers.clear();
  }

  list(includeDisabled = false): CronJob[] {
    return this.store.list(includeDisabled);
  }

  listByType(type: 'cron' | 'heartbeat', includeDisabled = false): CronJob[] {
    return this.store.listByType(type, includeDisabled);
  }

  updateLastRun(id: string): void {
    this.store.updateLastRun(id);
  }

  add(input: CronJobCreate): CronJob {
    const job = this.store.add(input);
    if (this.running && job.enabled && job.type !== 'heartbeat') {
      this.scheduleJob(job);
    }
    return job;
  }

  remove(id: string): boolean {
    const cron = this.schedulers.get(id);
    if (cron) {
      cron.stop();
      this.schedulers.delete(id);
    }
    return this.store.remove(id);
  }

  edit(id: string, changes: CronJobUpdate): CronJob | null {
    const updated = this.store.update(id, changes);
    if (!updated) return null;

    // If schedule changed, reschedule the croner job
    if (changes.schedule !== undefined || changes.enabled !== undefined) {
      const existing = this.schedulers.get(id);
      if (existing) {
        existing.stop();
        this.schedulers.delete(id);
      }
      if (updated.enabled && this.running) {
        this.scheduleJob(updated);
      }
    }

    return updated;
  }

  async run(id: string): Promise<string> {
    const job = this.store.get(id);
    if (!job) return `Job ${id} not found`;
    await this.executeJob(job);
    return `Job ${id} executed`;
  }

  private scheduleAll(): void {
    for (const job of this.store.list()) {
      if (job.type === 'heartbeat') continue;
      this.scheduleJob(job);
    }
  }

  private scheduleJob(job: CronJob): void {
    try {
      const cron = new Cron(job.schedule, {
        timezone: this.timezone,
      }, async () => {
        if (!this.running) return;
        await this.executeJob(job);
      });

      this.schedulers.set(job.id, cron);
      const next = cron.nextRun();
      console.log(`[Cron] Scheduled "${job.name}" (${job.schedule}) — next run: ${next?.toISOString() ?? 'unknown'}`);
    } catch (err) {
      console.warn(`[Cron] CONFIG_INVALID: Invalid schedule "${job.schedule}" for job ${job.id} —`, err instanceof Error ? err.message : err);
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    console.log(`[Cron] Triggering job: ${job.name} (${job.id})`);
    try {
      await this.onTrigger(job);
      this.store.updateLastRun(job.id);
    } catch (err) {
      console.warn(`[Cron] TOOL_EXECUTION_ERROR: Job ${job.id} failed —`, err instanceof Error ? err.message : err);
    }
  }
}

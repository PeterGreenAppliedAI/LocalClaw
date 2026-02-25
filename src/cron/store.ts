import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CronJob, CronJobCreate, CronJobUpdate } from './types.js';

export class CronStore {
  private jobs: CronJob[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  list(includeDisabled = false): CronJob[] {
    if (includeDisabled) return [...this.jobs];
    return this.jobs.filter(j => j.enabled);
  }

  get(id: string): CronJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  listByType(type: 'cron' | 'heartbeat', includeDisabled = false): CronJob[] {
    return this.jobs.filter(j => j.type === type && (includeDisabled || j.enabled));
  }

  add(input: CronJobCreate): CronJob {
    const job: CronJob = {
      ...input,
      type: input.type ?? 'cron',
      id: randomUUID().slice(0, 8),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    this.save();
    return job;
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter(j => j.id !== id);
    if (this.jobs.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  update(id: string, changes: CronJobUpdate): CronJob | null {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return null;
    if (changes.name !== undefined) job.name = changes.name;
    if (changes.schedule !== undefined) job.schedule = changes.schedule;
    if (changes.category !== undefined) job.category = changes.category;
    if (changes.message !== undefined) job.message = changes.message;
    if (changes.enabled !== undefined) job.enabled = changes.enabled;
    this.save();
    return job;
  }

  updateLastRun(id: string): void {
    const job = this.jobs.find(j => j.id === id);
    if (job) {
      job.lastRunAt = new Date().toISOString();
      this.save();
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.jobs = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.jobs = JSON.parse(data);
      // Backfill type for pre-migration jobs
      for (const job of this.jobs) {
        if (!job.type) job.type = 'cron';
      }
    } catch {
      this.jobs = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.jobs, null, 2));
    renameSync(tmp, this.filePath);
  }
}

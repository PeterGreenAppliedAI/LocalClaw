import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Task, TaskCreate, TaskUpdate, TaskFilter } from './types.js';

const DONE_LIMIT = 20;

export class TaskStore {
  private tasks: Task[] = [];

  constructor(
    private readonly filePath: string,
    private readonly markdownPath: string,
  ) {
    this.load();
  }

  list(filter?: TaskFilter): Task[] {
    let result = [...this.tasks];

    if (filter?.status) {
      result = result.filter(t => t.status === filter.status);
    } else if (!filter?.assignee && !filter?.tag) {
      // Default: show todo + in_progress
      result = result.filter(t => t.status === 'todo' || t.status === 'in_progress');
    }

    if (filter?.assignee) {
      result = result.filter(t => t.assignee === filter.assignee);
    }

    if (filter?.tag) {
      result = result.filter(t => t.tags?.includes(filter.tag!));
    }

    return result;
  }

  get(id: string): Task | undefined {
    return this.tasks.find(t => t.id === id);
  }

  add(input: TaskCreate, createdBy: 'user' | 'bot'): Task {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID().slice(0, 8),
      title: input.title,
      details: input.details,
      status: 'todo',
      priority: input.priority ?? 'medium',
      createdBy,
      assignee: input.assignee,
      dueDate: input.dueDate,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    this.save();
    return task;
  }

  update(id: string, changes: TaskUpdate): Task | null {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return null;

    if (changes.title !== undefined) task.title = changes.title;
    if (changes.details !== undefined) task.details = changes.details;
    if (changes.priority !== undefined) task.priority = changes.priority;
    if (changes.assignee !== undefined) task.assignee = changes.assignee;
    if (changes.dueDate !== undefined) task.dueDate = changes.dueDate;
    if (changes.tags !== undefined) task.tags = changes.tags;

    if (changes.status !== undefined) {
      task.status = changes.status;
      if (changes.status === 'done') {
        task.completedAt = new Date().toISOString();
      }
    }

    task.updatedAt = new Date().toISOString();
    this.save();
    return task;
  }

  remove(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(t => t.id !== id);
    if (this.tasks.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.tasks = [];
      return;
    }
    try {
      const data = readFileSync(this.filePath, 'utf-8');
      this.tasks = JSON.parse(data);
    } catch {
      this.tasks = [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.tasks, null, 2));
    renameSync(tmp, this.filePath);
    this.renderMarkdown();
  }

  private renderMarkdown(): void {
    const todo = this.tasks.filter(t => t.status === 'todo');
    const inProgress = this.tasks.filter(t => t.status === 'in_progress');
    const done = this.tasks.filter(t => t.status === 'done').slice(-DONE_LIMIT);
    const cancelled = this.tasks.filter(t => t.status === 'cancelled');

    const lines: string[] = ['# Task Board', ''];

    lines.push('## Todo');
    if (todo.length === 0) {
      lines.push('_No tasks_');
    } else {
      for (const t of todo) lines.push(this.formatTask(t, false));
    }
    lines.push('');

    lines.push('## In Progress');
    if (inProgress.length === 0) {
      lines.push('_No tasks_');
    } else {
      for (const t of inProgress) lines.push(this.formatTask(t, false));
    }
    lines.push('');

    lines.push('## Done');
    if (done.length === 0) {
      lines.push('_No tasks_');
    } else {
      for (const t of done) lines.push(this.formatTask(t, true));
    }
    lines.push('');

    lines.push('## Cancelled');
    if (cancelled.length === 0) {
      lines.push('_No tasks_');
    } else {
      for (const t of cancelled) lines.push(this.formatTask(t, true));
    }
    lines.push('');

    mkdirSync(dirname(this.markdownPath), { recursive: true });
    const tmp = this.markdownPath + '.tmp';
    writeFileSync(tmp, lines.join('\n'));
    renameSync(tmp, this.markdownPath);
  }

  private formatTask(task: Task, checked: boolean): string {
    const box = checked ? '- [x]' : '- [ ]';
    const parts = [box, task.title];

    if (task.priority === 'high') parts.push('**HIGH**');
    if (task.dueDate) parts.push(`(due: ${task.dueDate})`);
    if (task.assignee) parts.push(`@${task.assignee}`);
    if (task.tags?.length) parts.push(`[${task.tags.join(', ')}]`);
    parts.push(`\`${task.id}\``);

    return parts.join(' ');
  }
}

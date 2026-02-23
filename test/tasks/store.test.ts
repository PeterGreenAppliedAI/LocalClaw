import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../../src/tasks/store.js';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(import.meta.dirname, '..', '..', 'tmp-test-tasks');
const JSON_PATH = join(TEST_DIR, 'tasks.json');
const MD_PATH = join(TEST_DIR, 'TASKS.md');

describe('TaskStore', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a task and persists to JSON', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    const task = store.add({ title: 'Buy groceries' }, 'user');

    expect(task.id).toHaveLength(8);
    expect(task.title).toBe('Buy groceries');
    expect(task.status).toBe('todo');
    expect(task.priority).toBe('medium');
    expect(task.createdBy).toBe('user');

    // Verify JSON persistence
    expect(existsSync(JSON_PATH)).toBe(true);
    const data = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
    expect(data).toHaveLength(1);
    expect(data[0].title).toBe('Buy groceries');
  });

  it('renders TASKS.md on mutation', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    store.add({ title: 'Task A' }, 'user');

    expect(existsSync(MD_PATH)).toBe(true);
    const md = readFileSync(MD_PATH, 'utf-8');
    expect(md).toContain('# Task Board');
    expect(md).toContain('## Todo');
    expect(md).toContain('Task A');
  });

  it('lists tasks with default filter (todo + in_progress)', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    store.add({ title: 'A' }, 'user');
    const b = store.add({ title: 'B' }, 'bot');
    store.update(b.id, { status: 'done' });
    store.add({ title: 'C' }, 'user');

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map(t => t.title)).toContain('A');
    expect(list.map(t => t.title)).toContain('C');
  });

  it('filters by status', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    const a = store.add({ title: 'A' }, 'user');
    store.update(a.id, { status: 'done' });
    store.add({ title: 'B' }, 'user');

    const done = store.list({ status: 'done' });
    expect(done).toHaveLength(1);
    expect(done[0].title).toBe('A');
  });

  it('filters by assignee', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    store.add({ title: 'A', assignee: 'user' }, 'user');
    store.add({ title: 'B', assignee: 'bot' }, 'bot');

    const userTasks = store.list({ assignee: 'user' });
    expect(userTasks).toHaveLength(1);
    expect(userTasks[0].title).toBe('A');
  });

  it('filters by tag', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    store.add({ title: 'A', tags: ['work', 'urgent'] }, 'user');
    store.add({ title: 'B', tags: ['home'] }, 'user');

    const work = store.list({ tag: 'work' });
    expect(work).toHaveLength(1);
    expect(work[0].title).toBe('A');
  });

  it('updates a task', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    const task = store.add({ title: 'Original' }, 'user');

    const updated = store.update(task.id, { title: 'Modified', priority: 'high' });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Modified');
    expect(updated!.priority).toBe('high');
  });

  it('marks task done and sets completedAt', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    const task = store.add({ title: 'Finish project' }, 'user');

    const updated = store.update(task.id, { status: 'done' });
    expect(updated!.status).toBe('done');
    expect(updated!.completedAt).toBeDefined();
  });

  it('removes a task', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    const task = store.add({ title: 'Delete me' }, 'user');

    expect(store.remove(task.id)).toBe(true);
    expect(store.get(task.id)).toBeUndefined();
    expect(store.remove('nonexistent')).toBe(false);
  });

  it('returns null for update/get on nonexistent ID', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    expect(store.get('nope')).toBeUndefined();
    expect(store.update('nope', { title: 'x' })).toBeNull();
  });

  it('loads from existing JSON on construction', () => {
    const store1 = new TaskStore(JSON_PATH, MD_PATH);
    store1.add({ title: 'Persisted' }, 'user');

    // New store reads the same file
    const store2 = new TaskStore(JSON_PATH, MD_PATH);
    const tasks = store2.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Persisted');
  });

  it('renders done section with checked boxes', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    const task = store.add({ title: 'Completed task' }, 'user');
    store.update(task.id, { status: 'done' });

    const md = readFileSync(MD_PATH, 'utf-8');
    expect(md).toContain('- [x] Completed task');
  });

  it('renders high priority and due date', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);
    store.add({ title: 'Urgent', priority: 'high', dueDate: '2026-03-01', assignee: 'user', tags: ['work'] }, 'user');

    const md = readFileSync(MD_PATH, 'utf-8');
    expect(md).toContain('**HIGH**');
    expect(md).toContain('(due: 2026-03-01)');
    expect(md).toContain('@user');
    expect(md).toContain('[work]');
  });

  it('limits done section to 20 items', () => {
    const store = new TaskStore(JSON_PATH, MD_PATH);

    // Add 25 tasks and mark them all done
    for (let i = 0; i < 25; i++) {
      const task = store.add({ title: `Task ${i}` }, 'bot');
      store.update(task.id, { status: 'done' });
    }

    const md = readFileSync(MD_PATH, 'utf-8');
    // Should only have 20 done items rendered
    const doneMatches = md.match(/- \[x\]/g);
    expect(doneMatches).toHaveLength(20);
  });
});

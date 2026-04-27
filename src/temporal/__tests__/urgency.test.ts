import { describe, it, expect } from 'vitest';
import {
  computeUrgencyTier,
  isEventLike,
  enrichTask,
  enrichTasks,
  getAutoActions,
  filterForModel,
  formatTaskBoard,
  enrichCalendarOutput,
} from '../urgency.js';
import type { Task } from '../../tasks/types.js';

const NOW = new Date('2026-04-26T10:00:00');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test1',
    title: 'Test task',
    status: 'todo',
    priority: 'medium',
    createdBy: 'user',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('computeUrgencyTier', () => {
  it('returns critical for overdue tasks', () => {
    const { tier, score } = computeUrgencyTier(-3, 'high', 'todo');
    expect(tier).toBe('critical');
    expect(score).toBe(12.0);
  });

  it('returns critical for tasks due today', () => {
    const { tier } = computeUrgencyTier(0, 'medium', 'todo');
    expect(tier).toBe('critical');
  });

  it('returns high for 1-3 days', () => {
    expect(computeUrgencyTier(1, 'medium', 'todo').tier).toBe('high');
    expect(computeUrgencyTier(3, 'medium', 'todo').tier).toBe('high');
  });

  it('returns medium for 4-7 days', () => {
    expect(computeUrgencyTier(4, 'medium', 'todo').tier).toBe('medium');
    expect(computeUrgencyTier(7, 'medium', 'todo').tier).toBe('medium');
  });

  it('returns low for 8-14 days', () => {
    expect(computeUrgencyTier(8, 'medium', 'todo').tier).toBe('low');
    expect(computeUrgencyTier(14, 'medium', 'todo').tier).toBe('low');
  });

  it('returns dormant for 15+ days', () => {
    expect(computeUrgencyTier(15, 'high', 'todo').tier).toBe('dormant');
    expect(computeUrgencyTier(264, 'high', 'todo').tier).toBe('dormant');
  });

  it('returns dormant for no due date (todo)', () => {
    expect(computeUrgencyTier(null, 'high', 'todo').tier).toBe('dormant');
  });

  it('returns low for no due date (in_progress)', () => {
    expect(computeUrgencyTier(null, 'high', 'in_progress').tier).toBe('low');
  });

  it('applies priority multiplier', () => {
    const high = computeUrgencyTier(2, 'high', 'todo').score;
    const med = computeUrgencyTier(2, 'medium', 'todo').score;
    const low = computeUrgencyTier(2, 'low', 'todo').score;
    expect(high).toBeGreaterThan(med);
    expect(med).toBeGreaterThan(low);
  });
});

describe('isEventLike', () => {
  it('detects event tags', () => {
    expect(isEventLike(makeTask({ tags: ['event'] }))).toBe(true);
    expect(isEventLike(makeTask({ tags: ['Meeting'] }))).toBe(true);
  });

  it('detects event title patterns', () => {
    expect(isEventLike(makeTask({ title: 'Career Fair: Tech Hiring' }))).toBe(true);
    expect(isEventLike(makeTask({ title: 'TKD Sparring Session' }))).toBe(true);
    expect(isEventLike(makeTask({ title: 'Team standup meeting' }))).toBe(true);
    expect(isEventLike(makeTask({ title: 'AI Seminar Workshop' }))).toBe(true);
  });

  it('does not match regular tasks', () => {
    expect(isEventLike(makeTask({ title: 'Follow-up on tax deadline' }))).toBe(false);
    expect(isEventLike(makeTask({ title: 'Summarize AI news' }))).toBe(false);
  });
});

describe('enrichTask', () => {
  it('marks past event as auto_complete', () => {
    const task = makeTask({ title: 'Career Fair', dueDate: '2026-04-24' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.isEvent).toBe(true);
    expect(enriched.recommendation).toBe('auto_complete');
    expect(enriched.urgencyTier).toBe('critical');
    expect(enriched.daysUntil).toBe(-2);
  });

  it('marks overdue deliverable as flag', () => {
    const task = makeTask({ title: 'Submit report', dueDate: '2026-04-23', priority: 'high' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.isEvent).toBe(false);
    expect(enriched.recommendation).toBe('flag');
  });

  it('marks stale task (7+ days overdue, todo) as auto_cancel', () => {
    const task = makeTask({ title: 'Old task', dueDate: '2026-04-10', status: 'todo' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.recommendation).toBe('auto_cancel');
  });

  it('does not auto_cancel in_progress tasks', () => {
    const task = makeTask({ title: 'Old task', dueDate: '2026-04-10', status: 'in_progress' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.recommendation).toBe('flag');
  });

  it('suppresses dormant tasks (264 days out)', () => {
    const task = makeTask({ title: 'Tax deadline', dueDate: '2027-01-15', priority: 'high' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.urgencyTier).toBe('dormant');
    expect(enriched.recommendation).toBe('suppress');
  });

  it('mentions tasks due within 3 days', () => {
    const task = makeTask({ title: 'Submit PR', dueDate: '2026-04-28', priority: 'medium' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.urgencyTier).toBe('high');
    expect(enriched.recommendation).toBe('mention');
  });

  it('mentions medium-priority tasks due within a week', () => {
    const task = makeTask({ title: 'Review docs', dueDate: '2026-05-01', priority: 'medium' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.urgencyTier).toBe('medium');
    expect(enriched.recommendation).toBe('mention');
  });

  it('suppresses low-priority tasks due in 8-14 days', () => {
    const task = makeTask({ title: 'Cleanup', dueDate: '2026-05-05', priority: 'low' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.urgencyTier).toBe('low');
    expect(enriched.recommendation).toBe('suppress');
  });

  it('mentions high-priority tasks due in 8-14 days', () => {
    const task = makeTask({ title: 'Important thing', dueDate: '2026-05-05', priority: 'high' });
    const enriched = enrichTask(task, NOW);
    expect(enriched.urgencyTier).toBe('low');
    expect(enriched.recommendation).toBe('mention');
  });
});

describe('enrichTasks', () => {
  it('sorts by score descending', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'Far out', dueDate: '2027-01-01', priority: 'high' }),
      makeTask({ id: 'b', title: 'Due today meeting', dueDate: '2026-04-26', priority: 'medium' }),
      makeTask({ id: 'c', title: 'Due in 5 days', dueDate: '2026-05-01', priority: 'medium' }),
    ];
    const enriched = enrichTasks(tasks, NOW);
    expect(enriched[0].task.id).toBe('b');
    expect(enriched[1].task.id).toBe('c');
    expect(enriched[2].task.id).toBe('a');
  });
});

describe('getAutoActions', () => {
  it('partitions auto_complete and auto_cancel', () => {
    const enriched = enrichTasks([
      makeTask({ id: 'evt', title: 'Career Fair', dueDate: '2026-04-20' }),
      makeTask({ id: 'stale', title: 'Old thing', dueDate: '2026-04-10' }),
      makeTask({ id: 'active', title: 'Submit report', dueDate: '2026-04-28' }),
    ], NOW);

    const { complete, cancel } = getAutoActions(enriched);
    expect(complete.map(t => t.id)).toContain('evt');
    expect(cancel.map(t => t.id)).toContain('stale');
    expect(complete.map(t => t.id)).not.toContain('active');
    expect(cancel.map(t => t.id)).not.toContain('active');
  });
});

describe('filterForModel', () => {
  it('removes suppressed, auto_complete, auto_cancel tasks', () => {
    const enriched = enrichTasks([
      makeTask({ id: 'show', title: 'Due tomorrow meeting', dueDate: '2026-04-27' }),
      makeTask({ id: 'hide', title: 'Tax deadline', dueDate: '2027-01-15', priority: 'high' }),
      makeTask({ id: 'past', title: 'Career Fair', dueDate: '2026-04-20' }),
    ], NOW);

    const filtered = filterForModel(enriched);
    const ids = filtered.map(e => e.task.id);
    expect(ids).toContain('show');
    expect(ids).not.toContain('hide');
    expect(ids).not.toContain('past');
  });
});

describe('formatTaskBoard', () => {
  it('formats enriched tasks with tier tags', () => {
    const enriched = filterForModel(enrichTasks([
      makeTask({ title: 'Submit PR', dueDate: '2026-04-27', priority: 'high' }),
    ], NOW));

    const output = formatTaskBoard(enriched);
    expect(output).toContain('[HIGH]');
    expect(output).toContain('Submit PR');
    expect(output).toContain('due TOMORROW');
  });

  it('returns no-tasks message for empty list', () => {
    expect(formatTaskBoard([])).toBe('No tasks need attention right now.');
  });

  it('adds NEEDS ACTION for flagged overdue deliverables', () => {
    const enriched = filterForModel(enrichTasks([
      makeTask({ title: 'Submit report', dueDate: '2026-04-23', priority: 'high' }),
    ], NOW));

    const output = formatTaskBoard(enriched);
    expect(output).toContain('NEEDS ACTION');
    expect(output).toContain('OVERDUE');
  });
});

describe('enrichCalendarOutput', () => {
  it('labels today events', () => {
    const raw = `Upcoming events (next 1 days):

- **Team Standup**
  Sat, Apr 26 9:00 AM – 9:30 AM`;

    const enriched = enrichCalendarOutput(raw, NOW);
    expect(enriched).toContain('[TODAY]');
  });

  it('labels tomorrow events', () => {
    const raw = `Upcoming events (next 2 days):

- **TKD Class**
  Sun, Apr 27 12:00 PM – 12:40 PM`;

    const enriched = enrichCalendarOutput(raw, NOW);
    expect(enriched).toContain('[TOMORROW]');
  });

  it('labels future events with day count', () => {
    const raw = `Upcoming events (next 7 days):

- **Colonoscopy**
  Tue, Apr 28 11:45 AM – 12:30 PM`;

    const enriched = enrichCalendarOutput(raw, NOW);
    expect(enriched).toContain('[in 2 days]');
  });

  it('labels past events', () => {
    const raw = `Upcoming events:

- **Career Fair**
  Fri, Apr 24 10:00 AM – 4:00 PM`;

    const enriched = enrichCalendarOutput(raw, NOW);
    expect(enriched).toContain('[PAST]');
  });

  it('leaves unparseable events unchanged', () => {
    const raw = `- **Something Weird**
  All day event`;

    const enriched = enrichCalendarOutput(raw, NOW);
    expect(enriched).toBe(raw);
  });
});

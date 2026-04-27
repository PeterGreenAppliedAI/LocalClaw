import type { Task, TaskPriority, TaskStatus } from '../tasks/types.js';

export type UrgencyTier = 'critical' | 'high' | 'medium' | 'low' | 'dormant';
export type Recommendation = 'auto_complete' | 'auto_cancel' | 'flag' | 'mention' | 'suppress';

export interface EnrichedTask {
  task: Task;
  daysUntil: number | null;
  urgencyTier: UrgencyTier;
  score: number;
  humanLabel: string;
  isEvent: boolean;
  recommendation: Recommendation;
}

const EVENT_TAGS = new Set(['event', 'meeting', 'appointment', 'class', 'call', 'conference']);
const EVENT_TITLE_RE = /\b(meeting|appointment|call|class|session|fair|conference|recital|game|match|sparring|seminar|workshop|expo|summit)\b/i;

export function isEventLike(task: Task): boolean {
  if (task.tags?.some(t => EVENT_TAGS.has(t.toLowerCase()))) return true;
  if (EVENT_TITLE_RE.test(task.title)) return true;
  return false;
}

export function computeUrgencyTier(
  daysUntil: number | null,
  priority: TaskPriority,
  status: TaskStatus,
): { tier: UrgencyTier; score: number } {
  if (daysUntil === null) {
    return status === 'in_progress'
      ? { tier: 'low', score: 3.0 }
      : { tier: 'dormant', score: 1.0 };
  }

  const mult = priority === 'high' ? 1.2 : priority === 'low' ? 0.8 : 1.0;

  if (daysUntil < 0) return { tier: 'critical', score: 10.0 * mult };
  if (daysUntil === 0) return { tier: 'critical', score: 9.0 * mult };
  if (daysUntil <= 3) return { tier: 'high', score: 7.0 * mult };
  if (daysUntil <= 7) return { tier: 'medium', score: 5.0 * mult };
  if (daysUntil <= 14) return { tier: 'low', score: 3.0 * mult };
  return { tier: 'dormant', score: 1.0 * mult };
}

function computeDaysUntil(dueDate: string | undefined, now: Date): number | null {
  if (!dueDate) return null;
  const due = new Date(dueDate + 'T00:00:00');
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((due.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
}

function computeRecommendation(
  daysUntil: number | null,
  tier: UrgencyTier,
  priority: TaskPriority,
  status: TaskStatus,
  isEvent: boolean,
): Recommendation {
  if (daysUntil !== null && daysUntil < 0) {
    // Overdue
    if (isEvent) return 'auto_complete';
    if (daysUntil <= -7 && status === 'todo') return 'auto_cancel';
    return 'flag';
  }

  if (tier === 'critical' || tier === 'high') return 'mention';
  if (tier === 'medium' && (priority === 'medium' || priority === 'high')) return 'mention';
  if (tier === 'low' && priority === 'high') return 'mention';
  return 'suppress';
}

function buildHumanLabel(daysUntil: number | null, tier: UrgencyTier, isEvent: boolean): string {
  const type = isEvent ? 'event' : 'deliverable';
  if (daysUntil === null) return `no due date (${type})`;
  if (daysUntil < -1) return `OVERDUE by ${Math.abs(daysUntil)} days (${tier}) -- ${type}`;
  if (daysUntil === -1) return `OVERDUE by 1 day (${tier}) -- ${type}`;
  if (daysUntil === 0) return `due TODAY (${tier}) -- ${type}`;
  if (daysUntil === 1) return `due TOMORROW (${tier}) -- ${type}`;
  if (daysUntil <= 7) return `due in ${daysUntil} days (${tier}) -- ${type}`;
  if (daysUntil <= 14) return `due in ${daysUntil} days (${tier}) -- ${type}`;
  return `due in ${daysUntil} days (dormant) -- ${type}`;
}

export function enrichTask(task: Task, now: Date): EnrichedTask {
  const daysUntil = computeDaysUntil(task.dueDate, now);
  const isEvent = isEventLike(task);
  const { tier, score } = computeUrgencyTier(daysUntil, task.priority, task.status);
  const recommendation = computeRecommendation(daysUntil, tier, task.priority, task.status, isEvent);
  const humanLabel = buildHumanLabel(daysUntil, tier, isEvent);

  return { task, daysUntil, urgencyTier: tier, score, humanLabel, isEvent, recommendation };
}

export function enrichTasks(tasks: Task[], now: Date): EnrichedTask[] {
  return tasks
    .map(t => enrichTask(t, now))
    .sort((a, b) => b.score - a.score);
}

export function getAutoActions(enriched: EnrichedTask[]): { complete: Task[]; cancel: Task[] } {
  const complete: Task[] = [];
  const cancel: Task[] = [];
  for (const e of enriched) {
    if (e.recommendation === 'auto_complete') complete.push(e.task);
    else if (e.recommendation === 'auto_cancel') cancel.push(e.task);
  }
  return { complete, cancel };
}

export function filterForModel(enriched: EnrichedTask[]): EnrichedTask[] {
  return enriched.filter(e =>
    e.recommendation !== 'auto_complete' &&
    e.recommendation !== 'auto_cancel' &&
    e.recommendation !== 'suppress',
  );
}

export function formatTaskBoard(enriched: EnrichedTask[]): string {
  if (enriched.length === 0) return 'No tasks need attention right now.';

  const lines = enriched.map(e => {
    const tierTag = `[${e.urgencyTier.toUpperCase()}]`;
    const action = e.recommendation === 'flag' ? ' -- NEEDS ACTION' : '';
    return `${tierTag} "${e.task.title}" -- ${e.humanLabel}${action}`;
  });

  return lines.join('\n');
}

// --- Calendar enrichment ---

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MONTH_MAP: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse "Mon, Apr 27" or "Apr 27" style dates relative to current year */
function parseLooseDate(dateStr: string, now: Date): Date | null {
  // Match patterns like "Mon, Apr 27" or "Apr 27"
  const match = dateStr.match(/(\w{3})\s+(\d{1,2})/);
  if (!match) return null;

  const month = MONTH_MAP[match[1]];
  if (month === undefined) {
    // Maybe first token was day-of-week: "Mon, Apr 27"
    const match2 = dateStr.match(/\w{3},\s+(\w{3})\s+(\d{1,2})/);
    if (!match2) return null;
    const m = MONTH_MAP[match2[1]];
    if (m === undefined) return null;
    return new Date(now.getFullYear(), m, parseInt(match2[2]));
  }

  return new Date(now.getFullYear(), month, parseInt(match[2]));
}

function daysBetween(now: Date, target: Date): number {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((targetStart.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
}

function relativeLabel(days: number): string {
  if (days < 0) return 'PAST';
  if (days === 0) return 'TODAY';
  if (days === 1) return 'TOMORROW';
  return `in ${days} days`;
}

export function enrichCalendarOutput(rawText: string, now: Date): string {
  // Match event blocks: "- **Title**\n  Day, Mon DD" or "- **Title**\n  Mon DD"
  return rawText.replace(
    /- \*\*([^*]+)\*\*\n(\s+)(\w{3},?\s+\w{3}\s+\d{1,2}|\w{3}\s+\d{1,2})/g,
    (match, title, indent, datePrefix) => {
      const eventDate = parseLooseDate(datePrefix, now);
      if (!eventDate) return match;

      const days = daysBetween(now, eventDate);
      const label = relativeLabel(days);
      return `- **${title}** [${label}]\n${indent}${datePrefix}`;
    },
  );
}

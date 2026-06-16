/**
 * General execution overview computed from the flat metrics log (data/metrics.jsonl).
 * Unlike the plan-pipeline ExecutionMetricsStore (which only records `multi` runs), this
 * covers EVERY dispatch / tool call / router classification across all categories — the
 * "is everything healthy" view for the console.
 */
import { readFileSync } from 'node:fs';

interface CategoryStat {
  category: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  abortRate: number;
}

export interface MetricsOverview {
  totalDispatches: number;
  avgDispatchMs: number;
  p95DispatchMs: number;
  abortCount: number;
  maxIterCount: number;
  routerAvgMs: number;
  toolCalls: number;
  toolSuccessRate: number;
  narrationRepairs: number;
  byCategory: CategoryStat[];
  topFailedTools: Array<{ tool: string; failCount: number }>;
  dailyDispatches: Array<{ date: string; count: number }>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function computeMetricsOverview(path: string, days: number): MetricsOverview {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const dispatchDurations: number[] = [];
  const perCategory = new Map<string, { durations: number[]; aborts: number }>();
  const dailyCounts = new Map<string, number>();
  const routerDurations: number[] = [];
  const failedTools = new Map<string, number>();
  let abortCount = 0;
  let maxIterCount = 0;
  let toolCalls = 0;
  let toolSuccesses = 0;
  let narrationRepairs = 0;

  let raw = '';
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return emptyOverview();
  }

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (e.category === 'test') continue; // strip test-suite noise

    switch (e.type) {
      case 'dispatch': {
        const cat = typeof e.category === 'string' ? e.category : 'unknown';
        const ms = typeof e.durationMs === 'number' ? e.durationMs : 0;
        dispatchDurations.push(ms);
        const day = new Date(ts).toISOString().slice(0, 10);
        dailyCounts.set(day, (dailyCounts.get(day) ?? 0) + 1);
        const c = perCategory.get(cat) ?? { durations: [], aborts: 0 };
        c.durations.push(ms);
        if (e.abortReason) { c.aborts++; abortCount++; }
        if (e.hitMaxIterations) maxIterCount++;
        perCategory.set(cat, c);
        break;
      }
      case 'router':
        if (typeof e.durationMs === 'number') routerDurations.push(e.durationMs);
        break;
      case 'tool_call': {
        toolCalls++;
        if (e.success) toolSuccesses++;
        else if (typeof e.tool === 'string') failedTools.set(e.tool, (failedTools.get(e.tool) ?? 0) + 1);
        break;
      }
      case 'narration_repair':
        narrationRepairs++;
        break;
    }
  }

  const sortedDispatch = [...dispatchDurations].sort((a, b) => a - b);
  const sortedRouter = [...routerDurations].sort((a, b) => a - b);
  const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0;

  const byCategory: CategoryStat[] = [...perCategory.entries()]
    .map(([category, c]) => {
      const sorted = [...c.durations].sort((a, b) => a - b);
      return {
        category,
        count: c.durations.length,
        avgMs: avg(c.durations),
        p95Ms: percentile(sorted, 95),
        abortRate: c.durations.length ? c.aborts / c.durations.length : 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    totalDispatches: dispatchDurations.length,
    avgDispatchMs: avg(dispatchDurations),
    p95DispatchMs: percentile(sortedDispatch, 95),
    abortCount,
    maxIterCount,
    routerAvgMs: avg(sortedRouter),
    toolCalls,
    toolSuccessRate: toolCalls ? toolSuccesses / toolCalls : 0,
    narrationRepairs,
    byCategory,
    topFailedTools: [...failedTools.entries()]
      .map(([tool, failCount]) => ({ tool, failCount }))
      .sort((a, b) => b.failCount - a.failCount)
      .slice(0, 8),
    dailyDispatches: [...dailyCounts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function emptyOverview(): MetricsOverview {
  return {
    totalDispatches: 0, avgDispatchMs: 0, p95DispatchMs: 0, abortCount: 0, maxIterCount: 0,
    routerAvgMs: 0, toolCalls: 0, toolSuccessRate: 0, narrationRepairs: 0,
    byCategory: [], topFailedTools: [], dailyDispatches: [],
  };
}

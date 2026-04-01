import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ErrorLearningEntry {
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  error: string;
  step: number;
  category: string;
}

/**
 * ErrorLearningStore — append-only JSONL store for tool execution errors.
 *
 * Records structured error data when tools fail so future tool calls can
 * be hinted with past failure context. Storage:
 *   <workspace>/.learnings/errors.jsonl
 */
export class ErrorLearningStore {
  private readonly filePath: string;
  private cache: ErrorLearningEntry[] | null = null;
  private cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(workspacePath: string) {
    const dir = join(workspacePath, '.learnings');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'errors.jsonl');
  }

  /** Append a structured error entry to the JSONL file. */
  recordError(entry: Omit<ErrorLearningEntry, 'timestamp'>): void {
    const full: ErrorLearningEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    try {
      appendFileSync(this.filePath, JSON.stringify(full) + '\n');
      this.cache = null; // invalidate
    } catch (err) {
      console.warn('[Learnings] Failed to record error:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Find hints from past errors matching this tool + similar params.
   * Returns human-readable hint strings, most recent first.
   */
  findHints(tool: string, params: Record<string, unknown>, limit = 3): string[] {
    const entries = this.loadAll();
    const paramKeys = new Set(Object.keys(params));

    // Match: same tool name + at least one overlapping param key
    const matches = entries
      .filter(e => e.tool === tool && Object.keys(e.params).some(k => paramKeys.has(k)))
      .slice(-limit * 2) // take recent entries, then deduplicate
      .reverse();

    // Deduplicate by error message (keep first = most recent)
    const seen = new Set<string>();
    const hints: string[] = [];
    for (const m of matches) {
      const key = m.error.slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push(`Past error with ${m.tool}: ${m.error.slice(0, 150)}`);
      if (hints.length >= limit) break;
    }

    return hints;
  }

  /** Count entries matching a tool + error substring. Used by promotion pipeline. */
  countByPattern(tool: string, errorSubstring: string): number {
    const normalized = errorSubstring.toLowerCase();
    return this.loadAll().filter(
      e => e.tool === tool && e.error.toLowerCase().includes(normalized),
    ).length;
  }

  /** Load all entries from disk (cached with 60s TTL). */
  loadAll(): ErrorLearningEntry[] {
    const now = Date.now();
    if (this.cache && now - this.cacheLoadedAt < ErrorLearningStore.CACHE_TTL_MS) {
      return this.cache;
    }

    if (!existsSync(this.filePath)) {
      this.cache = [];
      this.cacheLoadedAt = now;
      return this.cache;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const entries: ErrorLearningEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Skip corrupt lines
        }
      }
      this.cache = entries;
      this.cacheLoadedAt = now;
      return entries;
    } catch (err) {
      console.warn('[Learnings] Failed to load errors:', err instanceof Error ? err.message : err);
      this.cache = [];
      this.cacheLoadedAt = now;
      return this.cache;
    }
  }
}

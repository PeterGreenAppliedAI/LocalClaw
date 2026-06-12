/**
 * Sliding window rate limiter — per-user message throttling.
 * Extracted from orchestrator.
 */

const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX = 10; // max messages per window

export class RateLimiter {
  private limits = new Map<string, number[]>();
  private windowMs: number;
  private max: number;

  constructor(windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX) {
    this.windowMs = windowMs;
    this.max = max;
  }

  /** Check if a user is rate limited. Also records the current message. */
  isLimited(userId: string): boolean {
    const now = Date.now();
    const timestamps = this.limits.get(userId) ?? [];
    const recent = timestamps.filter(t => now - t < this.windowMs);
    recent.push(now);
    this.limits.set(userId, recent);
    return recent.length > this.max;
  }
}

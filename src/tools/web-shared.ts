export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  insertedAt: number;
}

// Keys are used VERBATIM — callers normalize as appropriate for their key type.
// Search queries are case-insensitive (use normalizeCacheKey); URLs are case-SENSITIVE
// on path/query (use normalizeUrlKey) so https://x.com/Foo and /foo don't collide.
export function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  const now = Date.now();
  cache.set(key, {
    value,
    expiresAt: now + ttlMs,
    insertedAt: now,
  });
}

/** Search-query key: case-insensitive. */
export function normalizeCacheKey(value: string): string {
  return value.toLowerCase().trim();
}

/** URL key: trim only — preserve case on path/query (those are case-sensitive). */
export function normalizeUrlKey(url: string): string {
  return url.trim();
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      controller.abort(signal.reason);
    });
  }

  // Clean up timeout when signal aborts naturally
  controller.signal.addEventListener('abort', () => clearTimeout(timeout));

  return controller.signal;
}

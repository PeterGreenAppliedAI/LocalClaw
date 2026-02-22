export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  insertedAt: number;
}

export function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(normalizeCacheKey(key));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(normalizeCacheKey(key));
    return null;
  }
  return entry.value;
}

export function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  const now = Date.now();
  cache.set(normalizeCacheKey(key), {
    value,
    expiresAt: now + ttlMs,
    insertedAt: now,
  });
}

export function normalizeCacheKey(value: string): string {
  return value.toLowerCase().trim();
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

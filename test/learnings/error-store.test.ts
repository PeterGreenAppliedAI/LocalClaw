import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ErrorLearningStore } from '../../src/learnings/error-store.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join('test', '_tmp_error_store');

describe('ErrorLearningStore', () => {
  let store: ErrorLearningStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new ErrorLearningStore(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('starts empty', () => {
    expect(store.loadAll()).toEqual([]);
  });

  it('records and loads errors', () => {
    store.recordError({ tool: 'web_search', params: { query: 'test' }, error: 'timeout', step: 1, category: 'web_search' });
    store.recordError({ tool: 'exec', params: { command: 'ls' }, error: 'permission denied', step: 2, category: 'exec' });

    const entries = store.loadAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe('web_search');
    expect(entries[0].error).toBe('timeout');
    expect(entries[1].tool).toBe('exec');
    expect(entries[1].timestamp).toBeTruthy();
  });

  it('findHints matches by tool name + overlapping params', () => {
    store.recordError({ tool: 'web_search', params: { query: 'news' }, error: 'rate limited', step: 1, category: 'web_search' });
    store.recordError({ tool: 'web_fetch', params: { url: 'http://x.com' }, error: '403 forbidden', step: 2, category: 'web_search' });

    const hints = store.findHints('web_search', { query: 'AI news' });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('rate limited');

    // No match for different tool
    const noHints = store.findHints('browser', { action: 'click' });
    expect(noHints).toHaveLength(0);
  });

  it('findHints deduplicates by error message', () => {
    for (let i = 0; i < 5; i++) {
      store.recordError({ tool: 'exec', params: { command: 'ls' }, error: 'permission denied', step: 1, category: 'exec' });
    }
    const hints = store.findHints('exec', { command: 'ls' });
    expect(hints).toHaveLength(1); // deduped
  });

  it('countByPattern counts matching entries', () => {
    store.recordError({ tool: 'exec', params: {}, error: 'permission denied /etc/hosts', step: 1, category: 'exec' });
    store.recordError({ tool: 'exec', params: {}, error: 'permission denied /etc/passwd', step: 2, category: 'exec' });
    store.recordError({ tool: 'exec', params: {}, error: 'file not found', step: 3, category: 'exec' });

    expect(store.countByPattern('exec', 'permission denied')).toBe(2);
    expect(store.countByPattern('exec', 'file not found')).toBe(1);
    expect(store.countByPattern('web_search', 'permission denied')).toBe(0);
  });

  it('handles corrupt JSONL lines gracefully', async () => {
    const { appendFileSync } = await import('node:fs');
    const filePath = join(TEST_DIR, '.learnings', 'errors.jsonl');
    appendFileSync(filePath, '{"tool":"valid","params":{},"error":"ok","step":1,"category":"exec","timestamp":"2026-01-01"}\n');
    appendFileSync(filePath, 'NOT JSON\n');
    appendFileSync(filePath, '{"tool":"also_valid","params":{},"error":"ok2","step":2,"category":"exec","timestamp":"2026-01-02"}\n');

    // Force cache invalidation
    const freshStore = new ErrorLearningStore(TEST_DIR);
    const entries = freshStore.loadAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe('valid');
    expect(entries[1].tool).toBe('also_valid');
  });
});

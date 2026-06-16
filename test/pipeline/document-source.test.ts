import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadDocSource, saveDocSource, detectAppendIntent } from '../../src/pipeline/definitions/document-source.js';

const SOURCE_DIR = 'data/media/documents/sources';

function storeFile(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  return join(SOURCE_DIR, `${safe}.json`);
}

describe('document source store', () => {
  const keys: string[] = [];
  afterEach(() => {
    for (const k of keys) {
      const p = storeFile(k);
      if (existsSync(p)) rmSync(p);
    }
    keys.length = 0;
  });

  it('round-trips saved markdown by session', () => {
    const key = 'test:doc:roundtrip';
    keys.push(key);
    saveDocSource(key, { slug: 'my-report', title: 'My Report', markdown: '# My Report\n\nBody.' });
    const loaded = loadDocSource(key);
    expect(loaded?.title).toBe('My Report');
    expect(loaded?.slug).toBe('my-report');
    expect(loaded?.markdown).toContain('Body.');
  });

  it('returns undefined when no prior document exists', () => {
    expect(loadDocSource('test:doc:never-written')).toBeUndefined();
  });

  it('overwrites prior version (append builds on latest)', () => {
    const key = 'test:doc:overwrite';
    keys.push(key);
    saveDocSource(key, { slug: 's', title: 'T', markdown: '# T\n\nv1' });
    saveDocSource(key, { slug: 's', title: 'T', markdown: '# T\n\nv1\n\n## Added\n\nv2' });
    expect(loadDocSource(key)?.markdown).toContain('## Added');
  });

  it('isolates documents across sessions', () => {
    const a = 'test:doc:sessA';
    const b = 'test:doc:sessB';
    keys.push(a, b);
    saveDocSource(a, { slug: 'a', title: 'A', markdown: '# A' });
    expect(loadDocSource(b)).toBeUndefined();
    expect(loadDocSource(a)?.title).toBe('A');
  });
});

describe('detectAppendIntent', () => {
  it('never appends when there is no prior document', () => {
    expect(detectAppendIntent('add a section on security to it', false)).toBe(false);
  });

  it('detects "is there anything we can add to it?"', () => {
    expect(detectAppendIntent('is there anything we can add to it?', true)).toBe(true);
  });

  it('detects "add a section about supply chain to the report"', () => {
    expect(detectAppendIntent('add a section about supply chain to the report', true)).toBe(true);
  });

  it('detects "update the pdf with the new numbers"', () => {
    expect(detectAppendIntent('update the pdf with the new numbers', true)).toBe(true);
  });

  it('treats a fresh paste as create even when a prior doc exists', () => {
    const paste = 'Quarterly Results\n\nRevenue was up 12% with strong margins across all units...';
    expect(detectAppendIntent(paste, true)).toBe(false);
  });

  it('does not append without a back-reference even with an add verb', () => {
    // "add" present but nothing pointing at an existing artifact → create.
    expect(detectAppendIntent('add headers and clean formatting please', true)).toBe(false);
  });
});

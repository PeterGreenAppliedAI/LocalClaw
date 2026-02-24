import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chunkText, chunkMarkdown, chunkCSV, chunkDocument } from '../../src/knowledge/chunker.js';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB = 'data/test-knowledge.db';
const TEST_DIR = 'data/test-knowledge-files';

describe('chunkText', () => {
  it('splits text on paragraph breaks', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, { maxChunkSize: 30, overlapSize: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain('First paragraph');
  });

  it('merges small paragraphs up to maxChunkSize', () => {
    const text = 'A.\n\nB.\n\nC.';
    const chunks = chunkText(text, { maxChunkSize: 100, overlapSize: 5 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('A.');
    expect(chunks[0].text).toContain('C.');
  });

  it('includes overlap from previous chunk', () => {
    const text = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50) + '\n\n' + 'C'.repeat(50);
    const chunks = chunkText(text, { maxChunkSize: 60, overlapSize: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should contain overlap from first
    if (chunks.length > 1) {
      expect(chunks[1].text.length).toBeGreaterThan(50);
    }
  });

  it('returns empty array for empty text', () => {
    expect(chunkText('', { maxChunkSize: 100, overlapSize: 10 })).toEqual([]);
  });
});

describe('chunkMarkdown', () => {
  it('respects headers', () => {
    const md = '## Introduction\n\nSome intro text.\n\n## Details\n\nSome details.';
    const chunks = chunkMarkdown(md, { maxChunkSize: 50, overlapSize: 5 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].text).toContain('## Introduction');
    expect(chunks[1].text).toContain('## Details');
  });

  it('prepends heading to each chunk', () => {
    const md = '## Section A\n\nContent A here.\n\n## Section B\n\nContent B here.';
    const chunks = chunkMarkdown(md, { maxChunkSize: 200, overlapSize: 5 });
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^##/);
    }
  });
});

describe('chunkCSV', () => {
  it('prepends header to each chunk', () => {
    const csv = 'name,age\nAlice,30\nBob,25\nCarol,35\nDave,40';
    const chunks = chunkCSV(csv, { maxChunkSize: 30, overlapSize: 0 });
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^name,age/);
    }
  });

  it('groups rows within maxChunkSize', () => {
    const csv = 'id,value\n1,a\n2,b\n3,c';
    const chunks = chunkCSV(csv, { maxChunkSize: 500, overlapSize: 0 });
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('3,c');
  });

  it('returns empty for header-only CSV', () => {
    const csv = 'name,age';
    expect(chunkCSV(csv, { maxChunkSize: 100, overlapSize: 0 })).toEqual([]);
  });
});

describe('chunkDocument', () => {
  it('routes .csv to chunkCSV', () => {
    const csv = 'a,b\n1,2\n3,4';
    const chunks = chunkDocument(csv, 'data.csv');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('routes .md to chunkMarkdown', () => {
    const md = '## Title\n\nContent here.';
    const chunks = chunkDocument(md, 'doc.md');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('## Title');
  });

  it('routes .txt to chunkText', () => {
    const txt = 'Hello.\n\nWorld.';
    const chunks = chunkDocument(txt, 'notes.txt');
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('EmbeddingStore source filtering', () => {
  let store: EmbeddingStore;

  beforeEach(() => {
    mkdirSync('data', { recursive: true });
    store = new EmbeddingStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    try { rmSync(TEST_DB); } catch { /* ignore */ }
  });

  const makeEmbedding = (val: number) => Array(384).fill(val);

  it('filters by source=knowledge', () => {
    store.add({ id: 'k1', text: 'Knowledge fact', file: 'doc.md', section: 'chunk-1', embedding: makeEmbedding(1), savedAt: new Date().toISOString(), source: 'knowledge' });
    store.add({ id: 'm1', text: 'Memory fact', file: 'MEMORY.md', section: 'saved', embedding: makeEmbedding(1), savedAt: new Date().toISOString(), source: 'memory' });

    const knowledgeOnly = store.search(makeEmbedding(1), 10, 0, 'knowledge');
    expect(knowledgeOnly.length).toBe(1);
    expect(knowledgeOnly[0].text).toBe('Knowledge fact');
  });

  it('filters by source=memory', () => {
    store.add({ id: 'k1', text: 'Knowledge fact', file: 'doc.md', section: 'chunk-1', embedding: makeEmbedding(1), savedAt: new Date().toISOString(), source: 'knowledge' });
    store.add({ id: 'm1', text: 'Memory fact', file: 'MEMORY.md', section: 'saved', embedding: makeEmbedding(1), savedAt: new Date().toISOString(), source: 'memory' });

    const memoryOnly = store.search(makeEmbedding(1), 10, 0, 'memory');
    expect(memoryOnly.length).toBe(1);
    expect(memoryOnly[0].text).toBe('Memory fact');
  });

  it('returns all when source is undefined or "all"', () => {
    store.add({ id: 'k1', text: 'Knowledge fact', file: 'doc.md', section: 'chunk-1', embedding: makeEmbedding(1), savedAt: new Date().toISOString(), source: 'knowledge' });
    store.add({ id: 'm1', text: 'Memory fact', file: 'MEMORY.md', section: 'saved', embedding: makeEmbedding(1), savedAt: new Date().toISOString(), source: 'memory' });

    const all = store.search(makeEmbedding(1), 10, 0);
    expect(all.length).toBe(2);

    const allExplicit = store.search(makeEmbedding(1), 10, 0, 'all');
    expect(allExplicit.length).toBe(2);
  });
});

describe('knowledge_import tool - path security', () => {
  it('rejects path traversal', async () => {
    const { createKnowledgeImportTool } = await import('../../src/tools/knowledge-import.js');
    const mockClient = { embed: vi.fn() } as any;
    const tool = createKnowledgeImportTool('/workspace', mockClient);
    const result = await tool.execute({ path: '../../etc/passwd' }, { agentId: 'test', sessionKey: 'test' });
    expect(result).toContain('Error');
  });
});

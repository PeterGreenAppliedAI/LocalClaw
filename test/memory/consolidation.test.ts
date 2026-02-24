import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseConsolidationResponse, checkForDuplicates, consolidateMemory } from '../../src/memory/consolidation.js';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_DB = 'data/test-consolidation.db';

describe('parseConsolidationResponse', () => {
  it('parses REPLACE action', () => {
    const result = parseConsolidationResponse('ACTION: REPLACE');
    expect(result.action).toBe('REPLACE');
    expect(result.mergedText).toBeUndefined();
  });

  it('parses KEEP_SEPARATE action', () => {
    const result = parseConsolidationResponse('ACTION: KEEP_SEPARATE');
    expect(result.action).toBe('KEEP_SEPARATE');
  });

  it('parses MERGE action with merged text', () => {
    const result = parseConsolidationResponse('ACTION: MERGE\nMERGED: User is Tadeu, a software developer');
    expect(result.action).toBe('MERGE');
    expect(result.mergedText).toBe('User is Tadeu, a software developer');
  });

  it('falls back to KEEP_SEPARATE on MERGE without merged text', () => {
    const result = parseConsolidationResponse('ACTION: MERGE\n');
    expect(result.action).toBe('KEEP_SEPARATE');
  });

  it('falls back to KEEP_SEPARATE on garbled output', () => {
    const result = parseConsolidationResponse('I think these should be merged somehow...');
    expect(result.action).toBe('KEEP_SEPARATE');
  });

  it('falls back to KEEP_SEPARATE on empty string', () => {
    const result = parseConsolidationResponse('');
    expect(result.action).toBe('KEEP_SEPARATE');
  });

  it('handles case-insensitive action', () => {
    const result = parseConsolidationResponse('ACTION: replace');
    expect(result.action).toBe('REPLACE');
  });
});

describe('EmbeddingStore - findSimilar, update, delete', () => {
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

  it('findSimilar returns entries above threshold', () => {
    store.add({
      id: 'e1',
      text: 'User name is Tadeu',
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    // Same embedding → similarity = 1.0
    const results = store.findSimilar(makeEmbedding(1), 0.85);
    expect(results.length).toBe(1);
    expect(results[0].text).toBe('User name is Tadeu');
  });

  it('findSimilar returns empty array below threshold', () => {
    store.add({
      id: 'e1',
      text: 'User name is Tadeu',
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    // Very different embedding
    const differentEmb = Array(384).fill(0).map((_, i) => i % 2 === 0 ? 1 : -1);
    const results = store.findSimilar(differentEmb, 0.99);
    expect(results.length).toBe(0);
  });

  it('update changes text and embedding', () => {
    store.add({
      id: 'e1',
      text: 'Old text',
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    store.update('e1', 'Updated text', makeEmbedding(0.5));

    const results = store.search(makeEmbedding(0.5), 1, 0);
    expect(results[0].text).toBe('Updated text');
  });

  it('delete removes entry', () => {
    store.add({
      id: 'e1',
      text: 'To be deleted',
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    expect(store.count()).toBe(1);
    store.delete('e1');
    expect(store.count()).toBe(0);
  });

  it('source column migration adds column', () => {
    // Store was already created with migration — verify source works
    store.add({
      id: 'e1',
      text: 'Knowledge entry',
      file: 'doc.md',
      section: 'chunk-1',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'knowledge',
    });

    store.add({
      id: 'e2',
      text: 'Memory entry',
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    const knowledgeOnly = store.search(makeEmbedding(1), 10, 0, 'knowledge');
    expect(knowledgeOnly.length).toBe(1);
    expect(knowledgeOnly[0].source).toBeUndefined(); // source not on MemorySearchResult yet but in DB

    const all = store.search(makeEmbedding(1), 10, 0);
    expect(all.length).toBe(2);
  });
});

describe('consolidateMemory', () => {
  let store: EmbeddingStore;

  const mockClient = {
    chat: vi.fn(),
    chatStream: vi.fn(),
    generate: vi.fn(),
    embed: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
  } as any;

  beforeEach(() => {
    mkdirSync('data', { recursive: true });
    store = new EmbeddingStore(TEST_DB);
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.close();
    try { rmSync(TEST_DB); } catch { /* ignore */ }
  });

  const makeEmbedding = (val: number) => Array(384).fill(val);

  it('returns KEEP_SEPARATE when no similar entries exist', async () => {
    const result = await consolidateMemory(
      store, mockClient, 'phi4-mini', 'new text', makeEmbedding(1), 0.85,
    );
    expect(result.action).toBe('KEEP_SEPARATE');
    expect(mockClient.chat).not.toHaveBeenCalled();
  });

  it('deletes old entry on REPLACE', async () => {
    store.add({
      id: 'existing1',
      text: "User's name is Tadeu",
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    mockClient.chat.mockResolvedValue({
      message: { content: 'ACTION: REPLACE' },
    });

    const result = await consolidateMemory(
      store, mockClient, 'phi4-mini', "User's name is Tadeu", makeEmbedding(1), 0.85,
    );

    expect(result.action).toBe('REPLACE');
    expect(store.count()).toBe(0); // old entry deleted
  });

  it('updates entry on MERGE', async () => {
    store.add({
      id: 'existing1',
      text: "User's name is Tadeu",
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    mockClient.chat.mockResolvedValue({
      message: { content: 'ACTION: MERGE\nMERGED: User is Tadeu, a developer from Brazil' },
    });
    mockClient.embed.mockResolvedValue([[0.5, 0.5]]);

    const result = await consolidateMemory(
      store, mockClient, 'phi4-mini', 'Tadeu is a developer from Brazil', makeEmbedding(1), 0.85,
    );

    expect(result.action).toBe('MERGE');
    expect(result.mergedText).toBe('User is Tadeu, a developer from Brazil');
    expect(store.count()).toBe(1); // still 1 entry, but updated
  });

  it('falls back to KEEP_SEPARATE on LLM error', async () => {
    store.add({
      id: 'existing1',
      text: "User's name is Tadeu",
      file: 'MEMORY.md',
      section: 'saved',
      embedding: makeEmbedding(1),
      savedAt: new Date().toISOString(),
      source: 'memory',
    });

    mockClient.chat.mockRejectedValue(new Error('connection refused'));

    const result = await consolidateMemory(
      store, mockClient, 'phi4-mini', "User's name is Tadeu", makeEmbedding(1), 0.85,
    );

    expect(result.action).toBe('KEEP_SEPARATE');
    expect(store.count()).toBe(1); // unchanged
  });
});

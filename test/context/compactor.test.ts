import { describe, it, expect, vi, beforeEach } from 'vitest';
import { estimateTokens, estimateMessagesTokens } from '../../src/context/tokens.js';
import { computeBudget } from '../../src/context/budget.js';
import { trimToolLoopMessages } from '../../src/tool-loop/engine.js';
import { buildCompactedHistory } from '../../src/context/compactor.js';
import type { OllamaMessage } from '../../src/ollama/types.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import { SessionStore } from '../../src/sessions/store.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Token estimation ----

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens as ceil(length / 3.5)', () => {
    const text = 'Hello, world!'; // 13 chars → ceil(13/3.5) = ceil(3.71) = 4
    expect(estimateTokens(text)).toBe(4);
  });

  it('handles long text', () => {
    const text = 'a'.repeat(1000); // 1000 chars → ceil(1000/3.5) = 286
    expect(estimateTokens(text)).toBe(286);
  });
});

describe('estimateMessagesTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('accounts for per-message overhead', () => {
    const messages: OllamaMessage[] = [
      { role: 'user', content: '' },
    ];
    // empty content (0 tokens) + 4 overhead = 4
    expect(estimateMessagesTokens(messages)).toBe(4);
  });

  it('sums multiple messages', () => {
    const messages: OllamaMessage[] = [
      { role: 'user', content: 'Hello' },     // ceil(5/3.5)=2 + 4 = 6
      { role: 'assistant', content: 'Hi!' },   // ceil(3/3.5)=1 + 4 = 5
    ];
    expect(estimateMessagesTokens(messages)).toBe(11);
  });
});

// ---- Budget ----

describe('computeBudget', () => {
  it('computes historyBudget correctly', () => {
    const budget = computeBudget({
      contextSize: 32768,
      systemPrompt: 'You are helpful.',       // 16 chars → ~5 tokens
      workspaceContext: '',
      currentMessage: 'Hi',                   // 2 chars → ~1 token
      outputReserve: 4096,
    });

    expect(budget.totalTokens).toBe(32768);
    expect(budget.outputReserve).toBe(4096);
    // historyBudget = 32768 - systemTokens - currentMsgTokens - 4096 - 256
    expect(budget.historyBudget).toBeGreaterThan(0);
    expect(budget.historyBudget).toBeLessThan(32768);
  });

  it('clamps historyBudget to 0 when budget is exhausted', () => {
    const budget = computeBudget({
      contextSize: 100,
      systemPrompt: 'a'.repeat(500),
      workspaceContext: '',
      currentMessage: 'test',
      outputReserve: 100,
    });

    expect(budget.historyBudget).toBe(0);
  });
});

// ---- Tool loop trimming ----

describe('trimToolLoopMessages', () => {
  it('does nothing when under budget', () => {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const originalContent = messages.map(m => m.content);
    trimToolLoopMessages(messages, 32768);
    expect(messages.map(m => m.content)).toEqual(originalContent);
  });

  it('truncates older tool messages when over budget', () => {
    const longObservation = 'x'.repeat(10000);
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'query' },
      { role: 'assistant', content: 'let me search' },
      { role: 'tool', content: longObservation },             // old — should be trimmed
      { role: 'assistant', content: 'found something' },
      { role: 'tool', content: longObservation },             // old — should be trimmed
      { role: 'assistant', content: 'let me search more' },   // recent — protected
      { role: 'tool', content: longObservation },             // recent — protected
      { role: 'assistant', content: 'here is the answer' },   // recent — protected
      { role: 'tool', content: longObservation },             // recent — protected
    ];

    // Use a small context size to force trimming
    trimToolLoopMessages(messages, 2000);

    // Older tool messages (indices 3, 5) should be truncated
    expect(messages[3].content).toContain('[Truncated:');
    expect(messages[5].content).toContain('[Truncated:');
    // Recent tool messages (indices 7, 9) should be preserved
    expect(messages[7].content).toBe(longObservation);
    expect(messages[9].content).toBe(longObservation);
  });

  it('preserves system message untouched', () => {
    const messages: OllamaMessage[] = [
      { role: 'system', content: 'a'.repeat(5000) },
      { role: 'tool', content: 'x'.repeat(5000) },
      { role: 'assistant', content: 'done' },
      { role: 'tool', content: 'y'.repeat(5000) },
    ];

    trimToolLoopMessages(messages, 1000);
    // System message should never be trimmed
    expect(messages[0].content).toBe('a'.repeat(5000));
  });
});

// ---- History compaction ----

describe('buildCompactedHistory', () => {
  const testDir = '/tmp/localclaw-test-compactor-' + Date.now();
  const workspacePath = join(testDir, 'workspace');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(workspacePath), { recursive: true });
  });

  function createMockClient(summaryResponse: string, factsResponse = 'No notable facts.'): OllamaClient {
    return {
      chat: vi.fn().mockImplementation(async (params: { messages: OllamaMessage[] }) => {
        const userMsg = params.messages.find(m => m.role === 'user')?.content ?? '';
        // Fact extraction call includes "extract key facts" in system prompt
        const systemMsg = params.messages.find(m => m.role === 'system')?.content ?? '';
        if (systemMsg.includes('fact extractor')) {
          return { message: { role: 'assistant', content: factsResponse } };
        }
        return { message: { role: 'assistant', content: summaryResponse } };
      }),
      generate: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;
  }

  it('returns all messages when under budget', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    // Add a few short turns
    store.appendTurn('main', 'test', { role: 'user', content: 'Hi', timestamp: new Date().toISOString() });
    store.appendTurn('main', 'test', { role: 'assistant', content: 'Hello!', timestamp: new Date().toISOString() });

    const client = createMockClient('summary');
    const result = await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test',
      budgetTokens: 10000, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content).toBe('Hi');
  });

  it('compacts when over budget', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    // Add many long turns to exceed budget
    for (let i = 0; i < 20; i++) {
      store.appendTurn('main', 'test', {
        role: 'user',
        content: `Question ${i}: ${'context '.repeat(100)}`,
        timestamp: new Date().toISOString(),
      });
      store.appendTurn('main', 'test', {
        role: 'assistant',
        content: `Answer ${i}: ${'explanation '.repeat(100)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const client = createMockClient('The user asked 20 questions about various topics.');
    const result = await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test',
      budgetTokens: 500, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    expect(result.compacted).toBe(true);
    // Should have summary message + recent turns
    expect(result.messages[0].content).toContain('[Prior conversation summary]');
    // Recent turns should be at most recentTurnsToKeep
    expect(result.messages.length).toBeLessThanOrEqual(7); // 1 summary + 6 recent
  });

  it('saves summary to disk after compaction', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    for (let i = 0; i < 20; i++) {
      store.appendTurn('main', 'test', {
        role: 'user',
        content: `Q${i}: ${'x'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
      store.appendTurn('main', 'test', {
        role: 'assistant',
        content: `A${i}: ${'y'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const client = createMockClient('Summary of conversation.');
    await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test',
      budgetTokens: 500, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    const summary = store.loadSummary('main', 'test');
    expect(summary).not.toBeNull();
    expect(summary!.text).toBe('Summary of conversation.');
    expect(summary!.model).toBe('test-model');
  });

  it('flushes facts to MEMORY.md when compacting', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    for (let i = 0; i < 20; i++) {
      store.appendTurn('main', 'test', {
        role: 'user',
        content: `Q${i}: ${'x'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
      store.appendTurn('main', 'test', {
        role: 'assistant',
        content: `A${i}: ${'y'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const facts = '- User prefers dark mode\n- User name is Alice';
    const client = createMockClient('Summary text.', facts);
    await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test',
      budgetTokens: 500, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    const memoryPath = join(workspacePath, 'MEMORY.md');
    expect(existsSync(memoryPath)).toBe(true);
    const memoryContent = readFileSync(memoryPath, 'utf-8');
    expect(memoryContent).toContain('User prefers dark mode');
    expect(memoryContent).toContain('User name is Alice');
  });

  it('deduplicates facts when flushing to MEMORY.md', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    for (let i = 0; i < 20; i++) {
      store.appendTurn('main', 'test', {
        role: 'user',
        content: `Q${i}: ${'x'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
      store.appendTurn('main', 'test', {
        role: 'assistant',
        content: `A${i}: ${'y'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const facts = '- User prefers dark mode\n- User name is Alice';
    const client = createMockClient('Summary text.', facts);

    // First compaction — writes facts
    await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test',
      budgetTokens: 500, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    // Clear summary so second compaction re-processes same archive
    store.saveSummary('main', 'test', null as any);

    // Second compaction with same facts — should NOT duplicate
    await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test2',
      budgetTokens: 500, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    const memoryPath = join(workspacePath, 'MEMORY.md');
    const content = readFileSync(memoryPath, 'utf-8');
    const darkModeCount = (content.match(/User prefers dark mode/g) || []).length;
    const aliceCount = (content.match(/User name is Alice/g) || []).length;
    expect(darkModeCount).toBe(1);
    expect(aliceCount).toBe(1);
  });

  it('returns empty messages for empty transcript', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    const client = createMockClient('summary');

    const result = await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'empty',
      budgetTokens: 10000, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(0);
  });

  it('falls back to recent turns when summary generation fails', async () => {
    const store = new SessionStore(join(testDir, 'sessions'));
    for (let i = 0; i < 20; i++) {
      store.appendTurn('main', 'test', {
        role: 'user',
        content: `Q${i}: ${'x'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
      store.appendTurn('main', 'test', {
        role: 'assistant',
        content: `A${i}: ${'y'.repeat(200)}`,
        timestamp: new Date().toISOString(),
      });
    }

    const client = {
      chat: vi.fn().mockRejectedValue(new Error('model unavailable')),
      generate: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const result = await buildCompactedHistory({
      store, client, agentId: 'main', sessionKey: 'test',
      budgetTokens: 500, recentTurnsToKeep: 6,
      model: 'test-model', workspacePath,
    });

    // Should still return something — fallback to recent turns
    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThanOrEqual(6);
  });
});

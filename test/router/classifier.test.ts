import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMessage } from '../../src/router/classifier.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { RouterConfig } from '../../src/config/types.js';

function createMockClient(response: string): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue({ response }),
    chat: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
  } as unknown as OllamaClient;
}

function createFailingClient(): OllamaClient {
  return {
    generate: vi.fn().mockRejectedValue(new Error('timeout')),
    chat: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
  } as unknown as OllamaClient;
}

const defaultConfig: RouterConfig = {
  model: 'phi4-mini',
  timeout: 2000,
  defaultCategory: 'chat',
  categories: {
    chat: { description: 'Conversation' },
    web_search: { description: 'Web search' },
    memory: { description: 'Memory' },
    exec: { description: 'Exec' },
    cron: { description: 'Cron' },
    message: { description: 'Message' },
    website: { description: 'Website' },
    multi: { description: 'Multi' },
  },
};

describe('classifyMessage', () => {
  it('returns model category when valid', async () => {
    const client = createMockClient('web_search');
    const result = await classifyMessage(client, defaultConfig, 'What is the latest AI news?');
    expect(result.category).toBe('web_search');
    expect(result.confidence).toBe('model');
  });

  it('strips whitespace and non-alpha from model output', async () => {
    const client = createMockClient('  web_search\n');
    const result = await classifyMessage(client, defaultConfig, 'search something');
    expect(result.category).toBe('web_search');
    expect(result.confidence).toBe('model');
  });

  it('falls back to keyword heuristics on invalid model output', async () => {
    const client = createMockClient('I think this is a web search request.');
    const result = await classifyMessage(client, defaultConfig, 'search for the latest news');
    expect(result.category).toBe('web_search');
    expect(result.confidence).toBe('keyword');
  });

  it('falls back to keyword heuristics on timeout', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'remind me at 5pm');
    expect(result.category).toBe('cron');
    expect(result.confidence).toBe('keyword');
  });

  it('falls back to defaultCategory when no keyword match', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'hey how are you');
    expect(result.category).toBe('chat');
    expect(result.confidence).toBe('fallback');
  });

  it('keyword: detects exec patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'install numpy with pip');
    expect(result.category).toBe('exec');
    expect(result.confidence).toBe('keyword');
  });

  it('keyword: detects memory patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'what did we discuss yesterday');
    expect(result.category).toBe('memory');
    expect(result.confidence).toBe('keyword');
  });

  it('keyword: detects message patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'tell the team about the release');
    expect(result.category).toBe('message');
    expect(result.confidence).toBe('keyword');
  });

  it('keyword: detects website patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'what homework is due');
    expect(result.category).toBe('website');
    expect(result.confidence).toBe('keyword');
  });
});

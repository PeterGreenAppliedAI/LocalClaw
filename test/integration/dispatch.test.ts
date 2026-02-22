import { describe, it, expect, vi } from 'vitest';
import { dispatchMessage } from '../../src/dispatch.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { LocalClawConfig } from '../../src/config/types.js';
import { loadConfig } from '../../src/config/loader.js';

function createMockClient(routerCategory: string, specialistAnswer: string): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue({ response: routerCategory }),
    chat: vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: specialistAnswer, tool_calls: null },
    }),
    listModels: vi.fn().mockResolvedValue([]),
    isAvailable: vi.fn().mockResolvedValue(true),
  } as unknown as OllamaClient;
}

describe('dispatchMessage', () => {
  it('routes to chat category and returns answer', async () => {
    const client = createMockClient('chat', 'Hello! Nice to meet you.');
    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'Hey there!',
    });

    expect(result.category).toBe('chat');
    expect(result.answer).toBeTruthy();
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it('routes to web_search with configured specialist', async () => {
    const client = createMockClient('web_search', 'Here are the latest AI developments...');
    const config = loadConfig('/tmp/nonexistent-config.json5');

    // Add specialist config with tools
    config.specialists.web_search = {
      model: 'test-model',
      maxTokens: 4096,
      temperature: 0.3,
      maxIterations: 5,
      tools: ['web_search'],
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'web_search',
      description: 'Search',
      parameterDescription: 'query',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
      category: 'web_search',
      execute: async () => 'mock results',
    });

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'Latest AI news',
    });

    expect(result.category).toBe('web_search');
    expect(result.classification.confidence).toBe('model');
  });

  it('falls back to chat when router returns garbage', async () => {
    const client: OllamaClient = {
      generate: vi.fn().mockResolvedValue({ response: 'I think this is a greeting' }),
      chat: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Hello there!', tool_calls: null },
      }),
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'yo',
    });

    // Should fall back to chat (default) since router output is garbage
    expect(result.category).toBe('chat');
    expect(result.classification.confidence).toBe('fallback');
  });

  it('uses keyword heuristic when router fails', async () => {
    const client: OllamaClient = {
      generate: vi.fn().mockRejectedValue(new Error('model not found')),
      chat: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Search results...', tool_calls: null },
      }),
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.web_search = {
      model: 'test',
      maxTokens: 1024,
      temperature: 0.3,
      maxIterations: 3,
      tools: [],
    };
    const registry = new ToolRegistry();

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'search for the latest news about AI',
    });

    expect(result.category).toBe('web_search');
    expect(result.classification.confidence).toBe('keyword');
  });

  it('passes history to specialist', async () => {
    const chatFn = vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'response', tool_calls: null },
    });

    const client: OllamaClient = {
      generate: vi.fn().mockResolvedValue({ response: 'chat' }),
      chat: chatFn,
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    await dispatchMessage({
      client,
      registry,
      config,
      message: 'follow up',
      history: [
        { role: 'user', content: 'previous message' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });

    // Verify chat was called with history messages
    const chatCall = chatFn.mock.calls[0][0];
    expect(chatCall.messages.length).toBeGreaterThan(2);
  });
});

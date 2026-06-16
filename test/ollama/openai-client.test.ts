import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatClient } from '../../src/ollama/openai-client.js';

function mockFetchOnce(body: unknown) {
  const captured: { url?: string; init?: RequestInit } = {};
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return captured;
}

function parseBody(captured: { init?: RequestInit }): any {
  return JSON.parse(captured.init?.body as string);
}

const OK_RESPONSE = {
  model: 'deepseek-v4-flash',
  choices: [{ message: { role: 'assistant', content: 'yes' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

describe('OpenAICompatClient max_tokens reasoning headroom', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds reasoning headroom to a small num_predict so reasoning cannot starve the answer', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://vllm.local');
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'does the source support this claim?' }],
      options: { num_predict: 400 },
    });
    expect(parseBody(captured).max_tokens).toBe(400 + 4096);
  });

  it('still adds headroom on top of large answer budgets', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://vllm.local');
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'write the report' }],
      options: { num_predict: 8192 },
    });
    expect(parseBody(captured).max_tokens).toBe(8192 + 4096);
  });

  it('omits max_tokens entirely when no num_predict is given', async () => {
    const captured = mockFetchOnce(OK_RESPONSE);
    const client = new OpenAICompatClient('http://vllm.local');
    await client.chat({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      options: { temperature: 0.2 },
    });
    expect(parseBody(captured).max_tokens).toBeUndefined();
  });
});

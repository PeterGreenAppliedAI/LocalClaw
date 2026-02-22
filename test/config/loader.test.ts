import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../../src/config/loader.js';

const TEST_CONFIG_PATH = '/tmp/localclaw-test-config.json5';

describe('loadConfig', () => {
  afterEach(() => {
    try { unlinkSync(TEST_CONFIG_PATH); } catch {}
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig('/tmp/nonexistent-config.json5');
    expect(config.ollama.url).toBe('http://127.0.0.1:11434');
    expect(config.router.model).toBe('phi4-mini');
    expect(config.router.defaultCategory).toBe('chat');
    expect(config.session.maxHistoryTurns).toBe(20);
  });

  it('loads and validates a JSON5 config', () => {
    writeFileSync(TEST_CONFIG_PATH, `{
      ollama: { url: "http://localhost:11434" },
      router: { model: "gemma3:4b", timeout: 3000 },
    }`);
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.ollama.url).toBe('http://localhost:11434');
    expect(config.router.model).toBe('gemma3:4b');
    expect(config.router.timeout).toBe(3000);
    // Defaults still applied
    expect(config.router.defaultCategory).toBe('chat');
  });

  it('expands ${ENV_VAR} placeholders', () => {
    process.env.TEST_LC_TOKEN = 'my-secret-token';
    writeFileSync(TEST_CONFIG_PATH, `{
      channels: {
        discord: { enabled: true, token: "\${TEST_LC_TOKEN}" }
      }
    }`);
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.channels.discord?.token).toBe('my-secret-token');
    delete process.env.TEST_LC_TOKEN;
  });

  it('strips empty env vars so defaults apply', () => {
    delete process.env.NONEXISTENT_VAR;
    writeFileSync(TEST_CONFIG_PATH, `{
      channels: {
        discord: { token: "\${NONEXISTENT_VAR}" }
      }
    }`);
    const config = loadConfig(TEST_CONFIG_PATH);
    // Empty env var becomes undefined (stripped), so Zod default kicks in
    expect(config.channels.discord?.token).toBeUndefined();
  });

  it('throws on invalid config shape', () => {
    writeFileSync(TEST_CONFIG_PATH, `{
      router: { timeout: "not-a-number" }
    }`);
    expect(() => loadConfig(TEST_CONFIG_PATH)).toThrow('Invalid config');
  });

  it('preserves specialist configurations', () => {
    writeFileSync(TEST_CONFIG_PATH, `{
      specialists: {
        chat: { model: "llama3", maxTokens: 1024, temperature: 0.9, tools: [] },
        web_search: { model: "qwen3:32b", tools: ["web_search", "web_fetch"] },
      }
    }`);
    const config = loadConfig(TEST_CONFIG_PATH);
    expect(config.specialists.chat?.model).toBe('llama3');
    expect(config.specialists.chat?.maxTokens).toBe(1024);
    expect(config.specialists.web_search?.tools).toEqual(['web_search', 'web_fetch']);
  });
});

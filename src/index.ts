import { createInterface } from 'node:readline';
import { loadConfig } from './config/loader.js';
import { OllamaClient } from './ollama/client.js';
import { ToolRegistry } from './tools/registry.js';
import { dispatchMessage } from './dispatch.js';
import { Orchestrator } from './orchestrator.js';
import { registerAllTools } from './tools/register-all.js';
import type { OllamaMessage } from './ollama/types.js';

// TLS safety: only disable cert verification if explicitly opted in
if (process.env.LOCALCLAW_UNSAFE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[LocalClaw] WARNING: TLS verification disabled (LOCALCLAW_UNSAFE_TLS=1). Do NOT use in production.');
} else if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  // Block accidental insecure TLS — must use LOCALCLAW_UNSAFE_TLS instead
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  console.warn('[LocalClaw] Removed NODE_TLS_REJECT_UNAUTHORIZED=0. Use LOCALCLAW_UNSAFE_TLS=1 if you need insecure TLS, or set NODE_EXTRA_CA_CERTS for custom CAs.');
}

async function main() {
  const config = loadConfig();

  const hasChannels = Object.values(config.channels).some(c => c.enabled);

  if (hasChannels) {
    await runOrchestrator(config);
  } else {
    await runRepl(config);
  }
}

async function runOrchestrator(config: ReturnType<typeof loadConfig>) {
  const orchestrator = new Orchestrator(config);

  // Register channel adapters (dynamic imports to avoid hard deps)
  const channelRegistry = orchestrator.getChannelRegistry();

  for (const channelId of Object.keys(config.channels)) {
    if (!config.channels[channelId]?.enabled) continue;

    try {
      switch (channelId) {
        case 'discord': {
          const { DiscordAdapter } = await import('./channels/discord/index.js');
          channelRegistry.register(new DiscordAdapter());
          break;
        }
        case 'telegram': {
          const { TelegramAdapter } = await import('./channels/telegram/index.js');
          channelRegistry.register(new TelegramAdapter());
          break;
        }
        case 'web': {
          const { WebApiAdapter } = await import('./channels/web/adapter.js');
          channelRegistry.register(new WebApiAdapter());
          break;
        }
        default:
          console.warn(`[LocalClaw] Unknown channel: ${channelId}`);
      }
    } catch (err) {
      console.error(`[LocalClaw] Failed to load ${channelId} adapter:`, err instanceof Error ? err.message : err);
    }
  }

  await orchestrator.start();

  const shutdown = async () => {
    console.log('\n[LocalClaw] Shutting down...');
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runRepl(config: ReturnType<typeof loadConfig>) {
  const client = new OllamaClient(config.ollama.url, config.ollama.keepAlive);
  const registry = new ToolRegistry();
  registerAllTools(registry, config);

  const available = await client.isAvailable();
  if (!available) {
    console.error(`[LocalClaw] Cannot reach Ollama at ${config.ollama.url}`);
    console.error('[LocalClaw] Make sure Ollama is running: ollama serve');
    process.exit(1);
  }

  const models = await client.listModels();
  console.log(`[LocalClaw] Connected to Ollama — ${models.length} model(s) available`);
  console.log(`[LocalClaw] Router model: ${config.router.model}`);
  console.log(`[LocalClaw] Specialists: ${Object.keys(config.specialists).join(', ') || '(defaults)'}`);
  console.log(`[LocalClaw] Tools: ${registry.list().join(', ') || '(none)'}`);
  console.log('[LocalClaw] Type a message (Ctrl+C to exit)\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  const history: OllamaMessage[] = [];

  rl.prompt();

  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }

    try {
      const result = await dispatchMessage({
        client,
        registry,
        config,
        message,
        history,
      });

      console.log(`\n[${result.category}/${result.classification.confidence}] (${result.iterations} step${result.iterations !== 1 ? 's' : ''})`);
      console.log(`Assistant: ${result.answer}\n`);

      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: result.answer });

      const maxTurns = config.session.maxHistoryTurns * 2;
      if (history.length > maxTurns) {
        history.splice(0, history.length - maxTurns);
      }
    } catch (err) {
      console.error(`\n[Error] ${err instanceof Error ? err.message : err}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n[LocalClaw] Goodbye!');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[LocalClaw] Fatal error:', err);
  process.exit(1);
});

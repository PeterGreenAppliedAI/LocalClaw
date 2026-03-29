#!/usr/bin/env node
/**
 * LocalClaw CLI — interactive terminal interface with streaming,
 * slash commands, markdown rendering, and session persistence.
 *
 * Usage: npx tsx src/cli/index.ts
 * Or:    npm run cli
 */

import { createInterface } from 'node:readline';
import { loadConfig } from '../config/loader.js';
import { OllamaClient } from '../ollama/client.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerAllTools } from '../tools/register-all.js';
import { SessionStore } from '../sessions/store.js';
import { PipelineRegistry } from '../pipeline/registry.js';
import { registerAllPipelines } from '../pipeline/definitions/index.js';
import { dispatchMessage } from '../dispatch.js';
import { resolveWorkspacePath } from '../agents/scope.js';
import { bootstrapWorkspace } from '../agents/workspace.js';
import { FactStore } from '../memory/fact-store.js';
import { TaskStore } from '../tasks/store.js';
import type { OllamaMessage } from '../ollama/types.js';
import { handleCommand, type CommandContext } from './commands.js';
import {
  bold, cyan, dim, green, yellow, gray, magenta,
  renderMarkdown, formatStatusBar, formatToolCall, formatError, divider,
} from './formatter.js';

async function main() {
  const config = loadConfig();
  const client = new OllamaClient(config.ollama.url, config.ollama.keepAlive);

  // Verify Ollama
  const available = await client.isAvailable();
  if (!available) {
    console.error(formatError(`Cannot reach Ollama at ${config.ollama.url}`));
    console.error(dim('Make sure Ollama is running: ollama serve'));
    process.exit(1);
  }

  // Initialize components
  const registry = new ToolRegistry();
  const sessionStore = new SessionStore(config.session.transcriptDir);
  const pipelineRegistry = new PipelineRegistry();
  registerAllPipelines(pipelineRegistry);

  const agentId = config.agents.default;
  const workspacePath = resolveWorkspacePath(agentId, config);
  bootstrapWorkspace(workspacePath);

  const factStore = new FactStore(workspacePath);
  const taskStore = new TaskStore(
    `data/tasks.json`,
    `${workspacePath}/TASKS.md`,
  );

  const { embeddingStore } = await registerAllTools(registry, config, {
    ollamaClient: client,
    taskStore,
    factStore,
  });

  const sessionKey = `cli:${agentId}`;
  const history: OllamaMessage[] = [];
  let modelOverride: string | null = null;

  // Banner
  const models = await client.listModels();
  console.log('');
  console.log(divider());
  console.log(`  ${bold(magenta('LocalClaw CLI'))}`);
  console.log(`  ${dim(`Ollama: ${config.ollama.url} — ${models.length} models`)}`);
  console.log(`  ${dim(`Router: ${config.router.model} | Agent: ${agentId}`)}`);
  console.log(`  ${dim(`Tools: ${registry.list().length} | Pipelines: ${pipelineRegistry.list().length}`)}`);
  console.log(`  ${dim('Type /help for commands, Ctrl+C to exit')}`);
  console.log(divider());
  console.log('');

  // Command context
  const cmdCtx: CommandContext = {
    client,
    config,
    sessionStore,
    registry,
    pipelineRegistry,
    agentId,
    sessionKey,
    clearHistory: () => { history.length = 0; },
    setModelOverride: (m) => { modelOverride = m; },
    get currentModelOverride() { return modelOverride; },
  };

  // Readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${green('❯')} `,
  });

  let processing = false;

  rl.prompt();

  rl.on('line', async (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }

    processing = true;

    // Slash commands
    const cmdResult = await handleCommand(message, cmdCtx);
    if (cmdResult) {
      console.log('');
      console.log(cmdResult.output);
      console.log('');
      processing = false;
      rl.prompt();
      return;
    }

    // Research shortcut
    if (message.toLowerCase().startsWith('/research ')) {
      const topic = message.slice('/research '.length).trim();
      if (!topic) {
        console.log(formatError('Usage: /research <topic>'));
        rl.prompt();
        return;
      }
      // Route to research pipeline
      console.log(dim(`\n  Researching: ${topic}...\n`));
      try {
        const result = await dispatchMessage({
          client,
          registry,
          config,
          message: `[RESEARCH PIPELINE]\nArtifact type: memo\nTopic: ${topic}\nOutput slug: ${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}\nCurrent date: ${new Date().toISOString().split('T')[0]}\n\nProduce a research deck on this topic.`,
          agentId,
          sessionKey,
          history,
          sessionStore,
          overrideCategory: 'research',
          sourceContext: { channel: 'cli', channelId: 'cli', senderId: 'cli-user' },
          factStore,
          pipelineRegistry,
        });

        console.log(formatStatusBar({
          model: result.classification.category === 'research' ? config.specialists.research?.model ?? '?' : '?',
          category: result.category,
          confidence: result.classification.confidence,
          iterations: result.iterations,
        }));
        console.log('');
        console.log(renderMarkdown(result.answer));
        console.log('');
      } catch (err) {
        console.log(formatError(err instanceof Error ? err.message : String(err)));
      }
      rl.prompt();
      return;
    }

    // Regular message dispatch
    try {
      // Show thinking indicator
      process.stdout.write(dim('\n  Thinking...'));

      let streamStarted = false;
      const onStream = (delta: string) => {
        if (!streamStarted) {
          // Clear "Thinking..." and start streaming
          process.stdout.write('\r\x1b[K');
          streamStarted = true;
        }
        process.stdout.write(delta);
      };

      const result = await dispatchMessage({
        client,
        registry,
        config,
        message,
        agentId,
        sessionKey,
        history,
        sessionStore,
        sourceContext: { channel: 'cli', channelId: 'cli', senderId: 'cli-user' },
        onStream,
        modelOverride: modelOverride ?? undefined,
        factStore,
        pipelineRegistry,
      });

      if (!streamStarted) {
        // No streaming happened — clear thinking indicator and print result
        process.stdout.write('\r\x1b[K');
      }

      // Status bar
      const specialist = config.specialists[result.category];
      console.log('');
      console.log(formatStatusBar({
        model: modelOverride ?? specialist?.model ?? config.router.model,
        category: result.category,
        confidence: result.classification.confidence,
        iterations: result.iterations,
      }));

      // Show tool calls if any
      if (result.steps && result.steps.length > 0) {
        for (const step of result.steps) {
          if (step.tool) {
            console.log(formatToolCall(step.tool, step.params));
          }
        }
      }

      // Print response (skip if already streamed)
      if (!streamStarted) {
        console.log('');
        console.log(renderMarkdown(result.answer));
      }
      console.log('');

      // Update history
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: result.answer });

      const maxTurns = config.session.maxHistoryTurns * 2;
      if (history.length > maxTurns) {
        history.splice(0, history.length - maxTurns);
      }
    } catch (err) {
      process.stdout.write('\r\x1b[K');
      console.log('');
      console.log(formatError(err instanceof Error ? err.message : String(err)));
      console.log('');
    }

    processing = false;
    rl.prompt();
  });

  rl.on('close', async () => {
    // Wait for any pending async command to finish
    if (processing) {
      await new Promise<void>(resolve => {
        const check = setInterval(() => {
          if (!processing) { clearInterval(check); resolve(); }
        }, 100);
      });
    }
    console.log(dim('\n  Goodbye!\n'));
    process.exit(0);
  });
}

main().catch(err => {
  console.error(formatError(`Fatal: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});

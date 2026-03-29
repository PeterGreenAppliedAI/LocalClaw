/**
 * CLI slash command handlers.
 * Each command returns a string response (or null to suppress output).
 */

import type { OllamaClient } from '../ollama/client.js';
import type { LocalClawConfig } from '../config/types.js';
import type { SessionStore } from '../sessions/store.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PipelineRegistry } from '../pipeline/registry.js';
import { clearWorkspaceCache } from '../dispatch.js';
import { bold, cyan, dim, green, yellow, red, divider, formatSuccess } from './formatter.js';

export interface CommandContext {
  client: OllamaClient;
  config: LocalClawConfig;
  sessionStore: SessionStore;
  registry: ToolRegistry;
  pipelineRegistry: PipelineRegistry;
  agentId: string;
  sessionKey: string;
  /** Callback to clear the in-memory history */
  clearHistory: () => void;
  /** Callback to switch the active model */
  setModelOverride: (model: string | null) => void;
  currentModelOverride: string | null;
}

export interface CommandResult {
  output: string;
  /** If true, don't add to conversation history */
  ephemeral?: boolean;
}

type CommandHandler = (args: string, ctx: CommandContext) => Promise<CommandResult>;

const commands: Record<string, { handler: CommandHandler; description: string }> = {
  help: {
    description: 'Show available commands',
    handler: async () => ({
      ephemeral: true,
      output: [
        bold('LocalClaw CLI Commands'),
        '',
        `  ${cyan('/reset')}          Clear session and start fresh`,
        `  ${cyan('/status')}         Show system status (models, tools, channels)`,
        `  ${cyan('/model')} ${dim('<name>')}   Switch model (e.g., /model qwen3.5:9b)`,
        `  ${cyan('/model')}          Show current model`,
        `  ${cyan('/tools')}          List registered tools`,
        `  ${cyan('/pipelines')}      List registered pipelines`,
        `  ${cyan('/tasks')}          Show task board`,
        `  ${cyan('/sessions')}       List recent sessions`,
        `  ${cyan('/research')} ${dim('<topic>')}  Run a research pipeline`,
        `  ${cyan('/compress')}       Manually trigger context compression`,
        `  ${cyan('/help')}           This message`,
        '',
        dim('Regular messages are dispatched through the router → specialist pipeline.'),
      ].join('\n'),
    }),
  },

  reset: {
    description: 'Clear session',
    handler: async (_args, ctx) => {
      ctx.sessionStore.clearSession(ctx.agentId, ctx.sessionKey);
      clearWorkspaceCache(ctx.sessionKey);
      ctx.clearHistory();
      return { output: formatSuccess('Session cleared. Starting fresh.'), ephemeral: true };
    },
  },

  status: {
    description: 'System status',
    handler: async (_args, ctx) => {
      const available = await ctx.client.isAvailable();
      const models = available ? await ctx.client.listModels() : [];

      const lines = [
        bold('System Status'),
        '',
        `  Ollama:     ${available ? green('connected') : red('unreachable')}`,
        `  Models:     ${models.length}`,
        `  Tools:      ${ctx.registry.list().length}`,
        `  Pipelines:  ${ctx.pipelineRegistry.list().length}`,
        `  Router:     ${ctx.config.router.model}`,
        `  Agent:      ${ctx.agentId}`,
        `  Session:    ${ctx.sessionKey}`,
      ];

      if (ctx.currentModelOverride) {
        lines.push(`  Override:   ${yellow(ctx.currentModelOverride)}`);
      }

      const specialists = Object.entries(ctx.config.specialists);
      if (specialists.length > 0) {
        lines.push('');
        lines.push(bold('Specialists'));
        for (const [cat, spec] of specialists) {
          const pipeline = (spec as any).pipeline ? ` ${dim(`→ ${(spec as any).pipeline}`)}` : '';
          lines.push(`  ${cyan(cat.padEnd(12))} ${spec.model}${pipeline}`);
        }
      }

      return { output: lines.join('\n'), ephemeral: true };
    },
  },

  model: {
    description: 'Switch or show model',
    handler: async (args, ctx) => {
      if (!args) {
        const override = ctx.currentModelOverride;
        const chatModel = ctx.config.specialists.chat?.model ?? 'default';
        return {
          output: override
            ? `Current model override: ${yellow(override)} (default: ${dim(chatModel)})`
            : `Using default model: ${chatModel}. Use ${cyan('/model <name>')} to override.`,
          ephemeral: true,
        };
      }

      if (args === 'reset' || args === 'default') {
        ctx.setModelOverride(null);
        return { output: formatSuccess('Model override cleared. Using defaults.'), ephemeral: true };
      }

      ctx.setModelOverride(args);
      return { output: formatSuccess(`Model override set to: ${bold(args)}`), ephemeral: true };
    },
  },

  tools: {
    description: 'List tools',
    handler: async (_args, ctx) => {
      const tools = ctx.registry.list();
      if (tools.length === 0) return { output: 'No tools registered.', ephemeral: true };

      const lines = [bold('Registered Tools'), ''];
      for (const name of tools) {
        lines.push(`  ${green('•')} ${name}`);
      }
      return { output: lines.join('\n'), ephemeral: true };
    },
  },

  pipelines: {
    description: 'List pipelines',
    handler: async (_args, ctx) => {
      const pipelines = ctx.pipelineRegistry.list();
      if (pipelines.length === 0) return { output: 'No pipelines registered.', ephemeral: true };

      const lines = [bold('Registered Pipelines'), ''];
      for (const name of pipelines) {
        lines.push(`  ${green('•')} ${name}`);
      }
      return { output: lines.join('\n'), ephemeral: true };
    },
  },

  tasks: {
    description: 'Show task board',
    handler: async (_args, ctx) => {
      try {
        const result = await ctx.registry.createExecutor()('task_list', {}, {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          workspacePath: `data/workspaces/${ctx.agentId}`,
        });
        return { output: result || 'No tasks found.', ephemeral: true };
      } catch {
        return { output: red('Task list unavailable.'), ephemeral: true };
      }
    },
  },

  sessions: {
    description: 'List sessions',
    handler: async (_args, ctx) => {
      try {
        const sessions = ctx.sessionStore.listSessions(ctx.agentId);
        if (sessions.length === 0) return { output: 'No sessions found.', ephemeral: true };

        const lines = [bold('Sessions'), ''];
        for (const s of sessions.slice(0, 10)) {
          lines.push(`  ${dim('•')} ${s}`);
        }
        if (sessions.length > 10) {
          lines.push(dim(`  ... and ${sessions.length - 10} more`));
        }
        return { output: lines.join('\n'), ephemeral: true };
      } catch {
        return { output: red('Could not list sessions.'), ephemeral: true };
      }
    },
  },

  compress: {
    description: 'Trigger context compression',
    handler: async (_args, _ctx) => {
      return { output: formatSuccess('Compression will trigger on next message if context exceeds 50% budget.'), ephemeral: true };
    },
  },
};

/**
 * Try to handle a message as a slash command.
 * Returns null if the message is not a command.
 */
export async function handleCommand(
  input: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const cmd = commands[name];
  if (!cmd) {
    return {
      output: `Unknown command: ${red('/' + name)}. Type ${cyan('/help')} for available commands.`,
      ephemeral: true,
    };
  }

  return cmd.handler(args, ctx);
}

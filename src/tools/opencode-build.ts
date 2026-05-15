import type { LocalClawTool, ToolContext } from './types.js';
import type { z } from 'zod';
import type { OpenCodeConfigSchema } from '../config/schema.js';

type OpenCodeConfig = z.infer<typeof OpenCodeConfigSchema>;

let serverInstance: { url: string; close: () => void } | null = null;
let clientInstance: any = null;

/**
 * Start the OpenCode headless server if not already running.
 * Returns the SDK client.
 */
async function getClient(config: OpenCodeConfig): Promise<any> {
  if (clientInstance) return clientInstance;

  const { createOpencodeServer, createOpencodeClient } = await import('@opencode-ai/sdk');
  const baseUrl = `http://${config.hostname}:${config.port}`;

  // Check if server is already running (user started it manually or from a previous run)
  try {
    const health = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
    if (health.ok || health.status === 200) {
      console.log(`[OpenCode] Connected to existing server at ${baseUrl}`);
      clientInstance = createOpencodeClient({ baseUrl, signal: AbortSignal.timeout(600_000) });
      return clientInstance;
    }
  } catch {
    // Server not running — start one
  }

  try {
    console.log(`[OpenCode] Starting server on port ${config.port}...`);
    serverInstance = await createOpencodeServer({
      port: config.port,
      hostname: config.hostname,
    });
    console.log(`[OpenCode] Server running at ${serverInstance.url}`);
    clientInstance = createOpencodeClient({ baseUrl: serverInstance.url, signal: AbortSignal.timeout(600_000) });
    return clientInstance;
  } catch (err) {
    throw new Error(`OpenCode server failed to start: ${err instanceof Error ? err.message : err}`);
  }
}

export function createOpenCodeBuildTool(config: OpenCodeConfig): LocalClawTool {
  return {
    name: 'opencode_build',
    description: `Start a coding task using OpenCode AI coding agent. OpenCode will read, write, and edit files to implement the requested feature or project.
WHEN TO USE: User asks to build, scaffold, implement, or write code for a project or feature.
Returns a session ID and summary of what was built.`,
    parameterDescription: 'prompt (required): Description of what to build. model (optional): Model to use (default: config default).',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of what to build' },
        model: { type: 'string', description: 'Model to use (e.g., ollama/qwen3-coder:30b)' },
      },
      required: ['prompt'],
    },
    category: 'code',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const prompt = params.prompt as string;
      if (!prompt?.trim()) return 'Error: prompt is required';

      const model = (params.model as string) || config.defaultModel;

      // Ensure builds directory exists
      const { mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const workspace = ctx.workspacePath ?? 'data/workspaces/main';
      const buildsDir = join(workspace, 'builds');
      mkdirSync(buildsDir, { recursive: true });

      try {
        const client = await getClient(config);

        // Create a new session
        const session = await client.session.create({
          body: {},
        });

        const sessionId = session.data?.id;
        if (!sessionId) return 'Error: failed to create OpenCode session';

        console.log(`[OpenCode] Session ${sessionId} created, sending prompt...`);

        // Parse model string "ollama/qwen3-coder:30b" → { providerID, modelID }
        const [providerID, modelID] = model.includes('/') ? model.split('/', 2) : ['ollama', model];

        // Send the prompt with directory constraint
        const fullPrompt = `IMPORTANT: Create ALL files inside the directory "${buildsDir}". Do NOT modify any files outside this directory. Do NOT modify README.md or any existing project files.\n\n${prompt}`;
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text', text: fullPrompt }],
            model: { providerID, modelID },
          },
        });

        console.log(`[OpenCode] Task completed in session ${sessionId}`);

        // List files created in builds directory
        const { readdirSync, statSync, readFileSync } = await import('node:fs');
        const listFiles = (dir: string, prefix = ''): string[] => {
          const entries: string[] = [];
          try {
            for (const f of readdirSync(dir)) {
              if (f.startsWith('.') || f === 'node_modules' || f === '__pycache__') continue;
              const full = join(dir, f);
              const rel = prefix ? `${prefix}/${f}` : f;
              if (statSync(full).isDirectory()) {
                entries.push(...listFiles(full, rel));
              } else {
                entries.push(rel);
              }
            }
          } catch { /* best-effort */ }
          return entries;
        };

        const files = listFiles(buildsDir);

        // Build concise summary — file list with sizes, no content dumps
        const parts = [`OpenCode build complete (session: ${sessionId})`, '', `Files created (${files.length}):`];
        for (const f of files.slice(0, 15)) {
          const fullPath = join(buildsDir, f);
          try {
            const size = statSync(fullPath).size;
            parts.push(`  ${f} (${size} bytes)`);
          } catch {
            parts.push(`  ${f}`);
          }
        }
        parts.push('', `Build directory: ${buildsDir}`, 'Build complete. All files are ready.');

        return parts.join('\n');
      } catch (err) {
        return `OpenCode build failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

export function createOpenCodeStatusTool(config: OpenCodeConfig): LocalClawTool {
  return {
    name: 'opencode_status',
    description: 'Check the status of an OpenCode coding task. Returns current progress, messages, and file changes.',
    parameterDescription: 'sessionId (required): The session ID returned by opencode_build.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'OpenCode session ID' },
      },
      required: ['sessionId'],
    },
    category: 'code',

    async execute(params: Record<string, unknown>): Promise<string> {
      const sessionId = params.sessionId as string;
      if (!sessionId) return 'Error: sessionId is required';

      try {
        const client = await getClient(config);

        // Status is a global map of sessionId → {type: "idle"|"retry"}
        const statusResp = await client.session.status({});
        const statusMap = statusResp.data ?? {};
        const sessionStatus = statusMap[sessionId];
        const statusText = sessionStatus?.type ?? 'complete'; // absent from map = done

        // Get messages for summary
        const messages = await client.session.messages({
          path: { id: sessionId },
        });

        const msgList = messages.data ?? [];
        const lastMessages = msgList.slice(-5);
        const summary = lastMessages
          .map((m: any) => {
            const parts = m.parts ?? [];
            const text = parts.map((p: any) => {
              if (p.type === 'text') return p.text?.slice(0, 150) ?? '';
              if (p.type === 'tool-invocation') return `[tool: ${p.toolInvocation?.toolName ?? 'unknown'}]`;
              return `[${p.type}]`;
            }).join(' ');
            return `[${m.role}] ${text.slice(0, 200)}`;
          })
          .join('\n');

        // Count file operations from messages
        const toolCalls = msgList.flatMap((m: any) =>
          (m.parts ?? []).filter((p: any) => p.type === 'tool-invocation')
        );
        const fileOps = toolCalls.filter((t: any) =>
          ['write', 'edit', 'read'].includes(t.toolInvocation?.toolName)
        ).length;

        return `Session: ${sessionId}\nStatus: ${statusText}\nFile operations: ${fileOps}\nMessages: ${msgList.length}\nRecent activity:\n${summary || '(no messages yet)'}`;
      } catch (err) {
        return `Status check failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

/** Shutdown the OpenCode server (called on LocalClaw shutdown) */
export function shutdownOpenCode(): void {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    clientInstance = null;
    console.log('[OpenCode] Server stopped');
  }
}

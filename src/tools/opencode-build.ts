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

      const { mkdirSync, readdirSync, statSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const workspace = ctx.workspacePath ?? 'data/workspaces/main';
      const buildsDir = join(workspace, 'builds');

      // Generate a project slug from the prompt
      const slug = prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 50)
        .replace(/-+$/, '');
      const projectDir = join(buildsDir, slug);
      mkdirSync(projectDir, { recursive: true });

      // Snapshot builds root before build — so we only move new files after
      const existingBefore = new Set<string>();
      try {
        for (const f of readdirSync(buildsDir)) existingBefore.add(f);
      } catch { /* empty dir */ }

      try {
        const client = await getClient(config);

        // Create a new session
        const session = await client.session.create({
          body: {},
        });

        const sessionId = session.data?.id;
        if (!sessionId) return 'Error: failed to create OpenCode session';

        console.log(`[OpenCode] Session ${sessionId} created for project "${slug}"`);

        // Parse model string "ollama/qwen3-coder:30b" → { providerID, modelID }
        const [providerID, modelID] = model.includes('/') ? model.split('/', 2) : ['ollama', model];

        // Send the prompt — no directory constraint (OpenCode writes to its working dir)
        // Quality standards appended automatically
        const fullPrompt = [
          prompt,
          '',
          'QUALITY STANDARDS:',
          '- Create all project files in the current directory.',
          '- Tests MUST make real HTTP requests or function calls — no mocked assertions against hardcoded values.',
          '- Tests should start the server/app, make actual requests, and validate responses.',
          '- Include error case tests (invalid input, missing fields, not found).',
          '- Code should have proper error handling, not just happy path.',
          '- Include a dependency file (package.json, requirements.txt, go.mod) with correct dependencies.',
        ].join('\n');
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text', text: fullPrompt }],
            model: { providerID, modelID },
          },
        });

        console.log(`[OpenCode] Task completed in session ${sessionId}`);

        // List files — check both project dir and builds root (OpenCode writes to its CWD)
        const listFiles = (dir: string, prefix = ''): string[] => {
          const entries: string[] = [];
          try {
            for (const f of readdirSync(dir)) {
              if (f.startsWith('.') || f === 'node_modules' || f === '__pycache__' || f === 'data') continue;
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

        // Move ONLY new files (not in snapshot) into project subdirectory
        const { renameSync } = await import('node:fs');
        const afterBuild = readdirSync(buildsDir);
        const newEntries = afterBuild.filter(f =>
          !existingBefore.has(f) && !f.startsWith('.') && f !== 'data' && f !== slug
        );
        for (const f of newEntries) {
          try {
            renameSync(join(buildsDir, f), join(projectDir, f));
          } catch { /* best-effort */ }
        }

        console.log(`[OpenCode] Moved files to project directory: ${projectDir}`);

        // List files in the project directory
        const files = listFiles(projectDir);

        // Build summary with file contents preview (8000 char limit in tool loop)
        const parts = [`OpenCode build complete (session: ${sessionId}, project: ${slug})`, '', `Files created (${files.length}):`];
        let totalChars = 0;
        for (const f of files.slice(0, 10)) {
          if (f.endsWith('.lock') || f.endsWith('.log')) {
            parts.push(`  ${f} (skipped — generated file)`);
            continue;
          }
          const fullPath = join(projectDir, f);
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const preview = content.length > 600 ? content.slice(0, 600) + '\n...(truncated)' : content;
            totalChars += preview.length;
            if (totalChars > 6000) {
              parts.push(`  ${f} (${content.length} bytes — omitted for space)`);
            } else {
              parts.push(`\n--- ${f} ---\n${preview}`);
            }
          } catch {
            parts.push(`  ${f} (could not read)`);
          }
        }
        parts.push('', `Project directory: ${projectDir}`);

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

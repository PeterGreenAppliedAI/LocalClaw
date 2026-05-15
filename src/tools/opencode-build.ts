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

  try {
    const { createOpencodeServer, createOpencodeClient } = await import('@opencode-ai/sdk');

    if (!serverInstance) {
      console.log(`[OpenCode] Starting server on port ${config.port}...`);
      serverInstance = await createOpencodeServer({
        port: config.port,
        hostname: config.hostname,
      });
      console.log(`[OpenCode] Server running at ${serverInstance.url}`);
    }

    clientInstance = createOpencodeClient({ baseUrl: serverInstance.url });
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

      try {
        const client = await getClient(config);

        // Create a new session
        const session = await client.session.create({
          body: { model },
        });

        const sessionId = session.data?.id;
        if (!sessionId) return 'Error: failed to create OpenCode session';

        console.log(`[OpenCode] Session ${sessionId} created, sending prompt...`);

        // Send the prompt (async — returns immediately, OpenCode works in background)
        await client.session.promptAsync({
          path: { id: sessionId },
          body: {
            parts: [{ type: 'text', text: prompt }],
          },
        });

        console.log(`[OpenCode] Task started in session ${sessionId}`);
        return `OpenCode task started (session: ${sessionId}, model: ${model}). Use opencode_status to check progress.`;
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

        const status = await client.session.status({
          path: { id: sessionId },
        });

        const messages = await client.session.messages({
          path: { id: sessionId },
        });

        const msgList = messages.data ?? [];
        const lastMessages = msgList.slice(-3);
        const summary = lastMessages
          .map((m: any) => {
            const text = m.parts?.map((p: any) => p.text ?? p.type).join(' ') ?? '';
            return `[${m.role}] ${text.slice(0, 200)}`;
          })
          .join('\n');

        const statusText = status.data?.status ?? 'unknown';
        return `Session: ${sessionId}\nStatus: ${statusText}\nRecent activity:\n${summary || '(no messages yet)'}`;
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

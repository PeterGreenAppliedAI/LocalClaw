import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { LocalClawTool, ToolContext } from './types.js';

/**
 * Protected workspace files that the bot must never overwrite.
 * These define the agent's identity and behavior — only humans edit these.
 */
const PROTECTED_FILES = new Set([
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'AGENTS.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
]);

export function createWriteFileTool(): LocalClawTool {
  return {
    name: 'write_file',
    description: 'Write or create a file (workspace-only for safety). Cannot overwrite protected files (SOUL.md, TOOLS.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md, BOOTSTRAP.md).',
    parameterDescription: 'path (required): File path relative to workspace. content (required): File content to write.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const path = params.path as string;
      const content = params.content as string;
      if (!path) return 'Error: path parameter is required';
      if (content === undefined) return 'Error: content parameter is required';

      // Block writes to protected files
      const filename = basename(path);
      if (PROTECTED_FILES.has(filename)) {
        return `Error: ${filename} is a protected file and cannot be overwritten. Only humans can edit this file.`;
      }

      // Workspace-only path validation
      const workspace = ctx.workspacePath;
      if (!workspace) {
        return 'Error: No workspace configured — cannot write files';
      }

      const fullPath = resolve(workspace, path);
      if (!fullPath.startsWith(resolve(workspace))) {
        return 'Error: Path traversal not allowed — must write within workspace';
      }

      try {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
        return `Written to ${path}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

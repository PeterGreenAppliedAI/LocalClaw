import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocalClawTool, ToolContext } from './types.js';

const READABLE_FILES = ['TOOLS.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md'] as const;

export function createWorkspaceReadTool(): LocalClawTool {
  return {
    name: 'workspace_read',
    description: `Read a workspace file. Available files: ${READABLE_FILES.join(', ')}.`,
    parameterDescription: `file (required): Filename to read. One of: ${READABLE_FILES.join(', ')}.`,
    example: 'workspace_read[{"file": "SOUL.md"}]',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: `Workspace file to read`, enum: [...READABLE_FILES] },
      },
      required: ['file'],
    },
    category: 'config',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const file = params.file as string;
      if (!file) return 'Error: file parameter is required';

      if (!READABLE_FILES.includes(file as any)) {
        return `Error: Invalid file "${file}". Must be one of: ${READABLE_FILES.join(', ')}`;
      }

      const workspace = ctx.workspacePath;
      if (!workspace) {
        return 'Error: No workspace configured';
      }

      const fullPath = resolve(workspace, file);
      if (!fullPath.startsWith(resolve(workspace))) {
        return 'Error: Path traversal not allowed';
      }

      if (!existsSync(fullPath)) {
        return `File not found: ${file}`;
      }

      try {
        const content = readFileSync(fullPath, 'utf-8');
        return content || '(empty file)';
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

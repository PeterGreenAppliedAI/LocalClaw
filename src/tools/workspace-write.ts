import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LocalClawTool, ToolContext } from './types.js';

const WRITABLE_FILES = ['TOOLS.md', 'USER.md', 'HEARTBEAT.md'] as const;

export function createWorkspaceWriteTool(): LocalClawTool {
  return {
    name: 'workspace_write',
    description: `Write to a workspace file. Writable files: ${WRITABLE_FILES.join(', ')}. Protected files (SOUL.md, IDENTITY.md, AGENTS.md, BOOTSTRAP.md) are read-only.`,
    parameterDescription: `file (required): Filename to write. One of: ${WRITABLE_FILES.join(', ')}. content (required): New file content (full overwrite).`,
    example: 'workspace_write[{"file": "TOOLS.md", "content": "# Tools\\n\\nUpdated tool documentation..."}]',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: `Workspace file to write`, enum: [...WRITABLE_FILES] },
        content: { type: 'string', description: 'New file content (full overwrite)' },
      },
      required: ['file', 'content'],
    },
    category: 'config',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const file = params.file as string;
      const content = params.content as string;
      if (!file) return 'Error: file parameter is required';
      if (content === undefined) return 'Error: content parameter is required';

      if (!WRITABLE_FILES.includes(file as any)) {
        return `Error: "${file}" is not writable. Writable files: ${WRITABLE_FILES.join(', ')}. SOUL.md, IDENTITY.md, AGENTS.md, and BOOTSTRAP.md are protected.`;
      }

      const workspace = ctx.workspacePath;
      if (!workspace) {
        return 'Error: No workspace configured';
      }

      const fullPath = resolve(workspace, file);
      if (!fullPath.startsWith(resolve(workspace))) {
        return 'Error: Path traversal not allowed';
      }

      try {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
        return `Updated ${file}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

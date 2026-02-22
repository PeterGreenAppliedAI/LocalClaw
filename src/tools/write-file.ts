import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { LocalClawTool, ToolContext } from './types.js';

export function createWriteFileTool(): LocalClawTool {
  return {
    name: 'write_file',
    description: 'Write or create a file (workspace-only for safety)',
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

      // Workspace-only path validation
      const workspace = ctx.workspacePath;
      if (workspace) {
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
      }

      // No workspace — write to provided path
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        return `Written to ${path}`;
      } catch (err) {
        return `Error writing file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

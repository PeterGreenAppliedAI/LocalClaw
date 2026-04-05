import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LocalClawTool, ToolContext } from './types.js';

export function createReadFileTool(): LocalClawTool {
  return {
    name: 'read_file',
    description: 'Read the contents of a file within the workspace. WHEN TO USE: Need to read a file from a prior step, check artifact contents, or load data for processing. Use this instead of exec[cat]. DO NOT use exec to read files — always use read_file.',
    parameterDescription: 'path (required): File path relative to workspace. maxLines (optional): Max lines to return (default: all).',
    example: 'read_file[{"path": "src/index.ts", "maxLines": 50}]',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        maxLines: { type: 'number', description: 'Maximum number of lines to return' },
      },
      required: ['path'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const path = params.path as string;
      if (!path) return 'Error: path parameter is required';

      const workspace = ctx.workspacePath;
      if (!workspace) {
        return 'Error: No workspace configured — cannot read files';
      }

      const fullPath = resolve(workspace, path);
      if (!fullPath.startsWith(resolve(workspace))) {
        return 'Error: Path traversal not allowed — must read within workspace';
      }

      if (!existsSync(fullPath)) {
        return `File not found: ${path}`;
      }

      try {
        const stat = statSync(fullPath);
        if (stat.size > 1_000_000) {
          return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 1MB.`;
        }

        let content = readFileSync(fullPath, 'utf-8');
        const maxLines = params.maxLines as number | undefined;
        if (maxLines) {
          const lines = content.split('\n');
          content = lines.slice(0, maxLines).join('\n');
          if (lines.length > maxLines) {
            content += `\n... (${lines.length - maxLines} more lines)`;
          }
        }
        return content || '(empty file)';
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

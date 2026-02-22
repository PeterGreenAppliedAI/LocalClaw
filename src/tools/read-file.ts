import { readFileSync, existsSync, statSync } from 'node:fs';
import type { LocalClawTool } from './types.js';

export function createReadFileTool(): LocalClawTool {
  return {
    name: 'read_file',
    description: 'Read the contents of a file',
    parameterDescription: 'path (required): Absolute or relative file path. maxLines (optional): Max lines to return (default: all).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to read' },
        maxLines: { type: 'string', description: 'Maximum number of lines to return' },
      },
      required: ['path'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>): Promise<string> {
      const path = params.path as string;
      if (!path) return 'Error: path parameter is required';

      if (!existsSync(path)) {
        return `File not found: ${path}`;
      }

      try {
        const stat = statSync(path);
        if (stat.size > 1_000_000) {
          return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 1MB.`;
        }

        let content = readFileSync(path, 'utf-8');
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

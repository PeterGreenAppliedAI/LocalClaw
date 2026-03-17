import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LocalClawTool } from './types.js';

export function createMemoryGetTool(workspacePath: string): LocalClawTool {
  return {
    name: 'memory_get',
    description: 'Read the contents of a memory file',
    parameterDescription: 'file (required): Path to the file relative to workspace (e.g., "MEMORY.md" or "memory/notes.md").',
    example: 'memory_get[{"file": "memory/notes.md"}]',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the file relative to workspace (e.g., "MEMORY.md")' },
      },
      required: ['file'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>): Promise<string> {
      const file = params.file as string;
      if (!file) return 'Error: file parameter is required';

      const fullPath = resolve(join(workspacePath, file));
      // Path traversal protection
      if (!fullPath.startsWith(resolve(workspacePath))) {
        return 'Error: Path traversal not allowed';
      }

      if (!existsSync(fullPath)) {
        return `File not found: ${file}`;
      }

      try {
        return readFileSync(fullPath, 'utf-8');
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

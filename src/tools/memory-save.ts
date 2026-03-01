import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import type { LocalClawTool } from './types.js';

/**
 * Files the memory_save tool is allowed to write to.
 * Everything else is off-limits — prevents the bot from corrupting its own identity.
 */
const WRITABLE_FILES = new Set(['MEMORY.md', 'USER.md']);

/** Max size for MEMORY.md before rotation (100KB) */
const MAX_MEMORY_FILE_BYTES = 100 * 1024;

export function createMemorySaveTool(
  workspacePath: string,
): LocalClawTool {

  return {
    name: 'memory_save',
    description: 'Save content to memory. Can only write to MEMORY.md or USER.md — all other files are protected. Content is appended as markdown. Searchable via memory_search.',
    parameterDescription: 'file (required): "MEMORY.md" or "USER.md". content (required): Text to save.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Target file: "MEMORY.md" or "USER.md"', enum: ['MEMORY.md', 'USER.md'] },
        content: { type: 'string', description: 'Text content to save to memory' },
      },
      required: ['file', 'content'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>): Promise<string> {
      const file = params.file as string;
      const content = params.content as string;
      if (!file) return 'Error: file parameter is required';
      if (!content) return 'Error: content parameter is required';

      // Only allow writes to approved files
      const filename = basename(file);
      if (!WRITABLE_FILES.has(filename)) {
        return `Error: memory_save can only write to MEMORY.md or USER.md. "${filename}" is protected.`;
      }

      const fullPath = resolve(join(workspacePath, filename));
      if (!fullPath.startsWith(resolve(workspacePath))) {
        return 'Error: Path traversal not allowed';
      }

      try {
        mkdirSync(dirname(fullPath), { recursive: true });

        // Rotate MEMORY.md if it's too large — trim older entries
        if (filename === 'MEMORY.md' && existsSync(fullPath)) {
          const size = statSync(fullPath).size;
          if (size > MAX_MEMORY_FILE_BYTES) {
            const existing = readFileSync(fullPath, 'utf-8');
            const lines = existing.split('\n');
            const keepFrom = Math.floor(lines.length * 0.6);
            const trimmed = [lines[0], '', '> _Older entries trimmed. Searchable via memory_search._', '', ...lines.slice(keepFrom)].join('\n');
            writeFileSync(fullPath, trimmed);
            console.log(`[Memory] Rotated MEMORY.md: ${size} bytes → ${trimmed.length} bytes`);
          }
        }

        const timestamp = new Date().toISOString();
        const entry = `\n\n---\n_Saved: ${timestamp}_\n\n${content}`;

        if (existsSync(fullPath)) {
          appendFileSync(fullPath, entry);
        } else {
          writeFileSync(fullPath, `# ${filename}\n${entry}`);
        }

        return `Saved to ${filename}`;
      } catch (err) {
        return `Error saving: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

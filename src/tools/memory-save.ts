import { appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import { EmbeddingStore, generateEmbedding, generateMemoryId } from '../memory/embeddings.js';

export function createMemorySaveTool(
  workspacePath: string,
  ollamaClient?: OllamaClient,
): LocalClawTool {
  const embeddingStore = new EmbeddingStore();

  return {
    name: 'memory_save',
    description: 'Save content to memory (stored as markdown and indexed with embeddings for semantic search)',
    parameterDescription: 'file (required): Path relative to workspace (e.g., "MEMORY.md"). content (required): Text to save.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path relative to workspace (e.g., "MEMORY.md")' },
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

      const fullPath = resolve(join(workspacePath, file));
      if (!fullPath.startsWith(resolve(workspacePath))) {
        return 'Error: Path traversal not allowed';
      }

      try {
        mkdirSync(dirname(fullPath), { recursive: true });

        const timestamp = new Date().toISOString();
        const entry = `\n\n---\n_Saved: ${timestamp}_\n\n${content}`;

        if (existsSync(fullPath)) {
          appendFileSync(fullPath, entry);
        } else {
          writeFileSync(fullPath, `# ${file}\n${entry}`);
        }

        // Generate embedding and store in vector index
        if (ollamaClient) {
          try {
            const embedding = await generateEmbedding(ollamaClient, content);
            embeddingStore.add({
              id: generateMemoryId(),
              text: content.slice(0, 500),
              file,
              section: 'saved',
              embedding,
              savedAt: timestamp,
            });
          } catch (err) {
            console.error('[Memory] Embedding generation failed:', err instanceof Error ? err.message : err);
            // File is still saved, just not indexed
          }
        }

        return `Saved to ${file} (indexed for semantic search)`;
      } catch (err) {
        return `Error saving: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

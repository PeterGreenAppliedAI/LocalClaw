import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import { searchMarkdownFiles } from '../memory/search.js';
import { EmbeddingStore, generateEmbedding } from '../memory/embeddings.js';

export function createMemorySearchTool(
  workspacePath: string,
  ollamaClient?: OllamaClient,
): LocalClawTool {
  const embeddingStore = new EmbeddingStore();

  return {
    name: 'memory_search',
    description: 'Search through stored memories and notes using semantic similarity',
    parameterDescription: 'query (required): What to search for in memories. maxResults (optional): Max results to return (default 5).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memories' },
        maxResults: { type: 'string', description: 'Maximum number of results to return (default 5)' },
      },
      required: ['query'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = params.query as string;
      if (!query) return 'Error: query parameter is required';

      const maxResults = Number(params.maxResults) || 5;

      // Try vector search first if client is available and store has entries
      if (ollamaClient && embeddingStore.count() > 0) {
        try {
          const queryEmbedding = await generateEmbedding(ollamaClient, query);
          const vectorResults = await embeddingStore.search(queryEmbedding, maxResults);

          if (vectorResults.length > 0) {
            return vectorResults
              .map((r, i) => `${i + 1}. [${r.file}] ${r.section} (similarity: ${(r.score * 100).toFixed(1)}%)\n   ${r.text}`)
              .join('\n\n');
          }
        } catch (err) {
          console.error('[Memory] Embedding search failed, falling back to keyword:', err instanceof Error ? err.message : err);
        }
      }

      // Fallback to keyword search
      const results = searchMarkdownFiles(workspacePath, query, maxResults);

      if (results.length === 0) {
        return `No memories found matching "${query}"`;
      }

      return results
        .map((r, i) => `${i + 1}. [${r.file}] ${r.section} (score: ${r.score})\n   ${r.content}`)
        .join('\n\n');
    },
  };
}

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
    description: 'Search through stored memories and knowledge using semantic similarity. Use source filter to search only memories, only knowledge base, or all.',
    parameterDescription: 'query (required): What to search for. maxResults (optional): Max results (default 5). source (optional): "memory", "knowledge", or "all" (default "all").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memories' },
        maxResults: { type: 'string', description: 'Maximum number of results to return (default 5)' },
        source: { type: 'string', description: 'Filter by source: "memory", "knowledge", or "all"', enum: ['memory', 'knowledge', 'all'] },
      },
      required: ['query'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>): Promise<string> {
      const query = params.query as string;
      if (!query) return 'Error: query parameter is required';

      const maxResults = Number(params.maxResults) || 5;
      const source = (params.source as string) || 'all';

      // Try vector search first if client is available and store has entries
      if (ollamaClient && embeddingStore.count() > 0) {
        try {
          const queryEmbedding = await generateEmbedding(ollamaClient, query);
          const vectorResults = embeddingStore.search(
            queryEmbedding,
            maxResults,
            0.3,
            source === 'all' ? undefined : source,
          );

          if (vectorResults.length > 0) {
            return vectorResults
              .map((r, i) => `${i + 1}. [${r.file}] ${r.section} (similarity: ${(r.score * 100).toFixed(1)}%)\n   ${r.text}`)
              .join('\n\n');
          }
        } catch (err) {
          console.error('[Memory] Embedding search failed, falling back to keyword:', err instanceof Error ? err.message : err);
        }
      }

      // Fallback to keyword search (only searches workspace markdown files, so no source filter)
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

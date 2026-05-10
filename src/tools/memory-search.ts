import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import { searchMarkdownFiles } from '../memory/search.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import { generateEmbedding } from '../memory/embeddings.js';
import type { FactStore } from '../memory/fact-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';

const CATEGORY_LABELS: Record<string, string> = {
  stable: 'STABLE',
  context: 'CONTEXT',
  decision: 'DECISION',
  question: 'QUESTION',
};

export function createMemorySearchTool(
  workspacePath: string,
  ollamaClient?: OllamaClient,
  embeddingStore?: EmbeddingStore,
  factStore?: FactStore,
  graphMemory?: GraphMemoryStore,
): LocalClawTool {

  return {
    name: 'memory_search',
    description: 'Search through stored memories and knowledge base. Use source="knowledge" to search imported documents (vector search). Default searches structured fact memory first, then falls back to markdown files.',
    parameterDescription: 'query (required): What to search for. maxResults (optional): Max results (default 5). source (optional): "memory" or "knowledge" (default "memory").',
    example: 'memory_search[{"query": "user preferred programming language", "maxResults": 3}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memories' },
        maxResults: { type: 'number', description: 'Maximum number of results to return (default 5)' },
        source: { type: 'string', description: 'Filter: "memory" (structured facts + markdown) or "knowledge" (imported documents)', enum: ['memory', 'knowledge'] },
      },
      required: ['query'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>, ctx: import('./types.js').ToolContext): Promise<string> {
      const query = params.query as string;
      if (!query) return 'Error: query parameter is required';

      const maxResults = Number(params.maxResults) || 5;
      const source = (params.source as string) || 'memory';

      // Knowledge base: use vector search (embeddings from knowledge_import)
      if (source === 'knowledge' && ollamaClient && embeddingStore && embeddingStore.count() > 0) {
        try {
          const queryEmbedding = await generateEmbedding(ollamaClient, query);
          const vectorResults = embeddingStore.search(queryEmbedding, maxResults, 0.3, 'knowledge');

          if (vectorResults.length > 0) {
            return vectorResults
              .map((r, i) => `${i + 1}. [${r.file}] ${r.section} (similarity: ${(r.score * 100).toFixed(1)}%)\n   ${r.text}`)
              .join('\n\n');
          }
          return `No knowledge base results matching "${query}"`;
        } catch (err) {
          console.warn('[Memory] Knowledge search failed:', err instanceof Error ? err.message : err);
          return `Knowledge search error: ${err instanceof Error ? err.message : err}`;
        }
      }

      // Graph memory (primary): semantic search with multi-signal scoring
      if (graphMemory && ctx.senderId) {
        try {
          const results = await graphMemory.search(query, ctx.senderId, maxResults);
          if (results.length > 0) {
            const lines = results.map((r, i) =>
              `${i + 1}. [${CATEGORY_LABELS[r.category] ?? r.category}] ${r.text} (imp: ${r.importance}, score: ${r.score.toFixed(2)})`
            );
            return `Found ${results.length} memories:\n${lines.join('\n')}`;
          }
          return 'No memories found.';
        } catch (err) {
          console.warn('[Memory] Graph search failed, falling back:', err instanceof Error ? err.message : err);
        }
      }

      // Flat FactStore fallback
      if (factStore) {
        const allResults = [];

        if (ctx.senderId) {
          const userFacts = factStore.searchFacts(query, ctx.senderId, maxResults);
          allResults.push(...userFacts);
        }

        const sharedFacts = factStore.searchFacts(query, undefined, maxResults);
        allResults.push(...sharedFacts);

        const seen = new Set<string>();
        const unique = allResults.filter(f => {
          if (seen.has(f.hash)) return false;
          seen.add(f.hash);
          return true;
        }).slice(0, maxResults);

        if (unique.length > 0) {
          const lines = unique
            .map((f, i) => `${i + 1}. [${CATEGORY_LABELS[f.category] ?? f.category}] ${f.text} (conf: ${f.confidence}, src: ${f.source})`);
          return `Found ${unique.length} memories:\n${lines.join('\n')}`;
        }

        return 'No memories found.';
      }

      // Legacy: workspace markdown search
      const results = searchMarkdownFiles(workspacePath, query, maxResults);
      if (results.length === 0) return 'No memories found.';

      return results
        .map((r, i) => `${i + 1}. [${r.file}] ${r.section} (score: ${r.score})\n   ${r.content}`)
        .join('\n\n');
    },
  };
}

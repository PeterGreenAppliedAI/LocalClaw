import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import { searchMarkdownFiles } from '../memory/search.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import { generateEmbedding } from '../memory/embeddings.js';
import type { FactStore } from '../memory/fact-store.js';

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
): LocalClawTool {

  return {
    name: 'memory_search',
    description: 'Search through stored memories and knowledge base. Use source="knowledge" to search imported documents (vector search). Default searches structured fact memory first, then falls back to markdown files.',
    parameterDescription: 'query (required): What to search for. maxResults (optional): Max results (default 5). source (optional): "memory" or "knowledge" (default "memory").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memories' },
        maxResults: { type: 'string', description: 'Maximum number of results to return (default 5)' },
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

      // Tier 1: Search structured facts via FactStore
      if (factStore) {
        const allResults = [];

        // Per-user facts first
        if (ctx.senderId) {
          const userFacts = factStore.searchFacts(query, ctx.senderId, maxResults);
          allResults.push(...userFacts);
        }

        // Shared facts
        const sharedFacts = factStore.searchFacts(query, undefined, maxResults);
        allResults.push(...sharedFacts);

        if (allResults.length > 0) {
          // Deduplicate by hash
          const seen = new Set<string>();
          const unique = allResults.filter(f => {
            if (seen.has(f.hash)) return false;
            seen.add(f.hash);
            return true;
          }).slice(0, maxResults);

          return unique
            .map((f, i) => `${i + 1}. [${CATEGORY_LABELS[f.category] ?? f.category}] ${f.text} (conf: ${f.confidence}, src: ${f.source})`)
            .join('\n\n');
        }
      }

      // Tier 2: Fallback to general keyword search across workspace markdown files
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

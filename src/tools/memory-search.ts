import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalClawTool } from './types.js';
import type { OllamaClient } from '../ollama/client.js';
import { searchMarkdownFiles } from '../memory/search.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import { generateEmbedding } from '../memory/embeddings.js';

export function createMemorySearchTool(
  workspacePath: string,
  ollamaClient?: OllamaClient,
  embeddingStore?: EmbeddingStore,
): LocalClawTool {

  return {
    name: 'memory_search',
    description: 'Search through stored memories and knowledge base. Use source="knowledge" to search imported documents (vector search). Default searches markdown memory files (keyword search).',
    parameterDescription: 'query (required): What to search for. maxResults (optional): Max results (default 5). source (optional): "memory" or "knowledge" (default "memory").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memories' },
        maxResults: { type: 'string', description: 'Maximum number of results to return (default 5)' },
        source: { type: 'string', description: 'Filter: "memory" (markdown files) or "knowledge" (imported documents)', enum: ['memory', 'knowledge'] },
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

      // Memory: keyword search on markdown files
      // Check per-user FACTS.md first, then shared FACTS.md
      const factsFiles: string[] = [];
      if (ctx.senderId) {
        const userFacts = join(workspacePath, 'memory', ctx.senderId, 'FACTS.md');
        if (existsSync(userFacts)) factsFiles.push(userFacts);
      }
      const sharedFacts = join(workspacePath, 'FACTS.md');
      if (existsSync(sharedFacts)) factsFiles.push(sharedFacts);

      if (factsFiles.length > 0) {
        const factsResults = searchMarkdownFiles(workspacePath, query, maxResults, factsFiles);
        if (factsResults.length > 0) {
          return factsResults
            .map((r, i) => `${i + 1}. [${r.file}] ${r.section} (score: ${r.score})\n   ${r.content}`)
            .join('\n\n');
        }
      }

      // Fallback: general keyword search across all workspace markdown files
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

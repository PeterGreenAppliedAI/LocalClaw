import type { LocalClawTool } from './types.js';
import type { FactStore } from '../memory/fact-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';
import type { FactCategory } from '../config/types.js';

const VALID_CATEGORIES = new Set<string>(['stable', 'context', 'decision', 'question']);

export function createMemorySaveTool(
  workspacePath: string,
  factStore?: FactStore,
  graphMemory?: GraphMemoryStore,
): LocalClawTool {

  return {
    name: 'memory_save',
    description: 'Save a fact to structured memory with provenance. Facts are categorized (stable, context, decision, question), deduplicated, and searchable via memory_search.',
    parameterDescription: 'content (required): The fact to save. category (optional): "stable" (default), "context", "decision", or "question".',
    example: 'memory_save[{"content": "User works at Acme Corp as a backend engineer", "category": "stable"}]',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or information to save to memory' },
        category: { type: 'string', description: 'Fact category: "stable" (permanent), "context" (temporary), "decision", or "question"', enum: ['stable', 'context', 'decision', 'question'] },
      },
      required: ['content'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>, ctx: import('./types.js').ToolContext): Promise<string> {
      const content = params.content as string;
      if (!content) return 'Error: content parameter is required';

      const catParam = params.category as string | undefined;
      const category: FactCategory = (catParam && VALID_CATEGORIES.has(catParam))
        ? catParam as FactCategory
        : 'stable';

      const importanceMap: Record<string, number> = { stable: 4, context: 2, decision: 3, question: 1 };
      const importance = importanceMap[category] ?? 3;

      // Graph memory (primary)
      if (graphMemory) {
        try {
          const id = await graphMemory.addFact(
            { text: content, category, confidence: 1.0, source: 'user/memory_save', importance },
            ctx.senderId ?? 'unknown',
          );
          if (!id) return 'Already saved (duplicate detected).';
          return `Saved [${category}] fact (conf: 1.0, id: ${id})`;
        } catch (err) {
          console.warn('[memory_save] Graph write failed, falling back to flat store:', err instanceof Error ? err.message : err);
        }
      }

      // Flat store fallback
      if (!factStore) return 'Error: memory not initialized';

      try {
        const entry = await factStore.writeFact(
          { text: content, category, confidence: 1.0, source: 'user/memory_save', importance },
          ctx.senderId,
          'user/memory_save',
        );
        if (!entry) return 'Already saved (duplicate detected).';
        factStore.rebuildFacts(ctx.senderId);
        return `Saved [${category}] fact (conf: 1.0, id: ${entry.id})`;
      } catch (err) {
        return `Error saving: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

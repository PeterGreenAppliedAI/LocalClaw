import type { LocalClawTool } from './types.js';
import type { FactStore } from '../memory/fact-store.js';
import type { FactCategory } from '../config/types.js';

const VALID_CATEGORIES = new Set<string>(['stable', 'context', 'decision', 'question']);

export function createMemorySaveTool(
  workspacePath: string,
  factStore?: FactStore,
): LocalClawTool {

  return {
    name: 'memory_save',
    description: 'Save a fact to structured memory with provenance. Facts are categorized (stable, context, decision, question), deduplicated, and searchable via memory_search.',
    parameterDescription: 'content (required): The fact to save. category (optional): "stable" (default), "context", "decision", or "question".',
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

      if (!factStore) {
        return 'Error: FactStore not initialized';
      }

      try {
        const entry = factStore.writeFact(
          { text: content, category, confidence: 1.0, source: 'user/memory_save' },
          ctx.senderId,
          'user/memory_save',
        );

        if (!entry) {
          return 'Already saved (duplicate detected).';
        }

        factStore.rebuildFacts(ctx.senderId);

        return `Saved [${category}] fact (conf: 1.0, id: ${entry.id})`;
      } catch (err) {
        return `Error saving: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

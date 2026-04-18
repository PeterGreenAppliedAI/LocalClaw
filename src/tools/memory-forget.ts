import type { LocalClawTool } from './types.js';
import type { FactStore } from '../memory/fact-store.js';

export function createMemoryForgetTool(
  workspacePath: string,
  factStore?: FactStore,
): LocalClawTool {
  return {
    name: 'memory_forget',
    description: 'Remove a specific fact from memory. Use when the user says something stored is wrong or outdated. Searches facts by text match and removes them.',
    parameterDescription: 'query (required): Text to match against stored facts. Facts containing this text will be removed.',
    example: 'memory_forget[{"query": "taking a beginners AI course"}]',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match — facts containing this text will be removed' },
      },
      required: ['query'],
    },
    category: 'memory',

    async execute(params: Record<string, unknown>, ctx: import('./types.js').ToolContext): Promise<string> {
      if (!factStore) return 'Memory system unavailable.';

      const query = params.query as string;
      if (!query || query.length < 3) return 'Query too short — provide at least 3 characters to match.';

      // Remove from user-specific facts
      let removed = 0;
      if (ctx.senderId) {
        removed += factStore.removeFact(query, ctx.senderId);
      }
      // Also check shared facts
      removed += factStore.removeFact(query);

      if (removed === 0) {
        return `No facts found matching "${query}". Try a different search term.`;
      }

      // Record removal to prevent heartbeat re-extraction
      if (ctx.senderId) {
        factStore.recordRemoval(query, 'user_denied', ctx.senderId);
      }
      factStore.recordRemoval(query, 'user_denied');

      return `Removed ${removed} fact(s) matching "${query}" from memory.`;
    },
  };
}

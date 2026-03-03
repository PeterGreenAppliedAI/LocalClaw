import type { LocalClawTool } from './types.js';
import type { FactStore } from '../memory/fact-store.js';

export function createMemoryCleanupTool(factStore?: FactStore): LocalClawTool {
  return {
    name: 'memory_cleanup',
    description: 'Consolidate stored memories by removing duplicate and overlapping facts. Run this periodically to keep memory clean.',
    parameterDescription: 'No parameters required.',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'memory',

    async execute(_params: Record<string, unknown>, ctx: import('./types.js').ToolContext): Promise<string> {
      if (!factStore) return 'Memory cleanup unavailable — no fact store configured.';

      let totalRemoved = 0;

      // Clean per-user facts
      if (ctx.senderId) {
        totalRemoved += factStore.consolidateFacts(ctx.senderId);
      }

      // Clean shared facts
      totalRemoved += factStore.consolidateFacts();

      if (totalRemoved === 0) return 'Memory is clean — no duplicates found.';
      return `Cleaned up ${totalRemoved} duplicate fact(s).`;
    },
  };
}

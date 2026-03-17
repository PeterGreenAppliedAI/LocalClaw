import type { LocalClawTool } from './types.js';
import type { FactStore } from '../memory/fact-store.js';
import type { OllamaClient } from '../ollama/client.js';
import { consolidateFactsWithLLM } from '../memory/consolidation.js';

export function createMemoryCleanupTool(
  factStore?: FactStore,
  ollamaClient?: OllamaClient,
  consolidationModel?: string,
): LocalClawTool {
  return {
    name: 'memory_cleanup',
    description: 'Consolidate stored memories by removing duplicate and overlapping facts. Run this periodically to keep memory clean.',
    parameterDescription: 'No parameters required.',
    example: 'memory_cleanup[{}]',
    parameters: { type: 'object', properties: {}, required: [] },
    category: 'memory',

    async execute(_params: Record<string, unknown>, ctx: import('./types.js').ToolContext): Promise<string> {
      if (!factStore) return 'Memory cleanup unavailable — no fact store configured.';

      let substringRemoved = 0;
      let llmRemoved = 0;

      // Phase 1: Substring dedup (fast, no LLM)
      if (ctx.senderId) {
        substringRemoved += factStore.consolidateFacts(ctx.senderId);
      }
      substringRemoved += factStore.consolidateFacts();

      // Phase 2: LLM-driven semantic dedup (if available)
      if (ollamaClient && consolidationModel) {
        try {
          if (ctx.senderId) {
            llmRemoved += await consolidateFactsWithLLM(factStore, ollamaClient, consolidationModel, ctx.senderId);
          }
          llmRemoved += await consolidateFactsWithLLM(factStore, ollamaClient, consolidationModel);
        } catch (err) {
          console.warn('[memory_cleanup] LLM consolidation failed:', err instanceof Error ? err.message : err);
        }
      }

      const total = substringRemoved + llmRemoved;
      if (total === 0) return 'Memory is clean — no duplicates found.';

      const parts: string[] = [];
      if (substringRemoved > 0) parts.push(`${substringRemoved} substring duplicate(s)`);
      if (llmRemoved > 0) parts.push(`${llmRemoved} semantic duplicate(s)`);
      return `Cleaned up ${parts.join(' + ')}.`;
    },
  };
}

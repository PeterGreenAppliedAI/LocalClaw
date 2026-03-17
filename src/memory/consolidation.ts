import type { OllamaClient } from '../ollama/client.js';
import type { EmbeddingStore, MemorySearchResult } from './embeddings.js';
import type { FactStore } from './fact-store.js';
import type { FactEntry } from '../config/types.js';

export type ConsolidationAction = 'MERGE' | 'REPLACE' | 'KEEP_SEPARATE';

export interface ConsolidationDecision {
  action: ConsolidationAction;
  mergedText?: string;
}

export interface ConsolidationResult {
  action: ConsolidationAction;
  existingEntry?: MemorySearchResult;
  mergedText?: string;
}

/**
 * Search embeddings for entries similar to the new text.
 * Returns matches above the similarity threshold.
 */
export function checkForDuplicates(
  store: EmbeddingStore,
  embedding: number[],
  threshold: number,
): MemorySearchResult[] {
  return store.findSimilar(embedding, threshold, 3);
}

/**
 * Ask the LLM to decide how to handle a near-duplicate memory.
 * Returns one of: MERGE, REPLACE, KEEP_SEPARATE.
 * Falls back to KEEP_SEPARATE on any parse failure.
 */
export async function decideConsolidation(
  client: OllamaClient,
  model: string,
  existingText: string,
  newText: string,
): Promise<ConsolidationDecision> {
  const prompt = `You are a memory deduplication assistant. Compare these two memories and decide what to do.

Existing memory: """${existingText}"""
New memory: """${newText}"""

Choose one action:
- MERGE: Combine both into a single, more complete memory
- REPLACE: New memory supersedes/updates the old one
- KEEP_SEPARATE: These are distinct facts that should both be kept

Respond in EXACTLY this format:
ACTION: <MERGE or REPLACE or KEEP_SEPARATE>
MERGED: <only if ACTION is MERGE, write the combined text>`;

  try {
    const response = await client.chat({
      model,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.1, num_predict: 256 },
    });

    const text = response.message?.content ?? '';
    return parseConsolidationResponse(text);
  } catch (err) {
    console.warn('[Consolidation] OLLAMA_INFERENCE_ERROR: LLM call failed, falling back to KEEP_SEPARATE —', err instanceof Error ? err.message : err);
    return { action: 'KEEP_SEPARATE' };
  }
}

/**
 * Parse the LLM's consolidation response.
 * Falls back to KEEP_SEPARATE on garbled output.
 */
export function parseConsolidationResponse(text: string): ConsolidationDecision {
  const actionMatch = text.match(/ACTION:\s*(MERGE|REPLACE|KEEP_SEPARATE)/i);
  if (!actionMatch) {
    return { action: 'KEEP_SEPARATE' };
  }

  const action = actionMatch[1].toUpperCase() as ConsolidationAction;

  if (action === 'MERGE') {
    const mergedMatch = text.match(/MERGED:\s*(.+)/is);
    const mergedText = mergedMatch?.[1]?.trim();
    if (!mergedText) {
      // MERGE requested but no merged text provided — fall back
      return { action: 'KEEP_SEPARATE' };
    }
    return { action: 'MERGE', mergedText };
  }

  return { action };
}

/**
 * Run the full consolidation flow for a new memory entry.
 * Returns the action taken and any affected entry.
 */
export async function consolidateMemory(
  store: EmbeddingStore,
  client: OllamaClient,
  model: string,
  newText: string,
  newEmbedding: number[],
  threshold: number,
): Promise<ConsolidationResult> {
  const similar = checkForDuplicates(store, newEmbedding, threshold);
  if (similar.length === 0) {
    return { action: 'KEEP_SEPARATE' };
  }

  // Use the most similar entry for comparison
  const existing = similar[0];
  const decision = await decideConsolidation(client, model, existing.text, newText);

  if (decision.action === 'REPLACE') {
    store.delete(existing.id);
    return { action: 'REPLACE', existingEntry: existing };
  }

  if (decision.action === 'MERGE' && decision.mergedText) {
    const mergedEmbedding = await generateEmbeddingForMerge(client, decision.mergedText);
    store.update(existing.id, decision.mergedText, mergedEmbedding);
    return { action: 'MERGE', existingEntry: existing, mergedText: decision.mergedText };
  }

  return { action: 'KEEP_SEPARATE' };
}

async function generateEmbeddingForMerge(
  client: OllamaClient,
  text: string,
): Promise<number[]> {
  const embeddings = await client.embed(text);
  return embeddings[0] ?? [];
}

/**
 * Word-overlap similarity between two texts. Returns 0-1.
 * Used as a cheap pre-filter before LLM dedup calls.
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.min(wordsA.size, wordsB.size);
}

/**
 * LLM-driven fact consolidation. Finds semantically similar facts using
 * word-overlap as a cheap pre-filter, then asks the LLM to decide
 * MERGE/REPLACE/KEEP_SEPARATE for each candidate pair.
 *
 * Does NOT depend on embeddings — uses keyword overlap for pre-filtering.
 * Bounded to MAX_PAIRS_PER_RUN to limit LLM cost.
 *
 * Returns the number of facts removed/merged.
 */
export async function consolidateFactsWithLLM(
  factStore: FactStore,
  client: OllamaClient,
  model: string,
  senderId?: string,
  overlapThreshold = 0.5,
): Promise<number> {
  const MAX_PAIRS_PER_RUN = 20;

  // Rebuild first to drop expired entries
  factStore.rebuildFacts(senderId);
  const entries = factStore.loadFactsJson(senderId);
  if (entries.length < 2) return 0;

  // Group by category to avoid cross-category comparisons
  const groups = new Map<string, FactEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.category) ?? [];
    list.push(e);
    groups.set(e.category, list);
  }

  // Find candidate pairs using word overlap
  const candidates: Array<{ a: FactEntry; b: FactEntry; overlap: number }> = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length && candidates.length < MAX_PAIRS_PER_RUN * 2; i++) {
      for (let j = i + 1; j < group.length && candidates.length < MAX_PAIRS_PER_RUN * 2; j++) {
        const overlap = wordOverlap(group[i].text, group[j].text);
        if (overlap >= overlapThreshold) {
          candidates.push({ a: group[i], b: group[j], overlap });
        }
      }
    }
  }

  if (candidates.length === 0) return 0;

  // Sort by overlap (highest first), take top N
  candidates.sort((x, y) => y.overlap - x.overlap);
  const toProcess = candidates.slice(0, MAX_PAIRS_PER_RUN);

  console.log(`[Consolidation] Found ${candidates.length} candidate pairs, processing top ${toProcess.length}`);

  const removedIds = new Set<string>();
  const mergedFacts: Array<{ text: string; category: string; source: string }> = [];

  for (const pair of toProcess) {
    // Skip if either fact was already removed in this run
    if (removedIds.has(pair.a.id) || removedIds.has(pair.b.id)) continue;

    const decision = await decideConsolidation(client, model, pair.a.text, pair.b.text);

    if (decision.action === 'MERGE' && decision.mergedText) {
      removedIds.add(pair.a.id);
      removedIds.add(pair.b.id);
      mergedFacts.push({
        text: decision.mergedText,
        category: pair.a.category,
        source: 'consolidation/llm-merge',
      });
      console.log(`[Consolidation] MERGE: "${pair.a.text.slice(0, 50)}..." + "${pair.b.text.slice(0, 50)}..."`);
    } else if (decision.action === 'REPLACE') {
      // Remove the older one (lower confidence or earlier creation)
      const toRemove = pair.a.confidence <= pair.b.confidence ? pair.a : pair.b;
      removedIds.add(toRemove.id);
      console.log(`[Consolidation] REPLACE: removing "${toRemove.text.slice(0, 50)}..."`);
    }
  }

  if (removedIds.size === 0) return 0;

  // Write merged facts as new entries (appends to index files)
  for (const merged of mergedFacts) {
    factStore.writeFact(
      { text: merged.text, category: merged.category as any, confidence: 0.9, source: merged.source },
      senderId,
      merged.source,
    );
  }

  // Rebuild — this re-reads all index files.
  // Removed IDs are still in the index, so we need to filter them out.
  // Use the same pattern as consolidateFacts(): overwrite facts.json directly.
  factStore.rebuildFacts(senderId);

  // Now load the rebuilt facts and remove the IDs we marked for removal
  const rebuilt = factStore.loadFactsJson(senderId);
  const final = rebuilt.filter(e => !removedIds.has(e.id));
  factStore.overwriteFacts(final, senderId);

  console.log(`[Consolidation] LLM consolidation complete: ${removedIds.size} removed, ${mergedFacts.length} merged`);
  return removedIds.size;
}

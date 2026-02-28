import type { OllamaClient } from '../ollama/client.js';
import type { EmbeddingStore, MemorySearchResult } from './embeddings.js';

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

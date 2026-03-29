import type { OllamaClient } from '../ollama/client.js';
import type { OllamaMessage } from '../ollama/types.js';
import type { SessionStore } from '../sessions/store.js';
import type { CompactionSummary } from '../sessions/types.js';
import type { FactStore } from '../memory/fact-store.js';
import { estimateMessagesTokens } from './tokens.js';

export interface CompactedHistory {
  messages: OllamaMessage[];  // [summary_msg?, ...recent_turns]
  compacted: boolean;         // whether compaction happened
}

export interface BuildCompactedHistoryParams {
  store: SessionStore;
  client: OllamaClient;
  agentId: string;
  sessionKey: string;
  budgetTokens: number;
  recentTurnsToKeep: number;
  model: string;
  workspacePath: string;
  factStore?: FactStore;
  senderId?: string;
}

/**
 * Proactive compaction threshold — compress at 50% of budget, not when full.
 * This gives the model room to work after compaction instead of being
 * immediately squeezed again.
 */
const PROACTIVE_THRESHOLD = 0.5;

/**
 * Build a compacted history that fits within the token budget.
 *
 * Flow:
 * 1. Load full transcript from disk
 * 2. Load existing summary (if any)
 * 3. If fits within 50% of budget → return all turns (zero overhead)
 * 4. If over 50%:
 *    a. Prune old tool results (cheap, no LLM)
 *    b. Take last N turns as recent zone
 *    c. Flush key facts from archive zone to MEMORY.md
 *    d. Generate structured summary (Goal/Progress/Decisions/Next Steps)
 *    e. Sanitize orphaned tool_call/result pairs
 *    f. Return [summary_msg, ...recent_turns]
 */
export async function buildCompactedHistory(params: BuildCompactedHistoryParams): Promise<CompactedHistory> {
  const { store, client, agentId, sessionKey, budgetTokens, recentTurnsToKeep, model, workspacePath, factStore, senderId } = params;

  const transcript = store.loadTranscript(agentId, sessionKey);
  if (transcript.length === 0) {
    return { messages: [], compacted: false };
  }

  const allMessages: OllamaMessage[] = transcript.map(t => ({
    role: t.role as 'user' | 'assistant',
    content: t.content,
  }));

  // Proactive threshold: compress at 50% of budget, not when full
  const threshold = Math.floor(budgetTokens * PROACTIVE_THRESHOLD);
  if (estimateMessagesTokens(allMessages) <= threshold) {
    return { messages: allMessages, compacted: false };
  }

  console.log(`[Compactor] Context exceeds ${Math.round(PROACTIVE_THRESHOLD * 100)}% of budget — compacting`);

  // Phase 1: Prune old tool results (cheap, no LLM call)
  pruneOldToolResults(allMessages, recentTurnsToKeep);

  // Re-check after pruning — might be enough
  if (estimateMessagesTokens(allMessages) <= budgetTokens) {
    console.log('[Compactor] Pruning was sufficient, no LLM summary needed');
    return { messages: allMessages, compacted: true };
  }

  // Phase 2: Split into zones
  const existingSummary = store.loadSummary(agentId, sessionKey);

  const recentStart = Math.max(0, allMessages.length - recentTurnsToKeep);
  const recentMessages = allMessages.slice(recentStart);

  const archiveStart = existingSummary ? existingSummary.coversUpToIndex + 1 : 0;
  const archiveEnd = recentStart;
  const archiveMessages = allMessages.slice(archiveStart, archiveEnd);

  if (archiveMessages.length === 0) {
    const result: OllamaMessage[] = [];
    if (existingSummary) {
      result.push({ role: 'system', content: `[Prior conversation summary]\n${existingSummary.text}` });
    }
    result.push(...recentMessages);
    return { messages: result, compacted: true };
  }

  const archiveText = archiveMessages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');

  // Phase 3: Flush key facts to FactStore
  try {
    await flushToMemory(client, model, archiveText, workspacePath, factStore, senderId);
  } catch (err) {
    console.warn('[Compactor] Memory flush failed, continuing with summary only:', err);
  }

  // Phase 4: Generate structured summary (or update existing)
  let newSummaryText: string;
  try {
    newSummaryText = await generateStructuredSummary(client, model, archiveText, existingSummary?.text);
  } catch (err) {
    console.warn('[Compactor] Summary generation failed, falling back to recent turns only:', err);
    return { messages: recentMessages, compacted: true };
  }

  const summary: CompactionSummary = {
    text: newSummaryText,
    coversUpToIndex: archiveEnd - 1,
    generatedAt: new Date().toISOString(),
    model,
  };
  store.saveSummary(agentId, sessionKey, summary);

  // Build final messages
  const result: OllamaMessage[] = [
    { role: 'system', content: `[Prior conversation summary]\n${newSummaryText}` },
    ...recentMessages,
  ];

  // Phase 5: Sanitize orphaned tool_call/result pairs
  sanitizeToolPairs(result);

  // If still over budget, trim recent turns from the start
  while (result.length > 2 && estimateMessagesTokens(result) > budgetTokens) {
    result.splice(1, 1);
  }

  console.log(`[Compactor] Compacted: ${allMessages.length} turns → ${result.length} messages`);

  return { messages: result, compacted: true };
}

/**
 * Phase 1: Prune old tool results without an LLM call.
 * Replaces tool observation content >200 chars with a short stub,
 * keeping only the most recent results intact.
 */
function pruneOldToolResults(messages: OllamaMessage[], protectCount: number): void {
  // Find non-system message indices
  const nonSystemIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'system') nonSystemIndices.push(i);
  }

  // Protect the last N messages
  const protectedSet = new Set(nonSystemIndices.slice(-protectCount));

  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (messages[i].role !== 'tool') continue;

    const content = messages[i].content ?? '';
    if (content.length > 200) {
      messages[i] = {
        ...messages[i],
        content: '[Old tool output cleared to save context space]',
      };
    }
  }
}

/**
 * Phase 5: Sanitize orphaned tool_call/result pairs after compression.
 *
 * After summarization removes archive messages, the remaining history may have:
 * - tool results whose corresponding tool_calls were summarized away
 * - tool_calls whose results were dropped
 *
 * This causes API errors and model confusion. Clean them up.
 */
function sanitizeToolPairs(messages: OllamaMessage[]): void {
  // Track which tool_call IDs exist in assistant messages
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        const id = call.function?.name ?? '';
        if (id) callIds.add(id);
      }
    }
    if (msg.role === 'tool') {
      // Tool messages reference their call by position/name
      resultIds.add(msg.content?.slice(0, 50) ?? '');
    }
  }

  // Remove orphaned tool messages (results without calls in history)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      // Check if there's a preceding assistant message with tool_calls
      let hasCall = false;
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === 'assistant' && messages[j].tool_calls) {
          hasCall = true;
          break;
        }
        if (messages[j].role === 'user') break; // crossed a turn boundary
      }
      if (!hasCall) {
        messages.splice(i, 1);
      }
    }
  }
}

/**
 * Extract key facts from archive turns and write through FactStore.
 */
async function flushToMemory(
  client: OllamaClient,
  model: string,
  archiveText: string,
  workspacePath: string,
  factStore?: FactStore,
  senderId?: string,
): Promise<void> {
  const response = await client.chat({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a fact extractor. Extract key facts from the conversation below that should be remembered long-term. Focus on:
- User preferences and decisions
- Names, dates, specific numbers
- Important outcomes and conclusions
- Technical details worth preserving

Output ONLY a bullet-point list of facts. If there are no notable facts, output "No notable facts."`,
      },
      { role: 'user', content: archiveText },
    ],
    options: { temperature: 0.1, num_predict: 512 },
  });

  const facts = response.message?.content ?? '';
  if (!facts || facts.toLowerCase().includes('no notable facts')) return;

  const bullets = facts
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('-') || trimmed.startsWith('*');
    })
    .map(line => line.trim().replace(/^[-*]\s*/, ''));

  if (bullets.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const source = `compaction/${today}`;

  if (factStore) {
    const inputs = bullets.map(text => ({
      text,
      category: 'stable' as const,
      confidence: 0.7,
      source,
    }));
    factStore.writeFactsBatch(inputs, senderId, source);
    factStore.rebuildFacts(senderId);
  } else {
    console.warn('[Compactor] No FactStore available, skipping memory flush');
  }
}

/**
 * Generate a structured summary using a template that preserves coherence.
 *
 * If an existing summary exists, update it iteratively instead of
 * regenerating from scratch (prevents information loss on long sessions).
 *
 * Template adapted from Hermes Agent's ContextCompressor.
 */
async function generateStructuredSummary(
  client: OllamaClient,
  model: string,
  archiveText: string,
  existingSummary?: string,
): Promise<string> {
  const isUpdate = !!existingSummary;

  const prompt = isUpdate
    ? `You are updating a conversation summary. Below is the existing summary and new conversation turns.
Update the summary to incorporate the new turns. Move items from "In Progress" to "Done" if completed.
Add new items to the appropriate sections. Keep the same structured format.

EXISTING SUMMARY:
${existingSummary}

NEW CONVERSATION TURNS:
${archiveText}`
    : `Summarize this conversation using the structured format below.

CONVERSATION:
${archiveText}`;

  const response = await client.chat({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a conversation summarizer. Use this EXACT format:

## Goal
What the user is trying to accomplish (1-2 sentences)

## Progress
- [DONE] Steps that have been completed
- [IN PROGRESS] What is currently being worked on
- [BLOCKED] Any issues or blockers encountered

## Decisions
Key choices made during the conversation (bullet points)

## Files & Data
Important file paths, URLs, data points, or values referenced

## Next Steps
What should happen next in the conversation

## Critical Context
Anything the model must remember to continue coherently (names, preferences, constraints)

Keep each section concise. Omit empty sections. This summary replaces older conversation history — include everything needed to continue the conversation coherently.`,
      },
      { role: 'user', content: prompt },
    ],
    options: { temperature: 0.2, num_predict: 1024 },
  });

  return response.message?.content ?? 'Unable to generate summary.';
}

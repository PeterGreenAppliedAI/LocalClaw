import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OllamaClient } from '../ollama/client.js';
import type { OllamaMessage } from '../ollama/types.js';
import type { SessionStore } from '../sessions/store.js';
import type { CompactionSummary } from '../sessions/types.js';
import { estimateTokens, estimateMessagesTokens } from './tokens.js';

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
}

/**
 * Build a compacted history that fits within the token budget.
 *
 * Flow:
 * 1. Load full transcript from disk
 * 2. Load existing summary (if any)
 * 3. If fits within budget → return all turns (zero overhead)
 * 4. If over budget:
 *    a. Take last N turns as recent zone
 *    b. Flush key facts from archive zone to MEMORY.md
 *    c. Summarize archive + existing summary into new summary
 *    d. Return [summary_msg, ...recent_turns]
 */
export async function buildCompactedHistory(params: BuildCompactedHistoryParams): Promise<CompactedHistory> {
  const { store, client, agentId, sessionKey, budgetTokens, recentTurnsToKeep, model, workspacePath } = params;

  // Load full transcript (use a large maxTurns since compaction handles size)
  const transcript = store.loadTranscript(agentId, sessionKey);
  if (transcript.length === 0) {
    return { messages: [], compacted: false };
  }

  // Convert to OllamaMessages
  const allMessages: OllamaMessage[] = transcript.map(t => ({
    role: t.role as 'user' | 'assistant',
    content: t.content,
  }));

  // Check if it fits within budget
  if (estimateMessagesTokens(allMessages) <= budgetTokens) {
    return { messages: allMessages, compacted: false };
  }

  // Over budget — need compaction
  const existingSummary = store.loadSummary(agentId, sessionKey);

  // Split into recent zone and archive zone
  const recentStart = Math.max(0, allMessages.length - recentTurnsToKeep);
  const recentMessages = allMessages.slice(recentStart);

  // Archive zone: turns between last summary boundary and recent zone
  const archiveStart = existingSummary ? existingSummary.coversUpToIndex + 1 : 0;
  const archiveEnd = recentStart;
  const archiveMessages = allMessages.slice(archiveStart, archiveEnd);

  // If no archive turns to process, just return recent + existing summary
  if (archiveMessages.length === 0) {
    const result: OllamaMessage[] = [];
    if (existingSummary) {
      result.push({ role: 'system', content: `[Prior conversation summary]\n${existingSummary.text}` });
    }
    result.push(...recentMessages);
    return { messages: result, compacted: true };
  }

  // Format archive for the model
  const archiveText = archiveMessages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n\n');

  // Step 1: Flush key facts to MEMORY.md
  try {
    await flushToMemory(client, model, archiveText, workspacePath);
  } catch (err) {
    console.warn('[Compactor] Memory flush failed, continuing with summary only:', err);
  }

  // Step 2: Generate new summary
  let newSummaryText: string;
  try {
    newSummaryText = await generateSummary(client, model, archiveText, existingSummary?.text);
  } catch (err) {
    // Fallback: return simple truncation (recent turns only)
    console.warn('[Compactor] Summary generation failed, falling back to recent turns only:', err);
    return { messages: recentMessages, compacted: true };
  }

  // Save summary
  const summary: CompactionSummary = {
    text: newSummaryText,
    coversUpToIndex: archiveEnd - 1,
    generatedAt: new Date().toISOString(),
    model,
  };
  store.saveSummary(agentId, sessionKey, summary);

  // Build final messages: summary + recent turns
  const result: OllamaMessage[] = [
    { role: 'system', content: `[Prior conversation summary]\n${newSummaryText}` },
    ...recentMessages,
  ];

  // If still over budget after compaction, trim recent turns from the start
  while (result.length > 2 && estimateMessagesTokens(result) > budgetTokens) {
    result.splice(1, 1);
  }

  return { messages: result, compacted: true };
}

/**
 * Extract key facts from archive turns and append to MEMORY.md.
 */
async function flushToMemory(
  client: OllamaClient,
  model: string,
  archiveText: string,
  workspacePath: string,
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

  // Append to MEMORY.md
  const memoryPath = join(workspacePath, 'MEMORY.md');
  const dir = dirname(memoryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const dateHeader = `\n\n## Compaction — ${new Date().toISOString().split('T')[0]}\n`;
  appendFileSync(memoryPath, dateHeader + facts + '\n');
}

/**
 * Generate a condensed summary of archive turns + existing summary.
 */
async function generateSummary(
  client: OllamaClient,
  model: string,
  archiveText: string,
  existingSummary?: string,
): Promise<string> {
  const contextParts: string[] = [];
  if (existingSummary) {
    contextParts.push(`Previous summary:\n${existingSummary}`);
  }
  contextParts.push(`New conversation to summarize:\n${archiveText}`);

  const response = await client.chat({
    model,
    messages: [
      {
        role: 'system',
        content: `You are a conversation summarizer. Condense the conversation into a brief summary that preserves:
- The main topics discussed
- Key decisions made
- Any ongoing tasks or questions
- The overall flow of the conversation

Keep it concise (2-4 paragraphs max). This summary will be used as context for future messages.`,
      },
      { role: 'user', content: contextParts.join('\n\n---\n\n') },
    ],
    options: { temperature: 0.2, num_predict: 1024 },
  });

  return response.message?.content ?? 'Unable to generate summary.';
}

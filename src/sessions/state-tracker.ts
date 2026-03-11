import type { OllamaClient } from '../ollama/client.js';
import type { SessionState, ConversationTurn } from './types.js';
import { createEmptySessionState } from './types.js';

/** Max session-scoped facts to keep before dropping oldest */
const MAX_KNOWN_FACTS = 20;

/** Max pending/completed actions to track */
const MAX_ACTIONS = 10;

/** Turns between LLM semantic extractions */
export const SEMANTIC_INTERVAL = 5;

/**
 * Patterns that suggest the assistant is asking the user something
 * or proposing an action it hasn't completed yet.
 */
const PENDING_PATTERNS = [
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bshould I\b/i,
  /\bshall I\b/i,
  /\blet me know\b/i,
  /\bwhich (?:one|channel|format|option)\b/i,
];

/**
 * Update session state from code-observable data. Zero LLM cost.
 * Runs after every turn.
 */
export function updateMechanicalState(
  current: SessionState | null,
  category: string,
  toolCalls: string[],
  assistantMessage: string,
): SessionState {
  const state = current ?? createEmptySessionState(category);

  const updated: SessionState = {
    ...state,
    currentCategory: category,
    turnCount: state.turnCount + 1,
    lastToolCalls: toolCalls,
    lastUpdated: new Date().toISOString(),
  };

  // Move matching pending actions to completed when tools succeed
  if (toolCalls.length > 0) {
    const remaining: string[] = [];
    const newCompleted = [...state.completedActions];

    for (const pending of state.pendingActions) {
      const matched = toolCalls.some(t =>
        pending.toLowerCase().includes(t.toLowerCase()),
      );
      if (matched) {
        newCompleted.push(pending);
      } else {
        remaining.push(pending);
      }
    }

    // Add tool calls as completed actions
    for (const tool of toolCalls) {
      if (!newCompleted.some(c => c.includes(tool))) {
        newCompleted.push(tool);
      }
    }

    updated.pendingActions = remaining.slice(-MAX_ACTIONS);
    updated.completedActions = newCompleted.slice(-MAX_ACTIONS);
  }

  // Detect new pending actions from assistant questions
  const hasPending = PENDING_PATTERNS.some(p => p.test(assistantMessage));
  if (hasPending && toolCalls.length === 0) {
    // Extract the question as a pending action (first sentence with ?)
    const questionMatch = assistantMessage.match(/[^.!]*\?/);
    if (questionMatch) {
      const question = questionMatch[0].trim().slice(0, 120);
      if (!updated.pendingActions.includes(question)) {
        updated.pendingActions = [...updated.pendingActions, question].slice(-MAX_ACTIONS);
      }
    }
  }

  return updated;
}

/**
 * Extract semantic state delta via a lightweight LLM call.
 * Runs every ~5 turns. Uses a small/fast model.
 */
export async function extractSemanticDelta(
  client: OllamaClient,
  model: string,
  recentTurns: ConversationTurn[],
  currentState: SessionState,
): Promise<Partial<SessionState>> {
  // Only include turns since last semantic update
  const newTurns = recentTurns.slice(-(currentState.turnCount - currentState.lastSemanticUpdate + 2));
  if (newTurns.length === 0) return {};

  const turnText = newTurns
    .map(t => `${t.role}: ${t.content.slice(0, 500)}`)
    .join('\n\n');

  try {
    const response = await client.chat({
      model,
      messages: [
        {
          role: 'system',
          content: `Extract structured state from this conversation segment. Output ONLY valid JSON with these fields (omit unchanged fields):
{
  "currentTopic": "brief topic description",
  "knownFacts": ["new fact 1", "new fact 2"],
  "openQuestions": ["unresolved question 1"]
}
Rules:
- currentTopic: what the conversation is currently about (1 sentence max)
- knownFacts: only NEW facts not already known. Current known facts: ${JSON.stringify(currentState.knownFacts)}
- openQuestions: questions or requests still unresolved
- Output ONLY the JSON object, nothing else`,
        },
        { role: 'user', content: turnText },
      ],
      options: { temperature: 0.1, num_predict: 256 },
    });

    const content = response.message?.content ?? '';
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const delta = JSON.parse(jsonMatch[0]);
    return {
      ...(typeof delta.currentTopic === 'string' ? { currentTopic: delta.currentTopic } : {}),
      ...(Array.isArray(delta.knownFacts) ? { knownFacts: delta.knownFacts } : {}),
      ...(Array.isArray(delta.openQuestions) ? { openQuestions: delta.openQuestions } : {}),
    };
  } catch (err) {
    console.warn('[StateTracker] Semantic extraction failed:', err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * Merge a partial delta into the current state.
 * - currentTopic: overwrite
 * - knownFacts: union with dedup, capped
 * - openQuestions: replace entirely (LLM sees full context)
 */
export function applyDelta(state: SessionState, delta: Partial<SessionState>): SessionState {
  const updated = { ...state, lastSemanticUpdate: state.turnCount };

  if (delta.currentTopic !== undefined) {
    updated.currentTopic = delta.currentTopic;
  }

  if (delta.knownFacts !== undefined) {
    const existing = new Set(state.knownFacts.map(f => f.toLowerCase().trim()));
    const merged = [...state.knownFacts];
    for (const fact of delta.knownFacts) {
      const normalized = fact.toLowerCase().trim();
      if (!existing.has(normalized)) {
        existing.add(normalized);
        merged.push(fact);
      }
    }
    // Cap at MAX_KNOWN_FACTS, drop oldest
    updated.knownFacts = merged.slice(-MAX_KNOWN_FACTS);
  }

  if (delta.openQuestions !== undefined) {
    updated.openQuestions = delta.openQuestions;
  }

  return updated;
}

/**
 * Serialize session state into a compact text preamble for prompt injection.
 * Targets ~100-200 tokens. Omits empty sections.
 */
export function serializeStatePreamble(state: SessionState): string {
  // Skip preamble for brand-new sessions
  if (state.turnCount <= 1 && !state.currentTopic) return '';

  const lines: string[] = ['[Session State]'];

  if (state.currentTopic) {
    lines.push(`Topic: ${state.currentTopic}`);
  }

  lines.push(`Turn: ${state.turnCount} | Category: ${state.currentCategory}`);

  if (state.lastToolCalls.length > 0) {
    lines.push(`Recent tools: ${state.lastToolCalls.join(', ')}`);
  }

  if (state.knownFacts.length > 0) {
    lines.push('Known facts:');
    for (const fact of state.knownFacts.slice(-10)) {
      lines.push(`- ${fact}`);
    }
  }

  if (state.openQuestions.length > 0) {
    lines.push('Open questions:');
    for (const q of state.openQuestions) {
      lines.push(`- ${q}`);
    }
  }

  if (state.pendingActions.length > 0) {
    lines.push(`Pending: ${state.pendingActions.join('; ')}`);
  }

  return lines.join('\n');
}

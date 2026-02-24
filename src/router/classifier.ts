import { routerTimeout } from '../errors.js';
import type { OllamaClient } from '../ollama/client.js';
import type { RouterConfig } from '../config/types.js';
import { buildRouterPrompt } from './prompt.js';

/**
 * Keyword patterns that bias away from chat (per ChatGPT feedback §1).
 * Order matters — more specific patterns (exec, cron) come before broader ones (web_search).
 */
const KEYWORD_HINTS: Array<{ pattern: RegExp; category: string }> = [
  // Multi first (longest match / compound intent)
  { pattern: /\b(save|write file|read file).*(search|send|remind)/i, category: 'multi' },
  { pattern: /\b(search|find).*(save|send|remind)/i, category: 'multi' },
  // Specific action categories before broad ones
  { pattern: /\b(config|configure|setting|settings|preference|edit.*cron|modify.*cron|update.*cron|change.*cron|enable|disable|workspace|tools\.md|heartbeat)\b/i, category: 'config' },
  { pattern: /\b(run|execute|compile|build|deploy|install|sudo|npm|pip|git|ls|cat|mkdir|rm)\b/i, category: 'exec' },
  { pattern: /\b(task|todo|to-do|kanban|checklist|add task|my tasks|pending|mark done|complete task)\b/i, category: 'task' },
  { pattern: /\b(remind|schedule|every day|at \d+\s*(am|pm)|cron|cronjob|cronjobs|cron\s*job|recurring|scheduled task|morning report|daily report)\b/i, category: 'cron' },
  { pattern: /\b(remember|recall|we (discussed|talked)|last time|yesterday)\b/i, category: 'memory' },
  { pattern: /\b(tell|send|notify|message|announce)\b/i, category: 'message' },
  { pattern: /\b(homework|assignment|syllabus|lecture)\b/i, category: 'website' },
  // Broad web_search last — "current" removed (false positive on "current directory" etc.)
  { pattern: /\b(search|google|look up|find out|latest|news|what is|who is)\b/i, category: 'web_search' },
];

const VALID_CATEGORIES = new Set([
  'chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi', 'config', 'task',
]);

export interface ClassifyResult {
  category: string;
  confidence: 'model' | 'keyword' | 'fallback' | 'sticky';
}

/**
 * Strong new-topic signals — these indicate the user is starting a genuinely
 * different task, not continuing the previous one.
 */
const NEW_TOPIC_PATTERNS = [
  /\b(search|google|look up)\b.*\b(for|about)\b/i,  // "search the web for X"
  /\b(run|execute|deploy|install|sudo)\b/i,           // explicit exec intent
  /\b(remind me|schedule|every day|set up a cron)\b/i, // explicit cron intent
  /\b(send|tell|notify)\b.*\b(message|channel)\b/i,   // explicit messaging intent
  /\b(remember this|save this|store this)\b/i,         // explicit memory intent
];

/** Messages that open with a greeting are starting a new conversation, not following up */
const GREETING_PATTERNS = [
  /^\s*(hi|hey|hello|yo|sup|howdy|hola|what'?s up|how'?s it going|good (morning|afternoon|evening)|thanks|thank you)\b/i,
];

function hasStrongNewTopicSignal(message: string): boolean {
  return NEW_TOPIC_PATTERNS.some(p => p.test(message));
}

/**
 * Heuristic: messages under a reasonable length that don't contain
 * strong signals for a completely different topic are likely continuations.
 */
function isGreeting(message: string): boolean {
  return GREETING_PATTERNS.some(p => p.test(message));
}

function isLikelyFollowUp(message: string): boolean {
  const trimmed = message.trim();
  // Long, self-contained messages are likely new topics
  if (trimmed.length > 200) return false;
  // Strong new-topic signals override stickiness
  if (hasStrongNewTopicSignal(trimmed)) return false;
  // Simple greetings are never follow-ups
  if (isGreeting(trimmed)) return false;
  // Under 200 chars without strong new-topic signals — likely a follow-up
  return true;
}

/**
 * Classify a message into a specialist category.
 *
 * Pipeline:
 *   1. Sticky category — if previous category exists and message looks like a follow-up,
 *      stay on the same category unless keywords strongly indicate otherwise
 *   2. Ask router model for classification
 *   3. If model output is a valid category, use it
 *   4. If invalid/timeout, check keyword heuristics
 *   5. Fallback to defaultCategory
 */
export async function classifyMessage(
  client: OllamaClient,
  config: RouterConfig,
  message: string,
  previousCategory?: string,
): Promise<ClassifyResult> {
  const validCategories = getValidCategories(config);

  // Sticky category: follow-ups stay on the previous specialist
  // Break out if: strong new-topic signal, long message, OR keywords point to a different category
  if (previousCategory && previousCategory !== 'chat' && validCategories.has(previousCategory)) {
    if (isLikelyFollowUp(message)) {
      // Check if keywords point to a DIFFERENT category — if so, don't stick
      const keywordHit = applyKeywordHeuristics(message, validCategories);
      if (keywordHit && keywordHit !== previousCategory) {
        console.log(`[Router] Sticky override: "${message.slice(0, 60)}..." keyword="${keywordHit}" beats sticky="${previousCategory}"`);
      } else {
        console.log(`[Router] Sticky: "${message.slice(0, 60)}..." → ${previousCategory} (follow-up)`);
        return { category: previousCategory, confidence: 'sticky' };
      }
    }
  }

  // Try model classification
  try {
    const prompt = buildRouterPrompt(message, config);

    const response = await client.generate({
      model: config.model,
      prompt,
      options: {
        temperature: 0.1,
        num_predict: 20,
      },
    });

    const raw = response.response.trim().toLowerCase().replace(/[^a-z_]/g, '');

    if (validCategories.has(raw)) {
      return { category: raw, confidence: 'model' };
    }

    // Model returned garbage — fall through to keyword heuristics
  } catch (err) {
    // Timeout or inference error — fall through
    console.error('[Router] Model classification failed:', err instanceof Error ? err.message : err);
  }

  // Keyword heuristic fallback (per ChatGPT feedback)
  const keywordHit = applyKeywordHeuristics(message, validCategories);
  if (keywordHit) {
    return { category: keywordHit, confidence: 'keyword' };
  }

  return { category: config.defaultCategory, confidence: 'fallback' };
}

function getValidCategories(config: RouterConfig): Set<string> {
  if (Object.keys(config.categories).length > 0) {
    return new Set(Object.keys(config.categories));
  }
  return VALID_CATEGORIES;
}

function applyKeywordHeuristics(message: string, validCategories: Set<string>): string | null {
  for (const hint of KEYWORD_HINTS) {
    if (hint.pattern.test(message) && validCategories.has(hint.category)) {
      return hint.category;
    }
  }
  return null;
}

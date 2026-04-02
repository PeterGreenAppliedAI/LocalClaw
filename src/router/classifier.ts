import { routerTimeout } from '../errors.js';
import type { OllamaClient } from '../ollama/client.js';
import type { RouterConfig } from '../config/types.js';
import { buildRouterPrompt } from './prompt.js';

/**
 * Keyword patterns that bias away from chat (per ChatGPT feedback §1).
 * Order matters — more specific patterns (exec, cron) come before broader ones (web_search).
 */
const KEYWORD_HINTS: Array<{ pattern: RegExp; category: string }> = [
  // Document format requests → multi (uses document tool for PDF/DOCX/XLSX generation)
  { pattern: /\b(pdf|docx|xlsx|pptx|word doc|spreadsheet|slide deck|presentation)\b/i, category: 'multi' },
  // Multi first (longest match / compound intent)
  { pattern: /\b(save|write file|read file).*(search|send|remind)/i, category: 'multi' },
  { pattern: /\b(search|find).*(save|send|remind|sign.*(up|me)|register|subscribe)/i, category: 'multi' },
  { pattern: /\b(find|search|look).*(and|then)\b/i, category: 'multi' },
  // Research — only trigger on clear research *requests*, not casual mentions
  { pattern: /\b(research|analyze)\b.*\b(for me|this topic|in depth|deep dive)\b/i, category: 'research' },
  { pattern: /\b(chart|graph|plot|visualize)\b.*\b(data|stock|trend|performance|price)\b/i, category: 'research' },
  // Browser interaction → multi (plan pipeline with browser tool)
  { pattern: /\b(screenshot|browse|go to|navigate to|visit)\b.*\b(\.com|\.org|\.net|\.io|site|website|page)\b/i, category: 'multi' },
  // Specific action categories before broad ones
  { pattern: /\b(config|configure|setting|settings|preference|edit.*cron|modify.*cron|update.*cron|change.*cron|enable|disable|workspace|tools\.md)\b/i, category: 'config' },
  { pattern: /\b(add.*heartbeat|remove.*heartbeat|list.*heartbeat|periodic check|periodic task|autonomous check)\b/i, category: 'cron' },
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
  'chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi', 'config', 'task', 'research',
]);

export interface ClassifyResult {
  category: string;
  confidence: 'model' | 'keyword' | 'fallback' | 'sticky';
}

/**
 * High-confidence keyword overrides that fire BEFORE model classification.
 * Used for categories the router model doesn't know well (e.g., newly added ones).
 * These patterns must be very specific to avoid false positives.
 */
const PRE_MODEL_OVERRIDES: Array<{ pattern: RegExp; category: string }> = [
  // PDF/DOCX report requests → research pipeline (deep content + formatting + quality review)
  { pattern: /\b(make|create|generate|write|give me|produce)\b.*\b(pdf|docx)\b.*\breport\b/i, category: 'research' },
  { pattern: /\breport\b.*\b(pdf|docx)\b/i, category: 'research' },
  { pattern: /\bpdf report\b/i, category: 'research' },
  // Other document format requests (spreadsheets, presentations) → multi
  { pattern: /\b(make|create|generate|build|write|give me|produce)\b.*\b(xlsx|pptx|spreadsheet|slide)\b/i, category: 'multi' },
  { pattern: /\b(pdf|docx)\b.*\b(spreadsheet|presentation)\b/i, category: 'multi' },
  // Browser interaction — compound: action + site/domain reference
  { pattern: /\b(screenshot|browse|go to|navigate to|visit)\b.*(\.\w{2,}|site|website|page)\b/i, category: 'multi' },
  // Research — only compound intent patterns, not bare keywords
  { pattern: /\b(research|analyze)\b.*\b(stock|market|data|trend|performance|price)\b/i, category: 'research' },
  { pattern: /\b(stock|market|data|trend|performance)\b.*\b(research|analyze|analysis)\b/i, category: 'research' },
];

/**
 * Strong new-topic signals — these indicate the user is starting a genuinely
 * different task, not continuing the previous one.
 */
const NEW_TOPIC_PATTERNS = [
  /\b(search|google|look up)\b.*\b(for|about)\b/i,  // "search the web for X"
  /\b(find|search|look).*(and|then)\b/i,              // compound action: "find X and do Y"
  /\b(sign.*(up|me)|register|subscribe)\b/i,          // explicit signup/registration intent
  /\b(run|execute|deploy|install|sudo)\b/i,           // explicit exec intent
  /\b(remind me|schedule|every day|set up a cron)\b/i, // explicit cron intent
  /\b(send|tell|notify)\b.*\b(message|channel)\b/i,   // explicit messaging intent
  /\b(remember this|save this|store this)\b/i,         // explicit memory intent
  /\b(research|analyze)\b.*\b(stock|data|trend|market)\b/i,  // explicit research intent
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

/** Categories where multi-turn sticky makes sense (conversation-oriented) */
const STICKY_CATEGORIES = new Set(['chat', 'memory']);

function isLikelyFollowUp(message: string, previousCategory?: string): boolean {
  const trimmed = message.trim();
  // Commands are never follow-ups
  if (trimmed.startsWith('!')) return false;
  // Only stick on conversation-oriented categories — tool specialists finish in one turn
  if (previousCategory && !STICKY_CATEGORIES.has(previousCategory)) return false;
  // Long, self-contained messages are likely new topics
  if (trimmed.length > 200) return false;
  // Strong new-topic signals override stickiness
  if (hasStrongNewTopicSignal(trimmed)) return false;
  // Simple greetings are never follow-ups
  if (isGreeting(trimmed)) return false;
  // Short continuation of a conversation-oriented specialist
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
  if (previousCategory && validCategories.has(previousCategory)) {
    if (isLikelyFollowUp(message, previousCategory)) {
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

  // Pre-model overrides for categories the model doesn't know well
  for (const override of PRE_MODEL_OVERRIDES) {
    if (override.pattern.test(message) && validCategories.has(override.category)) {
      console.log(`[Router] Pre-model override: "${message.slice(0, 60)}..." → ${override.category}`);
      return { category: override.category, confidence: 'keyword' };
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
    console.warn('[Router] OLLAMA_INFERENCE_ERROR: Classification failed —', err instanceof Error ? err.message : err);
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

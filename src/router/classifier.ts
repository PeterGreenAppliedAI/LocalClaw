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
  { pattern: /\b(remind|schedule|every day|at \d+\s*(am|pm)|cron|cronjob|cronjobs|cron\s*job|recurring|scheduled task|morning report|daily report)\b/i, category: 'cron' },
  { pattern: /\b(remember|recall|we (discussed|talked)|last time|yesterday)\b/i, category: 'memory' },
  { pattern: /\b(tell|send|notify|message|announce)\b/i, category: 'message' },
  { pattern: /\b(homework|assignment|course|class|syllabus|lecture)\b/i, category: 'website' },
  // Broad web_search last — "current" removed (false positive on "current directory" etc.)
  { pattern: /\b(search|google|look up|find out|latest|news|what is|who is)\b/i, category: 'web_search' },
];

const VALID_CATEGORIES = new Set([
  'chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi', 'config',
]);

export interface ClassifyResult {
  category: string;
  confidence: 'model' | 'keyword' | 'fallback';
}

/**
 * Classify a message into a specialist category.
 *
 * Pipeline:
 *   1. Ask router model for classification
 *   2. If model output is a valid category, use it
 *   3. If invalid/timeout, check keyword heuristics
 *   4. Fallback to defaultCategory
 */
export async function classifyMessage(
  client: OllamaClient,
  config: RouterConfig,
  message: string,
): Promise<ClassifyResult> {
  const validCategories = getValidCategories(config);

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

import type { ErrorLearningStore } from './error-store.js';

interface ErrorPattern {
  pattern: RegExp;
  type: string;
  suggestion: string;
}

/**
 * Known error patterns with contextual anchoring to reduce false positives.
 * Patterns require error-context words nearby (e.g., "Error: not found", not just "not found" in prose).
 */
const ERROR_PATTERNS: ErrorPattern[] = [
  { pattern: /permission denied|EACCES/i, type: 'permission_denied', suggestion: 'Check file permissions or run with elevated privileges' },
  { pattern: /cannot find module|module not found|ERR_MODULE_NOT_FOUND/i, type: 'module_not_found', suggestion: 'Check the module name and ensure it is installed' },
  { pattern: /ECONNREFUSED|connection refused/i, type: 'connection_refused', suggestion: 'The target service may be down or the URL/port may be wrong' },
  { pattern: /timeout|ETIMEDOUT|timed out/i, type: 'timeout', suggestion: 'The operation timed out — retry or check connectivity' },
  { pattern: /\b(HTTP\s*)?4(?:04|03)\b|status(?:Code)?\s*[:=]\s*4(?:04|03)/i, type: 'http_error', suggestion: 'Resource not found or access denied — check the URL' },
  { pattern: /rate limit|429|too many requests/i, type: 'rate_limit', suggestion: 'Rate limited — wait before retrying' },
  { pattern: /(?:Error|Exception|Traceback)[\s:]+at\s+|Traceback \(most recent/i, type: 'stack_trace', suggestion: 'A runtime error occurred — read the stack trace for the root cause' },
  { pattern: /ENOMEM|out of memory|heap out of memory/i, type: 'out_of_memory', suggestion: 'Out of memory — reduce input size or free resources' },
];

/**
 * Detect a known error pattern in tool output.
 * Returns the matched pattern type and suggestion, or null if no match.
 */
export function detectErrorPattern(observation: string): { type: string; suggestion: string } | null {
  for (const ep of ERROR_PATTERNS) {
    if (ep.pattern.test(observation)) {
      return { type: ep.type, suggestion: ep.suggestion };
    }
  }
  return null;
}

/**
 * Enrich a tool observation with error pattern hints + past learnings.
 * Only prepends if an error pattern is actually detected.
 */
export function enrichObservation(
  observation: string,
  errorStore: ErrorLearningStore | undefined,
  toolName: string,
): string {
  const detected = detectErrorPattern(observation);
  if (!detected) return observation;

  let enrichment = `[Error pattern: ${detected.type}. ${detected.suggestion}`;

  // Search past learnings for this tool + pattern type
  if (errorStore) {
    const pastHints = errorStore.loadAll()
      .filter(e => e.tool === toolName && e.error.toLowerCase().includes(detected.type))
      .slice(-2)
      .map(e => e.error.slice(0, 100));
    if (pastHints.length > 0) {
      enrichment += `. Past: ${pastHints.join('; ')}`;
    }
  }

  enrichment += ']\n';
  return enrichment + observation;
}

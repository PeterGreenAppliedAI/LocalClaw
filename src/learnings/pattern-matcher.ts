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
 * Tool-specific recovery instructions — maps (toolName, errorType) → actionable guidance.
 * These override the generic suggestions in ERROR_PATTERNS when available.
 */
const TOOL_RECOVERY_MAP: Record<string, Record<string, string>> = {
  web_fetch: {
    http_error: 'URL returned 404/403. Use web_search to find the correct/current URL, or try an alternative domain.',
    timeout: 'Page took too long to load. Try web_search for a cached version, or use a simpler URL.',
    connection_refused: 'Server is unreachable. Use web_search to find an alternative source for this information.',
    rate_limit: 'Rate limited by this site. Wait 30s then retry, or use web_search for alternative sources.',
  },
  browser: {
    timeout: 'Page load timed out. Try browser with a wait action first, or navigate to a simpler page.',
    connection_refused: 'Cannot connect to browser. The Playwright service may not be running.',
    http_error: 'Page returned an error. Try navigating to the site root first, then follow links.',
  },
  exec: {
    permission_denied: 'Permission denied. If using allowlist mode, check the command is allowed. Try Docker backend if available.',
    timeout: 'Command timed out. Break the task into smaller steps or use a shorter-running command.',
    module_not_found: 'Module not found. Install it first: exec npm install <pkg> or exec pip install <pkg>.',
    out_of_memory: 'Out of memory. Reduce input size or process data in smaller chunks.',
  },
  web_search: {
    rate_limit: 'Search API rate limited. Wait 30s before retrying or simplify the query.',
    timeout: 'Search timed out. Retry with a shorter, simpler query.',
    connection_refused: 'Search API unreachable. Check API key and service availability.',
  },
  document: {
    timeout: 'Document creation timed out. Reduce content size or try a simpler format.',
    permission_denied: 'Cannot create document. Check LibreOffice is installed and accessible.',
  },
  image_generate: {
    timeout: 'Image generation timed out. Try a simpler prompt or smaller dimensions.',
    connection_refused: 'Image service unreachable. Check the image generation endpoint is running.',
  },
};

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

  // Tool-specific recovery takes priority over generic suggestion
  const toolRecovery = TOOL_RECOVERY_MAP[toolName]?.[detected.type];
  const suggestion = toolRecovery ?? detected.suggestion;

  let enrichment = `[Error pattern: ${detected.type}. ${suggestion}`;

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

import { Marked } from 'marked';

/**
 * Server-side markdown → HTML for deterministic report rendering.
 * GitHub-flavored (tables, fenced code, line breaks), synchronous, no external fetches.
 * The model writes markdown (its strength); code converts it to valid HTML (no LLM-authored HTML).
 */
const md = new Marked({
  gfm: true,
  breaks: false,
  async: false,
});

export function markdownToHtml(markdown: string): string {
  if (!markdown?.trim()) return '';
  return md.parse(markdown) as string;
}

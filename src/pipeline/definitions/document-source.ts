import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Persisted source markdown for a generated document, keyed by session.
 *
 * PDFs aren't editable in place — the only honest way to "add to the PDF" is to keep the
 * markdown that built it, merge the delta, and re-render the whole thing. The document pipeline
 * already builds this markdown before rendering; here we stop throwing it away. The most recent
 * document per session is "the PDF" the user means when they say "add a section to it".
 */
export interface DocSource {
  slug: string;
  title: string;
  markdown: string;
}

const SOURCE_DIR = 'data/media/documents/sources';

function sessionStorePath(sessionKey: string): string {
  const safe = (sessionKey || 'default').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  return join(SOURCE_DIR, `${safe}.json`);
}

/** Load the last document's source markdown for this session, or undefined if none/unreadable. */
export function loadDocSource(sessionKey: string): DocSource | undefined {
  try {
    const p = sessionStorePath(sessionKey);
    if (!existsSync(p)) return undefined;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as DocSource;
    return parsed?.markdown ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist this session's latest document source so a later "add to it" can regenerate from it. */
export function saveDocSource(sessionKey: string, src: DocSource): void {
  try {
    mkdirSync(SOURCE_DIR, { recursive: true });
    writeFileSync(sessionStorePath(sessionKey), JSON.stringify(src, null, 2));
  } catch (err) {
    console.warn('[Document] Failed to persist source markdown:', err instanceof Error ? err.message : err);
  }
}

// Add/modify verbs — the user wants to change an existing document, not start fresh.
const ADD_RE = /\b(add|append|include|expand|incorporate|insert|revise|update|extend|enhance|amend|append|more)\b/i;
// Back-reference to an existing artifact — "it", "that report", "the PDF", "the above".
const BACKREF_RE = /\b(pdf|document|doc|report|paper|guide|file|deck|slides?|it|that|this|previous|existing|earlier|above)\b/i;

/**
 * Decide whether a request is "modify the existing document" vs "create a new one".
 * Append only when a prior document exists AND the message both asks to add/change AND
 * refers back to an existing artifact. Create is the safe default — a fresh paste never
 * gets hijacked into an append.
 */
export function detectAppendIntent(message: string, hasPrior: boolean): boolean {
  if (!hasPrior || !message) return false;
  return ADD_RE.test(message) && BACKREF_RE.test(message);
}

/**
 * Evidence verification for the research pipeline.
 *
 * Principle: no claim should outrun its evidence. We extract atomic claims from the
 * drafted report, check each against the source it was actually built from (cited-source
 * only — no independent search), and where a claim overstates its source or rests on a
 * single weak source we attribute it ("according to X, …"), qualify, or remove it.
 *
 * This does NOT independently adjudicate truth — a source that is itself wrong is
 * faithfully attributed, not disproven (that needs a Tier-1 cross-check pass, deferred).
 */

export type Verdict =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'UNSUPPORTED'
  | 'VENDOR_CLAIM'
  | 'AMBIGUOUS';

export type ClaimAction = 'keep' | 'attribute' | 'qualify' | 'remove';

/** Claim types worth verifying. Opinions / explanations / forecasts are skipped. */
export const VERIFIABLE_TYPES = new Set([
  'financial',
  'market_share',
  'corporate_event',
  'product_spec',
  'benchmark',
]);

export interface Claim {
  claim_id: string;
  claim: string;
  claim_type: string;
  time_sensitive: boolean;
  entities: string[];
  date_scope?: string;
  requires_verification: boolean;
  /** The [n] citation index carried by the sentence; maps to a source URL. */
  citation?: number;
}

export interface VerificationResult {
  claim_id: string;
  claim: string;
  verdict: Verdict;
  cited_source?: string;
  supported_elements: string[];
  unsupported_elements: string[];
  evidence_sentence?: string;
  reason: string;
  recommended_action: ClaimAction;
}

/** Patch-set sent to the corrector: only failed claims, each with an edit instruction. */
export type PatchSet = Record<string, { verdict: Verdict; instruction: string }>;

// --- JSON parsing (handles arrays AND objects from thinking-capable models) ---

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\/no_?think/gi, '').trim();
}

/** Best-effort JSON extraction for an array or object embedded in LLM prose/fences. */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  const cleaned = stripThink(text);
  // Direct
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  // Find the first array or object and balance brackets
  const open = cleaned.search(/[[{]/);
  if (open === -1) return null;
  const openCh = cleaned[open];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < cleaned.length; i++) {
    if (cleaned[i] === openCh) depth++;
    else if (cleaned[i] === closeCh) depth--;
    if (depth === 0) {
      try { return JSON.parse(cleaned.slice(open, i + 1)) as T; } catch { return null; }
    }
  }
  return null;
}

// --- Claim extraction ---

export function extractClaimsPrompt(reportMarkdown: string, maxClaims: number): { system: string; user: string } {
  return {
    system: [
      'You extract ATOMIC, checkable factual claims from a research report so each can be verified against its source.',
      'Split compound sentences: a sentence with two facts becomes two claims (a source may support one half but not the other).',
      'Only extract claims that are stated as fact AND verifiable: financial figures, market-share, corporate events (acquisitions/IPOs/launches), product specs, benchmarks.',
      'Do NOT extract opinions, analysis, predictions/forecasts, or general technical explanations.',
      'For each claim capture the inline citation number it carries, e.g. a sentence ending in "[3]" → "citation": 3. If none, omit citation.',
      `Return ONLY a JSON array (max ${maxClaims} highest-impact claims), each:`,
      '{"claim_id":"claim-001","claim":"<one factual statement>","claim_type":"financial|market_share|corporate_event|product_spec|benchmark","time_sensitive":true,"entities":["NVIDIA"],"date_scope":"2025","requires_verification":true,"citation":3}',
      'Return ONLY the JSON array, no prose. /no_think',
    ].join('\n'),
    user: `Report:\n\n${reportMarkdown}`,
  };
}

export function parseClaims(raw: string, maxClaims: number): Claim[] {
  const arr = parseJsonLoose<unknown[]>(raw);
  if (!Array.isArray(arr)) return [];
  const claims: Claim[] = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (typeof o.claim !== 'string' || o.claim.trim().length < 8) continue;
    const claim_type = typeof o.claim_type === 'string' ? o.claim_type : 'unknown';
    if (!VERIFIABLE_TYPES.has(claim_type)) continue;
    claims.push({
      claim_id: typeof o.claim_id === 'string' ? o.claim_id : `claim-${String(claims.length + 1).padStart(3, '0')}`,
      claim: o.claim.trim(),
      claim_type,
      time_sensitive: o.time_sensitive === true,
      entities: Array.isArray(o.entities) ? o.entities.filter((e): e is string => typeof e === 'string') : [],
      date_scope: typeof o.date_scope === 'string' ? o.date_scope : undefined,
      requires_verification: o.requires_verification !== false,
      citation: typeof o.citation === 'number' ? o.citation : undefined,
    });
    if (claims.length >= maxClaims) break;
  }
  return claims;
}

// --- Source relevance (broader-corpus checking) ---

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'were', 'will', 'can', 'approximately', 'about', 'into', 'than', 'between', 'their', 'these', 'those', 'which']);

/** Claim tokens worth matching: words ≥4 chars + any token containing a digit (512gb, 92%, $20b, q4). */
function claimTokens(text: string): Set<string> {
  const toks = text.toLowerCase().match(/[a-z0-9$%.]+/g) ?? [];
  return new Set(toks.filter(t => (/\d/.test(t) || t.length >= 4) && !STOP.has(t)));
}

/**
 * Rank cached sources by how many of the claim's distinctive tokens they contain, and return
 * the top-k URLs. The report's [n] citations are unreliable (the model synthesizes across
 * sources), so we check a claim against the pages that actually mention it — not one cited URL.
 * `mustInclude` (the cited URL) is always kept if present.
 */
export function pickRelevantSources(claim: Claim, sourceText: Record<string, string>, k = 3, mustInclude?: string): string[] {
  const tokens = claimTokens(claim.claim);
  const scored = Object.entries(sourceText).map(([url, text]) => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of tokens) if (lower.includes(t)) score++;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter(s => s.score > 0).slice(0, k).map(s => s.url);
  if (mustInclude && sourceText[mustInclude] && !picked.includes(mustInclude)) {
    picked.unshift(mustInclude);
    if (picked.length > k) picked.pop();
  }
  return picked;
}

// --- Entailment judging ---

export function entailmentPrompt(claim: Claim, sources: Array<{ url: string; text: string }>): { system: string; user: string } {
  const blocks = sources.map((s, i) => `[Source ${i + 1}: ${s.url}]\n${s.text.slice(0, 3500)}`).join('\n\n---\n\n');
  return {
    system: [
      'You are a strict fact-checker. Decide whether ANY of the SOURCES below supports the CLAIM.',
      'Judge ONLY from the source text provided — do not use outside knowledge.',
      'Verdicts:',
      '- VERIFIED: a source clearly states the claim.',
      '- PARTIALLY_VERIFIED: a source supports part of the claim but not all of it.',
      '- UNSUPPORTED: none of the sources state the claim (even if plausible).',
      '- VENDOR_CLAIM: the figure/spec is the vendor\'s own marketing number, not an independent measurement.',
      '- AMBIGUOUS: the sources are unclear or could be read either way.',
      'recommended_action: keep (VERIFIED) | attribute (true but single/vendor source → "according to X") | qualify (partly supported, ambiguous, or not found → hedge the certainty). NEVER delete.',
      'In "source_url" put the URL of the source that supports the claim (empty if none).',
      'Return ONLY this JSON object:',
      '{"verdict":"...","source_url":"<supporting url or empty>","supported_elements":["..."],"unsupported_elements":["..."],"evidence_sentence":"<exact sentence from a source or empty>","reason":"<one sentence>","recommended_action":"keep|attribute|qualify"}',
      'Return ONLY JSON. /no_think',
    ].join('\n'),
    user: `CLAIM: ${claim.claim}\n\nSOURCES:\n${blocks}`,
  };
}

const VALID_VERDICTS: Verdict[] = ['VERIFIED', 'PARTIALLY_VERIFIED', 'UNSUPPORTED', 'VENDOR_CLAIM', 'AMBIGUOUS'];
const VALID_ACTIONS: ClaimAction[] = ['keep', 'attribute', 'qualify', 'remove'];

/**
 * Default action for a verdict. We never auto-REMOVE: a claim absent from its cited page
 * is usually true-but-misattributed (the report synthesizes across sources), so deletion
 * loses real information. Unsupported → hedge/attribute, never delete.
 */
export function verdictToAction(verdict: Verdict): ClaimAction {
  switch (verdict) {
    case 'VERIFIED': return 'keep';
    case 'VENDOR_CLAIM': return 'attribute';
    case 'PARTIALLY_VERIFIED': return 'qualify';
    case 'AMBIGUOUS': return 'qualify';
    case 'UNSUPPORTED': return 'qualify';
  }
}

export function parseVerdict(raw: string, claim: Claim, fallbackSource?: string): VerificationResult {
  const o = parseJsonLoose<Record<string, unknown>>(raw) ?? {};
  const verdict = VALID_VERDICTS.includes(o.verdict as Verdict) ? (o.verdict as Verdict) : 'AMBIGUOUS';
  let action = VALID_ACTIONS.includes(o.recommended_action as ClaimAction)
    ? (o.recommended_action as ClaimAction)
    : verdictToAction(verdict);
  // Never auto-delete — downgrade any 'remove' to a hedge.
  if (action === 'remove') action = 'qualify';
  const supportingUrl = typeof o.source_url === 'string' && o.source_url.trim() ? o.source_url.trim() : fallbackSource;
  return {
    claim_id: claim.claim_id,
    claim: claim.claim,
    verdict,
    cited_source: supportingUrl,
    supported_elements: Array.isArray(o.supported_elements) ? o.supported_elements.filter((e): e is string => typeof e === 'string') : [],
    unsupported_elements: Array.isArray(o.unsupported_elements) ? o.unsupported_elements.filter((e): e is string => typeof e === 'string') : [],
    evidence_sentence: typeof o.evidence_sentence === 'string' && o.evidence_sentence.trim() ? o.evidence_sentence.trim() : undefined,
    reason: typeof o.reason === 'string' ? o.reason : '',
    recommended_action: action,
  };
}

/** A claim needs a correction edit if it isn't cleanly verified-and-kept. */
export function needsCorrection(v: VerificationResult): boolean {
  return v.recommended_action !== 'keep';
}

export function buildPatchSet(results: VerificationResult[]): PatchSet {
  const patch: PatchSet = {};
  for (const v of results) {
    if (!needsCorrection(v)) continue;
    patch[v.claim_id] = { verdict: v.verdict, instruction: instructionFor(v) };
  }
  return patch;
}

function instructionFor(v: VerificationResult): string {
  const src = v.cited_source ? ` (source: ${v.cited_source})` : '';
  switch (v.recommended_action) {
    case 'attribute':
      return `Attribute this claim to its source${src} — phrase it as "According to <source>, …" rather than stating it as established fact. Do NOT delete the claim.`;
    case 'qualify':
      if (v.unsupported_elements.length > 0) {
        return `Partly supported: keep what is supported (${v.supported_elements.join('; ') || 'the supported part'}) and hedge or soften the unsupported part (${v.unsupported_elements.join('; ')}). Do NOT delete the whole claim.`;
      }
      return `This claim could not be confirmed on the available source(s)${src}. Hedge the certainty (e.g. "reportedly", "according to secondary reporting") rather than stating it as established fact. Do NOT delete it.`;
    default:
      return `Hedge this claim's certainty against its source${src}. Do NOT delete it.`;
  }
}

export function correctionPrompt(reportMarkdown: string, patch: PatchSet, claimText: Record<string, string>): { system: string; user: string } {
  const items = Object.entries(patch)
    .map(([id, p]) => `- [${p.verdict}] "${claimText[id] ?? id}"\n  → ${p.instruction}`)
    .join('\n');
  return {
    system: [
      'You are revising a research report to fix overstated or unsupported claims.',
      'Edit ONLY the sentences affected by the instructions below. Preserve all other text, headings, the `## Sources` list, and any `{{chart:...}}` placeholders VERBATIM.',
      'Do not add new factual claims. Do not change the structure. Keep markdown formatting and the existing [n] citation numbers.',
      'Return the FULL corrected report in markdown. /no_think',
    ].join('\n'),
    user: `Fix these claims:\n${items}\n\n---\nREPORT:\n${reportMarkdown}`,
  };
}

/** Markdown appendix summarizing what verification did, for the published report. */
export function verificationSection(results: VerificationResult[]): string {
  if (results.length === 0) return '';
  const corrected = results.filter(needsCorrection);
  const lines: string[] = ['', '## Verification', ''];
  if (corrected.length === 0) {
    lines.push(`All ${results.length} checkable claims were verified against their cited sources.`);
  } else {
    lines.push(`${results.length} claims checked against their cited sources; ${corrected.length} hedged or attributed:`);
    lines.push('');
    for (const v of corrected) {
      lines.push(`- **${v.verdict}** — ${v.claim} _(${v.recommended_action})_`);
    }
  }
  return lines.join('\n');
}

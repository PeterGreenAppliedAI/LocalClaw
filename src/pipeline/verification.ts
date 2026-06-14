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
  | 'AMBIGUOUS'
  | 'CONTRADICTED';   // set by the Tier-1 independent cross-check

export type ClaimAction = 'keep' | 'attribute' | 'qualify' | 'remove' | 'correct';

/** Outcome of an independent (Tier-1) cross-check against a freshly-searched source. */
export type Tier1Status = 'CONFIRMED' | 'CONTRADICTED' | 'SILENT';

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
  /** Independent cross-check result, when the claim was escalated to Tier-1. */
  tier1?: { status: Tier1Status; source_url?: string; evidence?: string; reason?: string };
}

export interface Tier1Result {
  status: Tier1Status;
  source_url?: string;
  evidence?: string;
  reason?: string;
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
      'PRIORITY: ALWAYS include every corporate event (acquisition, merger, IPO/public offering, major product launch, partnership — with its date, dollar amount, and the EXACT verb used e.g. "acquired" vs "licensed") and every market-share figure BEFORE any routine product price or spec. These named-deal/date/share claims are the highest stakes — never omit one to make room for a price.',
      'Do NOT extract opinions, analysis, predictions/forecasts, or general technical explanations.',
      'For each claim capture the inline citation number it carries, e.g. a sentence ending in "[3]" → "citation": 3. If none, omit citation.',
      `Return ONLY a JSON array (max ${maxClaims} claims, corporate events and market-share first, then highest-impact specs/figures):`,
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

const VALID_VERDICTS: Verdict[] = ['VERIFIED', 'PARTIALLY_VERIFIED', 'UNSUPPORTED', 'VENDOR_CLAIM', 'AMBIGUOUS', 'CONTRADICTED'];
const VALID_ACTIONS: ClaimAction[] = ['keep', 'attribute', 'qualify', 'remove', 'correct'];

/**
 * Default action for a verdict. We never auto-REMOVE: a claim absent from its cited page
 * is usually true-but-misattributed (the report synthesizes across sources), so deletion
 * loses real information. Unsupported → hedge/attribute, never delete. CONTRADICTED only
 * comes from the Tier-1 independent check, which has authoritative evidence to correct with.
 */
export function verdictToAction(verdict: Verdict): ClaimAction {
  switch (verdict) {
    case 'VERIFIED': return 'keep';
    case 'VENDOR_CLAIM': return 'attribute';
    case 'PARTIALLY_VERIFIED': return 'qualify';
    case 'AMBIGUOUS': return 'qualify';
    case 'UNSUPPORTED': return 'qualify';
    case 'CONTRADICTED': return 'correct';
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

// --- Tier-1 independent cross-check ---
// Cited-source verification can't disprove a faithfully-cited wrong fact (e.g. a wrong
// acquisition date). For a small set of high-impact, falsifiable claims we run ONE
// independent search against fresh sources to catch outright contradictions.

/**
 * High-impact, STABLE, falsifiable claim types worth an independent search: acquisitions,
 * IPOs, launches (corporate_event) and share figures (market_share). Deliberately excludes
 * `financial` — the extractor tags volatile product *prices* as financial, which waste the
 * cross-check budget and return junk (stock-ticker pages). Corporate events are exactly the
 * Groq-acquisition / Cerebras-IPO class we want to catch.
 */
const ESCALATE_TYPES = new Set(['corporate_event', 'market_share']);

export function shouldEscalate(claim: Claim): boolean {
  return ESCALATE_TYPES.has(claim.claim_type) && claim.entities.length > 0;
}

/**
 * Build an independent search query from the claim's entities + key non-numeric terms —
 * deliberately WITHOUT the contested value (date/figure), so the search finds the
 * authoritative source rather than echoes of the possibly-wrong number.
 */
const MAGNITUDE = new Set(['billion', 'million', 'trillion', 'thousand', 'percent']);

export function tier1Query(claim: Claim): string {
  const terms = [...claimTokens(claim.claim)]
    .filter(t => !/[\d$%]/.test(t) && !MAGNITUDE.has(t))
    .slice(0, 5);
  const entities = claim.entities.map(e => e.toLowerCase());
  return [...new Set([...entities, ...terms])].join(' ').trim();
}

export function tier1JudgePrompt(claim: Claim, sources: Array<{ url: string; text: string }>): { system: string; user: string } {
  const blocks = sources.map((s, i) => `[Source ${i + 1}: ${s.url}]\n${s.text.slice(0, 3500)}`).join('\n\n---\n\n');
  return {
    system: [
      'You are independently fact-checking ONE claim against freshly-retrieved sources.',
      'Focus on the SPECIFIC falsifiable detail in the claim — a date, a dollar figure, a percentage, or a characterization (e.g. "acquisition" vs "license").',
      'Status:',
      '- CONFIRMED: a source states the same specific detail as the claim.',
      '- CONTRADICTED: a source states a DIFFERENT specific detail (e.g. a different date or that it was a license, not an acquisition). Quote it.',
      '- SILENT: the sources do not address the specific detail.',
      'Be conservative: only CONTRADICTED when a source clearly states a conflicting fact. Judge ONLY from the sources.',
      'Return ONLY this JSON: {"status":"CONFIRMED|CONTRADICTED|SILENT","source_url":"<url or empty>","evidence":"<exact conflicting/confirming sentence or empty>","reason":"<one sentence>"}',
      'Return ONLY JSON. /no_think',
    ].join('\n'),
    user: `CLAIM: ${claim.claim}\n\nSOURCES:\n${blocks}`,
  };
}

const VALID_TIER1: Tier1Status[] = ['CONFIRMED', 'CONTRADICTED', 'SILENT'];

export function parseTier1(raw: string): Tier1Result {
  const o = parseJsonLoose<Record<string, unknown>>(raw) ?? {};
  const status = VALID_TIER1.includes(o.status as Tier1Status) ? (o.status as Tier1Status) : 'SILENT';
  return {
    status,
    source_url: typeof o.source_url === 'string' && o.source_url.trim() ? o.source_url.trim() : undefined,
    evidence: typeof o.evidence === 'string' && o.evidence.trim() ? o.evidence.trim() : undefined,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
  };
}

/**
 * Fold a Tier-1 result into a claim's verification result.
 * CONTRADICTED → escalate to a correction with the independent evidence.
 * CONFIRMED → if the cited-source pass had only hedged it, we can keep it (un-hedge).
 * SILENT → leave the cited-source verdict untouched.
 */
export function applyTier1(v: VerificationResult, t: Tier1Result): VerificationResult {
  const next: VerificationResult = { ...v, tier1: t };
  if (t.status === 'CONTRADICTED') {
    next.verdict = 'CONTRADICTED';
    next.recommended_action = 'correct';
  } else if (t.status === 'CONFIRMED' && (v.recommended_action === 'qualify' || v.recommended_action === 'attribute')) {
    next.recommended_action = 'keep';
  }
  return next;
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
    case 'correct': {
      const ev = v.tier1?.evidence ? ` Independent evidence: "${v.tier1.evidence}"` : '';
      const url = v.tier1?.source_url ? ` (${v.tier1.source_url})` : src;
      return `An independent source CONTRADICTS this claim${url}. Correct the claim to match the independent evidence${ev} — fix the specific wrong detail (e.g. a date, figure, or "acquisition" vs "license"). Keep the rest of the sentence.`;
    }
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
      'Hedge CONCISELY: use at most ONE hedge per sentence (a single "According to <source>, …" OR one "reportedly"). Never stack qualifiers or repeat "reportedly" within a sentence. Keep the prose clean and readable.',
      'Do not add new factual claims. Do not delete claims. Do not change the structure. Keep markdown formatting and the existing [n] citation numbers.',
      'Return the FULL corrected report in markdown. /no_think',
    ].join('\n'),
    user: `Fix these claims:\n${items}\n\n---\nREPORT:\n${reportMarkdown}`,
  };
}

/** Markdown appendix summarizing what verification did, for the published report. */
export function verificationSection(results: VerificationResult[]): string {
  if (results.length === 0) return '';
  const corrected = results.filter(needsCorrection);
  const crossChecked = results.filter(v => v.tier1).length;
  const lines: string[] = ['', '## Verification', ''];
  const checkedNote = crossChecked > 0 ? ` (${crossChecked} cross-checked against independent sources)` : '';
  if (corrected.length === 0) {
    lines.push(`All ${results.length} checkable claims were verified against their cited sources${checkedNote}.`);
  } else {
    lines.push(`${results.length} claims checked${checkedNote}; ${corrected.length} corrected, hedged, or attributed:`);
    lines.push('');
    for (const v of corrected) {
      const note = v.recommended_action === 'correct' && v.tier1?.evidence ? ` — independent source: "${v.tier1.evidence}"` : '';
      lines.push(`- **${v.verdict}** — ${v.claim} _(${v.recommended_action})_${note}`);
    }
  }
  return lines.join('\n');
}

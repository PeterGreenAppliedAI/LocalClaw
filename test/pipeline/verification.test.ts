import { describe, it, expect } from 'vitest';
import {
  parseJsonLoose,
  parseClaims,
  parseVerdict,
  verdictToAction,
  needsCorrection,
  buildPatchSet,
  pickRelevantSources,
  verificationSection,
  shouldEscalate,
  tier1Query,
  parseTier1,
  applyTier1,
  type Claim,
  type VerificationResult,
  type Tier1Result,
} from '../../src/pipeline/verification.js';

describe('parseJsonLoose', () => {
  it('parses a bare array', () => {
    expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('extracts an array from prose + fences', () => {
    const txt = 'Sure! ```json\n[{"a":1}]\n``` done';
    expect(parseJsonLoose(txt)).toEqual([{ a: 1 }]);
  });
  it('strips <think> blocks and parses an object', () => {
    expect(parseJsonLoose('<think>hmm</think>{"verdict":"VERIFIED"}')).toEqual({ verdict: 'VERIFIED' });
  });
  it('returns null on garbage', () => {
    expect(parseJsonLoose('no json here')).toBeNull();
  });
});

describe('parseClaims', () => {
  it('keeps only verifiable claim types and caps at maxClaims', () => {
    const raw = JSON.stringify([
      { claim_id: 'claim-001', claim: 'NVIDIA held ~92% of the discrete GPU market in H1 2025.', claim_type: 'market_share', citation: 5 },
      { claim_id: 'claim-002', claim: 'Local inference is exciting and the future.', claim_type: 'opinion' },
      { claim_id: 'claim-003', claim: 'The RTX PRO 6000 has 96GB of VRAM.', claim_type: 'product_spec', citation: 1 },
    ]);
    const claims = parseClaims(raw, 12);
    expect(claims).toHaveLength(2); // opinion dropped
    expect(claims[0].citation).toBe(5);
    expect(claims.map(c => c.claim_type)).toEqual(['market_share', 'product_spec']);
  });

  it('respects the maxClaims cap', () => {
    const raw = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ claim: `Company ${i} reported $${i}B revenue in 2025.`, claim_type: 'financial' })),
    );
    expect(parseClaims(raw, 5)).toHaveLength(5);
  });

  it('returns [] for non-array / unparseable input', () => {
    expect(parseClaims('not json', 12)).toEqual([]);
    expect(parseClaims('{"claim":"x"}', 12)).toEqual([]);
  });
});

describe('verdictToAction', () => {
  it('maps verdicts to default actions and NEVER auto-removes', () => {
    expect(verdictToAction('VERIFIED')).toBe('keep');
    expect(verdictToAction('VENDOR_CLAIM')).toBe('attribute');
    expect(verdictToAction('PARTIALLY_VERIFIED')).toBe('qualify');
    expect(verdictToAction('UNSUPPORTED')).toBe('qualify'); // hedge, not delete
    expect(verdictToAction('AMBIGUOUS')).toBe('qualify');
    expect(verdictToAction('CONTRADICTED')).toBe('correct'); // Tier-1 only
  });
});

describe('Tier-1 independent cross-check', () => {
  const corporate: Claim = { claim_id: 't1', claim: "NVIDIA acquired Groq's LPU technology for $20 billion in December 2024.", claim_type: 'corporate_event', time_sensitive: true, entities: ['NVIDIA', 'Groq'], requires_verification: true };
  const spec: Claim = { claim_id: 't2', claim: 'The RTX 5090 has 32GB VRAM.', claim_type: 'product_spec', time_sensitive: false, entities: ['NVIDIA'], requires_verification: true };
  const noEntity: Claim = { claim_id: 't3', claim: 'The market grew 20% last year.', claim_type: 'market_share', time_sensitive: true, entities: [], requires_verification: true };

  it('escalates high-impact claims with entities, not specs or entity-less claims', () => {
    expect(shouldEscalate(corporate)).toBe(true);
    expect(shouldEscalate(spec)).toBe(false);       // product_spec not escalated
    expect(shouldEscalate(noEntity)).toBe(false);   // needs an entity to target
  });

  it('builds a query from entities + key terms, WITHOUT the contested number/date', () => {
    const q = tier1Query(corporate);
    expect(q).toContain('nvidia');
    expect(q).toContain('groq');
    expect(q).not.toMatch(/\$20|billion|2024/i); // contested value excluded so search finds the truth
  });

  it('parseTier1 defaults to SILENT on garbage and reads a CONTRADICTED verdict', () => {
    expect(parseTier1('junk').status).toBe('SILENT');
    const t = parseTier1(JSON.stringify({ status: 'CONTRADICTED', source_url: 'https://nvidia.com/news', evidence: 'NVIDIA licensed Groq tech in December 2025.', reason: 'Different date and it was a license.' }));
    expect(t.status).toBe('CONTRADICTED');
    expect(t.evidence).toMatch(/December 2025/);
  });

  it('applyTier1 CONTRADICTED escalates the claim to a correction', () => {
    const v: VerificationResult = { claim_id: 't1', claim: corporate.claim, verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' };
    const t: Tier1Result = { status: 'CONTRADICTED', source_url: 'https://nvidia.com/news', evidence: 'NVIDIA licensed Groq tech in December 2025.' };
    const out = applyTier1(v, t);
    expect(out.verdict).toBe('CONTRADICTED');
    expect(out.recommended_action).toBe('correct');
    expect(needsCorrection(out)).toBe(true);
    expect(out.tier1?.evidence).toMatch(/December 2025/);
  });

  it('applyTier1 CONFIRMED un-hedges a previously qualified claim', () => {
    const v: VerificationResult = { claim_id: 't1', claim: corporate.claim, verdict: 'AMBIGUOUS', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' };
    const out = applyTier1(v, { status: 'CONFIRMED' });
    expect(out.recommended_action).toBe('keep');
  });

  it('applyTier1 SILENT leaves the cited-source verdict untouched', () => {
    const v: VerificationResult = { claim_id: 't1', claim: corporate.claim, verdict: 'AMBIGUOUS', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' };
    const out = applyTier1(v, { status: 'SILENT' });
    expect(out.recommended_action).toBe('qualify');
    expect(out.tier1?.status).toBe('SILENT');
  });

  it('a corrected claim renders in the appendix with its independent evidence', () => {
    const results: VerificationResult[] = [
      { claim_id: 't1', claim: 'NVIDIA acquired Groq in December 2024.', verdict: 'CONTRADICTED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'correct', tier1: { status: 'CONTRADICTED', evidence: 'It was a license in December 2025.' } },
    ];
    const md = verificationSection(results);
    expect(md).toContain('CONTRADICTED');
    expect(md).toMatch(/independent source/i);
    expect(md).toContain('December 2025');
  });
});

describe('pickRelevantSources', () => {
  const sources = {
    'https://guide.example/hardware': 'The Mac Studio M3 Ultra can be configured with up to 512GB unified memory at 819 GB/s.',
    'https://blog.example/cloud': 'This post is about cloud AI versus local AI and CUDA tooling. No Apple specifics.',
    'https://news.example/market': 'NVIDIA holds roughly 92% of the discrete GPU market in 2025.',
  };
  const claim: Claim = { claim_id: 'c1', claim: 'The Mac Studio M3 Ultra can be configured with up to 512GB unified memory.', claim_type: 'product_spec', time_sensitive: false, entities: ['Apple'], requires_verification: true };

  it('ranks the source that actually mentions the claim first', () => {
    const picked = pickRelevantSources(claim, sources, 2);
    expect(picked[0]).toBe('https://guide.example/hardware');
  });

  it('always keeps the cited URL even if low-scoring', () => {
    const picked = pickRelevantSources(claim, sources, 1, 'https://blog.example/cloud');
    expect(picked).toContain('https://blog.example/cloud');
  });

  it('returns [] when no source shares tokens with the claim', () => {
    expect(pickRelevantSources(claim, { 'https://x/y': 'completely unrelated content about gardening' }, 3)).toEqual([]);
  });
});

describe('parseVerdict', () => {
  const claim: Claim = { claim_id: 'claim-014', claim: 'RTX PRO 6000 does 100-120 tok/s on 70B Q4.', claim_type: 'benchmark', time_sensitive: true, entities: ['NVIDIA'], requires_verification: true };

  it('parses a partial verdict and carries the cited source', () => {
    const raw = JSON.stringify({
      verdict: 'PARTIALLY_VERIFIED',
      supported_elements: ['96GB memory'],
      unsupported_elements: ['100-120 tok/s on 70B Q4'],
      evidence_sentence: 'The RTX PRO 6000 includes 96GB of memory.',
      reason: 'Spec supported; throughput not.',
      recommended_action: 'qualify',
    });
    const v = parseVerdict(raw, claim, 'https://nvidia.com/x');
    expect(v.verdict).toBe('PARTIALLY_VERIFIED');
    expect(v.recommended_action).toBe('qualify');
    expect(v.unsupported_elements).toContain('100-120 tok/s on 70B Q4');
    expect(v.cited_source).toBe('https://nvidia.com/x');
    expect(needsCorrection(v)).toBe(true);
  });

  it('falls back to AMBIGUOUS + default action on garbage', () => {
    const v = parseVerdict('the model rambled', claim);
    expect(v.verdict).toBe('AMBIGUOUS');
    expect(v.recommended_action).toBe(verdictToAction('AMBIGUOUS'));
  });

  it('a VERIFIED+keep claim does not need correction', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'VERIFIED', recommended_action: 'keep', reason: 'ok' }), claim);
    expect(needsCorrection(v)).toBe(false);
  });
});

describe('buildPatchSet', () => {
  it('includes only claims needing correction, hedging never deleting', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'A', verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' },
      { claim_id: 'b', claim: 'B', verdict: 'UNSUPPORTED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify', cited_source: 'https://blog.example/x' },
      { claim_id: 'c', claim: 'C', verdict: 'VENDOR_CLAIM', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'attribute' },
    ];
    const patch = buildPatchSet(results);
    expect(Object.keys(patch)).toEqual(['b', 'c']); // 'a' (kept) excluded
    expect(patch.b.verdict).toBe('UNSUPPORTED');
    expect(patch.b.instruction).toMatch(/hedge|do not delete/i);
    expect(patch.c.instruction).toMatch(/according to/i);
  });

  it('coerces a judge-returned remove action into a hedge (never deletes)', () => {
    const claim: Claim = { claim_id: 'x', claim: 'Some unsupported claim', claim_type: 'financial', time_sensitive: true, entities: [], requires_verification: true };
    const v = parseVerdict(JSON.stringify({ verdict: 'UNSUPPORTED', recommended_action: 'remove' }), claim);
    expect(v.recommended_action).toBe('qualify');
  });
});

describe('verificationSection', () => {
  it('shows an all-clear message when nothing needs correction', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'A', verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' },
    ];
    const md = verificationSection(results);
    expect(md).toContain('## Verification');
    expect(md).toMatch(/1 checkable claims were verified/);
  });

  it('lists hedged/attributed claims', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'Overstated throughput claim', verdict: 'PARTIALLY_VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' },
    ];
    const md = verificationSection(results);
    expect(md).toContain('PARTIALLY_VERIFIED');
    expect(md).toMatch(/hedged, or attributed/);
  });

  it('returns empty string when no claims were checked', () => {
    expect(verificationSection([])).toBe('');
  });
});

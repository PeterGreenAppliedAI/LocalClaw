import { describe, it, expect } from 'vitest';
import {
  parseJsonLoose,
  parseClaims,
  parseVerdict,
  verdictToAction,
  needsCorrection,
  buildPatchSet,
  diffClaimSets,
  verificationSection,
  type Claim,
  type VerificationResult,
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
  it('maps verdicts to default actions', () => {
    expect(verdictToAction('VERIFIED')).toBe('keep');
    expect(verdictToAction('VENDOR_CLAIM')).toBe('attribute');
    expect(verdictToAction('PARTIALLY_VERIFIED')).toBe('qualify');
    expect(verdictToAction('UNSUPPORTED')).toBe('remove');
    expect(verdictToAction('AMBIGUOUS')).toBe('attribute');
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
  it('includes only claims needing correction, with an instruction', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'A', verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' },
      { claim_id: 'b', claim: 'B', verdict: 'UNSUPPORTED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'remove', cited_source: 'https://blog.example/x' },
      { claim_id: 'c', claim: 'C', verdict: 'VENDOR_CLAIM', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'attribute' },
    ];
    const patch = buildPatchSet(results);
    expect(Object.keys(patch)).toEqual(['b', 'c']); // 'a' (kept) excluded
    expect(patch.b.verdict).toBe('UNSUPPORTED');
    expect(patch.b.instruction).toMatch(/does not support/i);
    expect(patch.c.instruction).toMatch(/according to/i);
  });
});

describe('diffClaimSets', () => {
  it('detects claims present after revision but not before', () => {
    const before: Claim[] = [{ claim_id: '1', claim: 'NVIDIA acquired Groq in December 2025.', claim_type: 'corporate_event', time_sensitive: true, entities: [], requires_verification: true }];
    const after: Claim[] = [
      { claim_id: '1', claim: 'According to the blog, NVIDIA acquired Groq in December 2025.', claim_type: 'corporate_event', time_sensitive: true, entities: [], requires_verification: true },
      { claim_id: '2', claim: 'The deal was worth exactly $20 billion in cash.', claim_type: 'financial', time_sensitive: true, entities: [], requires_verification: true },
    ];
    // claim 1 normalizes to a superset; the brand-new financial claim is flagged
    const added = diffClaimSets(before, after);
    expect(added).toContain('The deal was worth exactly $20 billion in cash.');
  });
});

describe('verificationSection', () => {
  it('shows an all-clear message when nothing needs correction', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'A', verdict: 'VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'keep' },
    ];
    const md = verificationSection(results, []);
    expect(md).toContain('## Verification');
    expect(md).toMatch(/1 checkable claims were verified/);
  });

  it('lists corrected claims and revision-added unverified claims', () => {
    const results: VerificationResult[] = [
      { claim_id: 'a', claim: 'Overstated throughput claim', verdict: 'PARTIALLY_VERIFIED', supported_elements: [], unsupported_elements: [], reason: '', recommended_action: 'qualify' },
    ];
    const md = verificationSection(results, ['A brand new claim added in revision']);
    expect(md).toContain('PARTIALLY_VERIFIED');
    expect(md).toContain('A brand new claim added in revision');
  });

  it('returns empty string when no claims were checked', () => {
    expect(verificationSection([], [])).toBe('');
  });
});

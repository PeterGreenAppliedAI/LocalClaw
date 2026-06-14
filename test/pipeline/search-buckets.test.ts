import { describe, it, expect } from 'vitest';
import { detectBucket, getBucketSources, buildSiteFilter, prioritizeUrls } from '../../src/pipeline/search-buckets.js';

describe('search-buckets', () => {
  describe('detectBucket', () => {
    it('classifies property/real-estate queries as real_estate', () => {
      expect(detectBucket('off-market properties in Huntington Station')).toBe('real_estate');
      expect(detectBucket('commercial real estate parcels')).toBe('real_estate');
      expect(detectBucket('foreclosure listings near me')).toBe('real_estate');
      expect(detectBucket('zoning for this lot')).toBe('real_estate');
    });

    it('real_estate wins over finance when both could match (market keyword)', () => {
      // "real estate market" contains "market" (finance) but real_estate pattern precedes finance
      expect(detectBucket('off market real estate deals')).toBe('real_estate');
    });

    it('still routes pure finance queries to finance', () => {
      expect(detectBucket('NVIDIA stock earnings')).toBe('finance');
    });

    it('routes GPU/hardware queries to hardware even when they mention inference', () => {
      // Regression: "AMD/NVIDIA hardware for local inference" used to hit ai_tech
      // (ai_tech "inference" matched before hardware), missing the hardware press.
      expect(detectBucket('AMD hardware and NVIDIA hardware for local inference')).toBe('hardware');
      expect(detectBucket('DGX Spark vs Strix Halo for local LLMs')).toBe('hardware');
      expect(detectBucket('RTX 5090 laptop benchmarks')).toBe('hardware');
    });

    it('does not let hardware steal finance (NVIDIA stock) or pure-AI queries', () => {
      expect(detectBucket('NVIDIA stock earnings Q2')).toBe('finance');
      expect(detectBucket('how does transformer inference work')).toBe('ai_tech');
    });

    it('returns null for unclassified queries', () => {
      expect(detectBucket('how do I tie a bowtie')).toBeNull();
    });
  });

  describe('buildSiteFilter anchors', () => {
    it('ALWAYS includes real_estate anchor (civic open data) across many calls', () => {
      for (let i = 0; i < 50; i++) {
        const filter = buildSiteFilter('real_estate');
        expect(filter).toContain('site:data.cityofnewyork.us');
        expect(filter).toContain('site:data.ny.gov');
      }
    });

    it('includes a mix beyond anchors (samples the rest)', () => {
      // Over many calls, at least one non-anchor listing site should appear
      const seen = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const f = buildSiteFilter('real_estate') ?? '';
        for (const d of ['loopnet.com', 'crexi.com', 'zillow.com', 'realtor.com', 'streeteasy.com', 'acris.nyc.gov', 'propertyshark.com']) {
          if (f.includes(`site:${d}`)) seen.add(d);
        }
      }
      expect(seen.size).toBeGreaterThan(0);
    });

    it('returns null for unknown bucket', () => {
      expect(buildSiteFilter('nonexistent')).toBeNull();
    });

    it('finance bucket can surface civic data (non-anchor, rotated in)', () => {
      let civicSeen = false;
      for (let i = 0; i < 100; i++) {
        const f = buildSiteFilter('finance', 6) ?? '';
        if (f.includes('site:data.cityofnewyork.us')) { civicSeen = true; break; }
      }
      expect(civicSeen).toBe(true);
    });
  });

  describe('prioritizeUrls', () => {
    it('puts curated bucket domains first', () => {
      const urls = [
        'https://randomblog.com/post',
        'https://data.cityofnewyork.us/dataset/123',
        'https://loopnet.com/listing/456',
      ];
      const result = prioritizeUrls(urls, 'real_estate');
      expect(result[0]).toContain('data.cityofnewyork.us');
      expect(result[result.length - 1]).toContain('randomblog.com');
    });

    it('returns urls unchanged when bucket is null', () => {
      const urls = ['https://a.com', 'https://b.com'];
      expect(prioritizeUrls(urls, null)).toEqual(urls);
    });
  });

  describe('getBucketSources', () => {
    it('returns the domain list for a known bucket', () => {
      expect(getBucketSources('real_estate')).toContain('data.cityofnewyork.us');
    });
    it('returns empty for unknown bucket', () => {
      expect(getBucketSources('nope')).toEqual([]);
    });
  });
});

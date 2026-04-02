import { describe, it, expect } from 'vitest';

// DriftTracker is private to engine.ts — test the behavior via exported signals
// We replicate the logic here for unit testing since we can't import a private class

class DriftTracker {
  private responseLengths: number[] = [];
  private lastToolSigs: string[] = [];
  private hedgingCount = 0;

  private static readonly HEDGING = /\b(I think|perhaps|maybe|I believe|let me try|I'm not sure|it seems|I'll try)\b/gi;
  private static readonly RESTATING = /\b(you asked|your question|the original|going back to|as I mentioned)\b/i;

  checkDrift(response: string, toolCall?: { tool: string; params: Record<string, unknown> }): 'none' | 'growing' | 'repeating' | 'hedging' {
    this.responseLengths.push(response.length);
    if (this.responseLengths.length > 3) this.responseLengths.shift();

    if (toolCall) {
      const sig = toolCall.tool + ':' + JSON.stringify(toolCall.params);
      this.lastToolSigs.push(sig);
      if (this.lastToolSigs.length > 3) this.lastToolSigs.shift();

      if (this.lastToolSigs.length >= 2 &&
          this.lastToolSigs[this.lastToolSigs.length - 1] === this.lastToolSigs[this.lastToolSigs.length - 2]) {
        return 'repeating';
      }
    }

    const hedges = response.match(DriftTracker.HEDGING);
    if (hedges) this.hedgingCount += hedges.length;
    if (DriftTracker.RESTATING.test(response)) this.hedgingCount++;
    if (this.hedgingCount >= 4) return 'hedging';

    if (this.responseLengths.length >= 3) {
      const [a, b, c] = this.responseLengths;
      if (c > a * 1.5 && c > b * 1.5 && !toolCall) {
        return 'growing';
      }
    }

    return 'none';
  }
}

describe('DriftTracker', () => {
  it('detects repeating tool calls', () => {
    const tracker = new DriftTracker();
    const call = { tool: 'web_search', params: { query: 'test' } };

    expect(tracker.checkDrift('step 1', call)).toBe('none');
    expect(tracker.checkDrift('step 2', call)).toBe('repeating');
  });

  it('does not flag different tool calls as repeating', () => {
    const tracker = new DriftTracker();

    expect(tracker.checkDrift('step 1', { tool: 'web_search', params: { query: 'a' } })).toBe('none');
    expect(tracker.checkDrift('step 2', { tool: 'web_search', params: { query: 'b' } })).toBe('none');
    expect(tracker.checkDrift('step 3', { tool: 'web_fetch', params: { url: 'x' } })).toBe('none');
  });

  it('detects hedging language', () => {
    const tracker = new DriftTracker();

    tracker.checkDrift('I think this might work');
    tracker.checkDrift('Perhaps I should try a different approach. Maybe the original question was about something else.');
    const result = tracker.checkDrift("I'm not sure, let me try again. I believe this is the right path.");
    expect(result).toBe('hedging');
  });

  it('detects growing responses without progress', () => {
    const tracker = new DriftTracker();

    tracker.checkDrift('a'.repeat(100)); // baseline
    tracker.checkDrift('b'.repeat(100)); // stable
    const result = tracker.checkDrift('c'.repeat(200)); // 2x growth, no tool call
    expect(result).toBe('growing');
  });

  it('does not flag growing when tool calls are happening', () => {
    const tracker = new DriftTracker();

    tracker.checkDrift('a'.repeat(100), { tool: 'search', params: {} });
    tracker.checkDrift('b'.repeat(100), { tool: 'fetch', params: {} });
    const result = tracker.checkDrift('c'.repeat(200), { tool: 'reason', params: {} });
    // Growing check requires no toolCall — this has one, so it shouldn't flag
    expect(result).toBe('none');
  });

  it('returns none for normal progression', () => {
    const tracker = new DriftTracker();

    expect(tracker.checkDrift('Thought: searching', { tool: 'web_search', params: { query: 'AI' } })).toBe('none');
    expect(tracker.checkDrift('Thought: fetching', { tool: 'web_fetch', params: { url: 'http://x.com' } })).toBe('none');
    expect(tracker.checkDrift('Here are the results')).toBe('none');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDebouncer } from '../../src/services/message-debouncer.js';
import type { InboundMessage } from '../../src/channels/types.js';

function textMsg(id: string, content: string): InboundMessage {
  return { id, channel: 'telegram', senderId: 'user1', content } as InboundMessage;
}

describe('MessageDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes short standalone messages through immediately (no latency)', () => {
    const d = new MessageDebouncer(1200, 3500);
    expect(d.tryBatch(textMsg('a', 'turn this into a PDF'), () => {})).toBe(false);
  });

  it('reassembles split fragments into one message', () => {
    const d = new MessageDebouncer(1200, 100); // low threshold for the test
    const released: InboundMessage[] = [];
    const onReady = (m: InboundMessage) => { d.tryBatch(m, onReady); released.push(m); };

    const part1 = 'A'.repeat(150) + ' first chunk';
    const part2 = 'B'.repeat(150) + ' second chunk';
    expect(d.tryBatch(textMsg('a', part1), onReady)).toBe(true);  // large → opens batch
    expect(d.tryBatch(textMsg('b', part2), onReady)).toBe(true);  // appended to open batch
    expect(released).toHaveLength(0);

    vi.advanceTimersByTime(1200);
    expect(released).toHaveLength(1);
    expect(released[0].content).toContain('first chunk');
    expect(released[0].content).toContain('second chunk');
  });

  it('appends even a short trailing fragment to an open batch', () => {
    const d = new MessageDebouncer(1200, 100);
    const released: InboundMessage[] = [];
    const onReady = (m: InboundMessage) => { d.tryBatch(m, onReady); released.push(m); };

    d.tryBatch(textMsg('a', 'X'.repeat(150)), onReady);   // opens batch
    expect(d.tryBatch(textMsg('b', 'make a PDF'), onReady)).toBe(true); // short, but batch is open
    vi.advanceTimersByTime(1200);
    expect(released[0].content).toContain('make a PDF');
  });

  it('does NOT re-collect a released batch (no infinite loop)', () => {
    const d = new MessageDebouncer(1200, 100);
    let dispatches = 0;
    const onReady = (m: InboundMessage) => {
      if (!d.tryBatch(m, onReady)) dispatches++;
    };
    d.tryBatch(textMsg('a', 'Y'.repeat(200)), onReady);
    vi.advanceTimersByTime(1200);
    vi.advanceTimersByTime(10000);
    expect(dispatches).toBe(1);
  });

  it('ignores empty/media-only messages', () => {
    const d = new MessageDebouncer(1200, 100);
    expect(d.tryBatch(textMsg('a', '   '), () => {})).toBe(false);
  });
});

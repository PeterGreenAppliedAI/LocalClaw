import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaDebouncer } from '../../src/services/media-debouncer.js';
import type { InboundMessage } from '../../src/channels/types.js';

function imgMsg(id: string): InboundMessage {
  return {
    id,
    channel: 'telegram',
    senderId: 'user1',
    content: '',
    attachments: [{ type: 'image', path: `/tmp/${id}.jpg`, mimeType: 'image/jpeg' } as any],
  } as InboundMessage;
}

describe('MediaDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collects a media-only message and releases it once after the window', () => {
    const d = new MediaDebouncer(3000);
    const released: InboundMessage[] = [];
    const onReady = (m: InboundMessage) => { d.tryBatch(m, onReady); released.push(m); };

    const collected = d.tryBatch(imgMsg('a'), onReady);
    expect(collected).toBe(true);        // first pass: collected, not dispatched
    expect(released).toHaveLength(0);

    vi.advanceTimersByTime(3000);        // timer fires → onReady
    expect(released).toHaveLength(1);    // released exactly once
  });

  it('does NOT re-debounce a released batch (no infinite loop)', () => {
    const d = new MediaDebouncer(3000);
    let dispatches = 0;
    // Mirror the orchestrator: onBatchReady re-enters tryBatch, then processes.
    const onReady = (m: InboundMessage) => {
      const reCollected = d.tryBatch(m, onReady);
      if (!reCollected) dispatches++;    // released message proceeds to real processing
    };

    d.tryBatch(imgMsg('a'), onReady);
    vi.advanceTimersByTime(3000);        // fire the batch
    // Run any (incorrectly) scheduled follow-up timers — should be none
    vi.advanceTimersByTime(10000);

    expect(dispatches).toBe(1);          // processed exactly once, no loop
  });

  it('passes through non-media messages immediately', () => {
    const d = new MediaDebouncer(3000);
    const textMsg = { id: 't', channel: 'telegram', senderId: 'user1', content: 'hello there' } as InboundMessage;
    expect(d.tryBatch(textMsg, () => {})).toBe(false);
  });
});

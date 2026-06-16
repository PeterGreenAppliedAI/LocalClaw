/**
 * Message debouncer — reassembles split text pastes from the same sender.
 *
 * Channels like Telegram cap a single message at ~4096 chars, so a long paste arrives as
 * several messages within a few hundred ms. Without this, each fragment is routed and
 * dispatched independently — and the router, timing out on each big chunk, keyword-matches
 * whatever stray word is in that fragment, so one job scatters into exec/personal/message/etc.
 *
 * Only LARGE messages open a batch (a likely split fragment); short standalone messages pass
 * through immediately with no added latency.
 */
import type { InboundMessage } from '../channels/types.js';

const DEFAULT_WINDOW_MS = 1200;
const DEFAULT_SPLIT_THRESHOLD = 3500; // near Telegram's 4096 cap → probably the head of a split

interface PendingText {
  msg: InboundMessage;
  parts: string[];
  timer: ReturnType<typeof setTimeout>;
}

export class MessageDebouncer {
  private pending = new Map<string, PendingText>();

  constructor(
    private windowMs = DEFAULT_WINDOW_MS,
    private splitThreshold = DEFAULT_SPLIT_THRESHOLD,
  ) {}

  /**
   * Returns true if the message was collected (caller should NOT dispatch). When the window
   * elapses, onReady fires with the reassembled message.
   */
  tryBatch(msg: InboundMessage, onReady: (batched: InboundMessage) => void): boolean {
    // A released batch passes straight through — never re-collect it (infinite-loop guard).
    if ((msg as { _textBatched?: boolean })._textBatched) return false;
    // Media-only messages belong to the MediaDebouncer, not here.
    if (!msg.content?.trim()) return false;

    const key = `${msg.channel}:${msg.senderId}`;
    const existing = this.pending.get(key);

    if (existing) {
      existing.parts.push(msg.content);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(key, onReady), this.windowMs);
      return true;
    }

    // Only open a batch for a large message (likely a split fragment).
    if (msg.content.length >= this.splitThreshold) {
      this.pending.set(key, {
        msg,
        parts: [msg.content],
        timer: setTimeout(() => this.flush(key, onReady), this.windowMs),
      });
      return true;
    }

    return false;
  }

  private flush(key: string, onReady: (batched: InboundMessage) => void): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    p.msg.content = p.parts.join('\n');
    (p.msg as { _textBatched?: boolean })._textBatched = true;
    if (p.parts.length > 1) {
      console.log(`[MessageDebouncer] Reassembled ${p.parts.length} split fragments (${p.msg.content.length} chars) from ${p.msg.senderId}`);
    }
    onReady(p.msg);
  }
}

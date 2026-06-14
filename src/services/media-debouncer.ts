/**
 * Media debouncer — batches rapid media-only messages from the same sender.
 * Collects attachments within a time window, then dispatches as one message.
 * Extracted from orchestrator.
 */
import type { InboundMessage, Attachment } from '../channels/types.js';

const DEFAULT_WINDOW_MS = 3000; // 3 seconds

interface PendingBatch {
  attachments: Attachment[];
  timer: ReturnType<typeof setTimeout>;
  msg: InboundMessage;
}

export class MediaDebouncer {
  private pending = new Map<string, PendingBatch>();
  private windowMs: number;

  constructor(windowMs = DEFAULT_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Check if a message should be debounced.
   * Returns true if the message was collected (caller should NOT dispatch).
   * Returns false if the message should proceed normally.
   * When the batch timer fires, it calls onBatchReady with the combined message.
   */
  tryBatch(msg: InboundMessage, onBatchReady: (batchedMsg: InboundMessage) => void): boolean {
    // A released batch is still media-only — without this guard it would be
    // re-collected and re-fired forever (infinite loop). Let it pass through.
    if ((msg as { _debounced?: boolean })._debounced) return false;

    // Only debounce media-only messages (attachments but no meaningful text)
    const isMediaOnly = msg.attachments?.length && (!msg.content?.trim() || msg.content.trim().length < 5);
    if (!isMediaOnly) return false;

    const key = `${msg.channel}:${msg.senderId}`;
    const existing = this.pending.get(key);

    if (existing) {
      // Add to existing batch, reset timer
      existing.attachments.push(...(msg.attachments ?? []));
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.pending.delete(key);
        existing.msg.attachments = existing.attachments;
        (existing.msg as { _debounced?: boolean })._debounced = true;
        console.log(`[MediaDebouncer] Batch: ${existing.attachments.length} attachment(s) from ${msg.senderId}`);
        onBatchReady(existing.msg);
      }, this.windowMs);
    } else {
      // Start new batch
      const timer = setTimeout(() => {
        const p = this.pending.get(key);
        if (!p) return;
        this.pending.delete(key);
        (p.msg as { _debounced?: boolean })._debounced = true;
        console.log(`[MediaDebouncer] Batch: ${p.attachments.length} attachment(s) from ${msg.senderId}`);
        onBatchReady(p.msg);
      }, this.windowMs);
      this.pending.set(key, {
        attachments: [...(msg.attachments ?? [])],
        timer,
        msg: { ...msg },
      });
    }

    return true; // Message collected, don't dispatch yet
  }
}

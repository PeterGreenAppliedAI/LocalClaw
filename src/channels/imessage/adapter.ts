import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';
import { IMessageConfigSchema } from '../../config/schema.js';
import type { IMessageConfig, IMessageContactOverride } from '../../config/types.js';

const IMESSAGE_MAX_LENGTH = 10_000;
const POLL_INTERVAL_MS = 3_000;
const HOUR_MS = 60 * 60 * 1000;

type IMessageMode = IMessageConfig['mode'];

interface BlueBubblesMessage {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  dateCreated: number;
  handle?: { address: string };
  chats?: Array<{ guid: string; displayName?: string }>;
  attachments?: Array<{
    guid: string;
    filename: string;
    mimeType: string;
    totalBytes?: number;
  }>;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly id = 'imessage';
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private hourlyResetTimer: ReturnType<typeof setInterval> | null = null;

  // Connection
  private baseUrl = '';
  private password = '';
  private lastPollTimestamp = 0;

  // Gating config
  private mode: IMessageMode = 'silent';
  private prefix = '!claw';
  private groupsEnabled = false;
  private groupsRequirePrefix = true;
  private allowSet = new Set<string>();
  private denySet = new Set<string>();
  private contactOverrides = new Map<string, IMessageContactOverride>();

  // Cooldown
  private cooldownPerContactMs = 30_000;
  private cooldownGlobalMs = 5_000;
  private maxPerContactPerHour = 20;
  private lastResponsePerContact = new Map<string, number>();
  private responseCountsThisHour = new Map<string, number>();
  private lastGlobalResponseTime = 0;

  // Monitoring
  private logMessages = true;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    // Parse iMessage-specific config with Zod validation
    let parsed: IMessageConfig;
    try {
      parsed = IMessageConfigSchema.parse(config);
    } catch (err) {
      throw channelConnectError('imessage', err);
    }

    this.baseUrl = parsed.url.replace(/\/+$/, '');
    this.password = parsed.password;
    this.currentStatus = 'connecting';

    // Apply gating config
    this.mode = parsed.mode;
    this.prefix = parsed.prefix;
    this.groupsEnabled = parsed.groups.enabled;
    this.groupsRequirePrefix = parsed.groups.requirePrefix;
    this.allowSet = new Set(parsed.contacts.allow);
    this.denySet = new Set(parsed.contacts.deny);
    this.contactOverrides = new Map(Object.entries(parsed.contacts.overrides));
    this.cooldownPerContactMs = parsed.cooldown.perContactMs;
    this.cooldownGlobalMs = parsed.cooldown.globalMs;
    this.maxPerContactPerHour = parsed.cooldown.maxPerContactPerHour;
    this.logMessages = parsed.monitor.logMessages;

    // Verify BlueBubbles is reachable
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/ping?password=${this.password}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`BlueBubbles returned ${res.status}`);
    } catch (err) {
      this.currentStatus = 'error';
      throw channelConnectError('imessage', err);
    }

    // Set poll baseline to now
    this.lastPollTimestamp = Date.now();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.warn('[iMessage] Poll error:', err instanceof Error ? err.message : err);
      });
    }, POLL_INTERVAL_MS);

    // Reset hourly counters
    this.hourlyResetTimer = setInterval(() => {
      this.responseCountsThisHour.clear();
    }, HOUR_MS);

    this.currentStatus = 'connected';
    console.log(`[iMessage] Connected to BlueBubbles at ${this.baseUrl} (mode: ${this.mode})`);
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.hourlyResetTimer) {
      clearInterval(this.hourlyResetTimer);
      this.hourlyResetTimer = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (this.currentStatus !== 'connected') {
      throw channelSendError('imessage', new Error('Not connected'));
    }

    try {
      // Send file attachments via BlueBubbles multipart endpoint
      if (content.attachments?.length) {
        for (const att of content.attachments) {
          try {
            const form = new FormData();
            form.append('chatGuid', target.channelId);
            form.append('tempGuid', `temp-${randomUUID()}`);
            form.append('message', '');
            form.append('attachment', new Blob([att.data], { type: att.mimeType }), att.filename);

            const res = await fetch(
              `${this.baseUrl}/api/v1/message/attachment?password=${this.password}`,
              { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) },
            );
            if (!res.ok) {
              const body = await res.text().catch(() => '');
              console.warn(`[iMessage] Attachment send failed (${res.status}): ${body}`);
            }
          } catch (attErr) {
            console.warn('[iMessage] Attachment send failed:', attErr instanceof Error ? attErr.message : attErr);
          }
        }
      }

      // Send text
      const chunks = splitMessage(content.text, IMESSAGE_MAX_LENGTH);
      for (const chunk of chunks) {
        const res = await fetch(
          `${this.baseUrl}/api/v1/message/text?password=${this.password}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chatGuid: target.channelId,
              tempGuid: `temp-${randomUUID()}`,
              message: chunk,
            }),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Send failed (${res.status}): ${body}`);
        }
      }
    } catch (err) {
      throw channelSendError('imessage', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  // --- Gating ---

  private shouldRespond(sender: string, text: string, isGroup: boolean): { respond: boolean; strippedText: string } {
    const result = { respond: false, strippedText: text };

    // Group gate
    if (isGroup && !this.groupsEnabled) return result;

    // Resolve effective mode (per-contact override takes precedence)
    const override = this.contactOverrides.get(sender);
    const effectiveMode = override?.mode ?? this.mode;
    const effectivePrefix = override?.prefix ?? this.prefix;

    // Mode gate
    switch (effectiveMode) {
      case 'silent':
        return result;

      case 'allowlist':
        if (!this.allowSet.has(sender)) return result;
        break;

      case 'denylist':
        if (this.denySet.has(sender)) return result;
        break;

      case 'prefix': {
        const lower = text.toLowerCase();
        const prefixLower = effectivePrefix.toLowerCase();
        if (!lower.startsWith(prefixLower)) return result;
        // Strip the prefix from the text
        result.strippedText = text.slice(effectivePrefix.length).trim();
        break;
      }

      case 'auto':
        // Auto still respects deny list
        if (this.denySet.has(sender)) return result;
        break;
    }

    // Group prefix gate — groups always require prefix unless disabled
    if (isGroup && this.groupsRequirePrefix && effectiveMode !== 'prefix') {
      const lower = text.toLowerCase();
      const prefixLower = this.prefix.toLowerCase();
      if (!lower.startsWith(prefixLower)) return result;
      result.strippedText = text.slice(this.prefix.length).trim();
    }

    // Cooldown gates
    const now = Date.now();

    // Global cooldown
    if (now - this.lastGlobalResponseTime < this.cooldownGlobalMs) return result;

    // Per-contact cooldown
    const effectiveCooldown = override?.cooldownMs ?? this.cooldownPerContactMs;
    const lastContact = this.lastResponsePerContact.get(sender) ?? 0;
    if (now - lastContact < effectiveCooldown) return result;

    // Hourly cap
    const hourCount = this.responseCountsThisHour.get(sender) ?? 0;
    if (this.maxPerContactPerHour > 0 && hourCount >= this.maxPerContactPerHour) return result;

    result.respond = true;
    return result;
  }

  private recordResponse(sender: string): void {
    const now = Date.now();
    this.lastGlobalResponseTime = now;
    this.lastResponsePerContact.set(sender, now);
    this.responseCountsThisHour.set(sender, (this.responseCountsThisHour.get(sender) ?? 0) + 1);
  }

  // --- Polling ---

  private async poll(): Promise<void> {
    if (!this.handler) return;

    const res = await fetch(
      `${this.baseUrl}/api/v1/message?password=${this.password}&limit=25&sort=ASC&after=${this.lastPollTimestamp}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return;

    const json = (await res.json()) as { data: BlueBubblesMessage[] };
    const messages = json.data ?? [];

    for (const msg of messages) {
      // Always advance the timestamp
      this.updatePollTimestamp(msg.dateCreated);

      // Skip own messages
      if (msg.isFromMe) continue;

      const text = msg.text?.trim() ?? '';
      if (!text && (!msg.attachments || msg.attachments.length === 0)) continue;

      const senderAddress = msg.handle?.address ?? 'unknown';
      const chatGuid = msg.chats?.[0]?.guid ?? `any;-;${senderAddress}`;
      const isGroup = chatGuid.includes(';+;');

      // Monitor logging (always, regardless of mode)
      if (this.logMessages) {
        const tag = isGroup ? 'group' : 'DM';
        console.log(`[iMessage] ${tag} from ${senderAddress}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);
      }

      // Gating check
      const gate = this.shouldRespond(senderAddress, text, isGroup);
      if (!gate.respond) continue;

      // Download attachments
      const attachments = await this.downloadAttachments(msg.attachments);

      const inbound: InboundMessage = {
        id: msg.guid,
        channel: 'imessage',
        content: gate.strippedText,
        senderId: senderAddress,
        senderName: msg.chats?.[0]?.displayName,
        channelId: chatGuid,
        guildId: isGroup ? chatGuid : undefined,
        timestamp: new Date(msg.dateCreated),
        raw: msg,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      try {
        await this.handler(inbound);
        this.recordResponse(senderAddress);
      } catch (err) {
        console.warn('[iMessage] Handler error:', err instanceof Error ? err.message : err);
      }
    }
  }

  private updatePollTimestamp(dateCreated: number): void {
    if (dateCreated > this.lastPollTimestamp) {
      this.lastPollTimestamp = dateCreated;
    }
  }

  private async downloadAttachments(
    raw?: BlueBubblesMessage['attachments'],
  ): Promise<Attachment[]> {
    if (!raw || raw.length === 0) return [];

    const attachments: Attachment[] = [];
    for (const att of raw) {
      try {
        const res = await fetch(
          `${this.baseUrl}/api/v1/attachment/${att.guid}/download?password=${this.password}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) continue;

        const buffer = Buffer.from(await res.arrayBuffer());
        attachments.push({
          filename: att.filename ?? 'attachment',
          mimeType: att.mimeType ?? 'application/octet-stream',
          size: buffer.length,
          data: buffer,
        });
      } catch (err) {
        console.warn('[iMessage] Failed to download attachment:', err instanceof Error ? err.message : err);
      }
    }
    return attachments;
  }
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit / 2) {
      splitAt = remaining.lastIndexOf(' ', limit);
    }
    if (splitAt === -1 || splitAt < limit / 2) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

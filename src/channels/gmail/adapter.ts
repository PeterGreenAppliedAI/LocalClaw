import { google } from 'googleapis';
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
import { createOAuth2Client } from './auth.js';

const POLL_INTERVAL_MS = 30_000;

export class GmailAdapter implements ChannelAdapter {
  readonly id = 'gmail';
  private gmail: any = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;

    try {
      const auth = createOAuth2Client();
      this.gmail = google.gmail({ version: 'v1', auth });
    } catch (err) {
      throw channelConnectError('gmail', err);
    }

    // Start polling for unread messages
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error('[Gmail] Poll error:', err instanceof Error ? err.message : err);
      });
    }, POLL_INTERVAL_MS);

    // Run first poll immediately
    this.poll().catch((err) => {
      console.error('[Gmail] Initial poll error:', err instanceof Error ? err.message : err);
    });

    this.currentStatus = 'connected';
    console.log('[Gmail] Adapter started (polling every 30s)');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.gmail) {
      throw channelSendError('gmail', new Error('Not connected'));
    }

    try {
      const to = target.channelId; // channelId holds the recipient email
      const subject = target.threadId ?? 'Re: LocalClaw';
      const raw = buildRawEmail(to, subject, content.text);

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });
    } catch (err) {
      throw channelSendError('gmail', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  private async poll(): Promise<void> {
    if (!this.gmail || !this.handler) return;

    const res = await this.gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10,
    });

    const messages = res.data.messages ?? [];

    for (const stub of messages) {
      const full = await this.gmail.users.messages.get({
        userId: 'me',
        id: stub.id,
        format: 'full',
      });

      const headers = full.data.payload?.headers ?? [];
      const from = getHeader(headers, 'From') ?? '';
      const subject = getHeader(headers, 'Subject') ?? '';
      const senderEmail = extractEmail(from);

      // allowFrom filtering on sender email
      if (this.allowFrom?.users?.length) {
        if (!this.allowFrom.users.includes(senderEmail)) {
          // Mark as read even if filtered out, to avoid re-processing
          await this.markAsRead(stub.id);
          continue;
        }
      }

      const body = extractBody(full.data.payload);
      const content = subject ? `[${subject}] ${body}` : body;

      // Extract attachments
      const attachments: Attachment[] = [];
      const attParts = findAttachmentParts(full.data.payload);
      for (const part of attParts) {
        try {
          const attData = await this.gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: stub.id,
            id: part.body.attachmentId,
          });
          if (attData.data?.data) {
            const buffer = Buffer.from(attData.data.data, 'base64url');
            attachments.push({
              filename: part.filename ?? 'attachment',
              mimeType: part.mimeType ?? 'application/octet-stream',
              size: buffer.length,
              data: buffer,
            });
          }
        } catch (err) {
          console.error(`[Gmail] Failed to download attachment ${part.filename}:`, err instanceof Error ? err.message : err);
        }
      }

      const inbound: InboundMessage = {
        id: stub.id,
        channel: 'gmail',
        content,
        senderId: senderEmail,
        senderName: from.replace(/<.*>/, '').trim() || senderEmail,
        channelId: senderEmail,
        threadId: full.data.threadId,
        timestamp: new Date(parseInt(full.data.internalDate, 10)),
        raw: full.data,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await this.handler(inbound);
      await this.markAsRead(stub.id);
    }
  }

  private async markAsRead(messageId: string): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
  }
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function extractEmail(from: string): string {
  const match = from.match(/<(.+?)>/);
  return match ? match[1] : from.trim();
}

function extractBody(payload: any): string {
  if (!payload) return '';

  // Simple text/plain body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8').trim();
  }

  // Multipart — find text/plain part
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  return '';
}

function findAttachmentParts(payload: any): any[] {
  const parts: any[] = [];
  if (!payload) return parts;

  if (payload.body?.attachmentId && payload.filename) {
    parts.push(payload);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      parts.push(...findAttachmentParts(part));
    }
  }

  return parts;
}

function buildRawEmail(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

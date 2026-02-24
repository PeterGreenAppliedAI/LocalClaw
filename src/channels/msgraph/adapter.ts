import type { Client } from '@microsoft/microsoft-graph-client';
import type {
  Attachment as ChannelAttachment,
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';
import { createGraphClient } from './auth.js';

const POLL_INTERVAL_MS = 30_000;

export class MsGraphAdapter implements ChannelAdapter {
  readonly id = 'msgraph';
  private client: Client | null = null;
  private userId: string = '';
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    const userId = (config as any).userId ?? process.env.MSGRAPH_USER_ID;
    if (!userId) {
      throw channelConnectError('msgraph', new Error('Missing MSGRAPH_USER_ID'));
    }

    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;
    this.userId = userId;

    try {
      this.client = createGraphClient();
    } catch (err) {
      throw channelConnectError('msgraph', err);
    }

    // Start polling for unread messages
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error('[MsGraph] Poll error:', err instanceof Error ? err.message : err);
      });
    }, POLL_INTERVAL_MS);

    // Run first poll immediately
    this.poll().catch((err) => {
      console.error('[MsGraph] Initial poll error:', err instanceof Error ? err.message : err);
    });

    this.currentStatus = 'connected';
    console.log('[MsGraph] Adapter started (polling every 30s)');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.client) {
      throw channelSendError('msgraph', new Error('Not connected'));
    }

    try {
      await this.client.api(`/users/${this.userId}/sendMail`).post({
        message: {
          subject: target.threadId ?? 'LocalClaw',
          body: {
            contentType: 'Text',
            content: content.text,
          },
          toRecipients: [
            {
              emailAddress: { address: target.channelId },
            },
          ],
        },
      });
    } catch (err) {
      throw channelSendError('msgraph', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.handler) return;

    const res = await this.client
      .api(`/users/${this.userId}/mailFolders/inbox/messages`)
      .filter('isRead eq false')
      .top(10)
      .select('id,subject,body,from,receivedDateTime,conversationId,hasAttachments')
      .get();

    const messages = res.value ?? [];

    for (const msg of messages) {
      const senderEmail: string = msg.from?.emailAddress?.address ?? '';
      const senderName: string = msg.from?.emailAddress?.name ?? senderEmail;

      // allowFrom filtering on sender email
      if (this.allowFrom?.users?.length) {
        if (!this.allowFrom.users.includes(senderEmail)) {
          await this.markAsRead(msg.id);
          continue;
        }
      }

      const subject = msg.subject ?? '';
      const body = (msg.body?.content ?? '').replace(/<[^>]+>/g, '').trim();
      const content = subject ? `[${subject}] ${body}` : body;

      // Fetch attachments
      const attachments: ChannelAttachment[] = [];
      if (msg.hasAttachments) {
        try {
          const attRes = await this.client!
            .api(`/users/${this.userId}/messages/${msg.id}/attachments`)
            .get();
          for (const att of attRes.value ?? []) {
            if (att.contentBytes) {
              const buffer = Buffer.from(att.contentBytes, 'base64');
              attachments.push({
                filename: att.name ?? 'attachment',
                mimeType: att.contentType ?? 'application/octet-stream',
                size: buffer.length,
                data: buffer,
              });
            }
          }
        } catch (err) {
          console.error('[MsGraph] Failed to fetch attachments:', err instanceof Error ? err.message : err);
        }
      }

      const inbound: InboundMessage = {
        id: msg.id,
        channel: 'msgraph',
        content,
        senderId: senderEmail,
        senderName,
        channelId: senderEmail,
        threadId: msg.conversationId,
        timestamp: new Date(msg.receivedDateTime),
        raw: msg,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await this.handler(inbound);
      await this.markAsRead(msg.id);
    }
  }

  private async markAsRead(messageId: string): Promise<void> {
    await this.client!.api(`/users/${this.userId}/messages/${messageId}`).patch({
      isRead: true,
    });
  }
}

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

const SLACK_MAX_LENGTH = 4000;

export class SlackAdapter implements ChannelAdapter {
  readonly id = 'slack';
  private app: any = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];
  private botToken: string = '';

  async connect(config: ChannelAdapterConfig): Promise<void> {
    const botToken = config.token ?? (config as any).botToken;
    const appToken = (config as any).appToken;

    if (!botToken || !appToken) {
      throw channelConnectError('slack', new Error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN'));
    }

    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;
    this.botToken = botToken;

    let bolt: any;
    try {
      bolt = await import('@slack/bolt');
    } catch {
      throw channelConnectError('slack', new Error('@slack/bolt not installed. Run: npm i @slack/bolt'));
    }

    this.app = new bolt.App({
      token: botToken,
      appToken,
      socketMode: true,
    });

    // Listen for @mentions
    this.app.event('app_mention', async ({ event, say }: any) => {
      if (!this.handler) return;
      if (!this.isAllowed(event)) return;

      const content = (event.text as string)
        .replace(/<@[A-Z0-9]+>/g, '')
        .trim();

      const attachments = await this.downloadSlackFiles(event.files);
      if (!content && attachments.length === 0) return;

      const inbound: InboundMessage = {
        id: event.ts,
        channel: 'slack',
        content,
        senderId: event.user,
        channelId: event.channel,
        threadId: event.thread_ts ?? event.ts,
        timestamp: new Date(parseFloat(event.ts) * 1000),
        raw: event,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await this.handler(inbound);
    });

    // Listen for DMs
    this.app.event('message', async ({ event, say }: any) => {
      if (!this.handler) return;
      // Only handle DMs (channel type 'im'), skip bot messages and subtypes
      if (event.channel_type !== 'im') return;
      if (event.bot_id || event.subtype) return;
      if (!this.isAllowed(event)) return;

      const content = (event.text as string).trim();

      const attachments = await this.downloadSlackFiles(event.files);
      if (!content && attachments.length === 0) return;

      const inbound: InboundMessage = {
        id: event.ts,
        channel: 'slack',
        content,
        senderId: event.user,
        channelId: event.channel,
        threadId: event.thread_ts ?? event.ts,
        timestamp: new Date(parseFloat(event.ts) * 1000),
        raw: event,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await this.handler(inbound);
    });

    // Slack Bolt handles WebSocket reconnection internally in Socket Mode.
    // Catch unhandled errors to update status.
    this.app.error(async (err: any) => {
      console.warn('[Slack] App error:', err.message ?? err);
      this.currentStatus = 'error';
    });

    await this.app.start();
    this.currentStatus = 'connected';
    console.log('[Slack] Bot started (Socket Mode)');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.app) {
      throw channelSendError('slack', new Error('Not connected'));
    }

    try {
      // Upload audio file if present
      if (content.audio) {
        try {
          await this.app.client.files.uploadV2({
            channel_id: target.channelId,
            file: content.audio.data,
            filename: 'response.ogg',
            thread_ts: target.threadId,
          });
        } catch (uploadErr) {
          console.warn('[Slack] CHANNEL_SEND_ERROR: Audio upload failed —', uploadErr instanceof Error ? uploadErr.message : uploadErr);
        }
      }

      // Send file attachments
      if (content.attachments?.length) {
        for (const att of content.attachments) {
          try {
            await this.app.client.files.uploadV2({
              channel_id: target.channelId,
              file: att.data,
              filename: att.filename,
              thread_ts: target.threadId,
            });
          } catch (attErr) {
            console.warn('[Slack] Attachment upload failed:', attErr instanceof Error ? attErr.message : attErr);
          }
        }
      }

      const chunks = splitMessage(content.text, SLACK_MAX_LENGTH);
      for (const chunk of chunks) {
        await this.app.client.chat.postMessage({
          channel: target.channelId,
          text: chunk,
          thread_ts: target.threadId,
        });
      }
    } catch (err) {
      throw channelSendError('slack', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  private async downloadSlackFiles(files?: any[]): Promise<Attachment[]> {
    if (!files || files.length === 0) return [];

    const attachments: Attachment[] = [];
    for (const file of files) {
      if (!file.url_private) continue;
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          attachments.push({
            filename: file.name ?? 'file',
            mimeType: file.mimetype ?? 'application/octet-stream',
            size: buffer.length,
            data: buffer,
          });
        }
      } catch (err) {
        console.warn(`[Slack] CHANNEL_CONNECT_ERROR: Failed to download file ${file.name} —`, err instanceof Error ? err.message : err);
      }
    }
    return attachments;
  }

  private isAllowed(event: any): boolean {
    if (!this.allowFrom) return true;

    if (this.allowFrom.channels?.length) {
      if (!this.allowFrom.channels.includes(event.channel)) return false;
    }
    if (this.allowFrom.users?.length) {
      if (!this.allowFrom.users.includes(event.user)) return false;
    }
    return true;
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

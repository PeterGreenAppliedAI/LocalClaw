import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';

const WHATSAPP_MAX_LENGTH = 4096;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp';
  private client: any = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];

  async connect(config: ChannelAdapterConfig): Promise<void> {
    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;

    let wweb: any;
    try {
      const mod = 'whatsapp-web.js';
      wweb = await import(/* webpackIgnore: true */ mod);
    } catch {
      throw channelConnectError('whatsapp', new Error('whatsapp-web.js not installed. Run: npm i whatsapp-web.js'));
    }

    const { Client, LocalAuth } = wweb;

    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: { headless: true, args: ['--no-sandbox'] },
    });

    this.client.on('qr', (qr: string) => {
      console.log('[WhatsApp] Scan QR code to connect:');
      console.log(qr);
    });

    this.client.on('ready', () => {
      this.currentStatus = 'connected';
      console.log('[WhatsApp] Client ready');
    });

    this.client.on('authenticated', () => {
      console.log('[WhatsApp] Authenticated');
    });

    this.client.on('auth_failure', (err: any) => {
      this.currentStatus = 'error';
      console.error('[WhatsApp] Auth failure:', err);
    });

    this.client.on('disconnected', (reason: string) => {
      this.currentStatus = 'disconnected';
      console.log('[WhatsApp] Disconnected:', reason);
    });

    this.client.on('message', async (msg: any) => {
      if (!this.handler) return;

      // Skip status broadcasts and own messages
      if (msg.from === 'status@broadcast') return;
      if (msg.fromMe) return;

      // allowFrom filtering by phone number
      const senderId = msg.from;
      if (this.allowFrom?.users?.length) {
        if (!this.allowFrom.users.includes(senderId)) return;
      }

      // Build inbound message
      let content = msg.body ?? '';
      let audio: { data: Buffer; mimeType: string } | undefined;

      // Handle voice messages
      if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            audio = {
              data: Buffer.from(media.data, 'base64'),
              mimeType: media.mimetype,
            };
          }
        } catch (err) {
          console.error('[WhatsApp] Failed to download voice message:', err instanceof Error ? err.message : err);
        }
      }

      const contact = await msg.getContact().catch(() => null);
      const chat = await msg.getChat().catch(() => null);

      const inbound: InboundMessage = {
        id: msg.id._serialized ?? msg.id.id,
        channel: 'whatsapp',
        content,
        senderId,
        senderName: contact?.pushname ?? contact?.name ?? senderId,
        channelId: msg.from,
        guildId: chat?.isGroup ? msg.from : undefined,
        timestamp: new Date(msg.timestamp * 1000),
        raw: msg,
        audio,
      };

      await this.handler(inbound);
    });

    await this.client.initialize();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy().catch(() => {});
      this.client = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.client) {
      throw channelSendError('whatsapp', new Error('Not connected'));
    }

    try {
      // Send audio if present
      if (content.audio) {
        let wweb: any;
        try {
          const mod = 'whatsapp-web.js';
          wweb = await import(/* webpackIgnore: true */ mod);
        } catch {
          // Fall through to text-only
        }
        if (wweb) {
          const { MessageMedia } = wweb;
          const base64 = content.audio.data.toString('base64');
          const media = new MessageMedia(content.audio.mimeType, base64, 'response.ogg');
          await this.client.sendMessage(target.channelId, media, { sendAudioAsVoice: true });
        }
      }

      // Always send text
      const chunks = splitMessage(content.text, WHATSAPP_MAX_LENGTH);
      for (const chunk of chunks) {
        await this.client.sendMessage(target.channelId, chunk);
      }
    } catch (err) {
      throw channelSendError('whatsapp', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
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

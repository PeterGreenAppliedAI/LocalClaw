import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';

const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';
  private bot: any = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';

  async connect(config: ChannelAdapterConfig): Promise<void> {
    if (!config.token) {
      throw channelConnectError('telegram', new Error('Missing token'));
    }

    this.currentStatus = 'connecting';

    let grammy: any;
    try {
      // Dynamic import to avoid hard dependency
      const mod = 'grammy';
      grammy = await import(/* webpackIgnore: true */ mod);
    } catch {
      throw channelConnectError('telegram', new Error('grammy not installed. Run: npm i grammy'));
    }

    const bot = new grammy.Bot(config.token);
    this.bot = bot;

    bot.on('message:text', async (ctx: any) => {
      if (!this.handler) return;

      const msg = ctx.message;
      const inbound: InboundMessage = {
        id: String(msg.message_id),
        channel: 'telegram',
        content: msg.text,
        senderId: String(msg.from.id),
        senderName: msg.from.first_name,
        channelId: String(msg.chat.id),
        timestamp: new Date(msg.date * 1000),
        raw: msg,
      };

      await this.handler(inbound);
    });

    bot.start();
    this.currentStatus = 'connected';
    console.log('[Telegram] Bot started');
  }

  async disconnect(): Promise<void> {
    if (this.bot && typeof this.bot.stop === 'function') {
      this.bot.stop();
    }
    this.bot = null;
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.bot) {
      throw channelSendError('telegram', new Error('Not connected'));
    }

    try {
      // Send voice message if audio is present
      if (content.audio) {
        try {
          const mod = 'grammy';
          const grammy = await import(/* webpackIgnore: true */ mod);
          const inputFile = new grammy.InputFile(content.audio.data, 'response.ogg');
          await this.bot.api.sendVoice(
            target.channelId,
            inputFile,
            { reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined },
          );
        } catch {
          // Ignore audio send failure, text will still be sent
        }
      }

      const chunks = splitTelegramMessage(content.text, TELEGRAM_MAX_LENGTH);
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(target.channelId, chunk, {
          reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined,
        });
      }
    } catch (err) {
      throw channelSendError('telegram', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }
}

function splitTelegramMessage(text: string, limit: number): string[] {
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

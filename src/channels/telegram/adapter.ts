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

    bot.on('message', async (ctx: any) => {
      if (!this.handler) return;

      const msg = ctx.message;
      const content = msg.text ?? msg.caption ?? '';

      // Download photo/document attachments
      const attachments: Attachment[] = [];

      if (msg.photo && msg.photo.length > 0) {
        try {
          // Use the largest photo size (last in array)
          const photo = msg.photo[msg.photo.length - 1];
          const file = await bot.api.getFile(photo.file_id);
          const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const ext = file.file_path?.split('.').pop() ?? 'jpg';
            attachments.push({
              filename: `photo.${ext}`,
              mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
              size: buffer.length,
              data: buffer,
            });
          }
        } catch (err) {
          console.warn('[Telegram] CHANNEL_CONNECT_ERROR: Failed to download photo —', err instanceof Error ? err.message : err);
        }
      }

      if (msg.document) {
        try {
          const file = await bot.api.getFile(msg.document.file_id);
          const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            attachments.push({
              filename: msg.document.file_name ?? 'document',
              mimeType: msg.document.mime_type ?? 'application/octet-stream',
              size: buffer.length,
              data: buffer,
            });
          }
        } catch (err) {
          console.warn('[Telegram] CHANNEL_CONNECT_ERROR: Failed to download document —', err instanceof Error ? err.message : err);
        }
      }

      // Download voice messages (OGG/Opus) for STT processing
      let audio: { data: Buffer; mimeType: string } | undefined;
      const voiceFile = msg.voice ?? msg.video_note;
      if (voiceFile) {
        try {
          const file = await bot.api.getFile(voiceFile.file_id);
          const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
          const res = await fetch(url);
          if (res.ok) {
            audio = {
              data: Buffer.from(await res.arrayBuffer()),
              mimeType: 'audio/ogg',
            };
            console.log(`[Telegram] Voice message: ${audio.data.length} bytes (${voiceFile.duration}s)`);
          }
        } catch (err) {
          console.warn('[Telegram] Failed to download voice message:', err instanceof Error ? err.message : err);
        }
      }

      if (!content && !audio && attachments.length === 0) return;

      const inbound: InboundMessage = {
        id: String(msg.message_id),
        channel: 'telegram',
        content,
        senderId: String(msg.from.id),
        senderName: msg.from.first_name,
        channelId: String(msg.chat.id),
        timestamp: new Date(msg.date * 1000),
        raw: msg,
        audio,
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      await this.handler(inbound);
    });

    // grammy's bot.start() handles long-polling with automatic retry on transient errors.
    // Catch fatal errors (e.g., invalid token) and update status.
    bot.catch((err: any) => {
      console.warn('[Telegram] Bot error:', err.message ?? err);
      this.currentStatus = 'error';
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
      // Send voice/audio message if present
      if (content.audio) {
        try {
          const mod = 'grammy';
          const grammy = await import(/* webpackIgnore: true */ mod);
          const replyOpts = { reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined };

          if (content.audio.mimeType === 'audio/ogg') {
            // OGG/Opus → sendVoice (plays inline as voice note)
            const inputFile = new grammy.InputFile(content.audio.data, 'response.ogg');
            await this.bot.api.sendVoice(target.channelId, inputFile, replyOpts);
          } else {
            // MP3/WAV → sendAudio (plays as audio file)
            const ext = content.audio.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
            const inputFile = new grammy.InputFile(content.audio.data, `response.${ext}`);
            await this.bot.api.sendAudio(target.channelId, inputFile, replyOpts);
          }
        } catch (err) {
          console.warn('[Telegram] Audio send failed:', err instanceof Error ? err.message : err);
        }
      }

      // Send image attachments
      if (content.attachments) {
        try {
          const mod = 'grammy';
          const grammy = await import(/* webpackIgnore: true */ mod);
          const replyOpts = { reply_to_message_id: target.replyToId ? Number(target.replyToId) : undefined };
          for (const att of content.attachments) {
            if (att.mimeType.startsWith('image/')) {
              const inputFile = new grammy.InputFile(att.data, att.filename);
              await this.bot.api.sendPhoto(target.channelId, inputFile, replyOpts);
            } else {
              const inputFile = new grammy.InputFile(att.data, att.filename);
              await this.bot.api.sendDocument(target.channelId, inputFile, replyOpts);
            }
          }
        } catch (err) {
          console.warn('[Telegram] Attachment send failed:', err instanceof Error ? err.message : err);
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

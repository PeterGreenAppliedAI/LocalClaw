import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
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

const WHATSAPP_MAX_LENGTH = 4096;
const AUTH_DIR = '.baileys_auth';
const MAX_MESSAGE_AGE_MS = 60_000; // Ignore messages older than 60s (history sync)
const RECONNECT_DELAY_MS = 3_000;

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp';
  private sock: WASocket | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];
  private startedAt = 0;
  private config: ChannelAdapterConfig | null = null;
  private reconnecting = false;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;
    this.config = config;
    this.startedAt = Date.now();

    await this.createSocket();

    // Wait for first connection or QR
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 30_000);

      const handler = (update: any) => {
        if (update.connection === 'open') {
          clearTimeout(timeout);
          this.sock?.ev.off('connection.update', handler);
          resolve();
        }
        if (update.connection === 'close') {
          const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            this.sock?.ev.off('connection.update', handler);
            reject(channelConnectError('whatsapp', new Error('Logged out — delete .baileys_auth and restart')));
          }
        }
        if (update.qr) {
          clearTimeout(timeout);
          this.sock?.ev.off('connection.update', handler);
          resolve();
        }
      };

      this.sock?.ev.on('connection.update', handler);
    });
  }

  private async createSocket(): Promise<void> {
    // Clean up old socket before creating a new one
    if (this.sock) {
      try { this.sock.end(undefined); } catch { /* ignore */ }
      this.sock = null;
    }

    const authDir = join(process.cwd(), AUTH_DIR);
    mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      generateHighQualityLinkPreview: false,
    });

    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WhatsApp] Scan QR code with WhatsApp > Linked Devices > Link a Device:');
        console.log('[WhatsApp] QR data length:', qr.length, 'preview:', qr.slice(0, 50));
        try {
          const require = createRequire(import.meta.url);
          const qrt = require('qrcode-terminal');
          qrt.generate(qr, { small: true });
        } catch {
          console.log(qr);
        }
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          this.currentStatus = 'connecting';
          this.scheduleReconnect();
        } else {
          console.log('[WhatsApp] Logged out');
          this.currentStatus = 'disconnected';
        }
      } else if (connection === 'open') {
        this.currentStatus = 'connected';
        this.reconnecting = false;
        console.log('[WhatsApp] Connected');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!this.handler) return;

      for (const msg of messages) {
        try {
          await this.handleMessage(msg);
        } catch (err) {
          console.warn('[WhatsApp] CHANNEL_CONNECT_ERROR: Message handling error —', err instanceof Error ? err.message : err);
        }
      }
    });
  }

  private scheduleReconnect(): void {
    // Prevent multiple overlapping reconnect attempts
    if (this.reconnecting) return;
    this.reconnecting = true;

    console.log(`[WhatsApp] Connection lost, reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);

    setTimeout(async () => {
      try {
        await this.createSocket();
      } catch (err) {
        console.warn('[WhatsApp] CHANNEL_CONNECT_ERROR: Reconnect failed —', err instanceof Error ? err.message : err);
        this.currentStatus = 'error';
        this.reconnecting = false;
      }
    }, RECONNECT_DELAY_MS);
  }

  private async handleMessage(msg: WAMessage): Promise<void> {
    if (!this.handler) return;
    if (!msg.message || !msg.key) return;
    if (msg.key.fromMe) return;

    // Ignore old messages (history sync replay)
    const msgTimestamp = (msg.messageTimestamp as number) * 1000;
    if (msgTimestamp < this.startedAt - MAX_MESSAGE_AGE_MS) return;

    const senderId = msg.key.remoteJid ?? '';

    // Skip status broadcasts
    if (senderId === 'status@broadcast') return;

    // allowFrom filtering
    if (this.allowFrom?.users?.length) {
      if (!this.allowFrom.users.includes(senderId)) return;
    }

    // Extract text content (including captions from images/documents)
    const content =
      msg.message.conversation ??
      msg.message.extendedTextMessage?.text ??
      msg.message.imageMessage?.caption ??
      msg.message.documentMessage?.caption ??
      '';

    // Handle audio/voice messages
    let audio: { data: Buffer; mimeType: string } | undefined;
    const audioMsg = msg.message.audioMessage;
    if (audioMsg) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        audio = {
          data: buffer as Buffer,
          mimeType: audioMsg.mimetype ?? 'audio/ogg',
        };
      } catch (err) {
        console.warn('[WhatsApp] CHANNEL_CONNECT_ERROR: Failed to download audio —', err instanceof Error ? err.message : err);
      }
    }

    // Handle image attachments
    const attachments: Attachment[] = [];
    const imageMsg = msg.message.imageMessage;
    if (imageMsg) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        attachments.push({
          filename: 'image.' + (imageMsg.mimetype?.split('/')[1]?.split(';')[0] ?? 'jpeg'),
          mimeType: imageMsg.mimetype ?? 'image/jpeg',
          size: (buffer as Buffer).length,
          data: buffer as Buffer,
        });
      } catch (err) {
        console.warn('[WhatsApp] CHANNEL_CONNECT_ERROR: Failed to download image —', err instanceof Error ? err.message : err);
      }
    }

    // Handle document attachments
    const docMsg = msg.message.documentMessage;
    if (docMsg) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        attachments.push({
          filename: docMsg.fileName ?? 'document',
          mimeType: docMsg.mimetype ?? 'application/octet-stream',
          size: (buffer as Buffer).length,
          data: buffer as Buffer,
        });
      } catch (err) {
        console.warn('[WhatsApp] CHANNEL_CONNECT_ERROR: Failed to download document —', err instanceof Error ? err.message : err);
      }
    }

    const isGroup = senderId.endsWith('@g.us');
    const pushName = msg.pushName ?? senderId;

    const inbound: InboundMessage = {
      id: msg.key.id ?? '',
      channel: 'whatsapp',
      content,
      senderId,
      senderName: pushName,
      channelId: senderId,
      guildId: isGroup ? senderId : undefined,
      timestamp: new Date((msg.messageTimestamp as number) * 1000),
      raw: msg,
      audio,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    await this.handler(inbound);
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.sock) {
      throw channelSendError('whatsapp', new Error('Not connected'));
    }

    try {
      // Send audio if present
      if (content.audio) {
        const mimetype = 'audio/ogg; codecs=opus';
        try {
          await this.sock.sendMessage(target.channelId, {
            audio: content.audio.data,
            mimetype,
            ptt: true,
          });
        } catch (audioErr) {
          console.warn('[WhatsApp] CHANNEL_SEND_ERROR: Audio send failed —', audioErr instanceof Error ? audioErr.message : audioErr);
        }
      }

      // Send file attachments
      if (content.attachments?.length) {
        for (const att of content.attachments) {
          try {
            const isImage = att.mimeType.startsWith('image/');
            await this.sock.sendMessage(target.channelId, isImage
              ? { image: att.data, mimetype: att.mimeType, caption: att.filename }
              : { document: att.data, mimetype: att.mimeType, fileName: att.filename },
            );
          } catch (attErr) {
            console.warn('[WhatsApp] Attachment send failed:', attErr instanceof Error ? attErr.message : attErr);
          }
        }
      }

      // Send text (skip if audio was sent — voice in → voice only out)
      if (!content.audio) {
        const chunks = splitMessage(content.text, WHATSAPP_MAX_LENGTH);
        for (const chunk of chunks) {
          await this.sock.sendMessage(target.channelId, { text: chunk });
        }
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

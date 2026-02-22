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

export class WhatsAppAdapter implements ChannelAdapter {
  readonly id = 'whatsapp';
  private sock: WASocket | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];
  private startedAt = 0;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;

    const authDir = join(process.cwd(), AUTH_DIR);
    mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    this.startedAt = Date.now();

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
          console.log('[WhatsApp] Connection lost, reconnecting...');
          this.currentStatus = 'connecting';
          this.connect(config).catch((err) => {
            console.error('[WhatsApp] Reconnect failed:', err instanceof Error ? err.message : err);
            this.currentStatus = 'error';
          });
        } else {
          console.log('[WhatsApp] Logged out');
          this.currentStatus = 'disconnected';
        }
      } else if (connection === 'open') {
        this.currentStatus = 'connected';
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
          console.error('[WhatsApp] Message handling error:', err instanceof Error ? err.message : err);
        }
      }
    });

    // Wait for connection to be established or QR to be shown
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 30_000); // Don't block forever

      sock.ev.on('connection.update', (update) => {
        if (update.connection === 'open') {
          clearTimeout(timeout);
          resolve();
        }
        if (update.connection === 'close') {
          const statusCode = (update.lastDisconnect?.error as any)?.output?.statusCode;
          if (statusCode === DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            reject(channelConnectError('whatsapp', new Error('Logged out — delete .baileys_auth and restart')));
          }
        }
        // If QR is shown, resolve so we don't block startup
        if (update.qr) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
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

    // Extract text content
    const content =
      msg.message.conversation ??
      msg.message.extendedTextMessage?.text ??
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
        console.error('[WhatsApp] Failed to download audio:', err instanceof Error ? err.message : err);
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
        await this.sock.sendMessage(target.channelId, {
          audio: content.audio.data,
          mimetype: content.audio.mimeType,
          ptt: true,
        });
      }

      // Send text
      const chunks = splitMessage(content.text, WHATSAPP_MAX_LENGTH);
      for (const chunk of chunks) {
        await this.sock.sendMessage(target.channelId, { text: chunk });
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

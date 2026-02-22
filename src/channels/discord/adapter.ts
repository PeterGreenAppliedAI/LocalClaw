import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';
import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';

const DISCORD_MAX_LENGTH = 2000;

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord';
  private client: Client | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private allowFrom?: ChannelAdapterConfig['allowFrom'];

  async connect(config: ChannelAdapterConfig): Promise<void> {
    if (!config.token) {
      throw channelConnectError('discord', new Error('Missing token'));
    }

    this.currentStatus = 'connecting';
    this.allowFrom = config.allowFrom;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    this.client.on('messageCreate', async (msg: Message) => {
      console.log(`[Discord] messageCreate from=${msg.author.tag} bot=${msg.author.bot} content="${msg.content}" guild=${msg.guildId ?? 'DM'}`);
      if (msg.author.bot) return;
      if (!this.handler) { console.log('[Discord] No handler set'); return; }
      if (!this.isAllowed(msg)) { console.log('[Discord] Not allowed'); return; }

      const content = msg.content
        .replace(/<@!?\d+>/g, '')
        .trim();

      // Allow ! commands without mention, require mention for everything else
      const isCommand = content.startsWith('!');
      if (!isCommand && msg.guild && this.client?.user && !msg.mentions.has(this.client.user)) {
        console.log('[Discord] Not mentioned, ignoring');
        return;
      }

      if (!content) return;

      // Show typing indicator while processing
      const typingInterval = setInterval(() => {
        if ('sendTyping' in msg.channel) msg.channel.sendTyping().catch(() => {});
      }, 5000);
      if ('sendTyping' in msg.channel) msg.channel.sendTyping().catch(() => {});

      const inbound: InboundMessage = {
        id: msg.id,
        channel: 'discord',
        content,
        senderId: msg.author.id,
        senderName: msg.author.displayName ?? msg.author.username,
        guildId: msg.guildId ?? undefined,
        channelId: msg.channelId,
        threadId: msg.thread?.id,
        timestamp: msg.createdAt,
        raw: msg,
      };

      try {
        await this.handler(inbound);
      } finally {
        clearInterval(typingInterval);
      }
    });

    await this.client.login(config.token);
    this.currentStatus = 'connected';
    console.log(`[Discord] Logged in as ${this.client.user?.tag}`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    if (!this.client) {
      throw channelSendError('discord', new Error('Not connected'));
    }

    try {
      const channel = await this.client.channels.fetch(target.channelId);
      if (!channel || !('send' in channel)) {
        throw new Error(`Channel ${target.channelId} not found or not text-based`);
      }

      const sendable = channel as any;

      // Send audio as file attachment if present
      const files = content.audio
        ? [{ attachment: content.audio.data, name: 'response.ogg' }]
        : undefined;

      const chunks = splitMessage(content.text, DISCORD_MAX_LENGTH);

      for (let i = 0; i < chunks.length; i++) {
        await sendable.send({
          content: chunks[i],
          reply: target.replyToId ? { messageReference: target.replyToId } : undefined,
          files: i === 0 ? files : undefined, // attach audio to first chunk only
        });
      }
    } catch (err) {
      throw channelSendError('discord', err);
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  /** Expose the client for streaming message edits */
  getClient(): Client | null {
    return this.client;
  }

  private isAllowed(msg: Message): boolean {
    if (!this.allowFrom) return true;

    if (this.allowFrom.guilds?.length && msg.guildId) {
      if (!this.allowFrom.guilds.includes(msg.guildId)) return false;
    }
    if (this.allowFrom.channels?.length) {
      if (!this.allowFrom.channels.includes(msg.channelId)) return false;
    }
    if (this.allowFrom.users?.length) {
      if (!this.allowFrom.users.includes(msg.author.id)) return false;
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

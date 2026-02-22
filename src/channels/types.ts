export interface InboundMessage {
  id: string;
  channel: string;
  content: string;
  senderId: string;
  senderName?: string;
  guildId?: string;
  channelId?: string;
  threadId?: string;
  timestamp: Date;
  raw?: unknown;
}

export interface MessageTarget {
  channel: string;
  channelId: string;
  guildId?: string;
  threadId?: string;
  replyToId?: string;
}

export interface MessageContent {
  text: string;
  embeds?: Array<{ title?: string; description?: string; url?: string }>;
}

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ChannelAdapterConfig {
  enabled: boolean;
  token?: string;
  allowFrom?: {
    guilds?: string[];
    channels?: string[];
    users?: string[];
  };
  [key: string]: unknown;
}

/**
 * The adapter contract — 5 methods.
 * Adding a new adapter = implement this interface + register it.
 * Zero core code changes. Open/Closed principle.
 */
export interface ChannelAdapter {
  readonly id: string;
  connect(config: ChannelAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  send(target: MessageTarget, content: MessageContent): Promise<void>;
  status(): ChannelStatus;
}

import { channelConnectError } from '../errors.js';
import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  InboundMessage,
  MessageTarget,
  MessageContent,
  ChannelStatus,
} from './types.js';

export class ChannelRegistry {
  private adapters = new Map<string, ChannelAdapter>();
  private messageHandlers: Array<(msg: InboundMessage) => Promise<void>> = [];

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  async connectAll(configs: Record<string, ChannelAdapterConfig>): Promise<void> {
    for (const [id, config] of Object.entries(configs)) {
      if (!config.enabled) continue;
      const adapter = this.adapters.get(id);
      if (!adapter) continue;

      try {
        adapter.onMessage(async (msg) => {
          for (const handler of this.messageHandlers) {
            await handler(msg);
          }
        });
        await adapter.connect(config);
        console.log(`[Channels] Connected: ${id}`);
      } catch (err) {
        throw channelConnectError(id, err);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.status() === 'connected') {
        await adapter.disconnect();
      }
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    const adapter = this.adapters.get(target.channel);
    if (!adapter) {
      throw channelConnectError(target.channel, new Error('Adapter not registered'));
    }
    await adapter.send(target, content);
  }

  statuses(): Record<string, ChannelStatus> {
    const result: Record<string, ChannelStatus> = {};
    for (const [id, adapter] of this.adapters) {
      result[id] = adapter.status();
    }
    return result;
  }
}

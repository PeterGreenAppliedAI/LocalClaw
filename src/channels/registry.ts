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
    // Disconnect every channel in PARALLEL, each capped by a timeout, so one hung socket
    // (e.g. a stuck WhatsApp/Baileys connection) can't block the others or stall shutdown.
    const connected = [...this.adapters.values()].filter(a => a.status() === 'connected');
    await Promise.allSettled(
      connected.map(adapter =>
        Promise.race([
          Promise.resolve(adapter.disconnect()),
          new Promise<void>(resolve => setTimeout(resolve, 3000)),
        ]).catch(() => { /* a failed disconnect must not block exit */ }),
      ),
    );
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

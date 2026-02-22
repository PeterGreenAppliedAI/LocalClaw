import { describe, it, expect, vi } from 'vitest';
import { ChannelRegistry } from '../../src/channels/registry.js';
import type { ChannelAdapter, ChannelStatus, InboundMessage, MessageTarget, MessageContent, ChannelAdapterConfig } from '../../src/channels/types.js';

function createMockAdapter(id: string): ChannelAdapter {
  let status: ChannelStatus = 'disconnected';
  let handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  return {
    id,
    connect: vi.fn().mockImplementation(async () => { status = 'connected'; }),
    disconnect: vi.fn().mockImplementation(async () => { status = 'disconnected'; }),
    onMessage: vi.fn().mockImplementation((h) => { handler = h; }),
    send: vi.fn().mockResolvedValue(undefined),
    status: () => status,
    // Expose handler for testing
    _triggerMessage: async (msg: InboundMessage) => { if (handler) await handler(msg); },
  } as ChannelAdapter & { _triggerMessage: (msg: InboundMessage) => Promise<void> };
}

describe('ChannelRegistry', () => {
  it('registers and retrieves adapters', () => {
    const registry = new ChannelRegistry();
    const adapter = createMockAdapter('discord');
    registry.register(adapter);

    expect(registry.get('discord')).toBe(adapter);
    expect(registry.list()).toContain('discord');
  });

  it('connects all enabled adapters', async () => {
    const registry = new ChannelRegistry();
    const discord = createMockAdapter('discord');
    const telegram = createMockAdapter('telegram');
    registry.register(discord);
    registry.register(telegram);

    await registry.connectAll({
      discord: { enabled: true, token: 'test' },
      telegram: { enabled: false },
    });

    expect(discord.connect).toHaveBeenCalled();
    expect(telegram.connect).not.toHaveBeenCalled();
    expect(discord.status()).toBe('connected');
  });

  it('routes messages through handler', async () => {
    const registry = new ChannelRegistry();
    const adapter = createMockAdapter('test');
    registry.register(adapter);

    const received: InboundMessage[] = [];
    registry.onMessage(async (msg) => { received.push(msg); });

    await registry.connectAll({ test: { enabled: true } });

    // Simulate incoming message
    const testMsg: InboundMessage = {
      id: '1',
      channel: 'test',
      content: 'hello',
      senderId: 'user1',
      channelId: 'ch1',
      timestamp: new Date(),
    };

    await (adapter as any)._triggerMessage(testMsg);
    expect(received).toHaveLength(1);
    expect(received[0].content).toBe('hello');
  });

  it('sends messages to correct adapter', async () => {
    const registry = new ChannelRegistry();
    const adapter = createMockAdapter('discord');
    registry.register(adapter);

    const target: MessageTarget = { channel: 'discord', channelId: 'ch1' };
    const content: MessageContent = { text: 'test message' };

    await registry.send(target, content);
    expect(adapter.send).toHaveBeenCalledWith(target, content);
  });

  it('throws on send to unregistered adapter', async () => {
    const registry = new ChannelRegistry();
    await expect(
      registry.send({ channel: 'slack', channelId: 'ch1' }, { text: 'hi' }),
    ).rejects.toThrow();
  });

  it('disconnects all connected adapters', async () => {
    const registry = new ChannelRegistry();
    const adapter = createMockAdapter('discord');
    registry.register(adapter);

    await registry.connectAll({ discord: { enabled: true } });
    expect(adapter.status()).toBe('connected');

    await registry.disconnectAll();
    expect(adapter.disconnect).toHaveBeenCalled();
  });

  it('reports statuses', () => {
    const registry = new ChannelRegistry();
    const adapter = createMockAdapter('discord');
    registry.register(adapter);

    const statuses = registry.statuses();
    expect(statuses.discord).toBe('disconnected');
  });
});

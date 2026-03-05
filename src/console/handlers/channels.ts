import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson, sendError } from '../helpers/send-json.js';

export function handleChannels(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  const statuses = deps.channelRegistry.statuses();
  const channels = Object.entries(statuses).map(([id, status]) => ({
    id,
    status,
    enabled: deps.config.channels[id]?.enabled ?? false,
  }));
  sendJson(res, channels);
}

export async function handleChannelReconnect(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  channelId: string,
): Promise<void> {
  const adapter = deps.channelRegistry.get(channelId);
  if (!adapter) {
    sendError(res, `Channel "${channelId}" not found`, 404);
    return;
  }

  const channelConfig = deps.config.channels[channelId];
  if (!channelConfig) {
    sendError(res, `No config for channel "${channelId}"`, 404);
    return;
  }

  try {
    await adapter.disconnect();
    await adapter.connect(channelConfig as import('../../channels/types.js').ChannelAdapterConfig);
    sendJson(res, { ok: true, status: adapter.status() });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Reconnect failed', 500);
  }
}

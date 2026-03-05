import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson } from '../helpers/send-json.js';
import { redactConfig } from '../helpers/redact.js';

export async function handleStatus(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  const ollamaAvailable = await deps.ollamaClient.isAvailable();
  const models = ollamaAvailable ? await deps.ollamaClient.listModels() : [];
  const channelStatuses = deps.channelRegistry.statuses();
  const tools = deps.toolRegistry.list();
  const cronJobs = deps.cronService?.list(true) ?? [];

  const cron = cronJobs.filter(j => j.type === 'cron');
  const heartbeats = cronJobs.filter(j => j.type === 'heartbeat');

  let totalFacts = 0;
  if (deps.factStore) {
    try {
      totalFacts = deps.factStore.loadFactsJson().length;
    } catch { /* ignore */ }
  }

  sendJson(res, {
    ollama: { available: ollamaAvailable, models: models.length },
    tools: tools.length,
    cron: { jobs: cron.length, heartbeats: heartbeats.length },
    memory: { totalFacts },
    channels: channelStatuses,
    defaultSenderId: deps.config.heartbeat?.delivery?.target ?? null,
  });
}

export async function handleModels(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  try {
    const models = await deps.ollamaClient.listModels();
    sendJson(res, models);
  } catch {
    sendJson(res, []);
  }
}

export function handleConfig(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  sendJson(res, redactConfig(deps.config));
}

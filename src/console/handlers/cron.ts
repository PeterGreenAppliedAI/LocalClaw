import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson, sendError } from '../helpers/send-json.js';
import { parseBody } from '../helpers/parse-body.js';

export function handleListCron(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  if (!deps.cronService) {
    sendJson(res, []);
    return;
  }
  sendJson(res, deps.cronService.list(true));
}

export async function handleCreateCron(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  if (!deps.cronService) {
    sendError(res, 'Cron service not enabled', 503);
    return;
  }

  try {
    const body = await parseBody<{
      name: string;
      schedule: string;
      category: string;
      message: string;
      type?: 'cron' | 'heartbeat';
      delivery: { channel: string; target: string };
    }>(req);

    if (!body.name || !body.schedule || !body.category || !body.message) {
      sendError(res, 'Missing required fields: name, schedule, category, message');
      return;
    }

    const job = deps.cronService.add(body);
    sendJson(res, job, 201);
  } catch {
    sendError(res, 'Invalid JSON body');
  }
}

export async function handleUpdateCron(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  cronId: string,
): Promise<void> {
  if (!deps.cronService) {
    sendError(res, 'Cron service not enabled', 503);
    return;
  }

  try {
    const body = await parseBody<Record<string, unknown>>(req);
    const updated = deps.cronService.edit(cronId, body);
    if (!updated) {
      sendError(res, `Cron job "${cronId}" not found`, 404);
      return;
    }
    sendJson(res, updated);
  } catch {
    sendError(res, 'Invalid JSON body');
  }
}

export function handleDeleteCron(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  cronId: string,
): void {
  if (!deps.cronService) {
    sendError(res, 'Cron service not enabled', 503);
    return;
  }

  const removed = deps.cronService.remove(cronId);
  if (!removed) {
    sendError(res, `Cron job "${cronId}" not found`, 404);
    return;
  }
  sendJson(res, { ok: true });
}

export async function handleRunCron(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  cronId: string,
): Promise<void> {
  if (!deps.cronService) {
    sendError(res, 'Cron service not enabled', 503);
    return;
  }

  try {
    const result = await deps.cronService.run(cronId);
    sendJson(res, { ok: true, result });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Run failed', 500);
  }
}

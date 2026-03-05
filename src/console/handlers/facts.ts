import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson, sendError } from '../helpers/send-json.js';
import { parseBody } from '../helpers/parse-body.js';
import { resolveWorkspacePath } from '../../agents/scope.js';

export function handleSearchFacts(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  if (!deps.factStore) {
    sendJson(res, []);
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const senderId = url.searchParams.get('senderId') ?? undefined;
  const query = url.searchParams.get('query') ?? '';

  const results = deps.factStore.searchFacts(query, senderId);
  sendJson(res, results);
}

export function handleAllFacts(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  if (!deps.factStore) {
    sendJson(res, []);
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const senderId = url.searchParams.get('senderId') ?? undefined;

  const facts = deps.factStore.loadFactsJson(senderId);
  sendJson(res, facts);
}

export async function handleWriteFact(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  if (!deps.factStore) {
    sendError(res, 'Fact store not available', 503);
    return;
  }

  try {
    const body = await parseBody<{
      text: string;
      category?: string;
      confidence?: number;
      tags?: string[];
      entities?: string[];
      senderId?: string;
    }>(req);

    if (!body.text) {
      sendError(res, 'Missing "text" field');
      return;
    }

    const entry = deps.factStore.writeFact(
      {
        text: body.text,
        category: (body.category as any) ?? 'stable',
        confidence: body.confidence ?? 0.9,
        tags: body.tags ?? [],
        entities: body.entities ?? [],
      },
      body.senderId,
      'console/manual',
    );

    if (entry) {
      deps.factStore.rebuildFacts(body.senderId);
    }

    sendJson(res, entry ?? { deduplicated: true }, entry ? 201 : 200);
  } catch {
    sendError(res, 'Invalid JSON body');
  }
}

export async function handleConsolidateFacts(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  if (!deps.factStore) {
    sendError(res, 'Fact store not available', 503);
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const senderId = url.searchParams.get('senderId') ?? undefined;

  const removed = deps.factStore.consolidateFacts(senderId);
  sendJson(res, { removed });
}

export function handleMemorySenders(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  const workspacePath = resolveWorkspacePath(deps.config.agents.default, deps.config);
  const memoryDir = join(workspacePath, 'memory');

  try {
    const entries = readdirSync(memoryDir, { withFileTypes: true });
    const senders = entries
      .filter(e => e.isDirectory() && e.name !== 'last-review.json')
      .map(e => e.name);
    sendJson(res, senders);
  } catch {
    sendJson(res, []);
  }
}

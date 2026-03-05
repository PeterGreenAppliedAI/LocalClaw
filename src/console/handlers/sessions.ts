import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson, sendError } from '../helpers/send-json.js';

export function handleSessions(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  const baseDir = deps.config.session.transcriptDir;
  const sessions: Array<import('../../sessions/types.js').SessionMetadata> = [];

  try {
    const agents = readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const agentId of agents) {
      const agentDir = join(baseDir, agentId);
      const metaFiles = readdirSync(agentDir).filter(f => f.endsWith('.meta.json'));

      for (const file of metaFiles) {
        try {
          const data = readFileSync(join(agentDir, file), 'utf-8');
          sessions.push(JSON.parse(data));
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* dir doesn't exist */ }

  sessions.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  sendJson(res, sessions);
}

export function handleSessionTranscript(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  agentId: string,
  sessionKey: string,
): void {
  const transcript = deps.sessionStore.loadTranscript(agentId, sessionKey);
  sendJson(res, transcript);
}

export function handleSessionDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  agentId: string,
  sessionKey: string,
): void {
  deps.sessionStore.clearSession(agentId, sessionKey);
  sendJson(res, { ok: true });
}

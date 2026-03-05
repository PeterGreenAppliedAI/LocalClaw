import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { ConsoleApiDeps } from '../types.js';
import { sendError } from '../helpers/send-json.js';
import { resolveWorkspacePath } from '../../agents/scope.js';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
};

export function handleServeFile(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  filePath: string,
): void {
  const workspace = resolveWorkspacePath(
    deps.config.agents.default,
    deps.config,
  );
  const fullPath = resolve(workspace, filePath);

  // Security: prevent path traversal outside workspace
  if (!fullPath.startsWith(resolve(workspace))) {
    sendError(res, 'Forbidden', 403);
    return;
  }

  if (!existsSync(fullPath)) {
    sendError(res, 'File not found', 404);
    return;
  }

  const ext = extname(fullPath).toLowerCase();
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    const data = readFileSync(fullPath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    sendError(res, 'Failed to read file', 500);
  }
}

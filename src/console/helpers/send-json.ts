import type { ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

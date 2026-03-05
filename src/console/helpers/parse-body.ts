import type { IncomingMessage } from 'node:http';

export async function parseBody<T = unknown>(req: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_048_576) throw new Error('Request body too large');
  }
  return JSON.parse(body) as T;
}

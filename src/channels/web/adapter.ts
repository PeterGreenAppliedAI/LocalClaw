import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';

/**
 * Simple HTTP REST API adapter for testing.
 * POST /api/message → dispatch → response
 */
export class WebApiAdapter implements ChannelAdapter {
  readonly id = 'web';
  private server: Server | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private pendingResponses = new Map<string, (content: MessageContent) => void>();

  async connect(config: ChannelAdapterConfig): Promise<void> {
    const port = (config as any).port ?? 3100;
    this.currentStatus = 'connecting';

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/api/message') {
        await this.handleHttpMessage(req, res);
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, () => {
        this.currentStatus = 'connected';
        console.log(`[Web] API listening on http://localhost:${port}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    const resolve = this.pendingResponses.get(target.replyToId ?? '');
    if (resolve) {
      resolve(content);
      this.pendingResponses.delete(target.replyToId ?? '');
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  private async handleHttpMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: { message: string; senderId?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!parsed.message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "message" field' }));
      return;
    }

    const msgId = `web-${Date.now()}`;

    const responsePromise = new Promise<MessageContent>((resolve) => {
      this.pendingResponses.set(msgId, resolve);
      // Timeout after 2 minutes
      setTimeout(() => {
        if (this.pendingResponses.has(msgId)) {
          this.pendingResponses.delete(msgId);
          resolve({ text: 'Request timed out' });
        }
      }, 120_000);
    });

    const inbound: InboundMessage = {
      id: msgId,
      channel: 'web',
      content: parsed.message,
      senderId: parsed.senderId ?? 'web-user',
      channelId: 'web',
      timestamp: new Date(),
    };

    if (this.handler) {
      this.handler(inbound).catch(console.error);
    }

    const response = await responsePromise;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const responseBody: Record<string, unknown> = { response: response.text };
    if (response.audio) {
      responseBody.audio = {
        data: response.audio.data.toString('base64'),
        mimeType: response.audio.mimeType,
      };
    }
    res.end(JSON.stringify(responseBody));
  }
}

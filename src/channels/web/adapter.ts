import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';

const voiceHtml = readFileSync(new URL('./voice-ui.html', import.meta.url), 'utf-8');

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
  private apiKey: string | undefined;

  async connect(config: ChannelAdapterConfig): Promise<void> {
    const port = (config as any).port ?? 3100;
    const host = (config as any).host ?? '0.0.0.0';
    this.apiKey = config.token;
    this.currentStatus = 'connecting';

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(voiceHtml);
      } else if (req.method === 'POST' && req.url === '/api/voice') {
        if (!this.checkAuth(req, res)) return;
        await this.handleVoiceMessage(req, res);
      } else if (req.method === 'POST' && req.url === '/api/message') {
        if (!this.checkAuth(req, res)) return;
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
      this.server!.listen(port, host, () => {
        this.currentStatus = 'connected';
        console.log(`[Web] API listening on http://${host}:${port}`);
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

  /** Return true if auth passes, false if response was sent with 401 */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true; // no key configured — open access
    const auth = req.headers['authorization'];
    if (auth === `Bearer ${this.apiKey}`) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  private async handleVoiceMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length < 1000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Audio too short' }));
      return;
    }

    const mimeType = req.headers['content-type'] ?? 'audio/webm';
    const msgId = `web-voice-${Date.now()}`;
    console.log(`[Web] Voice message from web-user (${audioBuffer.length} bytes, ${mimeType})`);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // SSE keepalive: send a comment every 15s to prevent browser/proxy timeouts
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);

    const responsePromise = new Promise<MessageContent>((resolve) => {
      this.pendingResponses.set(msgId, resolve);
      setTimeout(() => {
        if (this.pendingResponses.has(msgId)) {
          this.pendingResponses.delete(msgId);
          resolve({ text: 'Request timed out' });
        }
      }, 300_000);
    });

    const inbound: InboundMessage = {
      id: msgId,
      channel: 'web',
      content: '',
      senderId: 'web-user',
      channelId: 'web',
      timestamp: new Date(),
      audio: { data: audioBuffer, mimeType },
      onProgress(stage: string, data?: Record<string, unknown>) {
        const payload = { stage, ...data };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    };

    if (this.handler) {
      this.handler(inbound).catch((err) => {
        console.warn('[Web] Voice handler error:', err instanceof Error ? err.message : err);
      });
    }

    const response = await responsePromise;
    clearInterval(keepalive);

    const donePayload: Record<string, unknown> = {
      stage: 'done',
      response: response.text,
    };
    if (response.audio) {
      donePayload.audio = {
        data: response.audio.data.toString('base64'),
        mimeType: response.audio.mimeType,
      };
    }
    res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
    res.end();
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
      }, 300_000);
    });

    const inbound: InboundMessage = {
      id: msgId,
      channel: 'web',
      content: parsed.message,
      senderId: 'web-user',
      channelId: 'web',
      timestamp: new Date(),
    };

    if (this.handler) {
      this.handler(inbound).catch((err) => {
        console.warn('[Web] Message handler error:', err instanceof Error ? err.message : err);
      });
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

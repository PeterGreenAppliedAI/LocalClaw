import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import { sendError } from '../helpers/send-json.js';
import { parseBody } from '../helpers/parse-body.js';
import { resolveRoute } from '../../agents/resolve-route.js';
import { saveAttachment, isImageMime } from '../../services/attachments.js';

interface ChatAttachment {
  name: string;
  data: string; // base64
  mimeType: string;
}

interface ChatBody {
  message: string;
  senderId?: string;
  attachments?: ChatAttachment[];
}

export async function handleChat(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  let body: ChatBody;
  try {
    body = await parseBody<ChatBody>(req);
  } catch {
    sendError(res, 'Invalid JSON body');
    return;
  }

  if (!body.message && (!body.attachments || body.attachments.length === 0)) {
    sendError(res, 'Missing "message" or "attachments"');
    return;
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  try {
    const senderId = body.senderId
      ?? deps.config.heartbeat?.delivery?.target
      ?? 'console-user';

    const route = resolveRoute(
      { channel: 'console', senderId, channelId: 'console' },
      deps.config,
    );

    // Process attachments — same pipeline as orchestrator
    let message = body.message || '';
    let hasImage = false;

    if (body.attachments?.length) {
      const prefixes: string[] = [];
      const suffixes: string[] = [];
      const msgId = `console-${Date.now()}`;

      for (const att of body.attachments) {
        const buffer = Buffer.from(att.data, 'base64');
        const saved = saveAttachment(
          { filename: att.name, data: buffer, size: buffer.length, mimeType: att.mimeType },
          'console',
          msgId,
        );
        if (!saved) continue;

        if (saved.isImage) {
          hasImage = true;
          if (deps.visionService?.enabled) {
            console.log(`[Console] Running vision on ${saved.filename} (${buffer.length} bytes)`);
            const description = await deps.visionService.describe(buffer, att.mimeType);
            if (description) {
              prefixes.push(`[The user attached an image. Vision analysis: ${description}]\nUse the above description to answer the user's question about the image.`);
            } else {
              prefixes.push(`[The user attached an image (${saved.filename}) but vision analysis was unavailable.]`);
            }
          } else {
            prefixes.push(`[The user attached an image (${saved.filename}) but vision is not enabled.]`);
          }
        } else if (att.mimeType === 'application/pdf') {
          try {
            const pdfParse = (await import('pdf-parse')).default;
            const pdf = await pdfParse(buffer);
            const text = pdf.text.trim();
            if (text) {
              console.log(`[Console] Extracted ${text.length} chars from PDF: ${saved.filename}`);
              prefixes.push(`[The user attached a PDF: ${saved.filename}. Extracted text below:]\n\n${text}`);
            } else {
              suffixes.push(`[Attached PDF: ${saved.filename} but no text could be extracted.]`);
            }
          } catch {
            suffixes.push(`[Attached file: ${saved.localPath}] (${saved.filename}, ${saved.mimeType})`);
          }
        } else {
          suffixes.push(`[Attached file: ${saved.localPath}] (${saved.filename}, ${saved.mimeType})`);
        }
      }

      if (prefixes.length > 0) {
        message = prefixes.join('\n\n') + '\n\n' + message;
      }
      if (suffixes.length > 0) {
        message = message + '\n' + suffixes.join('\n');
      }
    }

    const result = await deps.dispatch({
      message,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      sessionStore: deps.sessionStore,
      sourceContext: {
        channel: 'console',
        channelId: 'console',
        senderId,
      },
      ...(hasImage ? { overrideCategory: 'chat' } : {}),
      factStore: deps.factStore,
    });

    res.write(`data: ${JSON.stringify({
      type: 'done',
      answer: result.answer,
      category: result.category,
      iterations: result.iterations,
    })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    })}\n\n`);
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}

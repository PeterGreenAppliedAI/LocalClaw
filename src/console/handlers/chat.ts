import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import type { DispatchResult } from '../../dispatch.js';
import { sendJson, sendError } from '../helpers/send-json.js';
import { parseBody } from '../helpers/parse-body.js';
import { resolveRoute } from '../../agents/resolve-route.js';
import { resolveWorkspacePath } from '../../agents/scope.js';
import { saveAttachment, isImageMime } from '../../services/attachments.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|svg|webp)$/i;

/** Extract image paths from the dispatch result for inline display */
function extractImagePaths(result: DispatchResult): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const addPath = (raw: string) => {
    // Normalize: strip workspace prefix to get relative path (e.g. "charts/foo.png")
    const p = raw.replace(/^.*?\/(charts\/)/, '$1');
    if (!seen.has(p)) { seen.add(p); paths.push(p); }
  };

  // 1. Markdown image refs in the answer: ![...](path)
  const mdPattern = /!\[.*?\]\(([^\s)]+\.(?:png|jpg|jpeg|gif|svg|webp))\)/gi;
  let match;
  while ((match = mdPattern.exec(result.answer)) !== null) addPath(match[1]);

  // 2. Bare file path mentions in the answer text
  const barePathPattern = /(?:charts\/[^\s"'<>)]+\.(?:png|jpg|jpeg|gif|svg|webp))/gi;
  while ((match = barePathPattern.exec(result.answer)) !== null) addPath(match[0]);

  // 3. Scan steps for image paths in tool params, code input, and observations
  if (result.steps) {
    for (const step of result.steps) {
      if (step.tool === 'write_file' && typeof step.params?.path === 'string') {
        const p = step.params.path as string;
        if (IMAGE_EXT_RE.test(p)) addPath(p);
      }
      if (step.tool === 'code_session') {
        const texts = [
          typeof step.params?.code === 'string' ? step.params.code as string : '',
          step.observation ?? '',
        ];
        for (const text of texts) {
          const sfPattern = /savefig\(['"](.*?\.(?:png|jpg|jpeg|gif|svg|webp))['"]/gi;
          let sf;
          while ((sf = sfPattern.exec(text)) !== null) addPath(sf[1]);
          const bpPattern = /(?:charts\/[^\s"'<>)]+\.(?:png|jpg|jpeg|gif|svg|webp))/gi;
          let bp;
          while ((bp = bpPattern.exec(text)) !== null) addPath(bp[0]);
        }
      }
    }
  }

  return paths;
}

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

    const trimmed = (body.message || '').trim();

    // Handle !reset / !new — clear session before it hits the router
    if (trimmed.toLowerCase() === '!reset' || trimmed.toLowerCase() === '!new') {
      try {
        await deps.sessionStore.clearSession(route.agentId, route.sessionKey);
      } catch { /* ignore */ }
      res.write(`data: ${JSON.stringify({ type: 'done', answer: 'Session cleared. Starting fresh!', category: 'system', iterations: 0 })}\n\n`);
      clearInterval(keepalive);
      res.end();
      return;
    }

    // Handle !research command
    if (trimmed.toLowerCase().startsWith('!research')) {
      const rawArgs = trimmed.slice('!research'.length).trim();
      const typeMatch = rawArgs.match(/^--(\w+)\s+/);
      const validTypes = ['deck', 'brief', 'deepdive', 'market', 'teardown', 'memo'];
      const artifactType = typeMatch && validTypes.includes(typeMatch[1]) ? typeMatch[1] : 'memo';
      const topic = typeMatch ? rawArgs.slice(typeMatch[0].length).trim() : rawArgs;

      if (!topic) {
        res.write(`data: ${JSON.stringify({ type: 'done', answer: 'Usage: `!research [--deck|--brief|--deepdive|--market|--teardown|--memo] <topic>`', category: 'research', iterations: 0 })}\n\n`);
        clearInterval(keepalive);
        res.end();
        return;
      }

      const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const today = new Date().toISOString().split('T')[0];
      const enhancedMessage = `[RESEARCH PIPELINE]\nArtifact type: ${artifactType}\nTopic: ${topic}\nOutput slug: ${slug}\nCurrent date: ${today}\n\nProduce a research deck on this topic using the MOST RECENT data available. Search for ${new Date().getFullYear()} data first. Follow your pipeline stages exactly.`;

      res.write(`data: ${JSON.stringify({ type: 'status', message: `Researching: ${topic} (${artifactType})...` })}\n\n`);

      const result = await deps.dispatch({
        message: enhancedMessage,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionStore: deps.sessionStore,
        overrideCategory: 'research',
        sourceContext: { channel: 'console', channelId: 'console', senderId },
        factStore: deps.factStore,
      });

      const deckPath = `research/${slug}.html`;
      const workspacePath = resolveWorkspacePath(route.agentId, deps.config);
      const deckExists = existsSync(join(workspacePath, deckPath));

      let answer = result.answer;
      if (deckExists) {
        answer += `\n\n[View your deck](/console/api/files/${deckPath})`;
      }

      const images = extractImagePaths(result);
      res.write(`data: ${JSON.stringify({
        type: 'done',
        answer,
        category: result.category,
        iterations: result.iterations,
        ...(images.length > 0 ? { images: images.map(p => `/console/api/files/${encodeURIComponent(p)}`) } : {}),
      })}\n\n`);
      clearInterval(keepalive);
      res.end();
      return;
    }

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

    const images = extractImagePaths(result);
    res.write(`data: ${JSON.stringify({
      type: 'done',
      answer: result.answer,
      category: result.category,
      iterations: result.iterations,
      ...(images.length > 0 ? { images: images.map(p => `/console/api/files/${encodeURIComponent(p)}`) } : {}),
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

export async function handleChatReset(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  const senderId = deps.config.heartbeat?.delivery?.target ?? 'console-user';
  const route = resolveRoute(
    { channel: 'console', senderId, channelId: 'console' },
    deps.config,
  );

  try {
    await deps.sessionStore.clearSession(route.agentId, route.sessionKey);
    sendJson(res, { ok: true, agentId: route.agentId, sessionKey: route.sessionKey });
  } catch (err) {
    sendError(res, err instanceof Error ? err.message : 'Failed to reset session');
  }
}

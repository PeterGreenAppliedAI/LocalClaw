import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, statSync, readFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson } from '../helpers/send-json.js';
import { resolveWorkspacePath } from '../../agents/scope.js';

export interface ResearchDeckMeta {
  slug: string;
  title: string;
  createdAt: string;
  fileSize: number;
  chartCount: number;
  url: string;
}

export function handleListResearch(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
): void {
  const workspace = resolveWorkspacePath(
    deps.config.agents.default,
    deps.config,
  );
  const researchDir = join(workspace, 'research');

  let files: string[];
  try {
    files = readdirSync(researchDir);
  } catch {
    sendJson(res, []);
    return;
  }

  const decks: ResearchDeckMeta[] = [];

  for (const file of files) {
    if (extname(file) !== '.html') continue;

    const fullPath = join(researchDir, file);
    const stat = statSync(fullPath);
    const slug = file.replace('.html', '');

    // Count charts in the slug's directory
    let chartCount = 0;
    try {
      const chartDir = join(researchDir, slug);
      const chartFiles = readdirSync(chartDir);
      chartCount = chartFiles.filter(f => /\.(png|jpg|svg)$/i.test(f)).length;
    } catch {
      // No chart directory
    }

    // Extract title from HTML
    let title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    try {
      const html = readFileSync(fullPath, 'utf-8');
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) title = titleMatch[1];
    } catch {
      // Use slug-derived title
    }

    decks.push({
      slug,
      title,
      createdAt: stat.mtime.toISOString(),
      fileSize: stat.size,
      chartCount,
      url: `/console/api/files/research/${file}`,
    });
  }

  // Sort newest first
  decks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  sendJson(res, decks);
}

export function handleDeleteResearch(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  slug: string,
): void {
  const workspace = resolveWorkspacePath(
    deps.config.agents.default,
    deps.config,
  );
  const researchDir = join(workspace, 'research');
  const htmlPath = join(researchDir, `${slug}.html`);
  const chartDir = join(researchDir, slug);

  if (!existsSync(htmlPath)) {
    sendJson(res, { error: 'Deck not found' }, 404);
    return;
  }

  try {
    unlinkSync(htmlPath);
    if (existsSync(chartDir)) {
      rmSync(chartDir, { recursive: true });
    }
    sendJson(res, { deleted: slug });
  } catch (err) {
    sendJson(res, { error: 'Failed to delete deck' }, 500);
  }
}

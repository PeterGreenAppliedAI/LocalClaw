import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdirSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ConsoleApiDeps } from '../types.js';
import { sendJson, sendError } from '../helpers/send-json.js';
import { parseBody } from '../helpers/parse-body.js';
import { resolveRoute } from '../../agents/resolve-route.js';
import { resolveWorkspacePath } from '../../agents/scope.js';

export type BuildStatus = 'passing' | 'failing' | 'unknown';

export interface BuildMeta {
  slug: string;
  status: BuildStatus;
  committed: boolean;
  lastCommit?: string;
  lastCommitAt?: string;
  fileCount: number;
}

export interface BuildFile {
  path: string;
  content: string;
  truncated: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', '.pytest_cache', 'dist', 'build', 'target']);
const MAX_FILE_BYTES = 40_000;

function buildsDir(deps: ConsoleApiDeps): string {
  return join(resolveWorkspacePath(deps.config.agents.default, deps.config), 'builds');
}

/** Derive pass/fail from the commit message the code_gen commit stage writes. */
function statusFromCommit(msg: string): BuildStatus {
  if (/tests passing/i.test(msg)) return 'passing';
  if (/tests failing/i.test(msg)) return 'failing';
  return 'unknown';
}

/** Last commit subject + ISO date for a project dir, or null if not a git repo. */
function gitLast(dir: string): { subject: string; date: string } | null {
  try {
    const out = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s%n%cI'], { encoding: 'utf-8', timeout: 5000 }).trim();
    const nl = out.indexOf('\n');
    return { subject: out.slice(0, nl), date: out.slice(nl + 1).trim() };
  } catch {
    return null;
  }
}

/** Recursively list source files (skipping deps/build dirs), relative to the project root. */
function listSourceFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const f of entries) {
    if (f.startsWith('.') || SKIP_DIRS.has(f)) continue;
    const full = join(dir, f);
    const rel = prefix ? `${prefix}/${f}` : f;
    try {
      if (statSync(full).isDirectory()) out.push(...listSourceFiles(full, rel));
      else out.push(rel);
    } catch { /* skip */ }
  }
  return out;
}

export function handleListBuilds(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  const dir = buildsDir(deps);
  let names: string[];
  try { names = readdirSync(dir); } catch { sendJson(res, []); return; }

  const builds: BuildMeta[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }

    const git = gitLast(full);
    builds.push({
      slug: name,
      committed: !!git,
      status: git ? statusFromCommit(git.subject) : 'unknown',
      lastCommit: git?.subject,
      lastCommitAt: git?.date,
      fileCount: listSourceFiles(full).length,
    });
  }

  // Newest commit first; uncommitted (no date) sink to the bottom.
  builds.sort((a, b) => (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? ''));
  sendJson(res, builds);
}

export function handleGetBuild(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps, slug: string): void {
  const full = join(buildsDir(deps), slug);
  if (!existsSync(full)) { sendJson(res, { error: 'Build not found' }, 404); return; }

  const git = gitLast(full);
  const files: BuildFile[] = [];
  for (const rel of listSourceFiles(full).slice(0, 50)) {
    try {
      const raw = readFileSync(join(full, rel), 'utf-8');
      files.push({ path: rel, content: raw.slice(0, MAX_FILE_BYTES), truncated: raw.length > MAX_FILE_BYTES });
    } catch { /* binary/unreadable — skip */ }
  }

  sendJson(res, {
    slug,
    committed: !!git,
    status: git ? statusFromCommit(git.subject) : 'unknown',
    lastCommit: git?.subject,
    lastCommitAt: git?.date,
    files,
  });
}

/**
 * Drive a build: dispatch a prompt through the code_gen pipeline and SSE-stream stage progress +
 * the final report. Owner access is the console's Bearer-token gate (enforced before this runs).
 * Spawns Pi with bash — but cwd-scoped to builds/<slug>/.
 */
export async function handleCodeBuild(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  const body = await parseBody<{ message?: string; senderId?: string }>(req);
  const message = (body.message ?? '').trim();
  if (!message) { sendError(res, 'Missing "message"'); return; }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);

  try {
    const senderId = body.senderId ?? deps.config.heartbeat?.delivery?.target ?? 'console-user';
    const route = resolveRoute({ channel: 'console', senderId, channelId: 'console' }, deps.config);

    const result = await deps.dispatch({
      message,
      overrideCategory: 'code_gen',
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      sessionStore: deps.sessionStore,
      sourceContext: { channel: 'console', channelId: 'console', senderId },
      factStore: deps.factStore,
      onProgress: (note: string) => send({ type: 'status', message: note }),
    });

    send({ type: 'done', answer: result.answer, category: result.category, iterations: result.iterations });
  } catch (err) {
    send({ type: 'error', error: err instanceof Error ? err.message : 'Build failed' });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}

export function handleDeleteBuild(_req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps, slug: string): void {
  const full = join(buildsDir(deps), slug);
  if (!existsSync(full)) { sendJson(res, { error: 'Build not found' }, 404); return; }
  try {
    rmSync(full, { recursive: true });
    sendJson(res, { deleted: slug });
  } catch {
    sendJson(res, { error: 'Failed to delete build' }, 500);
  }
}

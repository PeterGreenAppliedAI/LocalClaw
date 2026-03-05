import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from '../types.js';
import type { TaskCreate } from '../../tasks/types.js';
import { sendJson, sendError } from '../helpers/send-json.js';
import { parseBody } from '../helpers/parse-body.js';

const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);

export function handleListTasks(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const status = url.searchParams.get('status') ?? undefined;
  const assignee = url.searchParams.get('assignee') ?? undefined;
  const tag = url.searchParams.get('tag') ?? undefined;
  const all = url.searchParams.get('all') === 'true';

  const tasks = deps.taskStore.list(all ? { status: status as any } : { status: status as any, assignee, tag });
  sendJson(res, tasks);
}

export async function handleCreateTask(req: IncomingMessage, res: ServerResponse, deps: ConsoleApiDeps): Promise<void> {
  try {
    const body = await parseBody<{ title: string; details?: string; priority?: string; assignee?: string; dueDate?: string; tags?: string[] }>(req);
    if (!body.title) {
      sendError(res, 'Missing "title" field');
      return;
    }
    const input: TaskCreate = {
      title: body.title,
      details: body.details,
      priority: VALID_PRIORITIES.has(body.priority ?? '') ? body.priority as TaskCreate['priority'] : undefined,
      assignee: body.assignee,
      dueDate: body.dueDate,
      tags: body.tags,
    };
    const task = deps.taskStore.add(input, 'user');
    sendJson(res, task, 201);
  } catch {
    sendError(res, 'Invalid JSON body');
  }
}

export async function handleUpdateTask(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  taskId: string,
): Promise<void> {
  try {
    const body = await parseBody<Record<string, unknown>>(req);
    const updated = deps.taskStore.update(taskId, body);
    if (!updated) {
      sendError(res, `Task "${taskId}" not found`, 404);
      return;
    }
    sendJson(res, updated);
  } catch {
    sendError(res, 'Invalid JSON body');
  }
}

export function handleDeleteTask(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  taskId: string,
): void {
  const removed = deps.taskStore.remove(taskId);
  if (!removed) {
    sendError(res, `Task "${taskId}" not found`, 404);
    return;
  }
  sendJson(res, { ok: true });
}

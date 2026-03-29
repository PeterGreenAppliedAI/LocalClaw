import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConsoleApiDeps } from './types.js';
import { sendError, sendJson } from './helpers/send-json.js';
import { handleStatus, handleModels, handleConfig } from './handlers/status.js';
import { handleChannels, handleChannelReconnect } from './handlers/channels.js';
import { handleSessions, handleSessionTranscript, handleSessionDelete } from './handlers/sessions.js';
import { handleListTasks, handleCreateTask, handleUpdateTask, handleDeleteTask } from './handlers/tasks.js';
import { handleListCron, handleCreateCron, handleUpdateCron, handleDeleteCron, handleRunCron } from './handlers/cron.js';
import { handleSearchFacts, handleAllFacts, handleWriteFact, handleConsolidateFacts, handleMemorySenders } from './handlers/facts.js';
import { handleTools } from './handlers/tools.js';
import { handleChat, handleChatReset } from './handlers/chat.js';
import { handleServeFile } from './handlers/files.js';
import { handleListResearch, handleDeleteResearch } from './handlers/research.js';

const API_PREFIX = '/console/api/';

/**
 * Main console API dispatcher.
 * Returns true if the request was handled, false if it should fall through.
 */
export async function handleConsoleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleApiDeps,
  apiKey?: string,
): Promise<boolean> {
  const url = req.url ?? '';

  // Only handle /console/api/* requests
  if (!url.startsWith(API_PREFIX)) return false;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Auth check
  if (apiKey) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${apiKey}`) {
      sendError(res, 'Unauthorized', 401);
      return true;
    }
  }

  const path = url.slice(API_PREFIX.length).split('?')[0];
  const method = req.method ?? 'GET';

  try {
    // Status / models / config
    if (path === 'status' && method === 'GET') {
      await handleStatus(req, res, deps);
      return true;
    }
    if (path === 'models' && method === 'GET') {
      await handleModels(req, res, deps);
      return true;
    }
    if (path === 'config' && method === 'GET') {
      handleConfig(req, res, deps);
      return true;
    }

    // Channels
    if (path === 'channels' && method === 'GET') {
      handleChannels(req, res, deps);
      return true;
    }
    const channelReconnect = path.match(/^channels\/([^/]+)\/reconnect$/);
    if (channelReconnect && method === 'POST') {
      await handleChannelReconnect(req, res, deps, channelReconnect[1]);
      return true;
    }

    // Sessions
    if (path === 'sessions' && method === 'GET') {
      handleSessions(req, res, deps);
      return true;
    }
    const sessionMatch = path.match(/^sessions\/([^/]+)\/(.+)$/);
    if (sessionMatch) {
      const [, agentId, sessionKey] = sessionMatch;
      if (method === 'GET') {
        handleSessionTranscript(req, res, deps, agentId, decodeURIComponent(sessionKey));
        return true;
      }
      if (method === 'DELETE') {
        handleSessionDelete(req, res, deps, agentId, decodeURIComponent(sessionKey));
        return true;
      }
    }

    // Tasks
    if (path === 'tasks' && method === 'GET') {
      handleListTasks(req, res, deps);
      return true;
    }
    if (path === 'tasks' && method === 'POST') {
      await handleCreateTask(req, res, deps);
      return true;
    }
    const taskMatch = path.match(/^tasks\/([^/]+)$/);
    if (taskMatch) {
      if (method === 'PATCH') {
        await handleUpdateTask(req, res, deps, taskMatch[1]);
        return true;
      }
      if (method === 'DELETE') {
        handleDeleteTask(req, res, deps, taskMatch[1]);
        return true;
      }
    }

    // Cron
    if (path === 'cron' && method === 'GET') {
      handleListCron(req, res, deps);
      return true;
    }
    if (path === 'cron' && method === 'POST') {
      await handleCreateCron(req, res, deps);
      return true;
    }
    const cronMatch = path.match(/^cron\/([^/]+)$/);
    if (cronMatch) {
      if (method === 'PATCH') {
        await handleUpdateCron(req, res, deps, cronMatch[1]);
        return true;
      }
      if (method === 'DELETE') {
        handleDeleteCron(req, res, deps, cronMatch[1]);
        return true;
      }
    }
    const cronRunMatch = path.match(/^cron\/([^/]+)\/run$/);
    if (cronRunMatch && method === 'POST') {
      await handleRunCron(req, res, deps, cronRunMatch[1]);
      return true;
    }

    // Facts / Memory
    if (path === 'facts' && method === 'GET') {
      handleSearchFacts(req, res, deps);
      return true;
    }
    if (path === 'facts/all' && method === 'GET') {
      handleAllFacts(req, res, deps);
      return true;
    }
    if (path === 'facts' && method === 'POST') {
      await handleWriteFact(req, res, deps);
      return true;
    }
    if (path === 'facts/consolidate' && method === 'POST') {
      await handleConsolidateFacts(req, res, deps);
      return true;
    }
    if (path === 'memory/senders' && method === 'GET') {
      handleMemorySenders(req, res, deps);
      return true;
    }

    // Tools
    if (path === 'tools' && method === 'GET') {
      handleTools(req, res, deps);
      return true;
    }

    // Chat
    if (path === 'chat' && method === 'POST') {
      await handleChat(req, res, deps);
      return true;
    }
    if (path === 'chat/reset' && method === 'POST') {
      await handleChatReset(req, res, deps);
      return true;
    }

    // Execution metrics
    if (path === 'metrics/stats' && method === 'GET') {
      const qs = new URL(url, 'http://localhost').searchParams;
      const days = parseInt(qs.get('days') ?? '7', 10);
      if (!deps.executionMetrics) {
        sendJson(res, { error: 'Execution metrics not available' }, 503);
      } else {
        sendJson(res, deps.executionMetrics.getStats(days));
      }
      return true;
    }
    if (path === 'metrics/runs' && method === 'GET') {
      const qs = new URL(url, 'http://localhost').searchParams;
      const limit = parseInt(qs.get('limit') ?? '50', 10);
      if (!deps.executionMetrics) {
        sendJson(res, { error: 'Execution metrics not available' }, 503);
      } else {
        sendJson(res, deps.executionMetrics.getRecentRuns(limit));
      }
      return true;
    }
    const stepsMatch = path.match(/^metrics\/runs\/(\d+)\/steps$/);
    if (stepsMatch && method === 'GET') {
      const runId = parseInt(stepsMatch[1], 10);
      if (!deps.executionMetrics) {
        sendJson(res, { error: 'Execution metrics not available' }, 503);
      } else {
        sendJson(res, deps.executionMetrics.getSteps(runId));
      }
      return true;
    }

    // Research decks
    if (path === 'research' && method === 'GET') {
      handleListResearch(req, res, deps);
      return true;
    }
    const researchMatch = path.match(/^research\/([^/]+)$/);
    if (researchMatch && method === 'DELETE') {
      handleDeleteResearch(req, res, deps, researchMatch[1]);
      return true;
    }

    // File serving (generated charts, workspace files)
    const fileMatch = path.match(/^files\/(.+)$/);
    if (fileMatch && method === 'GET') {
      handleServeFile(req, res, deps, decodeURIComponent(fileMatch[1]));
      return true;
    }

    sendError(res, 'Not found', 404);
    return true;
  } catch (err) {
    console.error('[Console API] Unhandled error:', err instanceof Error ? err.message : err);
    sendError(res, 'Internal server error', 500);
    return true;
  }
}

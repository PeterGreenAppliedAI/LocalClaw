import type { OllamaModel } from '../ollama/types.js';

export interface SpecialistTemplate {
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  maxIterations: number;
  tools: string[];
}

export const SPECIALIST_TEMPLATES: Record<string, SpecialistTemplate> = {
  chat: {
    systemPrompt: 'You are a helpful AI assistant. Be conversational, accurate, and concise.',
    maxTokens: 4096,
    temperature: 0.8,
    maxIterations: 1,
    tools: [],
  },
  web_search: {
    systemPrompt: 'You are a web research specialist. ALWAYS use the web_search tool to find information before answering. Use web_fetch to read page content. Use browser for JavaScript-heavy pages that need rendering. Never answer from memory alone — search first.',
    maxTokens: 4096,
    temperature: 0.3,
    maxIterations: 8,
    tools: ['web_search', 'web_fetch', 'browser', 'reason'],
  },
  memory: {
    systemPrompt: 'You are a memory management specialist. When the user asks you to remember something, ALWAYS use memory_save to store it. When the user asks about past conversations or stored info, ALWAYS use memory_search first. Confirm what you saved or found.',
    maxTokens: 2048,
    temperature: 0.2,
    maxIterations: 5,
    tools: ['memory_search', 'memory_get', 'memory_save', 'knowledge_import'],
  },
  exec: {
    systemPrompt: 'You are a command execution specialist. When the user asks you to run a command, ALWAYS use the exec tool. Show the command output in your response. For file operations, use read_file and write_file.',
    maxTokens: 4096,
    temperature: 0.3,
    maxIterations: 8,
    tools: ['exec', 'read_file', 'write_file', 'code_session', 'reason'],
  },
  cron: {
    systemPrompt: 'You are a scheduling specialist. You manage two types of scheduled tasks:\n\n1. **Cron jobs** — individual recurring tasks with their own schedule, category, and delivery. Use cron_add/cron_list/cron_remove.\n2. **Heartbeat tasks** — autonomous periodic tasks that all run together on a shared schedule. Use heartbeat_add/heartbeat_list/heartbeat_remove.\n\nFor cron schedules, use standard 5-field cron expressions (minute hour day month weekday).',
    maxTokens: 2048,
    temperature: 0.2,
    maxIterations: 3,
    tools: ['cron_add', 'cron_list', 'cron_remove', 'heartbeat_add', 'heartbeat_list', 'heartbeat_remove'],
  },
  message: {
    systemPrompt: '',
    maxTokens: 2048,
    temperature: 0.5,
    maxIterations: 3,
    tools: ['send_message'],
  },
  website: {
    systemPrompt: '',
    maxTokens: 4096,
    temperature: 0.3,
    maxIterations: 5,
    tools: ['website_query'],
  },
  multi: {
    systemPrompt: '',
    maxTokens: 4096,
    temperature: 0.3,
    maxIterations: 8,
    tools: ['web_search', 'memory_search', 'exec', 'send_message', 'task_add', 'task_list', 'task_done', 'reason'],
  },
  config: {
    systemPrompt: 'You are a configuration specialist. You can edit cron jobs (cron_edit), read workspace files (workspace_read), write workspace files (workspace_write), and manage scheduled tasks. Always confirm changes after making them.',
    maxTokens: 4096,
    temperature: 0.3,
    maxIterations: 5,
    tools: ['cron_edit', 'cron_add', 'cron_list', 'cron_remove', 'workspace_read', 'workspace_write'],
  },
  task: {
    systemPrompt: 'You are a task management specialist. Use task_add to create tasks, task_list to show them, task_update to modify, task_done to complete, task_remove to delete. Default to showing todo + in_progress. Always confirm changes.',
    maxTokens: 2048,
    temperature: 0.2,
    maxIterations: 5,
    tools: ['task_add', 'task_list', 'task_update', 'task_done', 'task_remove'],
  },
};

export const ROUTER_CATEGORIES: Record<string, { description: string }> = {
  chat: { description: 'Simple conversation, greetings, opinions, questions about the owner/user, or anything answerable from context' },
  web_search: { description: 'Questions needing current internet information about external topics' },
  memory: { description: 'Questions about past conversations or stored info' },
  exec: { description: 'Run commands, edit files, system operations' },
  cron: { description: 'Schedule, list, or manage recurring tasks and heartbeat tasks' },
  message: { description: 'Send messages to other channels/users' },
  website: { description: 'Teaching materials, courses, assignments' },
  task: { description: 'Create, list, update, or complete tasks and to-dos' },
  multi: { description: 'Complex requests needing multiple different tools' },
  config: { description: 'Edit settings, cron jobs, workspace files, agent configuration' },
};

/**
 * Pick best router model from available models.
 * Prefers phi4-mini, falls back to smallest model.
 */
export function pickRouterModel(models: OllamaModel[]): string | undefined {
  if (!models.length) return undefined;

  // Prefer phi4-mini
  const phi4Mini = models.find(m => m.name.includes('phi4-mini'));
  if (phi4Mini) return phi4Mini.name;

  // Prefer phi4
  const phi4 = models.find(m => m.name.includes('phi4'));
  if (phi4) return phi4.name;

  // Fall back to smallest model
  const sorted = [...models].sort((a, b) => a.size - b.size);
  return sorted[0].name;
}

/**
 * Pick best specialist model from available models.
 * Prefers *-coder models, falls back to largest model.
 */
export function pickSpecialistModel(models: OllamaModel[]): string | undefined {
  if (!models.length) return undefined;

  // Prefer coder models
  const coders = models.filter(m => m.name.includes('coder'));
  if (coders.length) {
    // Pick the largest coder
    const sorted = [...coders].sort((a, b) => b.size - a.size);
    return sorted[0].name;
  }

  // Fall back to largest model
  const sorted = [...models].sort((a, b) => b.size - a.size);
  return sorted[0].name;
}

/**
 * Find vision-capable models (usually contain 'vl' in the name).
 */
export function findVisionModels(models: OllamaModel[]): OllamaModel[] {
  return models.filter(m => m.name.includes('-vl') || m.name.includes('vision'));
}

export interface SystemStatus {
  ollama: { available: boolean; url: string; models: number };
  channels: Record<string, string>;
  uptime: number;
  tools: number;
  cron: { jobs: number; heartbeats: number };
  memory: { totalFacts: number };
  defaultSenderId?: string | null;
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface ChannelInfo {
  id: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  enabled: boolean;
}

export interface SessionMeta {
  agentId: string;
  sessionKey: string;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  category?: string;
  model?: string;
  iterations?: number;
  toolCalls?: Array<{ tool: string; params: Record<string, unknown>; observation: string }>;
}

export interface Task {
  id: string;
  title: string;
  details?: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high';
  createdBy: 'user' | 'bot';
  assignee?: string;
  dueDate?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CronJob {
  id: string;
  name: string;
  type: 'cron' | 'heartbeat';
  schedule: string;
  category: string;
  message: string;
  delivery: { channel: string; target: string };
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}

export interface FactEntry {
  id: string;
  text: string;
  category: 'stable' | 'context' | 'decision' | 'question';
  confidence: number;
  source: string;
  createdAt: string;
  expiresAt?: string;
  hash: string;
  senderId?: string;
  tags: string[];
  entities: string[];
}

export interface ResearchDeck {
  slug: string;
  title: string;
  createdAt: string;
  fileSize: number;
  chartCount: number;
  url: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameterDescription: string;
  category: string;
  parameters?: Record<string, unknown>;
}

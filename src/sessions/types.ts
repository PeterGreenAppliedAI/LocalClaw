export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  category?: string;
  model?: string;
  iterations?: number;
  toolCalls?: Array<{ tool: string; params: Record<string, unknown>; observation: string }>;
}

export interface SessionMetadata {
  agentId: string;
  sessionKey: string;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
}

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

export interface CompactionSummary {
  text: string;
  coversUpToIndex: number;
  generatedAt: string;
  model: string;
}

export interface SessionState {
  // Code-driven (updated every turn, zero LLM cost)
  currentCategory: string;
  turnCount: number;
  lastToolCalls: string[];
  pendingActions: string[];
  completedActions: string[];

  // LLM-driven (updated every ~5 turns, ~200 tokens)
  currentTopic: string;
  knownFacts: string[];
  openQuestions: string[];

  // Metadata
  lastUpdated: string;
  lastSemanticUpdate: number;
}

export function createEmptySessionState(category: string): SessionState {
  return {
    currentCategory: category,
    turnCount: 0,
    lastToolCalls: [],
    pendingActions: [],
    completedActions: [],
    currentTopic: '',
    knownFacts: [],
    openQuestions: [],
    lastUpdated: new Date().toISOString(),
    lastSemanticUpdate: 0,
  };
}

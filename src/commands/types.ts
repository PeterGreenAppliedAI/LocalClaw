/**
 * Command handler types — extracted from orchestrator.
 * Commands are !-prefixed messages that bypass routing.
 */
import type { LocalClawConfig } from '../config/types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { SessionStore } from '../sessions/store.js';
import type { FactStore } from '../memory/fact-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';
import type { InboundMessage } from '../channels/types.js';

export interface CommandContext {
  config: LocalClawConfig;
  client: OllamaClient;
  toolRegistry: ToolRegistry;
  channelRegistry: ChannelRegistry;
  sessionStore: SessionStore;
  factStore?: FactStore;
  graphMemory?: GraphMemoryStore;
  /** Extract facts from a transcript — calls the LLM extraction logic */
  extractFacts: (
    transcript: Array<{ role: string; content: string; category?: string }>,
    recentlyRemoved?: string[],
    senderId?: string,
  ) => Promise<import('../config/types.js').FactInput[]>;
}

export interface CommandResult {
  /** Whether the command was handled (message consumed, no further dispatch) */
  handled: boolean;
}

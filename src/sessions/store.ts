import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sessionIoError } from '../errors.js';
import type { ConversationTurn, SessionMetadata, CompactionSummary, SessionState } from './types.js';

export class SessionStore {
  constructor(private readonly baseDir: string) {}

  private sessionPath(agentId: string, sessionKey: string): string {
    return join(this.baseDir, agentId, `${sanitizeKey(sessionKey)}.json`);
  }

  private metaPath(agentId: string, sessionKey: string): string {
    return join(this.baseDir, agentId, `${sanitizeKey(sessionKey)}.meta.json`);
  }

  private summaryPath(agentId: string, sessionKey: string): string {
    return join(this.baseDir, agentId, `${sanitizeKey(sessionKey)}.summary.json`);
  }

  private statePath(agentId: string, sessionKey: string): string {
    return join(this.baseDir, agentId, `${sanitizeKey(sessionKey)}.state.json`);
  }

  loadTranscript(agentId: string, sessionKey: string, maxTurns?: number): ConversationTurn[] {
    const path = this.sessionPath(agentId, sessionKey);
    try {
      const data = readFileSync(path, 'utf-8');
      const turns: ConversationTurn[] = JSON.parse(data);
      if (maxTurns && turns.length > maxTurns) {
        return turns.slice(-maxTurns);
      }
      return turns;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw sessionIoError(`Failed to read transcript: ${path}`, err);
    }
  }

  appendTurn(agentId: string, sessionKey: string, turn: ConversationTurn): void {
    const path = this.sessionPath(agentId, sessionKey);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    // Atomic write: load → append → write tmp → rename
    const existing = this.loadTranscript(agentId, sessionKey);
    existing.push(turn);

    const tmpPath = path + '.tmp';
    try {
      writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
      renameSync(tmpPath, path);
    } catch (err) {
      throw sessionIoError(`Failed to write transcript: ${path}`, err);
    }

    // Update metadata
    this.updateMetadata(agentId, sessionKey, existing.length);
  }

  clearSession(agentId: string, sessionKey: string): void {
    const path = this.sessionPath(agentId, sessionKey);
    try {
      writeFileSync(path, '[]');
    } catch {
      // Ignore if file doesn't exist
    }

    // Also clear the compaction summary — stale summaries after !new
    // would inject old context into the fresh session
    const summary = this.summaryPath(agentId, sessionKey);
    try {
      writeFileSync(summary, '');
    } catch {
      // Ignore
    }

    // Clear session state — stale state would mislead the specialist
    const state = this.statePath(agentId, sessionKey);
    try {
      writeFileSync(state, '');
    } catch {
      // Ignore
    }
  }

  loadSummary(agentId: string, sessionKey: string): CompactionSummary | null {
    const path = this.summaryPath(agentId, sessionKey);
    try {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as CompactionSummary;
    } catch {
      return null;
    }
  }

  loadState(agentId: string, sessionKey: string): SessionState | null {
    const path = this.statePath(agentId, sessionKey);
    try {
      const data = readFileSync(path, 'utf-8');
      if (!data.trim()) return null;
      return JSON.parse(data) as SessionState;
    } catch {
      return null;
    }
  }

  saveState(agentId: string, sessionKey: string, state: SessionState): void {
    const path = this.statePath(agentId, sessionKey);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path, JSON.stringify(state, null, 2));
    } catch {
      console.warn(`[SessionStore] Failed to write state: ${path}`);
    }
  }

  saveSummary(agentId: string, sessionKey: string, summary: CompactionSummary): void {
    const path = this.summaryPath(agentId, sessionKey);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path, JSON.stringify(summary, null, 2));
    } catch {
      // Non-critical — don't throw
    }
  }

  getMetadata(agentId: string, sessionKey: string): SessionMetadata | null {
    const path = this.metaPath(agentId, sessionKey);
    try {
      const data = readFileSync(path, 'utf-8');
      return JSON.parse(data) as SessionMetadata;
    } catch {
      return null;
    }
  }

  private updateMetadata(agentId: string, sessionKey: string, turnCount: number): void {
    const path = this.metaPath(agentId, sessionKey);
    const now = new Date().toISOString();

    const existing = this.getMetadata(agentId, sessionKey);
    const meta: SessionMetadata = {
      agentId,
      sessionKey,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
      turnCount,
    };

    try {
      writeFileSync(path, JSON.stringify(meta, null, 2));
    } catch {
      // Non-critical — don't throw
    }
  }
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_\-:.]/g, '_');
}

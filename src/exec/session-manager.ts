import { spawn, type ChildProcess } from 'node:child_process';
import type { SessionExecConfig } from '../config/types.js';

const SENTINEL = '__LOCALCLAW_DONE__';
const DEFAULT_COMMAND_TIMEOUT = 30_000;

export type SessionRuntime = 'python' | 'node' | 'bash';

export interface SessionInfo {
  id: string;
  runtime: SessionRuntime;
  startedAt: string;
  outputBytes: number;
}

interface Session {
  id: string;
  runtime: SessionRuntime;
  process: ChildProcess;
  outputBuffer: string;
  startedAt: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private config: Required<SessionExecConfig>;

  constructor(config?: Partial<SessionExecConfig>) {
    this.config = {
      idleTimeoutMs: config?.idleTimeoutMs ?? 300_000,
      maxSessions: config?.maxSessions ?? 3,
      maxOutputBytes: config?.maxOutputBytes ?? 1024 * 1024,
      allowedRuntimes: config?.allowedRuntimes ?? ['python', 'node', 'bash'],
    };
  }

  /**
   * Start a new persistent session.
   */
  start(id: string, runtime: SessionRuntime, cwd?: string): string {
    if (this.sessions.has(id)) {
      return `Session "${id}" already exists`;
    }

    if (this.sessions.size >= this.config.maxSessions) {
      return `Max sessions (${this.config.maxSessions}) reached. Close one first.`;
    }

    if (!this.config.allowedRuntimes.includes(runtime)) {
      return `Runtime "${runtime}" not allowed. Allowed: ${this.config.allowedRuntimes.join(', ')}`;
    }

    const { command, args } = this.getRuntimeCommand(runtime);
    const proc = spawn(command, args, {
      cwd: cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const session: Session = {
      id,
      runtime,
      process: proc,
      outputBuffer: '',
      startedAt: new Date().toISOString(),
      idleTimer: null,
    };

    // Collect stdout and stderr
    proc.stdout?.on('data', (data: Buffer) => {
      session.outputBuffer += data.toString();
      this.trimOutputBuffer(session);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      session.outputBuffer += `[STDERR] ${data.toString()}`;
      this.trimOutputBuffer(session);
    });

    proc.on('exit', () => {
      this.cleanup(id);
    });

    this.sessions.set(id, session);
    this.resetIdleTimer(session);

    return `Session "${id}" started (${runtime})`;
  }

  /**
   * Start a session from an external ChildProcess (e.g., Docker).
   */
  startFromProcess(id: string, runtime: SessionRuntime, proc: ChildProcess): string {
    if (this.sessions.has(id)) {
      return `Session "${id}" already exists`;
    }

    if (this.sessions.size >= this.config.maxSessions) {
      return `Max sessions (${this.config.maxSessions}) reached. Close one first.`;
    }

    const session: Session = {
      id,
      runtime,
      process: proc,
      outputBuffer: '',
      startedAt: new Date().toISOString(),
      idleTimer: null,
    };

    proc.stdout?.on('data', (data: Buffer) => {
      session.outputBuffer += data.toString();
      this.trimOutputBuffer(session);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      session.outputBuffer += `[STDERR] ${data.toString()}`;
      this.trimOutputBuffer(session);
    });

    proc.on('exit', () => {
      this.cleanup(id);
    });

    this.sessions.set(id, session);
    this.resetIdleTimer(session);

    return `Session "${id}" started (${runtime})`;
  }

  /**
   * Run code in a session. Writes code + sentinel, awaits sentinel in output.
   */
  async run(id: string, code: string): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) return `Error: Session "${id}" not found`;

    if (!session.process.stdin?.writable) {
      return `Error: Session "${id}" stdin is not writable (process may have exited)`;
    }

    this.resetIdleTimer(session);

    // Clear output buffer before running
    const beforeLength = session.outputBuffer.length;

    // Write code + sentinel command
    const sentinelCmd = this.getSentinelCommand(session.runtime);
    session.process.stdin.write(`${code}\n${sentinelCmd}\n`);

    // Wait for sentinel in output
    const output = await this.waitForSentinel(session, beforeLength, DEFAULT_COMMAND_TIMEOUT);
    return output;
  }

  /**
   * Get the current output buffer for a session.
   */
  getOutput(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return `Error: Session "${id}" not found`;
    return session.outputBuffer || '(no output yet)';
  }

  /**
   * Close a session.
   */
  close(id: string): string {
    const session = this.sessions.get(id);
    if (!session) return `Session "${id}" not found`;

    this.killProcess(session);
    this.cleanup(id);
    return `Session "${id}" closed`;
  }

  /**
   * Close all sessions (shutdown hook).
   */
  closeAll(): void {
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }

  /**
   * List active sessions.
   */
  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      runtime: s.runtime,
      startedAt: s.startedAt,
      outputBytes: s.outputBuffer.length,
    }));
  }

  private getRuntimeCommand(runtime: SessionRuntime): { command: string; args: string[] } {
    switch (runtime) {
      case 'python':
        return { command: 'python3', args: ['-u', '-i'] };
      case 'node':
        return { command: 'node', args: ['--interactive'] };
      case 'bash':
        return { command: 'bash', args: ['--norc'] };
    }
  }

  private getSentinelCommand(runtime: SessionRuntime): string {
    switch (runtime) {
      case 'python':
        return `print("${SENTINEL}")`;
      case 'node':
        return `console.log("${SENTINEL}")`;
      case 'bash':
        return `echo "${SENTINEL}"`;
    }
  }

  private async waitForSentinel(session: Session, fromIndex: number, timeoutMs: number): Promise<string> {
    const start = Date.now();

    return new Promise((resolve) => {
      const check = () => {
        const newOutput = session.outputBuffer.slice(fromIndex);
        const sentinelIdx = newOutput.indexOf(SENTINEL);

        if (sentinelIdx !== -1) {
          // Extract output before sentinel, clean up
          const output = newOutput.slice(0, sentinelIdx).trim();
          resolve(output || '(no output)');
          return;
        }

        if (Date.now() - start > timeoutMs) {
          const partial = newOutput.trim();
          resolve(partial ? `${partial}\n[Timed out after ${timeoutMs / 1000}s]` : `[Timed out after ${timeoutMs / 1000}s — no output]`);
          return;
        }

        setTimeout(check, 50);
      };

      check();
    });
  }

  private resetIdleTimer(session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = setTimeout(() => {
      console.log(`[SessionManager] Session "${session.id}" idle timeout, closing`);
      this.close(session.id);
    }, this.config.idleTimeoutMs);
  }

  private trimOutputBuffer(session: Session): void {
    if (session.outputBuffer.length > this.config.maxOutputBytes) {
      // Keep the tail
      session.outputBuffer = session.outputBuffer.slice(-this.config.maxOutputBytes);
    }
  }

  private killProcess(session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    try {
      session.process.kill('SIGTERM');
      // Force kill after 5s
      const forceKill = setTimeout(() => {
        try { session.process.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5000);
      session.process.on('exit', () => clearTimeout(forceKill));
    } catch { /* already dead */ }
  }

  private cleanup(id: string): void {
    const session = this.sessions.get(id);
    if (session?.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    this.sessions.delete(id);
  }
}

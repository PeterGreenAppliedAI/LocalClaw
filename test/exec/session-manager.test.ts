import { describe, it, expect, afterEach } from 'vitest';
import { SessionManager } from '../../src/exec/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  afterEach(() => {
    manager?.closeAll();
  });

  it('starts and lists sessions', () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    const result = manager.start('test1', 'bash');
    expect(result).toContain('started');

    const sessions = manager.list();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe('test1');
    expect(sessions[0].runtime).toBe('bash');
  });

  it('rejects duplicate session IDs', () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('dup', 'bash');
    const result = manager.start('dup', 'bash');
    expect(result).toContain('already exists');
  });

  it('enforces max sessions limit', () => {
    manager = new SessionManager({ maxSessions: 1, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('s1', 'bash');
    const result = manager.start('s2', 'bash');
    expect(result).toContain('Max sessions');
  });

  it('rejects disallowed runtimes', () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['bash'] });
    const result = manager.start('s1', 'python');
    expect(result).toContain('not allowed');
  });

  it('closes a session', () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('s1', 'bash');
    const result = manager.close('s1');
    expect(result).toContain('closed');
    expect(manager.list().length).toBe(0);
  });

  it('returns error for unknown session', () => {
    manager = new SessionManager();
    const result = manager.close('nonexistent');
    expect(result).toContain('not found');
  });

  it('runs code in bash session and preserves state', async () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('bash1', 'bash');

    // Set a variable
    await manager.run('bash1', 'export TESTVAR=hello');

    // Read it back
    const output = await manager.run('bash1', 'echo $TESTVAR');
    expect(output).toContain('hello');
  });

  it('runs code in python session and preserves state', async () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('py1', 'python');

    // Give python a moment to start
    await new Promise(r => setTimeout(r, 500));

    // Define variable
    await manager.run('py1', 'x = 42');

    // Use it
    const output = await manager.run('py1', 'print(x)');
    expect(output).toContain('42');
  }, 15_000);

  it('captures stderr', async () => {
    manager = new SessionManager({ maxSessions: 3, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('bash-err', 'bash');

    const output = await manager.run('bash-err', 'echo "error msg" >&2');
    // stderr should appear in output buffer
    const fullOutput = manager.getOutput('bash-err');
    expect(fullOutput).toContain('error msg');
  });

  it('closeAll cleans up all sessions', () => {
    manager = new SessionManager({ maxSessions: 5, idleTimeoutMs: 60_000, maxOutputBytes: 1024 * 1024, allowedRuntimes: ['python', 'node', 'bash'] });
    manager.start('s1', 'bash');
    manager.start('s2', 'bash');
    expect(manager.list().length).toBe(2);

    manager.closeAll();
    expect(manager.list().length).toBe(0);
  });
});

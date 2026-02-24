import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerBackend } from '../../src/exec/docker-backend.js';
import { execFile } from 'node:child_process';

// Mock execFile for unit testing without Docker
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: actual.spawn,
  };
});

const mockedExecFile = vi.mocked(execFile);

describe('DockerBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isAvailable', () => {
    it('returns true when docker info succeeds', async () => {
      mockedExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
        if (cb) cb(null, 'Docker info output', '');
        return {} as any;
      });

      const available = await DockerBackend.isAvailable();
      expect(available).toBe(true);
    });

    it('returns false when docker info fails', async () => {
      mockedExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb?: any) => {
        if (cb) cb(new Error('docker not found'), '', '');
        return {} as any;
      });

      const available = await DockerBackend.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe('exec', () => {
    it('runs command inside container and returns output', async () => {
      const backend = new DockerBackend({ image: 'test:latest' });

      // Mock container inspect (exists + running)
      let callCount = 0;
      mockedExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
        callCount++;
        if (Array.isArray(args)) {
          if (args.includes('inspect') && args.includes('-f')) {
            if (cb) cb(null, 'true\n', '');
          } else if (args.includes('inspect')) {
            if (cb) cb(null, '[{}]', '');
          } else if (args[0] === 'exec') {
            if (cb) cb(null, 'command output', '');
          }
        }
        return {} as any;
      });

      const result = await backend.exec('echo', ['hello'], 5000);
      expect(result.stdout).toBe('command output');
      expect(result.exitCode).toBe(0);
    });

    it('returns exit code on command failure', async () => {
      const backend = new DockerBackend({ image: 'test:latest' });

      mockedExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
        if (Array.isArray(args)) {
          if (args.includes('inspect') && args.includes('-f')) {
            if (cb) cb(null, 'true\n', '');
          } else if (args.includes('inspect')) {
            if (cb) cb(null, '[{}]', '');
          } else if (args[0] === 'exec') {
            const err = new Error('command failed') as any;
            err.code = 1;
            if (cb) cb(err, '', 'error output');
          }
        }
        return {} as any;
      });

      const result = await backend.exec('false', [], 5000);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('ensureRunning', () => {
    it('creates container when it does not exist', async () => {
      const backend = new DockerBackend();
      const runCalls: string[][] = [];

      mockedExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
        if (Array.isArray(args)) {
          runCalls.push(args);
          if (args.includes('inspect') && !args.includes('-f')) {
            // Container doesn't exist
            if (cb) cb(new Error('no such container'), '', '');
          } else if (args[0] === 'run') {
            if (cb) cb(null, 'container_id', '');
          }
        }
        return {} as any;
      });

      await backend.ensureRunning();
      const runCall = runCalls.find(args => args[0] === 'run');
      expect(runCall).toBeDefined();
      expect(runCall).toContain('-d');
      expect(runCall).toContain('--name');
    });

    it('starts existing stopped container', async () => {
      const backend = new DockerBackend();
      const calls: string[][] = [];

      mockedExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
        if (Array.isArray(args)) {
          calls.push(args);
          if (args.includes('inspect') && args.includes('-f')) {
            // Container exists but not running
            if (cb) cb(null, 'false\n', '');
          } else if (args.includes('inspect')) {
            if (cb) cb(null, '[{}]', '');
          } else if (args[0] === 'start') {
            if (cb) cb(null, '', '');
          }
        }
        return {} as any;
      });

      await backend.ensureRunning();
      const startCall = calls.find(args => args[0] === 'start');
      expect(startCall).toBeDefined();
    });

    it('is idempotent when container already running', async () => {
      const backend = new DockerBackend();
      let inspectCount = 0;

      mockedExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
        if (Array.isArray(args)) {
          if (args.includes('inspect') && args.includes('-f')) {
            inspectCount++;
            if (cb) cb(null, 'true\n', '');
          } else if (args.includes('inspect')) {
            if (cb) cb(null, '[{}]', '');
          }
        }
        return {} as any;
      });

      await backend.ensureRunning();
      await backend.ensureRunning(); // second call should skip
      // Second call should not even check since running flag is set
      expect(inspectCount).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('stops and removes the container', async () => {
      const backend = new DockerBackend();
      const calls: string[][] = [];

      mockedExecFile.mockImplementation((_cmd: any, args: any, _opts: any, cb?: any) => {
        if (Array.isArray(args)) {
          calls.push(args);
          if (args.includes('inspect') && args.includes('-f')) {
            if (cb) cb(null, 'true\n', '');
          } else if (args.includes('inspect')) {
            if (cb) cb(null, '[{}]', '');
          } else if (args[0] === 'run') {
            if (cb) cb(null, 'id', '');
          } else {
            if (cb) cb(null, '', '');
          }
        }
        return {} as any;
      });

      await backend.ensureRunning();
      await backend.shutdown();

      const stopCall = calls.find(args => args[0] === 'stop');
      const rmCall = calls.find(args => args[0] === 'rm');
      expect(stopCall).toBeDefined();
      expect(rmCall).toBeDefined();
    });
  });

  describe('createExecTool with docker', () => {
    it('skips allowlist when docker backend is provided', async () => {
      const { createExecTool } = await import('../../src/tools/exec.js');

      const mockBackend = {
        exec: vi.fn().mockResolvedValue({ stdout: 'docker output', stderr: '', exitCode: 0 }),
        ensureRunning: vi.fn(),
      } as any;

      const tool = createExecTool(undefined, mockBackend);

      // This command would be blocked by allowlist, but docker allows it
      const result = await tool.execute(
        { command: 'apt-get', args: 'update' },
        { agentId: 'test', sessionKey: 'test' },
      );
      expect(result).toContain('docker output');
      expect(mockBackend.exec).toHaveBeenCalledWith('apt-get', ['update'], expect.any(Number));
    });

    it('falls back to allowlist when no docker backend', async () => {
      const { createExecTool } = await import('../../src/tools/exec.js');
      const tool = createExecTool({ security: 'allowlist', allowlist: ['ls'], timeout: 5000 });

      const result = await tool.execute(
        { command: 'apt-get', args: 'update' },
        { agentId: 'test', sessionKey: 'test' },
      );
      expect(result).toContain('not in the allowlist');
    });
  });
});

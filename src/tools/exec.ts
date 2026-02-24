import { execFile } from 'node:child_process';
import type { LocalClawTool } from './types.js';
import type { ExecConfig } from '../config/types.js';
import type { DockerBackend } from '../exec/docker-backend.js';

export function createExecTool(config?: ExecConfig, dockerBackend?: DockerBackend): LocalClawTool {
  const allowlist = new Set(config?.allowlist ?? ['ls', 'cat', 'python3', 'node', 'git']);
  const timeout = config?.timeout ?? 30_000;
  const useDocker = !!dockerBackend;

  return {
    name: 'exec',
    description: useDocker
      ? 'Run a shell command inside a sandboxed Docker container.'
      : `Run a shell command. Allowed commands: ${[...allowlist].join(', ')}`,
    parameterDescription: 'command (required): The command to run. args (optional): Arguments for the command.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: useDocker
            ? 'The command to run inside the sandbox'
            : `The command to run. Must be one of: ${[...allowlist].join(', ')}`,
        },
        args: { type: 'string', description: 'Space-separated arguments for the command' },
      },
      required: ['command'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>): Promise<string> {
      const command = params.command as string;
      if (!command) return 'Error: command parameter is required';

      // Handle args as string (split on spaces) or array
      let args: string[] = [];
      if (typeof params.args === 'string') {
        args = params.args.split(/\s+/).filter(Boolean);
      } else if (Array.isArray(params.args)) {
        args = params.args;
      }

      // Docker execution path — no allowlist needed
      if (dockerBackend) {
        try {
          const result = await dockerBackend.exec(command, args, timeout);
          const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
          if (result.exitCode !== 0) {
            return `Error (exit ${result.exitCode}): ${output.slice(0, 5000)}`;
          }
          return output.slice(0, 5000) || '(no output)';
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : err}`;
        }
      }

      // Allowlist execution path
      const baseCmd = command.split(/[\s/]/)[0];
      if (!allowlist.has(baseCmd)) {
        return `Error: Command "${baseCmd}" is not in the allowlist. Allowed: ${[...allowlist].join(', ')}`;
      }

      return new Promise((resolve) => {
        execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            const output = stderr || err.message;
            resolve(`Error (exit ${(err as any).code ?? '?'}): ${output.slice(0, 2000)}`);
            return;
          }
          const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
          resolve(output.slice(0, 5000) || '(no output)');
        });
      });
    },
  };
}

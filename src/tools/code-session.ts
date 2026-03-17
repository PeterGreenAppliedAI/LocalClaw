import type { LocalClawTool } from './types.js';
import type { SessionManager, SessionRuntime } from '../exec/session-manager.js';

export function createCodeSessionTool(
  sessionManager: SessionManager,
): LocalClawTool {
  return {
    name: 'code_session',
    description: 'Manage persistent code sessions. Start a REPL, run code that preserves state between calls, get output, or close sessions.',
    parameterDescription: 'action (required): start/run/output/close/list. session (required for start/run/output/close): Session name. runtime (required for start): python/node/bash. code (required for run): Code to execute.',
    example: 'code_session[{"action": "start", "session": "analysis", "runtime": "python"}]',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform', enum: ['start', 'run', 'output', 'close', 'list'] },
        session: { type: 'string', description: 'Session name/ID' },
        runtime: { type: 'string', description: 'Runtime for new session', enum: ['python', 'node', 'bash'] },
        code: { type: 'string', description: 'Code to run in the session' },
      },
      required: ['action'],
    },
    category: 'exec',

    async execute(params: Record<string, unknown>): Promise<string> {
      const action = params.action as string;
      const sessionId = params.session as string;
      const runtime = params.runtime as SessionRuntime;
      const code = params.code as string;

      switch (action) {
        case 'start': {
          if (!sessionId) return 'Error: session parameter is required for start';
          if (!runtime) return 'Error: runtime parameter is required for start';
          return sessionManager.start(sessionId, runtime);
        }

        case 'run': {
          if (!sessionId) return 'Error: session parameter is required for run';
          if (!code) return 'Error: code parameter is required for run';
          return sessionManager.run(sessionId, code);
        }

        case 'output': {
          if (!sessionId) return 'Error: session parameter is required for output';
          return sessionManager.getOutput(sessionId);
        }

        case 'close': {
          if (!sessionId) return 'Error: session parameter is required for close';
          return sessionManager.close(sessionId);
        }

        case 'list': {
          const sessions = sessionManager.list();
          if (sessions.length === 0) return 'No active sessions';
          return sessions
            .map(s => `- ${s.id} (${s.runtime}, started ${s.startedAt}, ${s.outputBytes} bytes output)`)
            .join('\n');
        }

        default:
          return `Error: Unknown action "${action}". Use: start, run, output, close, list`;
      }
    },
  };
}

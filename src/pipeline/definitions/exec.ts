import type { PipelineDefinition } from '../types.js';

/**
 * Exec pipeline: extract(command, args, code) → code(validate) → tool(exec) → llm(format output)
 *
 * Replaces the ReAct loop for the "exec" category.
 */
export const execPipeline: PipelineDefinition = {
  name: 'exec',
  stages: [
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        command: { type: 'string', description: 'Command to run (e.g., "python3", "node", "ls", "git")', required: true },
        args: { type: 'string', description: 'Command arguments (space-separated)' },
        code: { type: 'string', description: 'Inline code snippet to execute (for interpreted languages)' },
      },
      examples: [
        { input: 'run ls -la', output: { command: 'ls', args: '-la' } },
        { input: 'execute python print("hello world")', output: { command: 'python3', code: 'print("hello world")' } },
        { input: 'check git status', output: { command: 'git', args: 'status' } },
      ],
    },
    {
      name: 'exec',
      type: 'tool',
      tool: 'exec',
      resolveParams: (ctx) => {
        const p: Record<string, unknown> = { command: ctx.params.command };
        if (ctx.params.args) p.args = ctx.params.args;
        if (ctx.params.code) p.code = ctx.params.code;
        return p;
      },
    },
    {
      name: 'format',
      type: 'llm',
      temperature: 0.2,
      maxTokens: 1024,
      buildPrompt: (ctx) => ({
        system: 'Format the command output for the user. If the output is an error, explain what went wrong. Be concise.',
        user: `User asked: "${ctx.userMessage}"\n\nCommand: ${ctx.params.command}${ctx.params.args ? ' ' + ctx.params.args : ''}\n\nOutput:\n${ctx.stageResults.exec as string}`,
      }),
    },
  ],
};

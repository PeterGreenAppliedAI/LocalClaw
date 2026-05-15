import type { PipelineDefinition } from '../types.js';

/**
 * Code generation pipeline: extract → build → report
 *
 * Deterministic — no ReAct loop. One opencode_build call, one result.
 */
export const codeGenPipeline: PipelineDefinition = {
  name: 'code_gen',
  stages: [
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        prompt: { type: 'string', description: 'What to build — language, framework, features, tests', required: true },
        model: { type: 'string', description: 'Model to use (optional)' },
      },
      examples: [
        { input: 'Build a Python CLI that reads CSV files and outputs stats', output: { prompt: 'Build a Python CLI that reads CSV files and outputs stats with tests' } },
        { input: 'Create a REST API with Express and tests', output: { prompt: 'Create a Node.js Express REST API with tests using built-in test runner' } },
      ],
    },
    {
      name: 'build',
      type: 'tool',
      tool: 'opencode_build',
      resolveParams: (ctx) => ({
        prompt: ctx.params.prompt,
        ...(ctx.params.model ? { model: ctx.params.model } : {}),
      }),
    },
    {
      name: 'report',
      type: 'llm',
      stream: true,
      temperature: 0.3,
      maxTokens: 1024,
      buildPrompt: (ctx) => {
        const buildResult = ctx.stageResults.build as string;
        return {
          system: 'You are summarizing the results of a code generation task. List the files created with a brief description of each. Mention if tests were included. Be concise.',
          user: `The build tool returned:\n\n${buildResult}\n\nSummarize what was built.`,
        };
      },
    },
  ],
};

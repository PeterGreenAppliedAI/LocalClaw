import type { PipelineDefinition } from '../types.js';

/**
 * Code generation pipeline: enrich → build → report
 *
 * Deterministic — no ReAct loop.
 * 1. LLM enriches the user's request into a detailed build specification
 * 2. opencode_build executes with the enriched prompt
 * 3. LLM summarizes what was built
 */
export const codeGenPipeline: PipelineDefinition = {
  name: 'code_gen',
  stages: [
    {
      name: 'enrich',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 1024,
      buildPrompt: (ctx) => ({
        system: [
          'You are a software architect preparing a detailed build specification for a coding agent.',
          'The user has a high-level request. Your job is to expand it into a precise, actionable specification.',
          '',
          'Include in your specification:',
          '- Language and framework (do NOT specify version numbers — let the package manager resolve latest)',
          '- File structure (which files to create)',
          '- Each endpoint/function with expected inputs and outputs',
          '- Error handling requirements (validation, error responses)',
          '- Test file with real integration tests (actual HTTP requests or function calls, NOT mocked assertions)',
          '- A package.json/requirements.txt with correct dependencies',
          '',
          'Write ONLY the specification as a clear, numbered list. No explanation, no preamble.',
        ].join('\n'),
        user: ctx.userMessage,
      }),
    },
    {
      name: 'build',
      type: 'tool',
      tool: 'opencode_build',
      resolveParams: (ctx) => {
        const enrichedPrompt = ctx.stageResults.enrich as string;
        console.log(`[CodeGen] Enriched prompt: ${enrichedPrompt.slice(0, 200)}...`);
        return { prompt: enrichedPrompt };
      },
    },
    {
      name: 'report',
      type: 'llm',
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

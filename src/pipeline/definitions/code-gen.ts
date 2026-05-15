import type { PipelineDefinition, PipelineContext } from '../types.js';

/**
 * Code generation pipeline: enrich → build → verify → [fix] → [re-verify] → report
 *
 * Deterministic — no ReAct loop.
 * 1. LLM enriches the user's request into a detailed build specification
 * 2. opencode_build executes with the enriched prompt
 * 3. Verify: detect project type, install deps, run tests
 * 4. Fix (conditional): if tests fail, send errors to same OpenCode session
 * 5. Re-verify (conditional): run tests again after fix
 * 6. LLM summarizes what was built + test status
 */

/** Detect project type and run tests in the given directory */
async function runTests(projectDir: string): Promise<{ pass: boolean; output: string; skipped?: boolean }> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');

  const run = (cmd: string, args: string[], cwd: string, timeout = 60000): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise(resolve => {
      execFile(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err as any).code ?? 1 : 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });

  // Detect project type and determine commands
  let installCmd: { cmd: string; args: string[] } | null = null;
  let testCmd: { cmd: string; args: string[] };

  if (existsSync(join(projectDir, 'package.json'))) {
    installCmd = { cmd: 'npm', args: ['install', '--no-audit', '--no-fund'] };
    testCmd = { cmd: 'npm', args: ['test'] };
  } else if (existsSync(join(projectDir, 'requirements.txt'))) {
    // Create venv if needed (macOS blocks bare pip install)
    const venvDir = join(projectDir, '.venv');
    if (!existsSync(venvDir)) {
      const venvResult = await run('python3', ['-m', 'venv', venvDir], projectDir, 30000);
      if (venvResult.code !== 0) {
        return { pass: false, output: `Failed to create venv:\n${venvResult.stderr}` };
      }
    }
    const pip = join(venvDir, 'bin', 'pip');
    const python = join(venvDir, 'bin', 'python');
    installCmd = { cmd: pip, args: ['install', '-r', 'requirements.txt', '-q'] };
    testCmd = { cmd: python, args: ['-m', 'pytest', '-v'] };
  } else if (existsSync(join(projectDir, 'go.mod'))) {
    testCmd = { cmd: 'go', args: ['test', './...'] };
  } else if (existsSync(join(projectDir, 'Cargo.toml'))) {
    testCmd = { cmd: 'cargo', args: ['test'] };
  } else {
    return { pass: true, output: 'No recognized project type — skipped tests', skipped: true };
  }

  // Install dependencies
  if (installCmd) {
    console.log(`[CodeGen] Installing dependencies in ${projectDir}...`);
    const install = await run(installCmd.cmd, installCmd.args, projectDir, 120000);
    if (install.code !== 0) {
      return { pass: false, output: `Dependency install failed:\n${(install.stderr || install.stdout).slice(0, 3000)}` };
    }
  }

  // Run tests
  console.log(`[CodeGen] Running tests: ${testCmd.cmd} ${testCmd.args.join(' ')}`);
  const result = await run(testCmd.cmd, testCmd.args, projectDir);
  const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 3000);

  if (result.code === 0) {
    console.log(`[CodeGen] Verify: PASS`);
    return { pass: true, output };
  } else {
    console.log(`[CodeGen] Verify: FAIL — ${output.slice(0, 200)}`);
    return { pass: false, output };
  }
}

/** Extract project directory from build result string */
function extractProjectDir(buildResult: string): string | null {
  const match = buildResult.match(/Project directory: (.+)/);
  return match ? match[1].trim() : null;
}

/** Extract session ID from build result string */
function extractSessionId(buildResult: string): string | null {
  const match = buildResult.match(/session: ([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export const codeGenPipeline: PipelineDefinition = {
  name: 'code_gen',
  stages: [
    {
      name: 'list_projects',
      type: 'code',
      execute: async (ctx: PipelineContext) => {
        const { readdirSync, statSync, existsSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const workspace = ctx.toolContext.workspacePath ?? 'data/workspaces/main';
        const buildsDir = join(workspace, 'builds');

        const projects: string[] = [];
        const sessions: Record<string, { sessionId: string; model: string }> = {};
        try {
          for (const f of readdirSync(buildsDir)) {
            if (f.startsWith('.') || f === 'data') continue;
            const full = join(buildsDir, f);
            const sessionFile = join(full, '.opencode-session.json');
            if (statSync(full).isDirectory() && existsSync(sessionFile)) {
              projects.push(f);
              try {
                sessions[f] = JSON.parse(readFileSync(sessionFile, 'utf-8'));
              } catch { /* corrupt session file */ }
            }
          }
        } catch { /* no builds dir yet */ }

        ctx.params._existingProjects = projects;
        ctx.params._projectSessions = sessions;
        ctx.params._buildsDir = buildsDir;
        if (projects.length > 0) {
          console.log(`[CodeGen] Existing projects: ${projects.join(', ')}`);
        }
      },
    },
    {
      name: 'enrich',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 1024,
      buildPrompt: (ctx) => {
        const projects = (ctx.params._existingProjects as string[]) || [];
        const projectList = projects.length > 0
          ? `\n\nEXISTING PROJECTS (can be modified instead of creating new):\n${projects.map(p => `- ${p}`).join('\n')}\n\nIf the user's request references an existing project, write "[MODIFY] <slug>" on the first line (e.g., "[MODIFY] websocket-chat-server"). Otherwise write a new project name.`
          : '';

        return {
          system: [
            'You are a software architect preparing a detailed build specification for a coding agent.',
            'The user has a high-level request. Your job is to expand it into a precise, actionable specification.',
            '',
            'Include in your specification:',
            '- Language and framework (do NOT specify version numbers — let the package manager resolve latest)',
            '- File structure (which files to create or modify)',
            '- Each endpoint/function with expected inputs and outputs',
            '- Error handling requirements (validation, error responses)',
            '- Test file with real integration tests (actual HTTP requests or function calls, NOT mocked assertions)',
            '- A package.json/requirements.txt with correct dependencies',
            '',
            'FIRST LINE: Write a short project name (2-4 words, lowercase, hyphens). Example: "file-monitor-cli"',
            'Then write the specification as a clear, numbered list. No other explanation.',
            projectList,
          ].join('\n'),
          user: ctx.userMessage,
        };
      },
    },
    {
      name: 'build',
      type: 'tool',
      tool: 'opencode_build',
      resolveParams: (ctx) => {
        const enrichedPrompt = ctx.stageResults.enrich as string;
        console.log(`[CodeGen] Enriched prompt: ${enrichedPrompt.slice(0, 200)}...`);
        const lines = enrichedPrompt.split('\n');
        const firstLine = lines[0].trim();
        const spec = lines.slice(1).join('\n').trim();

        // Check for [MODIFY] prefix — reuse existing project + session
        const modifyMatch = firstLine.match(/^\[MODIFY\]\s*(.+)/i);
        if (modifyMatch) {
          const existingSlug = modifyMatch[1].trim();
          const buildsDir = ctx.params._buildsDir as string;
          const projectDir = `${buildsDir}/${existingSlug}`;
          const sessions = (ctx.params._projectSessions ?? {}) as Record<string, { sessionId: string }>;
          const savedSession = sessions[existingSlug];

          if (savedSession?.sessionId) {
            console.log(`[CodeGen] MODIFY existing project: ${existingSlug}, session: ${savedSession.sessionId}`);
            return { prompt: spec || enrichedPrompt, sessionId: savedSession.sessionId, projectDir };
          }
          console.log(`[CodeGen] MODIFY: no saved session for ${existingSlug}, creating new`);
          return { prompt: spec || enrichedPrompt, projectName: existingSlug };
        }

        console.log(`[CodeGen] New project: ${firstLine}`);
        return { prompt: spec || enrichedPrompt, projectName: firstLine };
      },
    },
    {
      name: 'verify',
      type: 'code',
      execute: async (ctx: PipelineContext) => {
        const buildResult = ctx.stageResults.build as string;
        const projectDir = extractProjectDir(buildResult);
        if (!projectDir) {
          ctx.params._verifyResult = { pass: false, output: 'Could not determine project directory' };
          return;
        }
        ctx.params._projectDir = projectDir;
        ctx.params._sessionId = extractSessionId(buildResult);
        ctx.params._verifyResult = await runTests(projectDir);
      },
    },
    {
      name: 'fix',
      type: 'code',
      when: (ctx) => {
        const result = ctx.params._verifyResult as any;
        return result && !result.pass && !result.skipped && !!ctx.params._sessionId;
      },
      execute: async (ctx: PipelineContext) => {
        const verifyResult = ctx.params._verifyResult as { pass: boolean; output: string };
        const sessionId = ctx.params._sessionId as string;
        const projectDir = ctx.params._projectDir as string;

        console.log(`[CodeGen] Fix: sending test errors to session ${sessionId}`);

        const fixPrompt = [
          'The tests failed with the following errors. Fix the code so all tests pass.',
          'Do NOT change the test expectations. Fix the implementation code only.',
          '',
          'Error output:',
          verifyResult.output,
        ].join('\n');

        // Call opencode_build with existing session
        const fixResult = await ctx.executor('opencode_build', {
          prompt: fixPrompt,
          sessionId,
          projectDir,
        }, ctx.toolContext);

        ctx.stageResults.fix = fixResult;
        ctx.params._fixApplied = true;
        console.log(`[CodeGen] Fix applied`);
      },
    },
    {
      name: 're_verify',
      type: 'code',
      when: (ctx) => !!ctx.params._fixApplied,
      execute: async (ctx: PipelineContext) => {
        const projectDir = ctx.params._projectDir as string;
        console.log(`[CodeGen] Re-verify after fix...`);
        ctx.params._verifyResult = await runTests(projectDir);
      },
    },
    {
      name: 'report',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 1024,
      buildPrompt: (ctx) => {
        const buildResult = ctx.stageResults.build as string;
        const verifyResult = ctx.params._verifyResult as { pass: boolean; output: string; skipped?: boolean } | undefined;
        const fixApplied = !!ctx.params._fixApplied;

        let testStatus = 'Tests: not run';
        if (verifyResult?.skipped) {
          testStatus = 'Tests: skipped (no recognized project type)';
        } else if (verifyResult?.pass) {
          testStatus = fixApplied ? 'Tests: PASS (after fix)' : 'Tests: PASS';
        } else if (verifyResult && !verifyResult.pass) {
          testStatus = fixApplied
            ? `Tests: STILL FAILING after fix attempt\nErrors:\n${verifyResult.output.slice(0, 500)}`
            : `Tests: FAILING\nErrors:\n${verifyResult.output.slice(0, 500)}`;
        }

        return {
          system: 'You are summarizing the results of a code generation task. List the files created with a brief description of each. Include the test status. Be concise.',
          user: `The build tool returned:\n\n${buildResult}\n\n${testStatus}\n\nSummarize what was built and the test results.`,
        };
      },
    },
  ],
};

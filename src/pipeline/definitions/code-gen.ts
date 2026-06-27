import type { PipelineDefinition, PipelineContext } from '../types.js';

/**
 * Code generation pipeline: enrich → build → verify → [fix] → [re-verify] → commit → report
 *
 * Deterministic — no ReAct loop. Code owns the workflow; the Pi coding agent fills the bounded
 * "make the files" slot, and the test result (not the model) is the gate.
 * 1. LLM enriches the user's request into a detailed build specification
 * 2. pi_build executes (cwd-scoped) with the enriched spec
 * 3. Verify: detect project type, install deps, run tests — the verdict is the test result
 * 4. Fix (conditional): if tests fail, re-run Pi in the project dir with the errors
 * 5. Re-verify (conditional): run tests again after fix
 * 6. Commit: local git commit (autonomous); remote push only when opted in
 * 7. LLM summarizes what was built + test + git status
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
    const python = join(venvDir, 'bin', 'python');
    // Use `python -m pip`, NOT the .venv/bin/pip script — the script's shebang is fragile across
    // python builds/paths and was returning non-zero even when the venv itself was healthy.
    installCmd = { cmd: python, args: ['-m', 'pip', 'install', '-r', 'requirements.txt', '-q', '--disable-pip-version-check'] };
    testCmd = { cmd: python, args: ['-m', 'pytest', '-v'] };
  } else if (existsSync(join(projectDir, 'go.mod'))) {
    testCmd = { cmd: 'go', args: ['test', './...'] };
  } else if (existsSync(join(projectDir, 'Cargo.toml'))) {
    testCmd = { cmd: 'cargo', args: ['test'] };
  } else {
    return { pass: true, output: 'No recognized project type — skipped tests', skipped: true };
  }

  // Install dependencies. Do NOT hard-fail the gate on a non-zero install exit — pip/npm can exit
  // non-zero for transient or cosmetic reasons, or deps may already be present from a prior run,
  // yet the tests still run fine. Defer the verdict to the actual test result (the source of truth).
  // A real missing-deps situation surfaces as a test failure (import error), which the gate catches.
  let installNote = '';
  if (installCmd) {
    console.log(`[CodeGen] Installing dependencies in ${projectDir}...`);
    const install = await run(installCmd.cmd, installCmd.args, projectDir, 120000);
    if (install.code !== 0) {
      installNote = `(dependency install exited ${install.code} — ran tests anyway)\n${(install.stderr || install.stdout).slice(0, 800)}\n`;
      console.warn(`[CodeGen] Install exited ${install.code} — running tests anyway`);
    }
  }

  // Run tests — this is what the gate actually judges on.
  console.log(`[CodeGen] Running tests: ${testCmd.cmd} ${testCmd.args.join(' ')}`);
  const result = await run(testCmd.cmd, testCmd.args, projectDir);
  const output = `${installNote}${result.stdout}\n${result.stderr}`.trim().slice(0, 3000);

  if (result.code === 0) {
    console.log(`[CodeGen] Verify: PASS`);
    return { pass: true, output };
  } else {
    console.log(`[CodeGen] Verify: FAIL — ${output.slice(0, 200)}`);
    return { pass: false, output };
  }
}

/** Run a shell command, resolving with code+output (never rejects). */
function sh(cmd: string, args: string[], cwd: string, timeout = 60000): Promise<{ code: number; out: string }> {
  return new Promise(async resolve => {
    const { execFile } = await import('node:child_process');
    execFile(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

const GITIGNORE = [
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.pytest_cache/',
  'dist/', 'build/', 'target/', '.DS_Store',
].join('\n') + '\n';

/**
 * Commit the build locally (autonomous — reversible, internal), and push to GitHub only when
 * explicitly opted in (visible/irreversible → gated). Never throws; records the outcome.
 */
async function commitBuild(
  projectDir: string,
  slug: string,
  status: string,
  git: { commitLocal: boolean; pushRemote: boolean; visibility: 'private' | 'public' },
): Promise<{ committed: boolean; pushed: boolean; url?: string; note: string }> {
  const { writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  if (!git.commitLocal) return { committed: false, pushed: false, note: 'local commit disabled' };

  try {
    if (!existsSync(join(projectDir, '.git'))) {
      const init = await sh('git', ['init', '-q'], projectDir);
      if (init.code !== 0) return { committed: false, pushed: false, note: `git init failed: ${init.out.slice(0, 200)}` };
    }
    writeFileSync(join(projectDir, '.gitignore'), GITIGNORE);
    await sh('git', ['add', '-A'], projectDir);
    const commit = await sh('git', ['commit', '-q', '-m', `Build ${slug}: ${status}`], projectDir);
    // commit exits non-zero if nothing to commit — treat as benign
    const committed = commit.code === 0 || /nothing to commit/.test(commit.out);
    if (!committed) return { committed: false, pushed: false, note: `commit failed: ${commit.out.slice(0, 200)}` };

    if (!git.pushRemote) return { committed: true, pushed: false, note: 'committed locally (remote push not enabled)' };

    // Opt-in GitHub push. Requires gh CLI authed. Create the repo from this dir and push.
    const gh = await sh('gh', ['repo', 'create', slug, `--${git.visibility}`, '--source=.', '--remote=origin', '--push'], projectDir, 120000);
    if (gh.code !== 0) return { committed: true, pushed: false, note: `committed locally; gh push failed: ${gh.out.slice(0, 200)}` };
    const url = (gh.out.match(/https?:\/\/\S+/) ?? [])[0];
    return { committed: true, pushed: true, url, note: `pushed to ${url ?? 'GitHub'}` };
  } catch (err) {
    return { committed: false, pushed: false, note: `git error: ${err instanceof Error ? err.message : err}` };
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
        const { readdirSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const workspace = ctx.toolContext.workspacePath ?? 'data/workspaces/main';
        const buildsDir = join(workspace, 'builds');

        // A project is any build directory. Pi re-runs in the project's cwd to modify it (no
        // session file needed — that was OpenCode's mechanism).
        const projects: string[] = [];
        try {
          for (const f of readdirSync(buildsDir)) {
            if (f.startsWith('.') || f === 'data') continue;
            if (statSync(join(buildsDir, f)).isDirectory()) projects.push(f);
          }
        } catch { /* no builds dir yet */ }

        ctx.params._existingProjects = projects;
        ctx.params._buildsDir = buildsDir;
        if (projects.length > 0) {
          console.log(`[CodeGen] Existing projects: ${projects.join(', ')}`);
        }
      },
    },
    {
      name: 'enrich',
      progressLabel: '› Planning the build…',
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
      progressLabel: '› Writing the code…',
      type: 'tool',
      tool: 'pi_build',
      resolveParams: (ctx) => {
        const enrichedPrompt = ctx.stageResults.enrich as string;
        console.log(`[CodeGen] Enriched prompt: ${enrichedPrompt.slice(0, 200)}...`);
        const lines = enrichedPrompt.split('\n');
        const firstLine = lines[0].trim();
        const spec = lines.slice(1).join('\n').trim();

        // Check for [MODIFY] prefix — re-run Pi in the existing project dir (it reads the files
        // already there). Passing projectDir puts pi_build in fix/modify mode.
        const modifyMatch = firstLine.match(/^\[MODIFY\]\s*(.+)/i);
        if (modifyMatch) {
          const existingSlug = modifyMatch[1].trim();
          const buildsDir = ctx.params._buildsDir as string;
          const projectDir = `${buildsDir}/${existingSlug}`;
          console.log(`[CodeGen] MODIFY existing project: ${existingSlug}`);
          return { prompt: spec || enrichedPrompt, projectDir };
        }

        console.log(`[CodeGen] New project: ${firstLine}`);
        return { prompt: spec || enrichedPrompt, projectName: firstLine };
      },
    },
    {
      name: 'verify',
      progressLabel: '› Running the tests…',
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
      progressLabel: '› Tests failed — fixing…',
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

        // Call pi_build on the existing project dir (Pi reads the files already there).
        const fixResult = await ctx.executor('pi_build', {
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
      name: 'commit',
      progressLabel: '› Committing…',
      type: 'code',
      when: (ctx) => !!ctx.params._projectDir && (ctx.params._pi as { git?: { commitLocal?: boolean } } | undefined)?.git?.commitLocal !== false,
      execute: async (ctx: PipelineContext) => {
        const projectDir = ctx.params._projectDir as string;
        const verify = ctx.params._verifyResult as { pass: boolean; skipped?: boolean } | undefined;
        const pi = ctx.params._pi as { git?: { commitLocal: boolean; pushRemote: boolean; visibility: 'private' | 'public' } } | undefined;
        const git = pi?.git ?? { commitLocal: true, pushRemote: false, visibility: 'private' as const };
        const slug = projectDir.split('/').pop() || 'build';
        const status = verify?.skipped ? 'no recognized tests' : verify?.pass ? 'tests passing' : 'WIP — tests failing';
        ctx.params._gitResult = await commitBuild(projectDir, slug, status, git);
        console.log(`[CodeGen] Git: ${(ctx.params._gitResult as { note: string }).note}`);
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
        const gitResult = ctx.params._gitResult as { committed: boolean; pushed: boolean; url?: string; note: string } | undefined;

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

        const gitStatus = gitResult
          ? `Git: ${gitResult.pushed ? `committed + pushed (${gitResult.url ?? 'GitHub'})` : gitResult.committed ? 'committed locally' : `not committed (${gitResult.note})`}`
          : 'Git: not attempted';

        return {
          system: 'You are summarizing the results of a code generation task. List the files created with a brief description of each. Include the test status and the git status. Be concise.',
          user: `The build tool returned:\n\n${buildResult}\n\n${testStatus}\n${gitStatus}\n\nSummarize what was built, the test results, and whether it was committed.`,
        };
      },
    },
  ],
};

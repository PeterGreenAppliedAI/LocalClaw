import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import type { LocalClawTool, ToolContext } from './types.js';
import type { PiConfigSchema } from '../config/schema.js';

type PiConfig = z.infer<typeof PiConfigSchema>;

/**
 * Pi (picoder) build tool — CODE-DRIVEN coding agent, replaces OpenCode.
 *
 * Inversion of control kept intact: the code_gen pipeline owns the workflow (enrich → build →
 * verify → fix → report); this tool is the bounded "make the files" slot. Unlike OpenCode there is
 * NO server, NO global session DB, and NO snapshot/move hack — Pi runs cwd-scoped to the project
 * directory, so files land where they belong and the agent can't write outside the build dir by
 * default (the package.json-overwrite class of bug is structurally prevented).
 *
 * Returns a string containing `Project directory: <dir>` and `session: <slug>` so the existing
 * code_gen pipeline's extractors keep working unchanged.
 */

// Resolve the Pi CLI (dist/cli.js) as a sibling of the package's main export. The package only
// exposes the ESM `import` condition (no `require`), so use the ESM resolver, not createRequire.
function piCliPath(): string {
  const mainUrl = import.meta.resolve('@earendil-works/pi-coding-agent'); // file://…/dist/index.js
  return join(dirname(fileURLToPath(mainUrl)), 'cli.js');
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || `build-${Date.now()}`;
}

const QUALITY_STANDARDS = [
  '',
  'QUALITY STANDARDS:',
  '- Create all project files in the current directory.',
  '- Tests MUST make real HTTP requests or function calls — no mocked assertions against hardcoded values.',
  '- Tests should start the server/app, make actual requests, and validate responses.',
  '- Include error case tests (invalid input, missing fields, not found).',
  '- Code should have proper error handling, not just the happy path.',
  '- Include a dependency file (package.json, requirements.txt, go.mod) with correct dependencies.',
].join('\n');

function runPi(cliPath: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // stdin MUST be ignored (/dev/null). Pi's print mode reads stdin to merge piped input, so an
    // open inherited stdin pipe makes it block forever waiting for EOF that never comes. 'ignore'
    // gives it immediate EOF. (This is why an interactive-shell run worked but a spawned one hung.)
    const child = spawn('node', [cliPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const CAP = 8 * 1024 * 1024;
    child.stdout.on('data', d => { if (stdout.length < CAP) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < CAP) stderr += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on('error', err => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: stderr + String(err) }); });
  });
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'node_modules' || f === '__pycache__' || f === '.venv') continue;
      const full = join(dir, f);
      const rel = prefix ? `${prefix}/${f}` : f;
      if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
      else out.push(rel);
    }
  } catch { /* best-effort */ }
  return out;
}

export function createPiBuildTool(config: PiConfig): LocalClawTool {
  return {
    name: 'pi_build',
    description: `Build code with the Pi coding agent. Pi reads, writes, and edits files in an isolated project directory to implement the requested feature or project.
WHEN TO USE: User asks to build, scaffold, implement, or write code for a project or feature.
Returns the project directory and a list of files created.`,
    parameterDescription: 'prompt (required): what to build. projectName (optional): name for a new project. projectDir + sessionId (optional): an existing project to modify/fix.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of what to build, or fix instructions for an existing project' },
        projectName: { type: 'string', description: 'Name for a new project (slugified into the build dir)' },
        projectDir: { type: 'string', description: 'Existing project directory (for fix/modify)' },
        sessionId: { type: 'string', description: 'Reuse marker for an existing project (for fix/modify)' },
        model: { type: 'string', description: 'Pi model id (provider/id), default from config' },
      },
      required: ['prompt'],
    },
    category: 'code',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const prompt = (params.prompt as string)?.trim();
      if (!prompt) return 'Error: prompt is required';

      const model = (params.model as string) || config.model;
      const workspace = ctx.workspacePath ?? 'data/workspaces/main';
      const buildsDir = join(workspace, 'builds');
      const existingProjectDir = params.projectDir as string | undefined;

      // New build vs fix/modify. For fix, reuse the given dir (Pi reads existing files there);
      // for new, derive the dir from projectName and append quality standards.
      let projectDir: string;
      let slug: string;
      let fullPrompt: string;
      const isFix = !!existingProjectDir;

      if (isFix) {
        projectDir = existingProjectDir!;
        slug = projectDir.split('/').pop() || 'project';
        fullPrompt = prompt;
      } else {
        slug = slugify((params.projectName as string) || '');
        projectDir = join(buildsDir, slug);
        mkdirSync(projectDir, { recursive: true });
        fullPrompt = prompt + '\n' + QUALITY_STANDARDS;
      }

      const cliPath = piCliPath();
      // -p print mode, -a trust this run (non-interactive), tools allowlisted, cwd = projectDir so
      // every write is scoped to the build dir. --no-context-files is important: Pi otherwise walks
      // UP from the build dir and loads AGENTS.md/CLAUDE.md — which would pull LocalClaw's OWN
      // CLAUDE.md (the build dir lives inside this repo) into every unrelated build. The pipeline's
      // enriched spec + quality standards are the single source of build instructions.
      const args = [
        '-p',
        '--no-context-files',
        '--model', model,
        '--api-key', config.apiKey,
        '--tools', config.tools.join(','),
        '-a',
        fullPrompt,
      ];

      console.log(`[Pi] ${isFix ? 'Fixing' : 'Building'} "${slug}" with ${model} (cwd-scoped)...`);
      const result = await runPi(cliPath, args, projectDir, config.timeout);

      if (result.code !== 0 && !readdirSync(projectDir).some(f => !f.startsWith('.'))) {
        // Non-zero exit AND nothing written — a real failure, surface it.
        return `Pi build failed (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 500)}\nProject directory: ${projectDir}\nsession: ${slug}`;
      }

      const files = listFiles(projectDir);
      const parts = [`Pi build complete (session: ${slug}, project: ${slug})`, '', `Files created (${files.length}):`];
      let totalChars = 0;
      for (const f of files.slice(0, 10)) {
        if (f.endsWith('.lock') || f.endsWith('.log')) { parts.push(`  ${f} (skipped — generated)`); continue; }
        try {
          const content = readFileSync(join(projectDir, f), 'utf-8');
          const preview = content.length > 600 ? content.slice(0, 600) + '\n...(truncated)' : content;
          totalChars += preview.length;
          if (totalChars > 6000) parts.push(`  ${f} (${content.length} bytes — omitted for space)`);
          else parts.push(`\n--- ${f} ---\n${preview}`);
        } catch { parts.push(`  ${f} (could not read)`); }
      }
      parts.push('', `Project directory: ${projectDir}`);
      return parts.join('\n');
    },
  };
}

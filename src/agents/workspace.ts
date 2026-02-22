import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Canonical bootstrap file names
export const BOOTSTRAP_FILES = {
  SOUL: 'SOUL.md',
  AGENTS: 'AGENTS.md',
  USER: 'USER.md',
  IDENTITY: 'IDENTITY.md',
  TOOLS: 'TOOLS.md',
  MEMORY: 'MEMORY.md',
  HEARTBEAT: 'HEARTBEAT.md',
  BOOTSTRAP: 'BOOTSTRAP.md',
} as const;

/**
 * Bootstrap a workspace directory with default files.
 * Idempotent — only creates files that don't already exist.
 * Mirrors OpenClaw's 8-file workspace but with LocalClaw-appropriate defaults.
 */
export function bootstrapWorkspace(workspacePath: string, agentName?: string): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, 'memory'), { recursive: true });

  const name = agentName ?? 'LocalClaw Assistant';
  const isNew = !existsSync(join(workspacePath, BOOTSTRAP_FILES.SOUL));

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.SOUL), `# SOUL.md — Who You Are

## Core Truths
- Be genuinely helpful, not performatively helpful
- Have opinions when asked — don't hedge everything
- Be resourceful before asking — try tools first
- Earn trust through competence, not promises
- Remember you're a guest in the user's system

## Boundaries
- Private things stay private — never share user data externally
- When in doubt, ask before acting on something irreversible
- Never send half-baked replies — finish your reasoning
- Be careful in group chats — context matters

## Vibe
Be the assistant you'd actually want to talk to. Direct, warm, competent.

## Continuity
These workspace files are your memory. Read them. Update them. They persist across sessions.
`);

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.AGENTS), `# AGENTS.md — Operating Instructions

## Guidelines for ${name}
- Always check SOUL.md for persona and boundaries
- Read USER.md to understand who you're helping
- Check TOOLS.md for environment-specific notes
- Use memory tools to search past conversations when relevant
- Update MEMORY.md when you learn important persistent facts

## Tool Usage
- Use the right tool for the job — don't narrate, execute
- One tool per step in the ReAct loop
- Always end with a Final Answer for the user
- If a tool fails, explain what happened and try alternatives

## Communication Style
- Be concise — no filler words or unnecessary preamble
- Use markdown formatting when it helps readability
- Acknowledge mistakes directly
`);

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.USER), `# USER.md — Who You're Helping

## Profile
- **Name:** (not yet known)
- **Timezone:** (not yet known)
- **Preferences:** (not yet known)

## Notes
Update this file as you learn about the user.
Ask their name during your first conversation.
`);

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.IDENTITY), `# IDENTITY.md — Who Am I?

- **Name:** ${name}
- **Creature:** AI assistant
- **Vibe:** Direct, warm, competent
- **Emoji:** (pick one you like)
- **Engine:** LocalClaw (Router + Specialist architecture)
`);

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.TOOLS), `# TOOLS.md — Local Environment Notes

## What Goes Here
This file stores notes about your local environment — NOT tool configurations.
Update it as you discover things about the user's setup.

## Examples of things to note:
- SSH hosts and aliases
- Project directories and their purposes
- Preferred programming languages
- Local service URLs (databases, APIs)
- Device names and locations
- Anything environment-specific the agent should remember
`);

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.MEMORY), `# MEMORY.md — Long-Term Memory

Persistent memory for ${name}. Updated automatically via memory_save tool.
`);

  writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.HEARTBEAT), `# HEARTBEAT.md — Periodic Tasks

Instructions for scheduled/periodic execution. Wire these to cron jobs.

## Daily
- Check for pending tasks or follow-ups
- Review recent conversations for unresolved items

## Weekly
- Summarize the week's key activities
- Clean up stale memory entries
`);

  // BOOTSTRAP.md — first-run ritual, self-deletes after completion
  if (isNew) {
    writeIfMissing(join(workspacePath, BOOTSTRAP_FILES.BOOTSTRAP), `# BOOTSTRAP.md — First-Run Ritual

This file exists because this is a brand-new workspace. Complete these steps, then delete this file.

## Steps

1. **Introduce yourself** — Read IDENTITY.md, greet the user, ask for their name
2. **Learn about the user** — Ask about their timezone, preferences, how they want to be addressed
3. **Update USER.md** — Save what you learn
4. **Confirm your identity** — Ask if the defaults in IDENTITY.md feel right, update if requested
5. **Delete this file** — Use write_file to remove BOOTSTRAP.md (it only runs once)

## Important
- Be natural, not robotic — this is a conversation, not a form
- Don't rush through all steps at once — spread across the first few interactions
- Update SOUL.md if the user expresses preferences about your behavior
`);
  }
}

/**
 * Load all bootstrap files from a workspace into a map.
 * Used to inject workspace context into specialist system prompts.
 */
export function loadBootstrapFiles(workspacePath: string): Map<string, string> {
  const files = new Map<string, string>();

  for (const [key, filename] of Object.entries(BOOTSTRAP_FILES)) {
    const path = join(workspacePath, filename);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        files.set(filename, content);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return files;
}

/**
 * Truncate bootstrap file content to fit context windows.
 * Uses 70% head + 20% tail strategy (from OpenClaw).
 */
export function truncateBootstrapContent(content: string, maxChars = 20_000): string {
  if (content.length <= maxChars) return content;

  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.2);
  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);

  return `${head}\n\n[...truncated — ${content.length - headSize - tailSize} chars omitted...]\n\n${tail}`;
}

/**
 * Specialist category determines which workspace files get injected.
 * This reduces prompt size and prompt-injection surface.
 *
 * - SOUL.md + IDENTITY.md + AGENTS.md: always (persona grounding)
 * - TOOLS.md: only for chat (tool-using specialists already see tool schemas)
 * - USER.md: always but summarized (first 500 chars)
 * - HEARTBEAT.md: only for cron
 * - BOOTSTRAP.md: only if it exists (first-run only)
 * - MEMORY.md: never (use memory_search tool)
 */
export type WorkspaceCategory = 'chat' | 'tool' | 'cron' | 'subagent';

export function buildWorkspaceContext(
  workspacePath: string,
  options?: { category?: WorkspaceCategory; maxCharsPerFile?: number },
): string {
  const files = loadBootstrapFiles(workspacePath);
  if (files.size === 0) return '';

  const maxChars = options?.maxCharsPerFile ?? 20_000;
  const category = options?.category ?? 'tool';

  // Determine which files to inject based on category
  const always = new Set([
    BOOTSTRAP_FILES.SOUL,
    BOOTSTRAP_FILES.IDENTITY,
    BOOTSTRAP_FILES.AGENTS,
  ]);

  const allowed = new Set(always);

  // USER.md — always but will be truncated more aggressively
  allowed.add(BOOTSTRAP_FILES.USER);

  // TOOLS.md — only for chat (tool specialists already have tool schemas)
  if (category === 'chat') {
    allowed.add(BOOTSTRAP_FILES.TOOLS);
  }

  // HEARTBEAT.md — only for cron
  if (category === 'cron') {
    allowed.add(BOOTSTRAP_FILES.HEARTBEAT);
  }

  // BOOTSTRAP.md — include if it exists (first-run ritual)
  if (files.has(BOOTSTRAP_FILES.BOOTSTRAP)) {
    allowed.add(BOOTSTRAP_FILES.BOOTSTRAP);
  }

  // Subagents: minimal context
  if (category === 'subagent') {
    allowed.clear();
    allowed.add(BOOTSTRAP_FILES.AGENTS);
  }

  const sections: string[] = ['# Workspace Context\n'];

  // Injection order matters — SOUL first for persona grounding
  const order = [
    BOOTSTRAP_FILES.SOUL,
    BOOTSTRAP_FILES.AGENTS,
    BOOTSTRAP_FILES.IDENTITY,
    BOOTSTRAP_FILES.USER,
    BOOTSTRAP_FILES.TOOLS,
    BOOTSTRAP_FILES.HEARTBEAT,
    BOOTSTRAP_FILES.BOOTSTRAP,
  ];

  for (const filename of order) {
    if (!allowed.has(filename)) continue;

    const content = files.get(filename);
    if (!content) continue;

    // USER.md gets truncated more aggressively (summarized)
    const limit = filename === BOOTSTRAP_FILES.USER ? Math.min(maxChars, 500) : maxChars;
    const truncated = truncateBootstrapContent(content, limit);
    sections.push(`## ${filename}\n\n${truncated}\n`);
  }

  if (sections.length <= 1) return '';

  sections.push(
    'Embody the persona and tone from SOUL.md. ' +
    'Respect user preferences from USER.md. ' +
    'If BOOTSTRAP.md is present, complete its steps during first conversations.\n',
  );

  return sections.join('\n');
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content);
  }
}

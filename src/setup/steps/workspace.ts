import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { askText, askYesNo, printStep, printSuccess, printWarning, printInfo } from '../prompts.js';

export interface WorkspaceStepResult {
  ownerName: string;
  botName: string;
  timezone: string;
  created: boolean;
}

const WORKSPACE_DIR = 'data/workspaces/main';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function buildSoul(ownerName: string): string {
  return `# SOUL.md — Who You Are

## Core Truths
- You are ${ownerName}'s personal AI assistant running on local infrastructure
- Be genuinely helpful, not performatively helpful
- Have opinions when asked — don't hedge everything
- Be resourceful before asking — try tools first

## Boundaries
- Private things stay private — never share user data externally
- When in doubt, ask before acting on something irreversible
- Never send half-baked replies — finish your reasoning

## Continuity
These workspace files are your memory. Read them. Update them. They persist across sessions.
`;
}

function buildUser(ownerName: string, tz: string): string {
  return `# USER.md — Who You're Helping

## Owner Profile
- **Name:** ${ownerName}
- **Timezone:** ${tz}

## Notes
- ${ownerName} is the owner. Everything you do is on their behalf.
`;
}

function buildIdentity(ownerName: string, botName: string): string {
  return `# IDENTITY.md — Who Am I?

- **Name:** ${botName}
- **Owner:** ${ownerName}
- **Engine:** LocalClaw (Router + Specialist architecture)
- **Infrastructure:** Runs on local hardware via Ollama
`;
}

function buildHeartbeat(): string {
  return `# HEARTBEAT.md — Autonomous Periodic Tasks

You are running as an autonomous heartbeat. Execute each applicable task below using your tools. Report findings concisely.

## Every Run
- Check the task board (task_list) — report overdue or high-priority items
`;
}

function buildTools(): string {
  return `# TOOLS.md — What You Can Do

## Your Capabilities
You are a local AI assistant running on the user's own hardware via Ollama. You have real tools — not just chat.

### Web Search & Browsing
- **Search the web** for current information
- **Fetch web pages** — read and extract content from any URL
- **Browse websites** — open pages in a headless browser

### Memory
- **Save information** to persistent memory that survives across sessions
- **Search memories** using semantic similarity

### Execution
- **Run shell commands** (allowlisted for safety)
- **Read and write files** on the local system

### Scheduling
- **Create/list/remove cron jobs** — schedule recurring tasks
- **Heartbeat tasks** — autonomous periodic checks

### Messaging
- **Send messages** to other channels

## How It Works
When a user sends a message, a fast router model classifies what they need, then a specialist with the right tools handles it.
`;
}

function buildMemory(): string {
  return `# MEMORY.md
`;
}

function buildTasks(): string {
  return `# TASKS.md
`;
}

export async function runWorkspaceStep(): Promise<WorkspaceStepResult> {
  printStep(5, 7, 'Workspace Files');

  const dir = resolve(WORKSPACE_DIR);

  // Check if workspace already exists
  const soulExists = existsSync(resolve(dir, 'SOUL.md'));
  if (soulExists) {
    printInfo(`Workspace files already exist in ${WORKSPACE_DIR}/`);
    const overwrite = await askYesNo('Regenerate workspace files?', false);
    if (!overwrite) {
      printInfo('Keeping existing workspace files.');
      return { ownerName: '', botName: '', timezone: '', created: false };
    }
  }

  printInfo('These files define your bot\'s personality, identity, and memory.');
  console.log('');

  const ownerName = await askText('Your name (the bot owner)', 'User');
  const botName = await askText('Bot display name', 'LocalClaw Assistant');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  ensureDir(dir);
  ensureDir(resolve(dir, 'memory'));

  const files: [string, string][] = [
    ['SOUL.md', buildSoul(ownerName)],
    ['USER.md', buildUser(ownerName, tz)],
    ['IDENTITY.md', buildIdentity(ownerName, botName)],
    ['HEARTBEAT.md', buildHeartbeat()],
    ['TOOLS.md', buildTools()],
    ['MEMORY.md', buildMemory()],
    ['TASKS.md', buildTasks()],
  ];

  for (const [name, content] of files) {
    const path = resolve(dir, name);
    writeFileSync(path, content, 'utf-8');
    printSuccess(name);
  }

  printInfo(`\nWorkspace created in ${WORKSPACE_DIR}/`);
  printInfo('Edit these files to customize your bot\'s personality and behavior.');

  return { ownerName, botName, timezone: tz, created: true };
}

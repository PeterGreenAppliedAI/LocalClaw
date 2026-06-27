import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { OllamaClient } from '../ollama/client.js';
import type { OllamaModel } from '../ollama/types.js';
import { DockerBackend } from '../exec/docker-backend.js';

/** Detect OS for install commands. */
export function detectPlatform(): 'mac' | 'linux' | 'windows' {
  const p = platform();
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  return 'linux';
}

/** Check if a command exists on PATH. */
export function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run a shell command with visible output. Returns true on success. */
export function runInstall(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

/** Check if a Docker container is running by name. */
export function isContainerRunning(name: string): boolean {
  try {
    const out = execSync(`docker ps --filter name=${name} --format "{{.Names}}"`, { encoding: 'utf-8' });
    return out.trim().includes(name);
  } catch {
    return false;
  }
}

/** Start FalkorDB via Docker. */
export function installFalkorDB(): boolean {
  return runInstall('docker run -d --name falkordb -p 6379:6379 -v falkordb_data:/var/lib/falkordb/data falkordb/falkordb:latest');
}


export interface OllamaTestResult {
  available: boolean;
  models: OllamaModel[];
}

export async function testOllama(url: string): Promise<OllamaTestResult> {
  const client = new OllamaClient(url);
  const available = await client.isAvailable();
  if (!available) return { available: false, models: [] };
  try {
    const models = await client.listModels();
    return { available: true, models };
  } catch {
    return { available: true, models: [] };
  }
}

export async function testHttpEndpoint(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function testDocker(): Promise<boolean> {
  return DockerBackend.isAvailable();
}

export async function testDiscordToken(token: string): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { username?: string };
    return { ok: true, username: data.username };
  } catch {
    return { ok: false };
  }
}

export async function testTelegramToken(token: string): Promise<{ ok: boolean; username?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (!data.ok) return { ok: false };
    return { ok: true, username: data.result?.username };
  } catch {
    return { ok: false };
  }
}

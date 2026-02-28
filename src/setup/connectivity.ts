import { OllamaClient } from '../ollama/client.js';
import type { OllamaModel } from '../ollama/types.js';
import { DockerBackend } from '../exec/docker-backend.js';

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

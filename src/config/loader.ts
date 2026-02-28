import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import JSON5 from 'json5';
import { LocalClawConfigSchema } from './schema.js';
import { configInvalid } from '../errors.js';
import type { LocalClawConfig } from './types.js';

/**
 * Load .env file into process.env (simple key=value parser, no dependency needed).
 */
function loadDotEnv(dir?: string): void {
  const envPath = resolve(dir ?? '.', '.env');
  if (!existsSync(envPath)) return;

  try {
    const text = readFileSync(envPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Expand ${ENV_VAR} placeholders in string values.
 */
function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)}/g, (_, key: string) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = expandEnvVars(v);
    }
    return result;
  }
  return obj;
}

/**
 * Remove empty-string values so Zod defaults kick in.
 * e.g. if OLLAMA_URL is not set, url becomes "" — we want the default instead.
 */
function removeEmptyStrings(obj: unknown): unknown {
  if (typeof obj === 'string') return obj === '' ? undefined : obj;
  if (Array.isArray(obj)) return obj.map(removeEmptyStrings);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleaned = removeEmptyStrings(v);
      if (cleaned !== undefined) {
        result[k] = cleaned;
      }
    }
    return result;
  }
  return obj;
}

export function loadConfig(filePath?: string): LocalClawConfig {
  // Load .env before anything else
  loadDotEnv();

  const path = filePath ?? 'localclaw.config.json5';

  let raw: unknown;
  try {
    const text = readFileSync(path, 'utf-8');
    raw = JSON5.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[config] ${path} not found — run "npm run setup" to generate it`);
      return LocalClawConfigSchema.parse({});
    }
    throw configInvalid(`Failed to read ${path}: ${err instanceof Error ? err.message : err}`);
  }

  const expanded = expandEnvVars(raw);
  const cleaned = removeEmptyStrings(expanded);
  const result = LocalClawConfigSchema.safeParse(cleaned);

  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw configInvalid(issues);
  }

  return result.data;
}

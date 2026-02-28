import { printStep, printPass, printWarning, printError, printInfo } from '../prompts.js';
import { testOllama, testHttpEndpoint, testDocker, testDiscordToken, testTelegramToken } from '../connectivity.js';
import type { OllamaStepResult } from './ollama.js';
import type { ModelsStepResult } from './models.js';
import type { ChannelsStepResult } from './channels.js';
import type { ServicesStepResult } from './services.js';
import type { GenerateStepResult } from './generate.js';

interface WizardState {
  ollama: OllamaStepResult;
  models: ModelsStepResult;
  channels: ChannelsStepResult;
  services: ServicesStepResult;
  generated: GenerateStepResult;
}

type Status = 'PASS' | 'WARN' | 'FAIL';

interface CheckResult {
  name: string;
  status: Status;
  detail?: string;
}

export async function runPreflightStep(state: WizardState): Promise<void> {
  printStep(7, 7, 'Preflight Check');

  const checks: CheckResult[] = [];

  // 1. Ollama reachable
  const ollamaResult = await testOllama(state.ollama.url);
  if (ollamaResult.available) {
    checks.push({ name: 'Ollama reachable', status: 'PASS' });
  } else {
    checks.push({ name: 'Ollama reachable', status: 'FAIL', detail: `Cannot reach ${state.ollama.url}` });
  }

  // 2. Router model available
  if (ollamaResult.available) {
    const hasRouter = ollamaResult.models.some(m => m.name === state.models.routerModel);
    if (hasRouter) {
      checks.push({ name: 'Router model available', status: 'PASS', detail: state.models.routerModel });
    } else {
      checks.push({ name: 'Router model available', status: 'WARN', detail: `${state.models.routerModel} not found — run: ollama pull ${state.models.routerModel}` });
    }
  } else {
    checks.push({ name: 'Router model available', status: 'WARN', detail: 'Cannot check — Ollama unreachable' });
  }

  // 3. Specialist models available
  const allSpecialistModels = new Set([
    state.models.specialistModel,
    ...Object.values(state.models.categoryModels),
  ]);
  if (ollamaResult.available) {
    for (const model of allSpecialistModels) {
      const found = ollamaResult.models.some(m => m.name === model);
      if (found) {
        checks.push({ name: `Specialist model: ${model}`, status: 'PASS' });
      } else {
        checks.push({ name: `Specialist model: ${model}`, status: 'WARN', detail: `not found — run: ollama pull ${model}` });
      }
    }
  } else {
    checks.push({ name: 'Specialist models', status: 'WARN', detail: 'Cannot check — Ollama unreachable' });
  }

  // 4. Channel tokens
  if (state.channels.discord.enabled && state.channels.discord.token) {
    const discord = await testDiscordToken(state.channels.discord.token);
    if (discord.ok) {
      checks.push({ name: 'Discord token', status: 'PASS', detail: discord.username });
    } else {
      checks.push({ name: 'Discord token', status: 'FAIL', detail: 'Token validation failed' });
    }
  }

  if (state.channels.telegram.enabled && state.channels.telegram.token) {
    const telegram = await testTelegramToken(state.channels.telegram.token);
    if (telegram.ok) {
      checks.push({ name: 'Telegram token', status: 'PASS', detail: `@${telegram.username}` });
    } else {
      checks.push({ name: 'Telegram token', status: 'FAIL', detail: 'Token validation failed' });
    }
  }

  if (state.channels.slack.enabled) {
    checks.push({ name: 'Slack tokens', status: 'WARN', detail: 'Cannot validate without connecting — will be tested on first run' });
  }

  // 5. TTS/STT endpoints
  if (state.services.tts.enabled && state.services.tts.url) {
    const ok = await testHttpEndpoint(state.services.tts.url);
    checks.push({
      name: 'TTS endpoint',
      status: ok ? 'PASS' : 'WARN',
      detail: ok ? state.services.tts.url : `${state.services.tts.url} not reachable`,
    });
  }

  if (state.services.stt.enabled && state.services.stt.url) {
    const ok = await testHttpEndpoint(state.services.stt.url);
    checks.push({
      name: 'STT endpoint',
      status: ok ? 'PASS' : 'WARN',
      detail: ok ? state.services.stt.url : `${state.services.stt.url} not reachable`,
    });
  }

  // 6. Vision model
  if (state.services.vision.enabled && state.services.vision.model && ollamaResult.available) {
    const hasVision = ollamaResult.models.some(m => m.name === state.services.vision.model);
    if (hasVision) {
      checks.push({ name: 'Vision model', status: 'PASS', detail: state.services.vision.model });
    } else {
      checks.push({ name: 'Vision model', status: 'WARN', detail: `${state.services.vision.model} not found — run: ollama pull ${state.services.vision.model}` });
    }
  }

  // 7. Docker
  if (state.services.exec.security === 'docker') {
    const ok = await testDocker();
    checks.push({
      name: 'Docker available',
      status: ok ? 'PASS' : 'FAIL',
      detail: ok ? undefined : 'docker info failed',
    });
  }

  // 8. Config validation
  try {
    // Load the generated config to validate it
    const { loadConfig } = await import('../../config/loader.js');
    loadConfig(state.generated.configPath);
    checks.push({ name: 'Config validation', status: 'PASS' });
  } catch (err) {
    checks.push({
      name: 'Config validation',
      status: 'FAIL',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Print results
  console.log('');
  let passes = 0;
  let warns = 0;
  let fails = 0;

  for (const check of checks) {
    const detail = check.detail ? ` — ${check.detail}` : '';
    switch (check.status) {
      case 'PASS':
        printPass(`${check.name}${detail}`);
        passes++;
        break;
      case 'WARN':
        printWarning(`${check.name}${detail}`);
        warns++;
        break;
      case 'FAIL':
        printError(`${check.name}${detail}`);
        fails++;
        break;
    }
  }

  // Summary
  console.log(`\n  Summary: ${passes} passed, ${warns} warnings, ${fails} failed`);

  if (fails === 0 && warns === 0) {
    printInfo('\nAll checks passed! Run `npm run dev` to start LocalClaw.');
  } else if (fails === 0) {
    printInfo('\nNo critical failures. Run `npm run dev` to start LocalClaw.');
    printInfo('Address warnings above for full functionality.');
  } else {
    printInfo('\nSome checks failed. Fix the issues above before running LocalClaw.');
  }
}

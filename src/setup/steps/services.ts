import { askText, askYesNo, askChoice, printStep, printSuccess, printWarning, printInfo } from '../prompts.js';
import { testHttpEndpoint, testDocker } from '../connectivity.js';
import { findVisionModels } from '../defaults.js';
import type { OllamaModel } from '../../ollama/types.js';

export interface WebSearchResult {
  enabled: boolean;
  provider?: 'brave' | 'perplexity' | 'grok' | 'tavily';
  apiKey?: string;
}

export interface TTSResult {
  enabled: boolean;
  url?: string;
}

export interface STTResult {
  enabled: boolean;
  url?: string;
}

export interface VisionResult {
  enabled: boolean;
  model?: string;
}

export interface BrowserResult {
  enabled: boolean;
  headless: boolean;
}

export interface ExecResult {
  security: 'allowlist' | 'docker';
}

export interface ServicesStepResult {
  webSearch: WebSearchResult;
  tts: TTSResult;
  stt: STTResult;
  vision: VisionResult;
  browser: BrowserResult;
  exec: ExecResult;
}

export async function runServicesStep(models: OllamaModel[]): Promise<ServicesStepResult> {
  printStep(4, 7, 'Optional Services');

  const result: ServicesStepResult = {
    webSearch: { enabled: false },
    tts: { enabled: false },
    stt: { enabled: false },
    vision: { enabled: false },
    browser: { enabled: false, headless: true },
    exec: { security: 'allowlist' },
  };

  // Web Search
  if (await askYesNo('Enable Web Search?', false)) {
    result.webSearch.enabled = true;
    const provider = await askChoice('Search provider:', ['brave', 'perplexity', 'grok', 'tavily']);
    result.webSearch.provider = provider as WebSearchResult['provider'];
    result.webSearch.apiKey = await askText(`${provider} API key`);
    printSuccess(`Web search: ${provider}`);
  }

  // TTS
  if (await askYesNo('Enable Text-to-Speech (TTS)?', false)) {
    result.tts.enabled = true;
    result.tts.url = await askText('TTS server URL', 'http://127.0.0.1:5005');
    printInfo(`Testing TTS at ${result.tts.url}...`);
    const ok = await testHttpEndpoint(result.tts.url);
    if (ok) {
      printSuccess('TTS server is reachable');
    } else {
      printWarning('TTS server not reachable — make sure it is running before starting LocalClaw');
    }
  }

  // STT
  if (await askYesNo('Enable Speech-to-Text (STT)?', false)) {
    result.stt.enabled = true;
    result.stt.url = await askText('STT server URL', 'http://127.0.0.1:8000');
    printInfo(`Testing STT at ${result.stt.url}...`);
    const ok = await testHttpEndpoint(result.stt.url);
    if (ok) {
      printSuccess('STT server is reachable');
    } else {
      printWarning('STT server not reachable — make sure it is running before starting LocalClaw');
    }
  }

  // Vision
  if (await askYesNo('Enable Vision?', false)) {
    result.vision.enabled = true;
    const visionModels = findVisionModels(models);
    if (visionModels.length > 0) {
      printInfo('Vision-capable models found:');
      for (const m of visionModels) {
        printInfo(`  - ${m.name}`);
      }
      result.vision.model = await askText('Vision model', visionModels[0].name);
    } else {
      printInfo('No vision models found in Ollama. You can pull one: ollama pull qwen3-vl:8b');
      result.vision.model = await askText('Vision model', 'qwen3-vl:8b');
    }
    printSuccess(`Vision model: ${result.vision.model}`);
  }

  // Browser
  if (await askYesNo('Enable Browser tool?', false)) {
    result.browser.enabled = true;
    result.browser.headless = await askYesNo('Run browser headless?', true);
    printSuccess(`Browser: enabled (headless: ${result.browser.headless})`);
  }

  // Exec security
  const execChoice = await askChoice('Code execution security:', ['allowlist (default)', 'docker']);
  if (execChoice.startsWith('docker')) {
    result.exec.security = 'docker';
    printInfo('Testing Docker availability...');
    const dockerOk = await testDocker();
    if (dockerOk) {
      printSuccess('Docker is available');
    } else {
      printWarning('Docker not available — falling back to allowlist');
      result.exec.security = 'allowlist';
    }
  } else {
    result.exec.security = 'allowlist';
  }
  printSuccess(`Exec security: ${result.exec.security}`);

  return result;
}

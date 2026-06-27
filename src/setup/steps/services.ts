import { askText, askYesNo, askChoice, printStep, printSuccess, printWarning, printInfo, printError } from '../prompts.js';
import { testHttpEndpoint, testDocker, isContainerRunning, installFalkorDB, commandExists } from '../connectivity.js';
import { findVisionModels, findReasoningModels } from '../defaults.js';
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

export interface GraphMemoryResult {
  enabled: boolean;
}

export interface HeartbeatResult {
  enabled: boolean;
  channel?: string;
  target?: string;
}

export interface ReasoningResult {
  enabled: boolean;
  model?: string;
}

export interface ImageGenResult {
  enabled: boolean;
  url?: string;
  model?: string;
}

export interface PiResult {
  enabled: boolean;
  model?: string;
}

export interface ServicesStepResult {
  webSearch: WebSearchResult;
  tts: TTSResult;
  stt: STTResult;
  vision: VisionResult;
  browser: BrowserResult;
  exec: ExecResult;
  graphMemory: GraphMemoryResult;
  heartbeat: HeartbeatResult;
  reasoning: ReasoningResult;
  imageGen: ImageGenResult;
  pi: PiResult;
}

export async function runServicesStep(models: OllamaModel[], enabledChannels: string[]): Promise<ServicesStepResult> {
  printStep(4, 7, 'Services & Features');

  const result: ServicesStepResult = {
    webSearch: { enabled: false },
    tts: { enabled: false },
    stt: { enabled: false },
    vision: { enabled: false },
    browser: { enabled: false, headless: true },
    exec: { security: 'allowlist' },
    graphMemory: { enabled: false },
    heartbeat: { enabled: false },
    reasoning: { enabled: false },
    imageGen: { enabled: false },
    pi: { enabled: false },
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

  // Graph Memory (FalkorDB)
  if (await askYesNo('Enable Graph Memory (FalkorDB)? Requires Docker.', false)) {
    const dockerOk = await testDocker();
    if (!dockerOk) {
      printError('Docker is required for FalkorDB but not available.');
      printInfo('Install Docker: https://docs.docker.com/get-docker/');
      printWarning('Graph memory disabled — using flat file store');
    } else if (isContainerRunning('falkordb')) {
      result.graphMemory.enabled = true;
      printSuccess('FalkorDB is already running');
    } else {
      printInfo('FalkorDB is not running.');
      if (await askYesNo('Install and start FalkorDB now?', true)) {
        printInfo('Pulling and starting FalkorDB...');
        if (installFalkorDB()) {
          result.graphMemory.enabled = true;
          printSuccess('FalkorDB installed and running on port 6379');
        } else {
          printError('FalkorDB install failed. You can start it manually:');
          printInfo('  docker run -d --name falkordb -p 6379:6379 -v falkordb_data:/var/lib/falkordb/data falkordb/falkordb:latest');
        }
      } else {
        printInfo('Start FalkorDB manually when ready:');
        printInfo('  docker run -d --name falkordb -p 6379:6379 -v falkordb_data:/var/lib/falkordb/data falkordb/falkordb:latest');
        result.graphMemory.enabled = true; // config enables it, they just need to start the container
      }
    }
  }

  // Heartbeat
  if (await askYesNo('Enable autonomous heartbeat? (memory review, task management every 2 hours)', true)) {
    result.heartbeat.enabled = true;
    if (enabledChannels.length > 0) {
      if (enabledChannels.length === 1) {
        result.heartbeat.channel = enabledChannels[0];
      } else {
        result.heartbeat.channel = await askChoice('Deliver heartbeat reports to:', enabledChannels);
      }
      result.heartbeat.target = await askText('Channel/user ID for heartbeat delivery');
      printSuccess(`Heartbeat → ${result.heartbeat.channel} (${result.heartbeat.target})`);
    } else {
      printWarning('No channels enabled — heartbeat will run but cannot deliver reports');
    }
  }

  // Reasoning model
  const reasoningModels = findReasoningModels(models);
  if (reasoningModels.length > 0) {
    printInfo('Reasoning-capable models found:');
    for (const m of reasoningModels) {
      printInfo(`  - ${m.name}`);
    }
    if (await askYesNo('Enable reasoning model for deep analysis?', true)) {
      result.reasoning.enabled = true;
      result.reasoning.model = await askText('Reasoning model', reasoningModels[0].name);
      printSuccess(`Reasoning model: ${result.reasoning.model}`);
    }
  } else if (await askYesNo('Enable reasoning model? (none auto-detected)', false)) {
    result.reasoning.enabled = true;
    result.reasoning.model = await askText('Reasoning model name');
    printSuccess(`Reasoning model: ${result.reasoning.model}`);
  }

  // Image generation
  if (await askYesNo('Enable image generation?', false)) {
    result.imageGen.enabled = true;
    result.imageGen.url = await askText('Image generation server URL');
    result.imageGen.model = await askText('Image generation model', 'flux2-klein:4b-fp8');
    printSuccess(`Image gen: ${result.imageGen.model} at ${result.imageGen.url}`);
  }

  // Pi coding agent (picoder) — headless, bundled as an npm dependency (no separate install).
  if (await askYesNo('Enable the Pi coding agent (code generation)?', false)) {
    result.pi.enabled = true;
    result.pi.model = await askText('Pi model (provider/id from ~/.pi/agent/models.json)', 'vllm/deepseek-v4-flash');
    printSuccess(`Pi enabled: ${result.pi.model}`);
    printInfo('Configure the model provider in ~/.pi/agent/models.json (Ollama/vLLM OpenAI-compatible endpoint).');
  }

  return result;
}

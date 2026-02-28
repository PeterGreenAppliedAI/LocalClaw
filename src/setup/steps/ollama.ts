import { askText, printStep, printSuccess, printError, printWarning, printInfo } from '../prompts.js';
import { testOllama } from '../connectivity.js';
import type { OllamaModel } from '../../ollama/types.js';

export interface OllamaStepResult {
  url: string;
  models: OllamaModel[];
}

export async function runOllamaStep(): Promise<OllamaStepResult> {
  printStep(1, 7, 'Ollama Connection');

  const defaultUrl = 'http://127.0.0.1:11434';
  printInfo(`Testing Ollama at ${defaultUrl}...`);

  let url = defaultUrl;
  let result = await testOllama(defaultUrl);

  if (result.available) {
    printSuccess(`Ollama is reachable at ${defaultUrl}`);
  } else {
    printWarning(`Ollama not found at ${defaultUrl}`);
    const customUrl = await askText('Enter Ollama URL', defaultUrl);
    url = customUrl;
    if (customUrl !== defaultUrl) {
      printInfo(`Testing Ollama at ${customUrl}...`);
      result = await testOllama(customUrl);
      if (result.available) {
        printSuccess(`Ollama is reachable at ${customUrl}`);
      } else {
        printError(`Ollama not reachable at ${customUrl}`);
        printInfo('Continuing anyway — you can fix the URL in the config later.');
        return { url: customUrl, models: [] };
      }
    } else {
      printInfo('Continuing anyway — make sure Ollama is running before starting LocalClaw.');
      return { url: defaultUrl, models: [] };
    }
  }

  if (result.models.length > 0) {
    printInfo(`Found ${result.models.length} model(s):`);
    for (const m of result.models) {
      const sizeMB = Math.round(m.size / 1024 / 1024);
      printInfo(`  - ${m.name} (${sizeMB} MB)`);
    }
  } else {
    printWarning('No models found. Pull some models before running LocalClaw:');
    printInfo('  ollama pull phi4-mini');
    printInfo('  ollama pull qwen3-coder:30b');
  }

  return { url, models: result.models };
}

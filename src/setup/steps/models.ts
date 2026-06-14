import { askText, askYesNo, printStep, printSuccess, printInfo } from '../prompts.js';
import { pickRouterModel, pickSpecialistModel, SPECIALIST_TEMPLATES } from '../defaults.js';
import type { OllamaModel } from '../../ollama/types.js';

export interface ModelsStepResult {
  routerModel: string;
  specialistModel: string;
  /** Per-category model overrides. Categories not listed use specialistModel. */
  categoryModels: Record<string, string>;
  /** OpenAI-compatible backends (e.g. vLLM). Chat calls whose model matches route here. */
  inferenceBackends: Array<{ url: string; models: string[] }>;
  /** Model for background reasoning (briefing + heartbeat). Defaults to specialistModel. */
  backgroundModel: string;
}

export async function runModelsStep(models: OllamaModel[]): Promise<ModelsStepResult> {
  printStep(2, 7, 'Model Selection');

  const modelNames = models.map(m => m.name);

  // Router model
  const suggestedRouter = pickRouterModel(models) ?? 'phi4-mini';
  printInfo(`Suggested router model: ${suggestedRouter}`);
  const routerModel = await askText('Router model', suggestedRouter);
  printSuccess(`Router model: ${routerModel}`);

  // Specialist model (global default)
  const suggestedSpecialist = pickSpecialistModel(models) ?? 'qwen3-coder:30b';
  printInfo(`Suggested specialist model: ${suggestedSpecialist}`);
  const specialistModel = await askText('Default specialist model', suggestedSpecialist);
  printSuccess(`Default specialist model: ${specialistModel}`);

  // OpenAI-compatible backends (vLLM) — for large models like MiniMax served outside Ollama.
  // The specialist model can point at a backend model id; calls matching it route there.
  const inferenceBackends: Array<{ url: string; models: string[] }> = [];
  const addBackend = await askYesNo('Add an OpenAI-compatible backend (e.g. vLLM for a large model)?', false);
  if (addBackend) {
    let more = true;
    while (more) {
      const url = await askText('  Backend URL (OpenAI-compatible, e.g. http://10.0.0.15:8000)', 'http://localhost:8000');
      const modelsCsv = await askText('  Model id(s) served here (comma-separated, e.g. cyankiwi/MiniMax-M2.7-AWQ-4bit)', specialistModel);
      const backendModels = modelsCsv.split(',').map(m => m.trim()).filter(Boolean);
      inferenceBackends.push({ url, models: backendModels });
      printSuccess(`  Backend ${url} → ${backendModels.join(', ')}`);
      more = await askYesNo('  Add another backend?', false);
    }
  }

  // Per-category overrides
  const categoryModels: Record<string, string> = {};
  const sameModelForAll = await askYesNo('Use same specialist model for all categories?', true);

  if (sameModelForAll) {
    printInfo(`All specialist categories will use: ${specialistModel}`);
  } else {
    printInfo('Configure model per category (Enter to keep default):');
    if (modelNames.length) {
      printInfo(`Available: ${modelNames.join(', ')}`);
    }
    for (const category of Object.keys(SPECIALIST_TEMPLATES)) {
      const chosen = await askText(`  ${category}`, specialistModel);
      if (chosen !== specialistModel) {
        categoryModels[category] = chosen;
        printSuccess(`  ${category}: ${chosen}`);
      }
    }
    const overrideCount = Object.keys(categoryModels).length;
    if (overrideCount) {
      printInfo(`${overrideCount} category override(s) set, rest use: ${specialistModel}`);
    } else {
      printInfo(`No overrides — all categories use: ${specialistModel}`);
    }
  }

  // Background reasoning model (briefing + heartbeat) — defaults to the specialist model
  const backgroundModel = await askText('Model for background jobs (briefing + heartbeat)', specialistModel);
  printSuccess(`Background jobs model: ${backgroundModel}`);

  return { routerModel, specialistModel, categoryModels, inferenceBackends, backgroundModel };
}

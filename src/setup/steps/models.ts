import { askText, askYesNo, printStep, printSuccess, printInfo } from '../prompts.js';
import { pickRouterModel, pickSpecialistModel, SPECIALIST_TEMPLATES } from '../defaults.js';
import type { OllamaModel } from '../../ollama/types.js';

export interface ModelsStepResult {
  routerModel: string;
  specialistModel: string;
  /** Per-category model overrides. Categories not listed use specialistModel. */
  categoryModels: Record<string, string>;
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

  return { routerModel, specialistModel, categoryModels };
}

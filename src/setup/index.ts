import { printHeader, closeRL, printInfo } from './prompts.js';
import { runOllamaStep } from './steps/ollama.js';
import { runModelsStep } from './steps/models.js';
import { runChannelsStep } from './steps/channels.js';
import { runServicesStep } from './steps/services.js';
import { runWorkspaceStep } from './steps/workspace.js';
import { runGenerateStep } from './steps/generate.js';
import { runPreflightStep } from './steps/preflight.js';

async function main(): Promise<void> {
  printHeader('LocalClaw Setup Wizard');
  printInfo('This wizard will help you configure LocalClaw.');
  printInfo('Press Enter to accept defaults shown in [brackets].\n');

  try {
    // Step 1: Ollama
    const ollama = await runOllamaStep();

    // Step 2: Models
    const models = await runModelsStep(ollama.models);

    // Step 3: Channels
    const channels = await runChannelsStep();

    // Step 4: Services
    const services = await runServicesStep(ollama.models);

    // Step 5: Workspace files (SOUL.md, USER.md, etc.)
    const workspace = await runWorkspaceStep();

    // Step 6: Generate .env + config
    const generated = await runGenerateStep({ ollama, models, channels, services });

    // Step 7: Preflight
    await runPreflightStep({ ollama, models, channels, services, generated });

    console.log('');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      // User closed stdin (Ctrl+D)
      console.log('\n\nSetup cancelled.');
    } else {
      console.error('\nSetup failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    closeRL();
  }
}

main();

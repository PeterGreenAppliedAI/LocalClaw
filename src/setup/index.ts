import { printHeader, closeRL, printInfo, printPass, printWarning } from './prompts.js';
import { testDocker } from './connectivity.js';
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
    // Prerequisites check
    printInfo('--- Prerequisites ---');
    const dockerAvailable = await testDocker();
    if (dockerAvailable) {
      printPass('Docker is available');
    } else {
      printWarning('Docker not found — FalkorDB (graph memory) and Docker exec will be unavailable');
      printInfo('Install Docker: https://docs.docker.com/get-docker/\n');
    }

    // Step 1: Ollama
    const ollama = await runOllamaStep();

    // Step 2: Models
    const models = await runModelsStep(ollama.models);

    // Step 3: Channels
    const channels = await runChannelsStep();

    // Step 4: Services
    const enabledChannels = Object.entries(channels)
      .filter(([k, v]) => k !== 'ownerId' && k !== 'trustedUsers' && typeof v === 'object' && 'enabled' in v && v.enabled)
      .map(([k]) => k);
    const services = await runServicesStep(ollama.models, enabledChannels);

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

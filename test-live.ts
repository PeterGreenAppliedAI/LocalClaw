import { loadConfig } from './src/config/loader.js';
import { OllamaClient } from './src/ollama/client.js';
import { ToolRegistry } from './src/tools/registry.js';
import { dispatchMessage } from './src/dispatch.js';
import { registerAllTools } from './src/tools/register-all.js';

async function main() {
  const config = loadConfig();
  const client = new OllamaClient(config.ollama.url, config.ollama.keepAlive);
  const registry = new ToolRegistry();
  await registerAllTools(registry, config);

  const available = await client.isAvailable();
  console.log(`Ollama available: ${available}`);
  console.log(`URL: ${config.ollama.url}`);

  const message = process.argv[2] ?? 'Hello! How are you today?';
  console.log(`\nMessage: "${message}"\n`);

  const result = await dispatchMessage({
    client,
    registry,
    config,
    message,
  });

  console.log(`Category: ${result.category}`);
  console.log(`Confidence: ${result.classification.confidence}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Hit max: ${result.hitMaxIterations}`);

  // Debug: show tool call steps
  if (result.steps) {
    for (const [i, step] of result.steps.entries()) {
      console.log(`\n--- Step ${i + 1}: Tool Call ---`);
      console.log(`Tool: ${step.tool}`);
      console.log(`Params: ${JSON.stringify(step.params)}`);
      console.log(`Observation (first 500 chars): ${step.observation?.slice(0, 500)}`);
    }
  }

  console.log(`\nAnswer: ${result.answer}`);
}

main().catch(console.error);

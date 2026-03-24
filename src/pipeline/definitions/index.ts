import type { PipelineRegistry } from '../registry.js';
import { messagePipeline } from './message.js';
import { websitePipeline } from './website.js';
import { taskPipeline } from './task.js';
import { memoryPipeline } from './memory.js';
import { cronPipeline } from './cron.js';
import { webSearchPipeline } from './web-search.js';
import { execPipeline } from './exec.js';
import { heartbeatPipeline } from './heartbeat.js';
import { researchPipeline } from './research.js';
import { planPipeline } from './plan.js';

/**
 * Register all pipeline definitions.
 * Called during orchestrator startup.
 */
export function registerAllPipelines(registry: PipelineRegistry): void {
  // Simple pipelines
  registry.register(messagePipeline);
  registry.register(websitePipeline);

  // Branched pipelines
  registry.register(taskPipeline);
  registry.register(memoryPipeline);
  registry.register(cronPipeline);

  // Complex pipelines
  registry.register(webSearchPipeline);
  registry.register(execPipeline);
  registry.register(heartbeatPipeline);
  registry.register(researchPipeline);

  // Meta pipelines
  registry.register(planPipeline);

  console.log(`[Pipelines] Registered ${registry.list().length} pipeline(s)`);
}

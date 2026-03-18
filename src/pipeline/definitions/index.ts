import type { PipelineRegistry } from '../registry.js';
import { messagePipeline } from './message.js';
import { websitePipeline } from './website.js';

/**
 * Register all pipeline definitions.
 * Called during orchestrator startup.
 */
export function registerAllPipelines(registry: PipelineRegistry): void {
  // Phase 2: simple pipelines
  registry.register(messagePipeline);
  registry.register(websitePipeline);

  // Phase 3: branched pipelines (task, memory, cron)
  // Phase 4: complex pipelines (web_search, exec, heartbeat)

  console.log(`[Pipelines] Registered ${registry.list().length} pipeline(s)`);
}

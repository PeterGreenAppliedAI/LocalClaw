import type { ToolRegistry } from './registry.js';
import type { LocalClawConfig } from '../config/types.js';
import type { CronService } from '../cron/service.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { OllamaClient } from '../ollama/client.js';
import { resolveWorkspacePath } from '../agents/scope.js';
import { createWebSearchTool } from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';
import { createMemorySearchTool } from './memory-search.js';
import { createMemoryGetTool } from './memory-get.js';
import { createMemorySaveTool } from './memory-save.js';
import { createExecTool } from './exec.js';
import { createReadFileTool } from './read-file.js';
import { createWriteFileTool } from './write-file.js';
import { createBrowserTool } from './browser.js';
import { createWebsiteQueryTool } from './website-query.js';
import { createCronAddTool } from './cron-add.js';
import { createCronListTool } from './cron-list.js';
import { createCronRemoveTool } from './cron-remove.js';
import { createSendMessageTool } from './send-message.js';

export interface RegisterToolsOptions {
  cronService?: CronService;
  channelRegistry?: ChannelRegistry;
  ollamaClient?: OllamaClient;
}

/**
 * Register all available tools with the registry based on config.
 * Called once at startup. New tools: add registration here.
 */
export function registerAllTools(
  registry: ToolRegistry,
  config: LocalClawConfig,
  options?: RegisterToolsOptions,
): void {
  // Web tools
  registry.register(createWebSearchTool(config.tools?.web?.search));
  registry.register(createWebFetchTool(config.tools?.web?.fetch));

  // Memory tools (with embedding support if client available)
  const workspace = resolveWorkspacePath(config.agents.default, config);
  registry.register(createMemorySearchTool(workspace, options?.ollamaClient));
  registry.register(createMemoryGetTool(workspace));
  registry.register(createMemorySaveTool(workspace, options?.ollamaClient));

  // Exec tools
  registry.register(createExecTool(config.tools?.exec));
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());

  // Browser tool
  if (config.browser?.enabled) {
    registry.register(createBrowserTool(config.browser));
  }

  // Website tool
  if (config.tools?.website?.baseUrl) {
    registry.register(createWebsiteQueryTool(config.tools.website));
  }

  // Cron tools (require running service)
  if (options?.cronService) {
    registry.register(createCronAddTool(options.cronService));
    registry.register(createCronListTool(options.cronService));
    registry.register(createCronRemoveTool(options.cronService));
  }

  // Send message tool (requires channel registry)
  if (options?.channelRegistry) {
    registry.register(createSendMessageTool(options.channelRegistry));
  }
}

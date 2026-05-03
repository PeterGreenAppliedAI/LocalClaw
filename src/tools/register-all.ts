import type { ToolRegistry } from './registry.js';
import type { LocalClawConfig } from '../config/types.js';
import type { CronService } from '../cron/service.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { OllamaClient } from '../ollama/client.js';
import type { TaskStore } from '../tasks/store.js';
import { EmbeddingStore } from '../memory/embeddings.js';
import { resolveWorkspacePath } from '../agents/scope.js';
import { createWebSearchTool } from './web-search.js';
import { createWebFetchTool } from './web-fetch.js';
import { createMemorySearchTool } from './memory-search.js';
import { createMemoryGetTool } from './memory-get.js';
import { createMemorySaveTool } from './memory-save.js';
import { createMemoryForgetTool } from './memory-forget.js';
import { createKnowledgeImportTool } from './knowledge-import.js';
import { createExecTool } from './exec.js';
import { createCodeSessionTool } from './code-session.js';
import { SessionManager } from '../exec/session-manager.js';
import { DockerBackend } from '../exec/docker-backend.js';
import { createReadFileTool } from './read-file.js';
import { createWriteFileTool } from './write-file.js';
import { createBrowserTool } from './browser.js';
import { createWebsiteQueryTool } from './website-query.js';
import { createCronAddTool } from './cron-add.js';
import { createCronListTool } from './cron-list.js';
import { createCronRemoveTool } from './cron-remove.js';
import { createSendMessageTool } from './send-message.js';
import { createCronEditTool } from './cron-edit.js';
import { createHeartbeatAddTool } from './heartbeat-add.js';
import { createHeartbeatListTool } from './heartbeat-list.js';
import { createHeartbeatRemoveTool } from './heartbeat-remove.js';
import { createWorkspaceReadTool } from './workspace-read.js';
import { createWorkspaceWriteTool } from './workspace-write.js';
import { createTaskAddTool } from './task-add.js';
import { createTaskListTool } from './task-list.js';
import { createTaskUpdateTool } from './task-update.js';
import { createTaskDoneTool } from './task-done.js';
import { createTaskRemoveTool } from './task-remove.js';
import { createReasonTool } from './reason.js';
import { createMemoryCleanupTool } from './memory-cleanup.js';
import { createDocumentTool } from './document.js';
import { createGmailSearchTool, createGmailReadTool } from './gmail-read.js';
import { createCalendarListTool, createCalendarSearchTool } from './calendar-read.js';
import { createImageGenerateTool } from './image-generate.js';

export interface RegisterToolsOptions {
  cronService?: CronService;
  channelRegistry?: ChannelRegistry;
  ollamaClient?: OllamaClient;
  taskStore?: TaskStore;
  heartbeatConfig?: import('../config/types.js').HeartbeatConfig;
  factStore?: import('../memory/fact-store.js').FactStore;
}

export interface RegisterToolsResult {
  embeddingStore: EmbeddingStore;
}

/**
 * Register all available tools with the registry based on config.
 * Called once at startup. New tools: add registration here.
 * Async to support Docker availability check.
 */
export async function registerAllTools(
  registry: ToolRegistry,
  config: LocalClawConfig,
  options?: RegisterToolsOptions,
): Promise<RegisterToolsResult> {
  // Web tools
  registry.register(createWebSearchTool(config.tools?.web?.search));
  registry.register(createWebFetchTool(config.tools?.web?.fetch));

  // Memory tools (with embedding support if client available)
  const workspace = resolveWorkspacePath(config.agents.default, config);

  // Create a single shared EmbeddingStore so all memory tools share one DB connection
  const embeddingStore = new EmbeddingStore();

  registry.register(createMemorySearchTool(workspace, options?.ollamaClient, embeddingStore, options?.factStore));
  registry.register(createMemoryGetTool(workspace));
  registry.register(createMemorySaveTool(workspace, options?.factStore));
  registry.register(createMemoryForgetTool(workspace, options?.factStore));
  registry.register(createMemoryCleanupTool(
    options?.factStore,
    options?.ollamaClient,
    config.memory?.consolidation?.model,
  ));

  // Knowledge import tool (requires Ollama for embeddings)
  if (options?.ollamaClient) {
    registry.register(createKnowledgeImportTool(workspace, options.ollamaClient, embeddingStore, config.tools?.knowledge));
  }

  // Docker backend (if configured)
  let dockerBackend: DockerBackend | undefined;
  if (config.tools?.exec?.security === 'docker') {
    const dockerAvailable = await DockerBackend.isAvailable();
    if (dockerAvailable) {
      dockerBackend = new DockerBackend(config.tools.exec.docker);
      console.log('[Docker] Docker sandbox enabled');
    } else {
      console.warn('[Docker] Docker requested but not available — falling back to allowlist');
    }
  }

  // Exec tools
  registry.register(createExecTool(config.tools?.exec, dockerBackend));
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());

  // Code session tool
  const sessionManager = new SessionManager(config.tools?.exec?.sessions);
  registry.register(createCodeSessionTool(sessionManager));

  // Browser tool (pass Ollama URL for visual mode vision model calls)
  if (config.browser?.enabled) {
    registry.register(createBrowserTool(config.browser, config.ollama?.url));
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
    registry.register(createCronEditTool(options.cronService));

    // Heartbeat tools (require heartbeat config)
    if (options.heartbeatConfig) {
      registry.register(createHeartbeatAddTool(options.cronService, options.heartbeatConfig));
      registry.register(createHeartbeatListTool(options.cronService));
      registry.register(createHeartbeatRemoveTool(options.cronService));
    }
  }

  // Send message tool (requires channel registry)
  if (options?.channelRegistry) {
    registry.register(createSendMessageTool(options.channelRegistry));
  }

  // Task tools (require task store)
  if (options?.taskStore) {
    registry.register(createTaskAddTool(options.taskStore));
    registry.register(createTaskListTool(options.taskStore));
    registry.register(createTaskUpdateTool(options.taskStore));
    registry.register(createTaskDoneTool(options.taskStore));
    registry.register(createTaskRemoveTool(options.taskStore));
  }

  // Reason tool (requires Ollama client + reasoning config)
  if (options?.ollamaClient && config.reasoning) {
    registry.register(createReasonTool(options.ollamaClient, config.reasoning));
  }

  // Document tool (LibreOffice headless)
  registry.register(createDocumentTool());

  // Google tools (owner-only, read-only — requires OAuth2 credentials)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
    registry.register(createGmailSearchTool());
    registry.register(createGmailReadTool());
    registry.register(createCalendarListTool());
    registry.register(createCalendarSearchTool());
    console.log('[Tools] Google tools registered (gmail_search, gmail_read, calendar_list, calendar_search)');
  }

  // Image generation (requires separate Ollama instance with Flux model)
  if (config.imageGen?.enabled) {
    registry.register(createImageGenerateTool(config.imageGen));
    console.log(`[Tools] Image generation registered (${config.imageGen.model})`);
  }

  // Workspace tools (always available)
  registry.register(createWorkspaceReadTool());
  registry.register(createWorkspaceWriteTool());

  return { embeddingStore };
}

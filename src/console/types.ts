import type { LocalClawConfig } from '../config/types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { SessionStore } from '../sessions/store.js';
import type { TaskStore } from '../tasks/store.js';
import type { CronService } from '../cron/service.js';
import type { FactStore } from '../memory/fact-store.js';
import type { VisionService } from '../services/vision.js';
import type { DispatchParams } from '../dispatch.js';

export interface ConsoleApiDeps {
  config: LocalClawConfig;
  ollamaClient: OllamaClient;
  toolRegistry: ToolRegistry;
  channelRegistry: ChannelRegistry;
  sessionStore: SessionStore;
  taskStore: TaskStore;
  cronService?: CronService;
  factStore?: FactStore;
  visionService?: VisionService;
  dispatch: (params: Omit<DispatchParams, 'client' | 'registry' | 'config'>) => Promise<import('../dispatch.js').DispatchResult>;
}

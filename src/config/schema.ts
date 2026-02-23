import { z } from 'zod';

export const OllamaConfigSchema = z.object({
  url: z.string().default('http://127.0.0.1:11434'),
  keepAlive: z.string().default('30m'),
});

export const RouterCategorySchema = z.object({
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

export const RouterConfigSchema = z.object({
  model: z.string().default('phi4-mini'),
  timeout: z.number().default(2000),
  defaultCategory: z.string().default('chat'),
  categories: z.record(z.string(), RouterCategorySchema).default({}),
});

export const SpecialistConfigSchema = z.object({
  model: z.string(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().default(4096),
  temperature: z.number().default(0.7),
  maxIterations: z.number().default(10),
  tools: z.array(z.string()).default([]),
});

export const ChannelAllowFromSchema = z.object({
  guilds: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  users: z.array(z.string()).optional(),
});

export const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  allowFrom: ChannelAllowFromSchema.optional(),
});

export const AgentBindingMatchSchema = z.object({
  channel: z.string().optional(),
  guildId: z.string().optional(),
  peerId: z.string().optional(),
  accountId: z.string().optional(),
});

export const AgentBindingSchema = z.object({
  agentId: z.string(),
  match: AgentBindingMatchSchema.optional(),
});

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  workspace: z.string().optional(),
  routerOverrides: z.object({
    defaultCategory: z.string().optional(),
  }).optional(),
});

export const AgentsConfigSchema = z.object({
  default: z.string().default('main'),
  list: z.array(AgentSchema).default([{ id: 'main' }]),
  bindings: z.array(AgentBindingSchema).default([]),
});

export const MemoryConfigSchema = z.object({
  backend: z.enum(['markdown']).default('markdown'),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(false),
  store: z.string().default('data/cron.json'),
});

export const SessionConfigSchema = z.object({
  transcriptDir: z.string().default('data/sessions'),
  maxHistoryTurns: z.number().default(100),
  contextSize: z.number().default(32768),
  recentTurnsToKeep: z.number().default(6),
});

export const WebSearchConfigSchema = z.object({
  provider: z.enum(['brave', 'perplexity', 'grok', 'tavily']).default('brave'),
  apiKey: z.string().optional(),
  cacheTtlMs: z.number().default(15 * 60 * 1000),
});

export const WebFetchConfigSchema = z.object({
  maxChars: z.number().default(30000),
  firecrawlApiKey: z.string().optional(),
  firecrawlBaseUrl: z.string().optional(),
});

export const ExecConfigSchema = z.object({
  security: z.enum(['allowlist']).default('allowlist'),
  allowlist: z.array(z.string()).default(['ls', 'cat', 'python3', 'node', 'git']),
  timeout: z.number().default(30000),
});

export const WebsiteConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

export const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(false),
  headless: z.boolean().default(true),
  executablePath: z.string().optional(),
});

export const TTSConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:5005'),
  voice: z.string().default('tara'),
  format: z.enum(['wav', 'opus', 'mp3']).default('opus'),
});

export const STTConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:8000'),
  model: z.string().default('whisper-large-v3'),
  language: z.string().default('en'),
});

export const ToolsConfigSchema = z.object({
  web: z.object({
    search: WebSearchConfigSchema.optional(),
    fetch: WebFetchConfigSchema.optional(),
  }).optional(),
  exec: ExecConfigSchema.optional(),
  website: WebsiteConfigSchema.optional(),
});

export const LocalClawConfigSchema = z.object({
  ollama: OllamaConfigSchema.default({}),
  router: RouterConfigSchema.default({}),
  specialists: z.record(z.string(), SpecialistConfigSchema).default({}),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
  agents: AgentsConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  tools: ToolsConfigSchema.optional(),
  browser: BrowserConfigSchema.optional(),
  tts: TTSConfigSchema.default({}),
  stt: STTConfigSchema.default({}),
});

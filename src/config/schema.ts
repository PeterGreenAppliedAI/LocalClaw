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
  /** Workspace context level: 'full' injects all workspace files, 'minimal' injects SOUL+IDENTITY only.
   *  Defaults to 'minimal' for tool-using specialists, 'full' for chat. */
  contextLevel: z.enum(['full', 'minimal']).optional(),
});

export const ChannelAllowFromSchema = z.object({
  guilds: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  users: z.array(z.string()).optional(),
});

export const ChannelSecuritySchema = z.object({
  allowedCategories: z.array(z.string()).optional(),
  blockedTools: z.array(z.string()).optional(),
  trustedUsers: z.array(z.string()).optional(),
  restrictedCategories: z.array(z.string()).optional(),
  restrictedTools: z.array(z.string()).optional(),
});

export const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  allowFrom: ChannelAllowFromSchema.optional(),
  security: ChannelSecuritySchema.optional(),
}).passthrough();

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

export const MemoryConsolidationSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default('phi4-mini'),
  similarityThreshold: z.number().min(0).max(1).default(0.85),
});

export const MemoryConfigSchema = z.object({
  backend: z.enum(['markdown']).default('markdown'),
  consolidation: MemoryConsolidationSchema.optional(),
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

export const SessionExecConfigSchema = z.object({
  idleTimeoutMs: z.number().default(300_000),
  maxSessions: z.number().default(3),
  maxOutputBytes: z.number().default(1024 * 1024),
  allowedRuntimes: z.array(z.enum(['python', 'node', 'bash'])).default(['python', 'node', 'bash']),
});

export const DockerConfigSchema = z.object({
  image: z.string().default('localclaw-sandbox:latest'),
  mountMode: z.enum(['ro', 'rw']).default('ro'),
  memoryLimit: z.string().default('512m'),
  cpuLimit: z.string().default('1.0'),
  networkMode: z.string().default('none'),
});

export const ExecConfigSchema = z.object({
  security: z.enum(['allowlist', 'docker']).default('allowlist'),
  allowlist: z.array(z.string()).default(['ls', 'cat', 'python3', 'node', 'git']),
  timeout: z.number().default(30000),
  sessions: SessionExecConfigSchema.optional(),
  docker: DockerConfigSchema.optional(),
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
  voice: z.string().default('serena'),
  format: z.enum(['wav', 'opus', 'mp3']).default('opus'),
});

export const STTConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:8000'),
  model: z.string().default('whisper-large-v3'),
  language: z.string().default('en'),
});

export const VisionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default('qwen3-vl:8b'),
  prompt: z.string().default('Describe this image in detail. Include text content, visual elements, layout, and any relevant context.'),
  maxTokens: z.number().default(512),
});

export const ReasoningConfigSchema = z.object({
  model: z.string().default('nemotron-3-nano:30b'),
  maxTokens: z.number().default(8192),
  temperature: z.number().default(0.6),
});

export const KnowledgeConfigSchema = z.object({
  maxChunkSize: z.number().default(800),
  overlapSize: z.number().default(100),
  allowedExtensions: z.array(z.string()).default(['.pdf', '.csv', '.md', '.txt', '.html', '.htm']),
});

export const ToolsConfigSchema = z.object({
  web: z.object({
    search: WebSearchConfigSchema.optional(),
    fetch: WebFetchConfigSchema.optional(),
  }).optional(),
  exec: ExecConfigSchema.optional(),
  website: WebsiteConfigSchema.optional(),
  knowledge: KnowledgeConfigSchema.optional(),
});

export const VoiceConfigSchema = z.object({
  model: z.string().default('qwen2.5:7b'),
});

export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('0 */2 * * *'), // every 2 hours
  delivery: z.object({
    channel: z.string().default('discord'),
    target: z.string(), // Discord channel ID or user ID for DMs
  }),
});

export const LocalClawConfigSchema = z.object({
  timezone: z.string().default('America/New_York'),
  ollama: OllamaConfigSchema.default({}),
  router: RouterConfigSchema.default({}),
  specialists: z.record(z.string(), SpecialistConfigSchema).default({}),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
  agents: AgentsConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  tools: ToolsConfigSchema.optional(),
  reasoning: ReasoningConfigSchema.optional(),
  browser: BrowserConfigSchema.optional(),
  tts: TTSConfigSchema.default({}),
  stt: STTConfigSchema.default({}),
  vision: VisionConfigSchema.default({}),
  voice: VoiceConfigSchema.default({}),
  heartbeat: HeartbeatConfigSchema.optional(),
});

import type { z } from 'zod';
import type {
  LocalClawConfigSchema,
  OllamaConfigSchema,
  RouterConfigSchema,
  RouterCategorySchema,
  SpecialistConfigSchema,
  ChannelConfigSchema,
  ChannelSecuritySchema,
  AgentsConfigSchema,
  AgentSchema,
  AgentBindingSchema,
  MemoryConfigSchema,
  MemoryConsolidationSchema,
  CronConfigSchema,
  SessionConfigSchema,
  ToolsConfigSchema,
  ExecConfigSchema,
  SessionExecConfigSchema,
  DockerConfigSchema,
  WebSearchConfigSchema,
  WebFetchConfigSchema,
  WebsiteConfigSchema,
  KnowledgeConfigSchema,
  ReasoningConfigSchema,
  BrowserConfigSchema,
  TTSConfigSchema,
  STTConfigSchema,
  VisionConfigSchema,
  HeartbeatConfigSchema,
  VoiceConfigSchema,
} from './schema.js';

export type LocalClawConfig = z.infer<typeof LocalClawConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type RouterCategory = z.infer<typeof RouterCategorySchema>;
export type SpecialistConfig = z.infer<typeof SpecialistConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ChannelSecurity = z.infer<typeof ChannelSecuritySchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentBinding = z.infer<typeof AgentBindingSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type MemoryConsolidationConfig = z.infer<typeof MemoryConsolidationSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ExecConfig = z.infer<typeof ExecConfigSchema>;
export type SessionExecConfig = z.infer<typeof SessionExecConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;
export type WebFetchConfig = z.infer<typeof WebFetchConfigSchema>;
export type WebsiteConfig = z.infer<typeof WebsiteConfigSchema>;
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;
export type ReasoningConfig = z.infer<typeof ReasoningConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type TTSConfig = z.infer<typeof TTSConfigSchema>;
export type STTConfig = z.infer<typeof STTConfigSchema>;
export type VisionConfig = z.infer<typeof VisionConfigSchema>;
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

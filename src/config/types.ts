import type { z } from 'zod';
import type {
  LocalClawConfigSchema,
  OllamaConfigSchema,
  RouterConfigSchema,
  RouterCategorySchema,
  SpecialistConfigSchema,
  ChannelConfigSchema,
  AgentsConfigSchema,
  AgentSchema,
  AgentBindingSchema,
  MemoryConfigSchema,
  CronConfigSchema,
  SessionConfigSchema,
  ToolsConfigSchema,
  ExecConfigSchema,
  WebSearchConfigSchema,
  WebFetchConfigSchema,
  WebsiteConfigSchema,
  BrowserConfigSchema,
} from './schema.js';

export type LocalClawConfig = z.infer<typeof LocalClawConfigSchema>;
export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type RouterCategory = z.infer<typeof RouterCategorySchema>;
export type SpecialistConfig = z.infer<typeof SpecialistConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type AgentBinding = z.infer<typeof AgentBindingSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type CronConfig = z.infer<typeof CronConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type ExecConfig = z.infer<typeof ExecConfigSchema>;
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;
export type WebFetchConfig = z.infer<typeof WebFetchConfigSchema>;
export type WebsiteConfig = z.infer<typeof WebsiteConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

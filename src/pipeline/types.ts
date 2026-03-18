import type { OllamaClient } from '../ollama/client.js';
import type { ToolExecutor, ToolContext, ToolParameterSchema } from '../tools/types.js';
import type { OllamaMessage } from '../ollama/types.js';

/**
 * Shared context passed between pipeline stages.
 * Stages read from and write to this accumulator.
 */
export interface PipelineContext {
  /** Original user message */
  userMessage: string;
  /** Extracted parameters (filled by extract stages, read by tool stages) */
  params: Record<string, unknown>;
  /** Results from each stage, keyed by stage name */
  stageResults: Record<string, unknown>;
  /** Tool call log for DispatchResult compatibility */
  steps: Array<{ tool?: string; params?: Record<string, unknown>; observation?: string }>;
  /** Ollama client for LLM calls */
  client: OllamaClient;
  /** Tool executor */
  executor: ToolExecutor;
  /** Tool context (agentId, workspacePath, senderId) */
  toolContext: ToolContext;
  /** Conversation history */
  history?: OllamaMessage[];
  /** Workspace context string (SOUL.md, IDENTITY.md, etc.) */
  workspaceContext?: string;
  /** User priming (stable facts) */
  userPriming?: string;
  /** Specialist model name */
  model: string;
  /** Source context from dispatch */
  sourceContext?: { channel: string; channelId: string; guildId?: string; senderId?: string };
  /** Current loop iteration (set by executor during loop stages) */
  loopIndex?: number;
  /** Set to true to abort the pipeline early */
  abort?: boolean;
  /** Final answer (set by the last stage or an early exit) */
  answer?: string;
  /** Stream callback — stages with stream: true will use this for progressive output */
  onStream?: (delta: string) => void;
}

// --- Stage types ---

interface BaseStage {
  /** Stage name — used as key in stageResults */
  name: string;
  /** Skip this stage if condition returns false */
  when?: (ctx: PipelineContext) => boolean;
}

/** Call a specific tool with computed params */
export interface ToolStage extends BaseStage {
  type: 'tool';
  tool: string;
  resolveParams: (ctx: PipelineContext) => Record<string, unknown>;
}

/** Ask the LLM to generate text (synthesis, analysis, formatting) */
export interface LlmStage extends BaseStage {
  type: 'llm';
  buildPrompt: (ctx: PipelineContext) => { system: string; user: string };
  maxTokens?: number;
  temperature?: number;
  /** Stream output progressively via ctx.onStream. Use on the final user-facing stage. */
  stream?: boolean;
}

/** Run deterministic code (date math, formatting, validation) */
export interface CodeStage extends BaseStage {
  type: 'code';
  execute: (ctx: PipelineContext) => unknown | Promise<unknown>;
}

/** Extract structured params from user message via LLM */
export interface ExtractStage extends BaseStage {
  type: 'extract';
  /** Schema for extraction — becomes the LLM prompt */
  schema: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
  /** Optional examples to guide extraction */
  examples?: Array<{ input: string; output: Record<string, unknown> }>;
}

/** Branch to a sub-pipeline based on intent */
export interface BranchStage extends BaseStage {
  type: 'branch';
  decide: (ctx: PipelineContext) => string;
  branches: Record<string, PipelineStage[]>;
}

/** Repeat stages N times or until a condition is false */
export interface LoopStage extends BaseStage {
  type: 'loop';
  maxIterations: number;
  stages: PipelineStage[];
  continueIf: (ctx: PipelineContext, iteration: number) => boolean;
}

/** Run multiple tool calls concurrently */
export interface ParallelToolStage extends BaseStage {
  type: 'parallel_tool';
  tool: string;
  /** Returns an array of param objects — one tool call per entry, all run concurrently */
  resolveParamsList: (ctx: PipelineContext) => Record<string, unknown>[];
}

export type PipelineStage =
  | ToolStage
  | LlmStage
  | CodeStage
  | ExtractStage
  | BranchStage
  | LoopStage
  | ParallelToolStage;

/**
 * A named pipeline: a sequence of stages.
 */
export interface PipelineDefinition {
  name: string;
  stages: PipelineStage[];
}

/**
 * Result from running a pipeline.
 */
export interface PipelineResult {
  answer: string;
  iterations: number;
  hitMaxIterations: boolean;
  steps: Array<{ tool?: string; params?: Record<string, unknown>; observation?: string }>;
}

export interface ReActStep {
  thought: string;
  action?: { tool: string; params: Record<string, unknown> };
  observation?: string;
  finalAnswer?: string;
}

export interface ReActResult {
  answer: string;
  steps: ReActStep[];
  iterations: number;
  hitMaxIterations: boolean;
  /** Total prompt tokens consumed across all iterations */
  promptTokens?: number;
  /** Total completion tokens generated across all iterations */
  completionTokens?: number;
}

export interface ReActConfig {
  maxIterations: number;
  model: string;
  temperature: number;
  maxTokens: number;
  topK?: number;
  topP?: number;
  repeatPenalty?: number;
  systemPrompt?: string;
  contextSize?: number;
  /** Skip drift detection — browser control sessions produce long responses that trigger false positives */
  skipDriftDetection?: boolean;
}

export type ParsedReActResponse =
  | { type: 'action'; thought: string; tool: string; params: Record<string, unknown>; raw: string }
  | { type: 'final_answer'; thought: string; answer: string }
  | { type: 'fallback'; content: string };

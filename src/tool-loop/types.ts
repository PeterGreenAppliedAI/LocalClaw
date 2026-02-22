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
}

export interface ReActConfig {
  maxIterations: number;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
}

export type ParsedReActResponse =
  | { type: 'action'; thought: string; tool: string; params: Record<string, unknown>; raw: string }
  | { type: 'final_answer'; thought: string; answer: string }
  | { type: 'fallback'; content: string };

export interface ToolContext {
  agentId: string;
  sessionKey: string;
  workspacePath?: string;
  senderId?: string;
  config?: Record<string, unknown>;
}

/** Structured parameter definition for Ollama tool calling */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required?: string[];
}

export interface LocalClawTool {
  name: string;
  description: string;
  parameterDescription: string;
  /** Structured parameters for native tool calling. If omitted, falls back to text-based ReAct. */
  parameters?: ToolParameterSchema;
  /** Example usage shown in the system prompt to guide the model. */
  example?: string;
  category: string;
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameterDescription: string;
  parameters?: ToolParameterSchema;
  example?: string;
}

export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>;

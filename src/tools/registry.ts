import { toolNotFound } from '../errors.js';
import type { LocalClawTool, ToolDefinition, ToolExecutor, ToolContext } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, LocalClawTool>();

  register(tool: LocalClawTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): LocalClawTool | undefined {
    return this.tools.get(name);
  }

  getByCategory(category: string): LocalClawTool[] {
    return [...this.tools.values()].filter(t => t.category === category);
  }

  getDefinitions(names: string[]): ToolDefinition[] {
    return names
      .map(n => this.tools.get(n))
      .filter((t): t is LocalClawTool => t !== undefined)
      .map(({ name, description, parameterDescription, parameters }) => ({
        name,
        description,
        parameterDescription,
        parameters,
      }));
  }

  createExecutor(): ToolExecutor {
    return async (toolName: string, params: Record<string, unknown>, ctx: ToolContext) => {
      const tool = this.tools.get(toolName);
      if (!tool) throw toolNotFound(toolName);
      return tool.execute(params, ctx);
    };
  }

  list(): string[] {
    return [...this.tools.keys()];
  }
}

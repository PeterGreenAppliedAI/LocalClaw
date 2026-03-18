import type { PipelineDefinition } from './types.js';

/**
 * Registry for named pipeline definitions.
 * Specialist configs reference pipelines by name (e.g., pipeline: "task").
 */
export class PipelineRegistry {
  private pipelines = new Map<string, PipelineDefinition>();

  register(definition: PipelineDefinition): void {
    if (this.pipelines.has(definition.name)) {
      console.warn(`[PipelineRegistry] Overwriting pipeline "${definition.name}"`);
    }
    this.pipelines.set(definition.name, definition);
  }

  get(name: string): PipelineDefinition | undefined {
    return this.pipelines.get(name);
  }

  has(name: string): boolean {
    return this.pipelines.has(name);
  }

  list(): string[] {
    return [...this.pipelines.keys()];
  }
}

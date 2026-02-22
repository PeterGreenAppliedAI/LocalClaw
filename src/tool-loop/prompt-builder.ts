import type { ToolDefinition } from '../tools/types.js';
import type { ReActStep } from './types.js';

/**
 * Build the ReAct system prompt for a specialist.
 * Optionally includes workspace context (SOUL.md, USER.md, etc).
 */
export function buildReActSystemPrompt(
  specialistPrompt: string | undefined,
  tools: ToolDefinition[],
  workspaceContext?: string,
): string {
  const today = new Date().toISOString().split('T')[0];

  let prompt = `You are a helpful AI assistant. Today's date is ${today}.\n`;

  if (specialistPrompt) {
    prompt += `\n${specialistPrompt}\n`;
  }

  // Inject workspace context (SOUL.md, USER.md, AGENTS.md, etc.)
  if (workspaceContext) {
    prompt += `\n${workspaceContext}\n`;
  }

  if (tools.length > 0) {
    prompt += '\n## Available Tools\n';
    for (const tool of tools) {
      prompt += `- ${tool.name}: ${tool.description}\n`;
      prompt += `  Parameters: ${tool.parameterDescription}\n`;
    }
  }

  // Build concrete examples using the actual tools
  const exampleTool = tools.length > 0 ? tools[0] : { name: 'tool_name' };
  const exampleTool2 = tools.length > 1 ? tools[1] : exampleTool;

  prompt += `
## Response Format

You MUST respond using EXACTLY this format. Do NOT deviate.

### To use a tool:

Thought: I need to [reason about what to do]
Action: ${exampleTool.name}[{"param": "value"}]

### After receiving an Observation, to use another tool:

Thought: Based on the result, I should [next step]
Action: ${exampleTool2.name}[{"param": "value"}]

### When you have the final answer:

Thought: I now have enough information to answer.
Final Answer: [your complete response to the user]

## CRITICAL RULES — FOLLOW EXACTLY

1. ALWAYS start your response with "Thought:"
2. To call a tool, write "Action:" followed by tool_name[{JSON}] on the SAME line
3. The tool name must be one of: ${tools.map(t => t.name).join(', ')}
4. Parameters must be valid JSON inside square brackets [ ]
5. Use ONE tool per response — then STOP and wait for the Observation
6. When you are done, write "Final Answer:" followed by your response
7. NEVER write code blocks, markdown tool calls, or JSON outside of Action: lines
8. NEVER narrate what you would do — actually DO it with Action:`;

  return prompt;
}

/**
 * Build the scratchpad from previous ReAct steps.
 */
export function buildScratchpad(steps: ReActStep[]): string {
  if (steps.length === 0) return '';

  const lines: string[] = [];
  for (const step of steps) {
    if (step.thought) lines.push(`Thought: ${step.thought}`);
    if (step.action) {
      lines.push(`Action: ${step.action.tool}[${JSON.stringify(step.action.params)}]`);
    }
    if (step.observation !== undefined) {
      lines.push(`Observation: ${step.observation}`);
    }
    if (step.finalAnswer) {
      lines.push(`Final Answer: ${step.finalAnswer}`);
    }
  }
  return lines.join('\n');
}

import type { ToolDefinition } from '../tools/types.js';
import type { ReActStep } from './types.js';

export interface PromptContext {
  specialistPrompt?: string;
  workspaceContext?: string;
  channel?: string;
  isVoice?: boolean;
  statePreamble?: string;
  workspacePath?: string;
  /** Stable user facts injected as context so specialists know who they're talking to. */
  userPriming?: string;
}

/**
 * Build the ReAct system prompt for a specialist.
 *
 * Prompt ordering follows primacy/recency bias research:
 *   TOP (highest weight):  Role + Task — what the model is doing right now
 *   MIDDLE:                Channel, Tools, Persona
 *   BOTTOM (second highest): Format rules + constraints
 */
export function buildReActSystemPrompt(
  specialistPrompt: string | undefined,
  tools: ToolDefinition[],
  workspaceContext?: string,
  promptContext?: PromptContext,
): string {
  const today = new Date().toISOString().split('T')[0];
  const sections: string[] = [];

  // ── TOP: Role + Task (primacy position) ──
  // The specialist prompt IS the role and task. Lead with it.
  if (specialistPrompt) {
    sections.push(specialistPrompt);
  } else {
    sections.push('You are a helpful AI assistant.');
  }

  sections.push(`Today's date is ${today}.`);

  // ── Channel context — unambiguous, one line ──
  if (promptContext?.channel) {
    sections.push(`You are responding via the ${promptContext.channel} channel.`);
  }

  // ── Voice mode ──
  if (promptContext?.isVoice) {
    sections.push('IMPORTANT: This is a voice conversation. Your response will be spoken aloud via TTS. Keep responses concise. Do NOT use emojis, markdown formatting, bullet points, or special characters. Use plain conversational English only.');
  }

  // ── Workspace path ──
  if (promptContext?.workspacePath) {
    sections.push(`Workspace directory: "${promptContext.workspacePath}" — user scripts, notes, and workspace files are stored here.`);
  }

  // ── Session state ──
  if (promptContext?.statePreamble) {
    sections.push(promptContext.statePreamble);
  }

  // ── User priming — stable facts about who's asking ──
  if (promptContext?.userPriming) {
    sections.push(promptContext.userPriming);
  }

  // ── Tools with structured descriptions + examples ──
  if (tools.length > 0) {
    const toolLines = ['## Available Tools', ''];
    for (const tool of tools) {
      toolLines.push(`**${tool.name}**: ${tool.description}`);
      toolLines.push(`  Parameters: ${tool.parameterDescription}`);
      if (tool.example) {
        toolLines.push(`  Example: ${tool.example}`);
      }
      toolLines.push('');
    }
    sections.push(toolLines.join('\n'));
  }

  // ── Persona (workspace context) — compressed, middle position ──
  // For tool-using specialists this is minimal (SOUL+IDENTITY only).
  // Placed after tools so it doesn't compete with task instructions.
  if (workspaceContext) {
    sections.push(workspaceContext);
  }

  // ── BOTTOM: Format rules + constraints (recency position) ──
  // These are the last thing the model reads before generating.
  const exampleTool = tools.length > 0 ? tools[0] : { name: 'tool_name' };
  const exampleTool2 = tools.length > 1 ? tools[1] : exampleTool;

  sections.push(`## Response Format

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
8. NEVER narrate what you would do — actually DO it with Action:
9. NEVER refuse to use tools — you have full access to all tools listed above`);

  return sections.join('\n\n');
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

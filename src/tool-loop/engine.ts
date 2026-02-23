import { logRepair, logToolCall } from '../metrics.js';
import type { OllamaClient } from '../ollama/client.js';
import type { OllamaMessage, OllamaTool, OllamaToolCall } from '../ollama/types.js';
import type { ToolDefinition, ToolExecutor, ToolContext } from '../tools/types.js';
import type { ReActConfig, ReActResult, ReActStep } from './types.js';
import { estimateMessagesTokens } from '../context/tokens.js';

export interface RunReActLoopParams {
  client: OllamaClient;
  config: ReActConfig;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  toolContext: ToolContext;
  userMessage: string;
  history?: OllamaMessage[];
  workspaceContext?: string;
}

/**
 * Trim older tool observations when the messages array exceeds the token budget.
 *
 * Strategy:
 * 1. Keep system message and current user message untouched
 * 2. Keep the most recent 2 assistant+tool pairs untouched
 * 3. Replace older tool observation content with a truncated preview
 */
export function trimToolLoopMessages(messages: OllamaMessage[], contextSize: number): void {
  const budget = Math.floor(contextSize * 0.85); // leave room for output + overhead
  if (estimateMessagesTokens(messages) <= budget) return;

  // Find tool messages eligible for trimming (not in the last 4 non-system messages)
  const nonSystemIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== 'system') nonSystemIndices.push(i);
  }

  // Protect last 4 non-system messages (≈ 2 assistant+tool pairs)
  const protectedSet = new Set(nonSystemIndices.slice(-4));

  for (let i = 0; i < messages.length; i++) {
    if (protectedSet.has(i)) continue;
    if (messages[i].role !== 'tool') continue;

    const original = messages[i].content ?? '';
    if (original.length > 300) {
      messages[i] = {
        ...messages[i],
        content: `[Truncated: ${original.slice(0, 200)}... (${original.length} chars)]`,
      };
    }

    if (estimateMessagesTokens(messages) <= budget) return;
  }
}

/**
 * Convert LocalClaw tool definitions to Ollama's native tool format.
 */
function toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? {
        type: 'object' as const,
        properties: {
          input: { type: 'string', description: t.parameterDescription },
        },
        required: ['input'],
      },
    },
  }));
}

/**
 * Fallback parser: extract tool calls from text content when models narrate
 * instead of using structured tool_calls.
 *
 * Handles formats:
 *   - XML-style: <function=tool_name><parameter=key>value</parameter></function>
 *   - Action-style: Action: tool_name[{"key": "value"}]
 */
function parseToolCallsFromText(
  content: string,
  availableTools: Set<string>,
): OllamaToolCall[] {
  const calls: OllamaToolCall[] = [];

  // XML-style: <function=name><parameter=key>value</parameter></function>
  const xmlPattern = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = xmlPattern.exec(content)) !== null) {
    const name = xmlMatch[1];
    if (!availableTools.has(name)) continue;

    const paramBlock = xmlMatch[2];
    const args: Record<string, unknown> = {};
    const paramPattern = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramPattern.exec(paramBlock)) !== null) {
      args[paramMatch[1]] = paramMatch[2].trim();
    }
    calls.push({ function: { name, arguments: args } });
  }

  if (calls.length > 0) return calls;

  // Action-style: Action: tool_name[{...}]
  const actionPattern = /Action:\s*(\w+)\s*\[(\{[\s\S]*?\})\]/g;
  let actionMatch: RegExpExecArray | null;
  while ((actionMatch = actionPattern.exec(content)) !== null) {
    const name = actionMatch[1];
    if (!availableTools.has(name)) continue;

    try {
      const args = JSON.parse(actionMatch[2]);
      calls.push({ function: { name, arguments: args } });
    } catch {
      // Skip malformed JSON
    }
  }

  return calls;
}

/**
 * Run the tool-calling loop using Ollama's native function calling.
 *
 * Flow:
 *   1. Send messages + tools to Ollama
 *   2. If response has tool_calls → execute tools, append results, loop
 *   3. If content contains narrated tool calls → parse + execute, loop
 *   4. If response has content only → that's the final answer
 *   5. Safety: max iterations limit
 */
export async function runToolLoop(params: RunReActLoopParams): Promise<ReActResult> {
  const { client, config, tools, executor, toolContext, userMessage, history, workspaceContext } = params;

  // Build system prompt
  const today = new Date().toISOString().split('T')[0];
  let systemPrompt = `You are a helpful AI assistant. Today's date is ${today}.\n`;
  if (config.systemPrompt) {
    systemPrompt += `\n${config.systemPrompt}\n`;
  }
  if (workspaceContext) {
    systemPrompt += `\n${workspaceContext}\n`;
  }
  systemPrompt += '\nUse the provided tools to help answer the user\'s question. When you have enough information, respond directly to the user.';

  // Convert tools to Ollama format
  const ollamaTools = toOllamaTools(tools);
  const availableToolNames = new Set(tools.map(t => t.name));

  // Build message history
  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(history ?? []),
    { role: 'user', content: userMessage },
  ];

  const steps: ReActStep[] = [];

  console.log(`[ReAct] model=${config.model}, tools=[${tools.map(t => t.name).join(', ')}]`);

  for (let i = 0; i < config.maxIterations; i++) {
    // Trim older tool observations if over budget
    if (config.contextSize) {
      trimToolLoopMessages(messages, config.contextSize);
    }

    const response = await client.chat({
      model: config.model,
      messages,
      tools: ollamaTools.length > 0 ? ollamaTools : undefined,
      options: {
        temperature: config.temperature,
        num_predict: config.maxTokens,
      },
    });

    const msg = response.message;
    let toolCalls = msg.tool_calls;

    // Fallback: if model narrated tool calls in text, parse them out
    if ((!toolCalls || toolCalls.length === 0) && msg.content && availableToolNames.size > 0) {
      const parsed = parseToolCallsFromText(msg.content, availableToolNames);
      if (parsed.length > 0) {
        toolCalls = parsed;
        const format = msg.content.includes('<function=') ? 'xml' as const : 'action' as const;
        for (const p of parsed) {
          logRepair({ category: config.model, format, toolName: p.function.name });
        }
        console.log(`[ReAct] Step ${i + 1}: parsed_from_text=${parsed.map(c => c.function.name).join(', ')}`);
      }
    }

    const hasTools = toolCalls && toolCalls.length > 0;
    if (hasTools) {
      console.log(`[ReAct] Step ${i + 1}: tool_call=${toolCalls![0].function.name}`);
    } else {
      console.log(`[ReAct] Step ${i + 1}: answer=${(msg.content || '').slice(0, 80)}...`);
    }

    // If model returns tool calls, execute them
    if (toolCalls && toolCalls.length > 0) {
      // Add the assistant message with tool calls to history
      messages.push(msg);

      for (const call of toolCalls) {
        const toolName = call.function.name;
        let toolParams = call.function.arguments ?? {};

        // Some models/gateways nest args as { function: "name", parameters: {...} }
        if ('parameters' in toolParams && typeof toolParams.parameters === 'object') {
          toolParams = toolParams.parameters as Record<string, unknown>;
        }

        let observation: string;
        const toolStart = Date.now();
        try {
          observation = await executor(toolName, toolParams, toolContext);
          logToolCall({ tool: toolName, category: config.model, durationMs: Date.now() - toolStart, success: true });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          observation = `Tool "${toolName}" failed: ${errMsg}. Try a different approach or tool.`;
          logToolCall({ tool: toolName, category: config.model, durationMs: Date.now() - toolStart, success: false, error: errMsg });
          console.error(`[ReAct] Tool error: ${toolName} — ${errMsg}`);
        }

        steps.push({
          thought: msg.content || '',
          action: { tool: toolName, params: toolParams },
          observation,
        });

        // Append tool result as a tool message
        messages.push({
          role: 'tool',
          content: observation,
        });
      }
      continue;
    }

    // No tool calls — this is the final answer
    const answer = msg.content || '';
    steps.push({ thought: '', finalAnswer: answer });
    return { answer, steps, iterations: i + 1, hitMaxIterations: false };
  }

  // Max iterations reached — ask the model to synthesize a final answer
  console.log(`[ReAct] Max iterations (${config.maxIterations}) reached, synthesizing final answer`);

  try {
    messages.push({
      role: 'user',
      content: 'You have reached the maximum number of tool calls. Based on all the information you have gathered so far, please provide your best answer to the original question now. Do not call any more tools.',
    });

    const finalResponse = await client.chat({
      model: config.model,
      messages,
      options: {
        temperature: config.temperature,
        num_predict: config.maxTokens,
      },
      // No tools — force a text answer
    });

    const answer = finalResponse.message?.content || 'I was unable to complete the request within the allowed steps.';
    steps.push({ thought: '', finalAnswer: answer });
    return { answer, steps, iterations: config.maxIterations, hitMaxIterations: true };
  } catch {
    // Synthesis failed — use last observation
    const lastStep = steps[steps.length - 1];
    const fallbackAnswer = lastStep?.observation ?? lastStep?.thought ?? 'I was unable to complete the request.';
    return { answer: fallbackAnswer, steps, iterations: config.maxIterations, hitMaxIterations: true };
  }
}

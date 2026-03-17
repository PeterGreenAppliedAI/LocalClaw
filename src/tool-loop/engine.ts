import { logRepair, logToolCall } from '../metrics.js';
import type { OllamaClient } from '../ollama/client.js';
import type { OllamaMessage, OllamaTool, OllamaToolCall } from '../ollama/types.js';
import type { ToolDefinition, ToolExecutor, ToolContext } from '../tools/types.js';
import type { ReActConfig, ReActResult, ReActStep } from './types.js';
import { estimateMessagesTokens } from '../context/tokens.js';
import { buildReActSystemPrompt, type PromptContext } from './prompt-builder.js';
import { parseReActResponse } from './parser.js';

export interface RunReActLoopParams {
  client: OllamaClient;
  config: ReActConfig;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  toolContext: ToolContext;
  userMessage: string;
  history?: OllamaMessage[];
  workspaceContext?: string;
  promptContext?: PromptContext;
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
 * Action hallucination detector — catches model claiming "I've updated/created/..."
 * without actually calling any tools (per ChatGPT analysis §3-4).
 */
const ACTION_CLAIM_PATTERNS = [
  /\b(?:i'?ve|i have|i just|i'?ve just)\s+(?:updated|created|added|removed|deleted|modified|changed|fixed|completed|set|saved|written|executed|ran|scheduled|marked|searched|checked|looked|fetched|retrieved)\b/i,
  /\b(?:successfully|already)\s+(?:updated|created|added|removed|deleted|modified|changed|fixed|completed|saved|scheduled)\b/i,
  /\btask\s+(?:has been|was|is now)\s+(?:updated|created|added|removed|deleted|modified|changed|completed|marked)\b/i,
  /\bhere(?:'s| is)\s+the\s+(?:updated|current|latest|result)\b/i,
  /\bthat(?:'s| is)\s+(?:been|now)\s+(?:updated|done|added|saved|fixed|changed)\b/i,
  /\bbased on (?:the |my )?(?:current|latest|recent)\s+(?:stock|data|information|search|results)\b/i,
  /\b(?:the|current)\s+(?:stock |share )?price (?:is|of)\b/i,
  /\baccording to (?:the |my )?(?:latest|current|recent)\b/i,
];

function claimsActionWithoutToolCall(text: string): boolean {
  return ACTION_CLAIM_PATTERNS.some(p => p.test(text));
}

/** Max chars for a single tool observation before truncation. */
const MAX_TOOL_RESULT_CHARS = 2000;

/**
 * Run the tool-calling loop using Ollama's native function calling.
 *
 * Flow:
 *   1. Send messages + tools to Ollama
 *   2. If response has tool_calls → execute tools, append results, loop
 *   3. If content contains narrated tool calls → parse + execute, loop
 *   4. If response has content only → check for action hallucination, then accept as final answer
 *   5. Safety: max iterations limit
 */
export async function runToolLoop(params: RunReActLoopParams): Promise<ReActResult> {
  const { client, config, tools, executor, toolContext, userMessage, history, workspaceContext, promptContext } = params;

  // Build system prompt with full ReAct format instructions, tool list, and examples
  const systemPrompt = buildReActSystemPrompt(config.systemPrompt, tools, workspaceContext, promptContext);

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
  const hasReasonTool = availableToolNames.has('reason');
  let repairAttempted = false;

  // Temperature lock: ≤0.3 for tool-calling specialists (ChatGPT feedback §6)
  const effectiveTemperature = ollamaTools.length > 0
    ? Math.min(config.temperature, 0.3)
    : config.temperature;

  console.log(`[ReAct] model=${config.model}, tools=[${tools.map(t => t.name).join(', ')}]${
    effectiveTemperature !== config.temperature ? `, temp clamped ${config.temperature}→${effectiveTemperature}` : ''
  }`);

  // Step-back planning: when reason tool is available, have the model plan
  // its approach before diving in. Prevents unstructured multi-draft outputs.
  if (hasReasonTool && tools.length > 1) {
    try {
      const planResponse = await client.chat({
        model: config.model,
        messages: [
          ...messages,
          {
            role: 'user',
            content: 'Before starting, briefly plan your approach in 2-3 bullet points. What tools will you use, in what order, and what is the expected output format? Be concise — just the plan, then I will say "go" and you can begin.',
          },
        ],
        options: { temperature: 0.2, num_predict: 256 },
      });

      const plan = planResponse.message?.content ?? '';
      if (plan) {
        messages.push({ role: 'assistant', content: plan });
        messages.push({ role: 'user', content: 'Go.' });
        console.log(`[ReAct] Step-back plan: ${plan.slice(0, 120)}...`);
      }
    } catch {
      // Planning failed — continue without it
      console.log('[ReAct] Step-back planning failed, proceeding without plan');
    }
  }

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
        temperature: effectiveTemperature,
        num_predict: config.maxTokens,
      },
    });

    const msg = response.message;
    let toolCalls = msg.tool_calls;

    // Fallback: if model narrated tool calls in text, parse them out
    let parsedFromText = false;
    if ((!toolCalls || toolCalls.length === 0) && msg.content && availableToolNames.size > 0) {
      // Try the inline XML/Action parser first
      const parsed = parseToolCallsFromText(msg.content, availableToolNames);
      if (parsed.length > 0) {
        // Only take the FIRST tool call — local models often "unroll" entire chains
        // with fabricated observations. Executing only the first and discarding the
        // rest forces the model to see the real observation before continuing.
        toolCalls = [parsed[0]];
        parsedFromText = true;
        const format = msg.content.includes('<function=') ? 'xml' as const : 'action' as const;
        logRepair({ category: config.model, format, toolName: parsed[0].function.name });
        if (parsed.length > 1) {
          console.log(`[ReAct] Step ${i + 1}: parsed_from_text=${parsed[0].function.name} (discarded ${parsed.length - 1} narrated follow-ups)`);
        } else {
          console.log(`[ReAct] Step ${i + 1}: parsed_from_text=${parsed[0].function.name}`);
        }
      } else {
        // Try the ReAct-aware parser with JSON5 repair for local model quirks
        const reActParsed = parseReActResponse(msg.content);
        if (reActParsed.type === 'action' && availableToolNames.has(reActParsed.tool)) {
          toolCalls = [{ function: { name: reActParsed.tool, arguments: reActParsed.params } }];
          parsedFromText = true;
          logRepair({ category: config.model, format: 'action' as const, toolName: reActParsed.tool });
          console.log(`[ReAct] Step ${i + 1}: react_parsed=${reActParsed.tool}`);
        }
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
      // When tool calls were parsed from text, truncate the assistant message to
      // just the Thought + first Action line. Local models often "unroll" entire
      // tool chains with fabricated observations in a single response — leaving
      // that text in history causes the model to believe its own hallucinations.
      let historyMsg = msg;
      if (parsedFromText && msg.content) {
        const firstActionEnd = msg.content.search(/Action:\s*\w+\s*[\[({].*?[\])}]/);
        if (firstActionEnd !== -1) {
          const actionLineEnd = msg.content.indexOf('\n', firstActionEnd);
          historyMsg = {
            ...msg,
            content: actionLineEnd !== -1
              ? msg.content.slice(0, actionLineEnd).trim()
              : msg.content.trim(),
          };
        }
      }

      // Add the (possibly truncated) assistant message to history
      messages.push(historyMsg);

      for (const call of toolCalls) {
        const toolName = call.function.name;
        let toolParams = call.function.arguments ?? {};

        // Some models/gateways nest args as { function: "name", parameters: {...} }
        if ('parameters' in toolParams && typeof toolParams.parameters === 'object') {
          toolParams = toolParams.parameters as Record<string, unknown>;
        }

        let observation: string;
        const toolStart = Date.now();
        console.log(`[ReAct] → ${toolName}(${JSON.stringify(toolParams).slice(0, 200)})`);
        try {
          observation = await executor(toolName, toolParams, toolContext);
          logToolCall({ tool: toolName, category: config.model, durationMs: Date.now() - toolStart, success: true });
          console.log(`[ReAct] ← ${toolName}: ${observation.slice(0, 200)}${observation.length > 200 ? '...' : ''}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          observation = `Tool "${toolName}" failed: ${errMsg}. Try a different approach or tool.`;
          logToolCall({ tool: toolName, category: config.model, durationMs: Date.now() - toolStart, success: false, error: errMsg });
          console.warn(`[ReAct] TOOL_EXECUTION_ERROR: ${toolName} — ${errMsg}`);
        }

        // Tool result normalization: proactively truncate large outputs (ChatGPT feedback §5)
        if (observation.length > MAX_TOOL_RESULT_CHARS) {
          const original = observation.length;
          observation = observation.slice(0, MAX_TOOL_RESULT_CHARS) + `\n... [truncated from ${original} chars]`;
          console.log(`[ReAct] Tool "${toolName}" output truncated: ${original} → ${MAX_TOOL_RESULT_CHARS} chars`);
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

    // No tool calls — check for action hallucination before accepting as final answer
    let answer = msg.content || '';

    // Action validator (ChatGPT feedback §3-4): if model claims it performed an action
    // but never called a tool, send a repair prompt and retry once
    if (ollamaTools.length > 0 && !repairAttempted && claimsActionWithoutToolCall(answer)) {
      console.log(`[ReAct] Step ${i + 1}: action hallucination detected — "${answer.slice(0, 80)}..."`);
      messages.push(msg);
      messages.push({
        role: 'user',
        content: 'You said you performed an action, but you did NOT call any tool. '
          + 'You MUST use the provided tools to make changes — you cannot modify data by just saying so. '
          + 'Please call the correct tool now to fulfill the request.',
      });
      repairAttempted = true;
      continue;
    }

    // Premature refusal detector: if a tool-using specialist gives a final answer
    // on the first step without calling ANY tools, it's almost always wrong —
    // the model is refusing or hallucinating constraints that don't exist.
    if (ollamaTools.length > 0 && steps.length === 0 && !repairAttempted) {
      console.log(`[ReAct] Step ${i + 1}: premature answer without tool use — "${answer.slice(0, 80)}..."`);
      messages.push(msg);
      messages.push({
        role: 'user',
        content: 'You gave a final answer without using any tools. '
          + 'You MUST use your available tools to fulfill this request — do not refuse or claim you cannot. '
          + 'You have full access to: ' + ollamaTools.map(t => t.function.name).join(', ') + '. '
          + 'Start by calling the most relevant tool now.',
      });
      repairAttempted = true;
      continue;
    }

    // Forced reasoning pass: if reason tool was available but never called,
    // and the model gathered data (2+ tool calls), run a reasoning pass
    // to produce a clean, single-draft synthesis.
    const reasonWasCalled = steps.some(s => s.action?.tool === 'reason');
    const toolCallSteps = steps.filter(s => s.action);

    if (hasReasonTool && !reasonWasCalled && toolCallSteps.length >= 2) {
      const observations = toolCallSteps
        .map(s => `[${s.action!.tool}]: ${s.observation ?? ''}`)
        .join('\n\n');

      console.log(`[ReAct] Forcing reasoning pass (${toolCallSteps.length} tool calls, reason never invoked)`);

      try {
        const reasoned = await executor('reason', {
          prompt: userMessage,
          context: observations,
        }, toolContext);

        answer = reasoned;
        console.log(`[ReAct] Reasoning pass complete (${answer.length} chars)`);
      } catch (err) {
        // Reasoning failed — keep the model's original answer
        console.warn(`[ReAct] OLLAMA_INFERENCE_ERROR: Reasoning pass failed — ${err instanceof Error ? err.message : err}`);
      }
    }

    steps.push({ thought: '', finalAnswer: answer });
    return { answer, steps, iterations: i + 1, hitMaxIterations: false };
  }

  // Max iterations reached — use reasoning pass if available, otherwise ask model to synthesize
  console.log(`[ReAct] Max iterations (${config.maxIterations}) reached, synthesizing final answer`);

  const maxIterToolCalls = steps.filter(s => s.action);
  const maxIterReasonCalled = steps.some(s => s.action?.tool === 'reason');

  // Prefer reasoning model for synthesis when available
  if (hasReasonTool && !maxIterReasonCalled && maxIterToolCalls.length >= 2) {
    try {
      const observations = maxIterToolCalls
        .map(s => `[${s.action!.tool}]: ${s.observation ?? ''}`)
        .join('\n\n');

      console.log(`[ReAct] Max-iter reasoning pass (${maxIterToolCalls.length} tool calls)`);
      const answer = await executor('reason', {
        prompt: userMessage,
        context: observations +
          '\n\nIMPORTANT: Base your answer ONLY on the tool observations above. If the observations contain errors or do not include the requested information, say so honestly. NEVER fabricate data, file names, or command output.',
      }, toolContext);

      steps.push({ thought: '', finalAnswer: answer });
      return { answer, steps, iterations: config.maxIterations, hitMaxIterations: true };
    } catch (err) {
      console.warn(`[ReAct] OLLAMA_INFERENCE_ERROR: Max-iter reasoning pass failed — ${err instanceof Error ? err.message : err}`);
      // Fall through to normal synthesis
    }
  }

  try {
    messages.push({
      role: 'user',
      content: 'You have reached the maximum number of tool calls. Based ONLY on the actual tool results above, provide your best answer to the original question. If you were unable to find the requested information, say so honestly. NEVER fabricate data, file names, command output, or results that did not appear in the tool observations. Do not call any more tools.',
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

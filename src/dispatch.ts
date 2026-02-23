import type { OllamaClient } from './ollama/client.js';
import type { ToolRegistry } from './tools/registry.js';
import type { LocalClawConfig, SpecialistConfig } from './config/types.js';
import type { ToolContext } from './tools/types.js';
import type { OllamaMessage } from './ollama/types.js';
import { classifyMessage, type ClassifyResult } from './router/classifier.js';
import { runToolLoop } from './tool-loop/engine.js';
import { SessionStore } from './sessions/store.js';
import type { ConversationTurn } from './sessions/types.js';
import { resolveWorkspacePath } from './agents/scope.js';
import { buildWorkspaceContext } from './agents/workspace.js';
import { logDispatch, logRouterClassification } from './metrics.js';
import { computeBudget } from './context/budget.js';
import { buildCompactedHistory } from './context/compactor.js';

export interface DispatchParams {
  client: OllamaClient;
  registry: ToolRegistry;
  config: LocalClawConfig;
  message: string;
  agentId?: string;
  sessionKey?: string;
  history?: OllamaMessage[];
  sessionStore?: SessionStore;
  /** Source channel context — passed to specialists for delivery targeting */
  sourceContext?: {
    channel: string;      // e.g. "discord"
    channelId: string;    // Discord channel ID
    guildId?: string;
    senderId?: string;
  };
  /** Override category — skip router classification (used by cron) */
  overrideCategory?: string;
  /** Stream callback — called with text deltas for progressive output */
  onStream?: (delta: string) => void;
}

export interface DispatchResult {
  answer: string;
  category: string;
  classification: ClassifyResult;
  iterations: number;
  hitMaxIterations: boolean;
  steps?: Array<{ tool?: string; params?: Record<string, unknown>; observation?: string }>;
}

/**
 * Dispatch a message through the Router → Specialist pipeline.
 * Loads session transcript for context, saves turn after completion.
 */
export async function dispatchMessage(params: DispatchParams): Promise<DispatchResult> {
  const { client, registry, config, message, agentId = 'main', sessionKey = 'default', sessionStore } = params;

  // 1. Load session history — budget-aware compaction replaces simple truncation
  let history = params.history;
  if (!history && sessionStore) {
    // Resolve workspace path and specialist early for budget calculation
    const workspacePath = resolveWorkspacePath(agentId, config);
    const tempClassification = params.overrideCategory
      ? { category: params.overrideCategory }
      : null;
    const tempSpecialist = tempClassification
      ? config.specialists[tempClassification.category]
      : null;
    const outputReserve = tempSpecialist?.maxTokens ?? 4096;

    // Build workspace context for budget estimation
    const wsCtx = buildWorkspaceContext(workspacePath, { category: 'tool' });
    const budget = computeBudget({
      contextSize: config.session.contextSize,
      systemPrompt: tempSpecialist?.systemPrompt ?? '',
      workspaceContext: wsCtx,
      currentMessage: message,
      outputReserve,
    });

    try {
      const compacted = await buildCompactedHistory({
        store: sessionStore,
        client,
        agentId,
        sessionKey,
        budgetTokens: budget.historyBudget,
        recentTurnsToKeep: config.session.recentTurnsToKeep,
        model: tempSpecialist?.model ?? config.router.model,
        workspacePath,
      });
      history = compacted.messages;
      if (compacted.compacted) {
        console.log(`[Dispatch] History compacted (budget: ${budget.historyBudget} tokens)`);
      }
    } catch (err) {
      // Fallback: simple truncation (original behavior)
      console.warn('[Dispatch] Compaction failed, falling back to turn-count truncation:', err);
      const transcript = sessionStore.loadTranscript(agentId, sessionKey, config.session.maxHistoryTurns);
      history = transcript.map(t => ({
        role: t.role as 'user' | 'assistant',
        content: t.content,
      }));
    }
  }

  // 2. Classify (or use override)
  const classifyStart = Date.now();
  let classification: ClassifyResult;
  if (params.overrideCategory) {
    classification = { category: params.overrideCategory, confidence: 'override' as any };
  } else {
    classification = await classifyMessage(client, config.router, message);
  }
  const { category } = classification;
  logRouterClassification({ category, confidence: classification.confidence, durationMs: Date.now() - classifyStart });

  console.log(`[Dispatch] Category: ${category} (${classification.confidence})`);

  // 3. Resolve specialist config
  const specialistConfig = config.specialists[category] ?? getDefaultSpecialist(config, category);

  let result: DispatchResult;
  const dispatchStart = Date.now();

  if (!specialistConfig) {
    result = await runAsBareChat(client, config, message, classification, history, undefined, params.onStream, agentId);
  } else if (specialistConfig.tools.length === 0) {
    // No tools — skip ReAct loop, just chat directly
    result = await runAsBareChat(client, config, message, classification, history, specialistConfig, params.onStream, agentId);
  } else if (category === 'multi') {
    result = await runMultiOrchestration(params, classification, specialistConfig, history);
  } else {
    result = await runSpecialist(params, classification, specialistConfig, history);
  }

  logDispatch({
    category,
    confidence: classification.confidence,
    iterations: result.iterations,
    hitMaxIterations: result.hitMaxIterations,
    durationMs: Date.now() - dispatchStart,
    toolCalls: result.steps?.map(s => s.tool).filter(Boolean) as string[] | undefined,
  });

  // 4. Persist turns if session store available
  if (sessionStore) {
    const now = new Date().toISOString();
    sessionStore.appendTurn(agentId, sessionKey, {
      role: 'user',
      content: message,
      timestamp: now,
      category,
    });
    sessionStore.appendTurn(agentId, sessionKey, {
      role: 'assistant',
      content: result.answer,
      timestamp: now,
      category,
      model: specialistConfig?.model,
      iterations: result.iterations,
    });
  }

  return result;
}

async function runSpecialist(
  params: DispatchParams,
  classification: ClassifyResult,
  specialist: SpecialistConfig,
  history?: OllamaMessage[],
): Promise<DispatchResult> {
  const { client, registry, message, agentId = 'main', sessionKey = 'default', config } = params;
  const { category } = classification;

  const toolDefs = registry.getDefinitions(specialist.tools);
  const executor = registry.createExecutor();
  const workspacePath = resolveWorkspacePath(agentId, config);
  const toolContext: ToolContext = {
    agentId,
    sessionKey,
    workspacePath,
  };

  // Build workspace context — only inject files relevant to this specialist category
  const wsCategory = category === 'cron' ? 'cron' as const : 'tool' as const;
  const workspaceContext = buildWorkspaceContext(workspacePath, { category: wsCategory });

  // Inject source context into system prompt for tools that need delivery info
  let systemPrompt = specialist.systemPrompt;
  if (params.sourceContext && ['cron', 'message', 'multi'].includes(category)) {
    const ctx = params.sourceContext;
    systemPrompt = (systemPrompt ?? '') +
      `\n\nCurrent message context: The user is messaging from channel="${ctx.channel}", channelId="${ctx.channelId}"${ctx.guildId ? `, guildId="${ctx.guildId}"` : ''}. Use these values for delivery targets (e.g., cron job channel and target fields).`;
  }

  const result = await runToolLoop({
    client,
    config: {
      model: specialist.model,
      maxIterations: specialist.maxIterations,
      temperature: specialist.temperature,
      maxTokens: specialist.maxTokens,
      systemPrompt,
      contextSize: config.session.contextSize,
    },
    tools: toolDefs,
    executor,
    toolContext,
    userMessage: message,
    history,
    workspaceContext,
  });

  return {
    answer: result.answer,
    category,
    classification,
    iterations: result.iterations,
    hitMaxIterations: result.hitMaxIterations,
    steps: result.steps.filter(s => s.action).map(s => ({
      tool: s.action!.tool,
      params: s.action!.params,
      observation: s.observation,
    })),
  };
}

/**
 * Multi orchestration: decompose complex requests into sub-tasks,
 * dispatch each to the appropriate specialist, aggregate results.
 */
async function runMultiOrchestration(
  params: DispatchParams,
  classification: ClassifyResult,
  specialist: SpecialistConfig,
  history?: OllamaMessage[],
): Promise<DispatchResult> {
  const { client, registry, config, message } = params;
  const categories = Object.keys(config.specialists).filter(c => c !== 'multi');

  // Step 1: Ask the model to decompose the request into sub-tasks
  const decomposePrompt = `You are a task decomposer. Break the user's request into individual sub-tasks that can each be handled by one specialist.

Available specialists: ${categories.join(', ')}
- chat: Simple conversation
- web_search: Internet lookups, current info
- memory: Save/retrieve stored information
- exec: Run commands, file operations
- cron: Schedule recurring tasks
- message: Send messages to channels

Respond with a JSON array of sub-tasks. Each sub-task has "category" (specialist) and "message" (the prompt for that specialist).
Example: [{"category": "web_search", "message": "Find the current weather in NYC"}, {"category": "memory", "message": "Save the weather info"}]

IMPORTANT: Respond with ONLY the JSON array, no other text.`;

  const decomposeResponse = await client.chat({
    model: specialist.model,
    messages: [
      { role: 'system', content: decomposePrompt },
      { role: 'user', content: message },
    ],
    options: { temperature: 0.2, num_predict: 1024 },
  });

  // Parse sub-tasks
  let subTasks: Array<{ category: string; message: string }> = [];
  try {
    const content = decomposeResponse.message?.content ?? '';
    // Extract JSON array from response (may have markdown fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      subTasks = JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Decomposition failed — fall back to running multi specialist directly
    console.log('[Dispatch] Multi decomposition failed, falling back to direct specialist');
    return runSpecialist(params, classification, specialist, history);
  }

  if (subTasks.length === 0) {
    return runSpecialist(params, classification, specialist, history);
  }

  console.log(`[Dispatch] Multi decomposed into ${subTasks.length} sub-tasks: ${subTasks.map(t => t.category).join(' → ')}`);

  // Step 2: Execute sub-tasks sequentially, passing results forward
  const subResults: string[] = [];
  let totalIterations = 1; // count decompose step

  for (const task of subTasks) {
    const taskSpecialist = config.specialists[task.category];
    if (!taskSpecialist) {
      subResults.push(`[${task.category}] Skipped: unknown specialist`);
      continue;
    }

    // Enhance the sub-task message with context from previous results
    let enhancedMessage = task.message;
    if (subResults.length > 0) {
      enhancedMessage += `\n\nContext from previous steps:\n${subResults.join('\n')}`;
    }

    try {
      const subResult = await dispatchMessage({
        ...params,
        message: enhancedMessage,
        overrideCategory: task.category,
        onStream: undefined, // don't stream sub-tasks
      });
      subResults.push(`[${task.category}] ${subResult.answer}`);
      totalIterations += subResult.iterations;
    } catch (err) {
      subResults.push(`[${task.category}] Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Step 3: Synthesize final answer
  const synthesizeResponse = await client.chat({
    model: specialist.model,
    messages: [
      { role: 'system', content: 'Synthesize the results from multiple sub-tasks into a single cohesive response for the user. Be concise and natural.' },
      { role: 'user', content: `Original request: ${message}\n\nSub-task results:\n${subResults.join('\n\n')}` },
    ],
    options: { temperature: 0.5, num_predict: specialist.maxTokens },
  });

  return {
    answer: synthesizeResponse.message?.content ?? subResults.join('\n\n'),
    category: 'multi',
    classification,
    iterations: totalIterations + 1,
    hitMaxIterations: false,
  };
}

async function runAsBareChat(
  client: OllamaClient,
  config: LocalClawConfig,
  message: string,
  classification: ClassifyResult,
  history?: OllamaMessage[],
  specialist?: SpecialistConfig,
  onStream?: (delta: string) => void,
  agentId = 'main',
): Promise<DispatchResult> {
  const chatModel = specialist?.model ?? config.specialists.chat?.model ?? config.router.model;
  const temperature = specialist?.temperature ?? 0.8;
  const maxTokens = specialist?.maxTokens ?? 2048;

  // Inject workspace context — chat gets TOOLS.md for self-awareness
  const workspacePath = resolveWorkspacePath(agentId, config);
  const workspaceContext = buildWorkspaceContext(workspacePath, { category: 'chat' });
  let systemContent = specialist?.systemPrompt ?? 'You are a helpful AI assistant. Respond naturally and concisely.';
  if (workspaceContext) {
    systemContent += '\n\n' + workspaceContext;
  }

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemContent },
    ...(history ?? []),
    { role: 'user', content: message },
  ];

  const chatParams = {
    model: chatModel,
    messages,
    options: { temperature, num_predict: maxTokens },
  };

  const response = onStream
    ? await client.chatStream(chatParams, onStream)
    : await client.chat(chatParams);

  return {
    answer: response.message?.content ?? '',
    category: classification.category,
    classification,
    iterations: 1,
    hitMaxIterations: false,
  };
}

function getDefaultSpecialist(config: LocalClawConfig, category: string): SpecialistConfig | undefined {
  if (category === 'chat') {
    return {
      model: config.router.model,
      maxTokens: 2048,
      temperature: 0.8,
      maxIterations: 1,
      tools: [],
    };
  }
  return undefined;
}

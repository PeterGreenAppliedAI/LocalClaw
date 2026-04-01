import type { OllamaClient } from './ollama/client.js';
import type { ToolRegistry } from './tools/registry.js';
import type { LocalClawConfig, SpecialistConfig, ChannelSecurity } from './config/types.js';
import type { ToolContext } from './tools/types.js';
import type { OllamaMessage } from './ollama/types.js';
import { classifyMessage, type ClassifyResult } from './router/classifier.js';
import { runToolLoop } from './tool-loop/engine.js';
import { ErrorLearningStore } from './learnings/error-store.js';
import { SessionStore } from './sessions/store.js';
import type { ConversationTurn, SessionState } from './sessions/types.js';
import { createEmptySessionState } from './sessions/types.js';
import {
  updateMechanicalState,
  extractSemanticDelta,
  applyDelta,
  serializeStatePreamble,
  SEMANTIC_INTERVAL,
} from './sessions/state-tracker.js';
import { resolveWorkspacePath } from './agents/scope.js';
import { buildWorkspaceContext, type WorkspaceCategory } from './agents/workspace.js';
import { logDispatch, logRouterClassification } from './metrics.js';

/**
 * Frozen workspace snapshot cache — workspace context is loaded once per session
 * and reused for all dispatches. This prevents mid-session memory writes from
 * destabilizing the conversation and enables prefix caching benefits.
 *
 * Clears on !reset (session clear) or after 2 hours of inactivity.
 */
const workspaceCache = new Map<string, { context: string; loadedAt: number }>();
const WORKSPACE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function getCachedWorkspaceContext(
  sessionKey: string,
  workspacePath: string,
  category: WorkspaceCategory,
  channel?: string,
): string {
  const cached = workspaceCache.get(sessionKey);
  if (cached && Date.now() - cached.loadedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached.context;
  }

  const context = buildWorkspaceContext(workspacePath, { category, channel });
  workspaceCache.set(sessionKey, { context, loadedAt: Date.now() });
  return context;
}

/**
 * Smart model routing heuristic — short simple messages don't need the heavy model.
 * Adapted from Hermes Agent's smart model routing.
 */
function shouldUseQuickModel(message: string): boolean {
  const trimmed = message.trim();
  // Long messages need the full model
  if (trimmed.length > 160) return false;
  // Code blocks need the full model
  if (trimmed.includes('```') || trimmed.includes('`')) return false;
  // Complex keywords suggest a real task
  const complexPatterns = /\b(search|find|research|analyze|create|build|write|code|debug|fix|deploy|schedule|remind|explain|compare|summarize)\b/i;
  if (complexPatterns.test(trimmed)) return false;
  // Short, simple message — use quick model
  return true;
}

/** Clear cached workspace context for a session (called on !reset) */
export function clearWorkspaceCache(sessionKey?: string): void {
  if (sessionKey) {
    workspaceCache.delete(sessionKey);
  } else {
    workspaceCache.clear();
  }
}
import { computeBudget } from './context/budget.js';
import { buildCompactedHistory } from './context/compactor.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { runPipeline } from './pipeline/executor.js';
import type { PipelineContext } from './pipeline/types.js';

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
  /** Override model — used by voice for faster responses */
  modelOverride?: string;
  /** Cron mode — strips write_file from tool set so automated tasks can't create files */
  cronMode?: boolean;
  /** FactStore for structured memory writes during compaction */
  factStore?: import('./memory/fact-store.js').FactStore;
  /** Pipeline registry for deterministic pipeline dispatch */
  pipelineRegistry?: PipelineRegistry;
  /** Execution metrics store for recording pipeline run data */
  executionMetrics?: import('./metrics/execution-store.js').ExecutionMetricsStore;
  /** Skip pipeline — force ReAct tool-loop (used by plan sub-dispatch to prevent recursion) */
  skipPipeline?: boolean;
  /** Bypass confirmation gate — set when user confirmed a pending action */
  confirmed?: boolean;
}

export interface DispatchResult {
  answer: string;
  category: string;
  classification: ClassifyResult;
  iterations: number;
  hitMaxIterations: boolean;
  steps?: Array<{ tool?: string; params?: Record<string, unknown>; observation?: string }>;
  attachments?: Array<{ data: Buffer; mimeType: string; filename: string }>;
}

function resolveChannelSecurity(
  config: LocalClawConfig,
  channel?: string,
): ChannelSecurity | undefined {
  if (!channel) return undefined;
  const chConfig = config.channels[channel];
  return chConfig?.security ?? undefined;
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

    // Build workspace context for budget estimation (frozen per session)
    const wsCtx = getCachedWorkspaceContext(sessionKey, workspacePath, 'minimal');
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
        factStore: params.factStore,
        senderId: params.sourceContext?.senderId,
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
  // Extract previous category from last assistant turn for sticky routing
  let previousCategory: string | undefined;
  if (sessionStore) {
    const recentTurns = sessionStore.loadTranscript(agentId, sessionKey, 4);
    for (let i = recentTurns.length - 1; i >= 0; i--) {
      if (recentTurns[i].role === 'assistant' && recentTurns[i].category) {
        previousCategory = recentTurns[i].category;
        break;
      }
    }
  }

  const classifyStart = Date.now();
  let classification: ClassifyResult;
  if (params.overrideCategory) {
    classification = { category: params.overrideCategory, confidence: 'override' as any };
  } else {
    classification = await classifyMessage(client, config.router, message, previousCategory);
  }
  const { category } = classification;
  logRouterClassification({ category, confidence: classification.confidence, durationMs: Date.now() - classifyStart });

  console.log(`[Dispatch] Category: ${category} (${classification.confidence})`);

  // 2b. Channel security — category enforcement
  const channelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
  const senderId = params.sourceContext?.senderId;
  const isTrusted = senderId !== undefined && (!channelSecurity?.trustedUsers || channelSecurity.trustedUsers.includes(senderId));
  let effectiveCategory = category;

  if (channelSecurity?.allowedCategories && !channelSecurity.allowedCategories.includes(category)) {
    effectiveCategory = channelSecurity.allowedCategories.includes('chat')
      ? 'chat'
      : channelSecurity.allowedCategories[0] ?? config.router.defaultCategory;
    console.log(`[Dispatch] Channel "${params.sourceContext?.channel}" blocked category "${category}" → "${effectiveCategory}"`);
  }

  // 2c. Per-user category restrictions — untrusted users can't use restricted categories
  if (!isTrusted && channelSecurity?.restrictedCategories?.includes(effectiveCategory)) {
    const fallback = 'chat';
    console.log(`[Dispatch] Untrusted user "${senderId}" blocked from restricted category "${effectiveCategory}" → "${fallback}"`);
    effectiveCategory = fallback;
  }

  // 3. Resolve specialist config
  let specialistConfig = config.specialists[effectiveCategory] ?? getDefaultSpecialist(config, effectiveCategory);

  // 3b. Channel security — tool enforcement
  if (specialistConfig && channelSecurity?.blockedTools) {
    const filtered = specialistConfig.tools.filter(t => !channelSecurity.blockedTools!.includes(t));
    if (filtered.length !== specialistConfig.tools.length) {
      console.log(`[Dispatch] Channel stripped tools: [${specialistConfig.tools.filter(t => channelSecurity.blockedTools!.includes(t)).join(', ')}]`);
      specialistConfig = { ...specialistConfig, tools: filtered };
    }
  }

  // 3c. Per-user tool restrictions — untrusted users can't use restricted tools
  if (!isTrusted && specialistConfig && channelSecurity?.restrictedTools) {
    const filtered = specialistConfig.tools.filter(t => !channelSecurity.restrictedTools!.includes(t));
    if (filtered.length !== specialistConfig.tools.length) {
      console.log(`[Dispatch] Untrusted user "${senderId}" stripped restricted tools: [${specialistConfig.tools.filter(t => channelSecurity.restrictedTools!.includes(t)).join(', ')}]`);
      specialistConfig = { ...specialistConfig, tools: filtered };
    }
  }

  // 3d. Voice model override — only for chat (no tools) to keep tool-calling reliable
  if (params.modelOverride && specialistConfig && specialistConfig.tools.length === 0) {
    console.log(`[Dispatch] Model override: ${specialistConfig.model} → ${params.modelOverride}`);
    specialistConfig = { ...specialistConfig, model: params.modelOverride };
  }

  // 3e. Smart model routing — use fast model for short simple chat messages
  // Saves compute on the DGX Spark for "hey", "thanks", "ok" type messages
  if (!params.modelOverride && specialistConfig && effectiveCategory === 'chat'
    && specialistConfig.tools.length === 0 && shouldUseQuickModel(message)) {
    const quickModel = 'phi4-mini';
    console.log(`[Dispatch] Smart routing: "${message.slice(0, 40)}..." → ${quickModel} (simple message)`);
    specialistConfig = { ...specialistConfig, model: quickModel };
  }

  // 4. Session state — load structured state and inject preamble
  let sessionState: SessionState | null = null;
  let statePreamble = '';
  if (sessionStore) {
    sessionState = sessionStore.loadState(agentId, sessionKey);
    if (sessionState) {
      statePreamble = serializeStatePreamble(sessionState);
      if (statePreamble) {
        console.log(`[Dispatch] State preamble: turn=${sessionState.turnCount}, topic="${sessionState.currentTopic.slice(0, 60)}"`);
      }
    }
  }

  // 4b. User priming — pull stable facts so specialists know who they're talking to
  let userPriming = '';
  if (params.factStore && senderId) {
    try {
      const stableFacts = params.factStore.loadFactsJson(senderId)
        .filter(f => f.category === 'stable' && f.confidence >= 0.7)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10)
        .map(f => `- ${f.text}`);
      if (stableFacts.length > 0) {
        userPriming = `## About this user\n${stableFacts.join('\n')}`;
      }
    } catch {
      // Non-critical — continue without priming
    }
  }

  // 4c. Continuation context — for short follow-ups, also include the last assistant message
  let effectiveMessage = message;
  if (
    classification.confidence === 'sticky' &&
    message.trim().length < 150 &&
    history &&
    history.length >= 1
  ) {
    const lastAssistant = [...history].reverse().find(h => h.role === 'assistant');
    if (lastAssistant?.content) {
      const preview = lastAssistant.content.length > 300
        ? lastAssistant.content.slice(-300) + '...'
        : lastAssistant.content;
      effectiveMessage = `[Continuation — the user is responding to your previous message: "${preview}"]\n\n${message}`;
      console.log(`[Dispatch] Injected continuation context (${preview.slice(0, 60)}...)`);
    }
  }

  let result: DispatchResult;
  const dispatchStart = Date.now();

  // Pass effective message through to specialists
  const effectiveParams = effectiveMessage !== message ? { ...params, message: effectiveMessage } : params;

  if (!specialistConfig) {
    result = await runAsBareChat(client, config, effectiveMessage, classification, history, undefined, params.onStream, agentId, params.sourceContext, !!params.modelOverride, statePreamble, userPriming);
  } else if (specialistConfig.tools.length === 0) {
    // No tools — skip ReAct loop, just chat directly
    result = await runAsBareChat(client, config, effectiveMessage, classification, history, specialistConfig, params.onStream, agentId, params.sourceContext, !!params.modelOverride, statePreamble, userPriming);
  } else if (!params.skipPipeline && specialistConfig.pipeline && params.pipelineRegistry?.has(specialistConfig.pipeline)) {
    // Deterministic pipeline — LLM fills params, code decides workflow
    result = await runPipelineDispatch(effectiveParams, classification, specialistConfig, history, statePreamble, userPriming);
  } else if (!params.skipPipeline && effectiveCategory === 'multi') {
    result = await runMultiOrchestration(effectiveParams, classification, specialistConfig, history, statePreamble);
  } else {
    result = await runSpecialist(effectiveParams, classification, specialistConfig, history, statePreamble, userPriming);
  }

  result.category = effectiveCategory;

  // Strip thinking tags from models that emit <think>...</think> blocks
  result.answer = result.answer.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Post-task self-review (Feature 4): lightweight quality check for tool-heavy responses
  if (!params.cronMode) {
    const correction = await runPostTaskReview(client, config, message, result.answer, result.steps, effectiveCategory);
    if (correction) {
      result.answer += `\n\n${correction}`;
    }
  }

  logDispatch({
    category: effectiveCategory,
    confidence: classification.confidence,
    iterations: result.iterations,
    hitMaxIterations: result.hitMaxIterations,
    durationMs: Date.now() - dispatchStart,
    toolCalls: result.steps?.map(s => s.tool).filter(Boolean) as string[] | undefined,
  });

  // 5. Update session state
  if (sessionStore) {
    const toolNames = (result.steps?.map(s => s.tool).filter(Boolean) as string[]) ?? [];
    sessionState = updateMechanicalState(
      sessionState ?? createEmptySessionState(effectiveCategory),
      effectiveCategory,
      toolNames,
      result.answer,
    );

    // Periodic semantic extraction (skip for cron — no human in the loop)
    if (!params.cronMode && sessionState.turnCount - sessionState.lastSemanticUpdate >= SEMANTIC_INTERVAL) {
      try {
        const recentTurns = sessionStore.loadTranscript(agentId, sessionKey, 10);
        const delta = await extractSemanticDelta(
          client,
          config.router.model,
          recentTurns,
          sessionState,
        );
        sessionState = applyDelta(sessionState, delta);
        console.log(`[Dispatch] Semantic state updated: topic="${sessionState.currentTopic.slice(0, 60)}", facts=${sessionState.knownFacts.length}`);
      } catch (err) {
        console.warn('[Dispatch] Semantic extraction failed:', err instanceof Error ? err.message : err);
      }
    }

    sessionStore.saveState(agentId, sessionKey, sessionState);
  }

  // 6. Persist turns if session store available
  if (sessionStore) {
    const now = new Date().toISOString();
    sessionStore.appendTurn(agentId, sessionKey, {
      role: 'user',
      content: message,
      timestamp: now,
      category: effectiveCategory,
    });
    sessionStore.appendTurn(agentId, sessionKey, {
      role: 'assistant',
      content: result.answer,
      timestamp: now,
      category: effectiveCategory,
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
  statePreamble?: string,
  userPriming?: string,
): Promise<DispatchResult> {
  const { client, registry, message, agentId = 'main', sessionKey = 'default', config } = params;
  const { category } = classification;

  // Cron mode: strip write tools so automated tasks can't mutate state
  const CRON_BLOCKED_TOOLS = new Set(['write_file', 'task_add', 'task_update', 'task_done', 'task_remove', 'workspace_write', 'memory_save']);
  const tools = params.cronMode
    ? specialist.tools.filter(t => !CRON_BLOCKED_TOOLS.has(t))
    : specialist.tools;
  if (params.cronMode && tools.length !== specialist.tools.length) {
    const stripped = specialist.tools.filter(t => CRON_BLOCKED_TOOLS.has(t));
    console.log(`[Dispatch] Cron mode: stripped [${stripped.join(', ')}] from tool set`);
  }

  const toolDefs = registry.getDefinitions(tools);
  const baseExecutor = registry.createExecutor();
  const workspacePath = resolveWorkspacePath(agentId, config);
  const errorStore = new ErrorLearningStore(workspacePath);

  // Confirmation gate: tools in confirmTools return a preview instead of executing
  const channelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
  const confirmSet = new Set(channelSecurity?.confirmTools ?? []);
  const executor: import('./tools/types.js').ToolExecutor = !params.confirmed && confirmSet.size > 0
    ? async (toolName, toolParams, ctx) => {
        if (confirmSet.has(toolName)) {
          const preview = JSON.stringify(toolParams, null, 2);
          console.log(`[Dispatch] Confirmation required for ${toolName}`);
          return `⚠️ Confirmation required — about to run **${toolName}**:\n\`\`\`\n${preview}\n\`\`\`\nTell the user what you're about to do and ask them to reply "confirm" to proceed.`;
        }
        return baseExecutor(toolName, toolParams, ctx);
      }
    : baseExecutor;
  const toolContext: ToolContext = {
    agentId,
    sessionKey,
    workspacePath,
    senderId: params.sourceContext?.senderId,
  };

  // Build workspace context — tool-using specialists get minimal context (SOUL+IDENTITY)
  // to preserve token budget for tool results. Chat gets full context.
  const wsCategory = category === 'cron'
    ? 'cron' as const
    : specialist.contextLevel === 'full'
      ? 'chat' as const
      : 'minimal' as const;
  const workspaceContext = getCachedWorkspaceContext(
    params.sessionKey ?? 'default', workspacePath, wsCategory, params.sourceContext?.channel,
  );

  // Channel context for delivery targets (cron scheduling, send_message, etc.)
  let systemPrompt = specialist.systemPrompt;
  if (params.sourceContext) {
    const ctx = params.sourceContext;
    systemPrompt = (systemPrompt ?? '') +
      `\n\nCurrent message context: channelId="${ctx.channelId}"${ctx.guildId ? `, guildId="${ctx.guildId}"` : ''}. Use these values for delivery targets (e.g., cron job channel and target fields).`;
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
    promptContext: {
      channel: params.sourceContext?.channel,
      isVoice: !!params.modelOverride,
      statePreamble: statePreamble || undefined,
      workspacePath,
      userPriming: userPriming || undefined,
    },
    errorStore,
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

/** Categories that benefit from post-task review */
const REVIEW_CATEGORIES = new Set(['exec', 'multi', 'web_search']);

/**
 * Post-task self-review — lightweight quality check on specialist output.
 * Uses the router model (fast) to verify the answer addresses the request
 * and tool errors weren't glossed over. Returns a correction note or null.
 */
async function runPostTaskReview(
  client: OllamaClient,
  config: LocalClawConfig,
  originalMessage: string,
  answer: string,
  steps: Array<{ tool?: string; observation?: string }> | undefined,
  category: string,
): Promise<string | null> {
  // Only review tool-heavy responses in relevant categories
  if (!REVIEW_CATEGORIES.has(category)) return null;
  const toolSteps = steps?.filter(s => s.tool) ?? [];
  if (toolSteps.length < 2) return null;

  const toolSummary = toolSteps.map(s => `${s.tool}: ${(s.observation ?? '').slice(0, 80)}`).join('\n');

  try {
    const response = await client.chat({
      model: config.router.model,
      messages: [{
        role: 'user',
        content: `Review this AI response for quality. Be brief.

Request: "${originalMessage.slice(0, 200)}"
Response: "${answer.slice(0, 500)}"
Tool calls (${toolSteps.length}):
${toolSummary.slice(0, 400)}

Check: (1) Does it answer the question? (2) Were tool errors ignored? (3) Is info fabricated?
If issues found, respond starting with "Note:" and a brief correction.
If adequate, respond with just "OK".`,
      }],
      options: { num_predict: 256, temperature: 0.2 },
    });

    const text = (response.message?.content ?? '').trim();
    if (text.startsWith('Note:') || text.startsWith('note:')) {
      console.log(`[Dispatch] Post-task review correction: ${text.slice(0, 100)}`);
      return text;
    }
    return null;
  } catch (err) {
    // Review is best-effort — don't block the response
    console.warn('[Dispatch] Post-task review failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Deterministic pipeline dispatch — replaces ReAct for specialists with a `pipeline` config.
 * The pipeline defines the exact workflow; the LLM only extracts params or synthesizes text.
 */
async function runPipelineDispatch(
  params: DispatchParams,
  classification: ClassifyResult,
  specialist: SpecialistConfig,
  history?: OllamaMessage[],
  statePreamble?: string,
  userPriming?: string,
): Promise<DispatchResult> {
  const { client, registry, message, agentId = 'main', sessionKey = 'default', config } = params;
  const { category } = classification;

  const pipelineDef = params.pipelineRegistry!.get(specialist.pipeline!);
  if (!pipelineDef) {
    // Fallback to ReAct if pipeline not found (shouldn't happen — checked in caller)
    console.warn(`[Dispatch] Pipeline "${specialist.pipeline}" not found, falling back to ReAct`);
    return runSpecialist(params, classification, specialist, history, statePreamble, userPriming);
  }

  // Cron mode: strip write tools
  const CRON_BLOCKED_TOOLS = new Set(['write_file', 'task_add', 'task_update', 'task_done', 'task_remove', 'workspace_write', 'memory_save']);
  const tools = params.cronMode
    ? specialist.tools.filter(t => !CRON_BLOCKED_TOOLS.has(t))
    : specialist.tools;

  const executor = registry.createExecutor();
  const workspacePath = resolveWorkspacePath(agentId, config);
  const toolContext: ToolContext = {
    agentId,
    sessionKey,
    workspacePath,
    senderId: params.sourceContext?.senderId,
  };

  // Context isolation: the plan pipeline gets a fresh context (no parent history)
  // and progressive workspace disclosure to maximize context budget for tool results.
  const isolateContext = specialist.pipeline === 'plan';

  const wsCategory = category === 'cron'
    ? 'cron' as const
    : isolateContext
      ? 'progressive' as const
      : specialist.contextLevel === 'full'
        ? 'chat' as const
        : 'minimal' as const;
  // Plan pipeline gets fresh context (progressive, no caching). Others use frozen snapshot.
  const workspaceContext = isolateContext
    ? buildWorkspaceContext(workspacePath, { category: wsCategory, channel: params.sourceContext?.channel })
    : getCachedWorkspaceContext(params.sessionKey ?? 'default', workspacePath, wsCategory, params.sourceContext?.channel);

  const ctx: PipelineContext = {
    userMessage: message,
    params: {},
    stageResults: {},
    steps: [],
    client,
    executor,
    toolContext,
    history: isolateContext ? undefined : history,
    workspaceContext,
    userPriming: userPriming || undefined,
    model: specialist.model,
    routerModel: config.router?.model,
    sourceContext: params.sourceContext,
    onStream: params.onStream,
  };

  // Sub-dispatch for plan pipeline orchestration — delegates sub-tasks to specialists
  if (isolateContext) {
    ctx.subDispatch = async (subMessage: string, subCategory: string) => {
      console.log(`[Plan] Sub-dispatch: "${subMessage.slice(0, 60)}..." → ${subCategory}`);
      const result = await dispatchMessage({
        ...params,
        message: subMessage,
        overrideCategory: subCategory,
        skipPipeline: true, // go to tool-loop, not pipeline (prevents plan→plan recursion)
        onStream: undefined, // don't stream sub-task responses
      });
      return { answer: result.answer, steps: result.steps };
    };
  }

  // Create metrics collector for plan pipeline runs
  let collector: import('./metrics/collector.js').MetricsCollector | undefined;
  if (specialist.pipeline === 'plan' && params.executionMetrics) {
    const { MetricsCollector } = await import('./metrics/collector.js');
    collector = new MetricsCollector();
    collector.pipeline = specialist.pipeline;
    collector.category = category;
    collector.userMessage = message;
    ctx.metricsCollector = collector;
  }

  console.log(`[Dispatch] Pipeline dispatch: "${specialist.pipeline}" for category "${category}"`);

  const pipelineResult = await runPipeline(pipelineDef, ctx);

  // Flush metrics
  if (collector && params.executionMetrics) {
    collector.answer = pipelineResult.answer;
    try {
      collector.flush(params.executionMetrics);
    } catch (err) {
      console.warn(`[Metrics] Failed to flush: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    answer: pipelineResult.answer,
    category,
    classification,
    iterations: pipelineResult.iterations,
    hitMaxIterations: pipelineResult.hitMaxIterations,
    steps: pipelineResult.steps,
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
  _statePreamble?: string,
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
    // Validate sub-task has required shape
    if (typeof task.category !== 'string' || typeof task.message !== 'string') {
      subResults.push('[unknown] Skipped: invalid sub-task format');
      continue;
    }

    // Enforce channel security on LLM-chosen category
    const subChannelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
    if (subChannelSecurity?.allowedCategories && !subChannelSecurity.allowedCategories.includes(task.category)) {
      subResults.push(`[${task.category}] Skipped: category not allowed on this channel`);
      continue;
    }
    const subSenderId = params.sourceContext?.senderId;
    const subIsTrusted = subSenderId !== undefined && (!subChannelSecurity?.trustedUsers || subChannelSecurity.trustedUsers.includes(subSenderId));
    if (!subIsTrusted && subChannelSecurity?.restrictedCategories?.includes(task.category)) {
      subResults.push(`[${task.category}] Skipped: restricted category for untrusted user`);
      continue;
    }

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
  sourceContext?: DispatchParams['sourceContext'],
  isVoice = false,
  statePreamble?: string,
  userPriming?: string,
): Promise<DispatchResult> {
  const chatModel = specialist?.model ?? config.specialists.chat?.model ?? config.router.model;
  const temperature = specialist?.temperature ?? 0.8;
  const maxTokens = specialist?.maxTokens ?? 2048;

  // Inject workspace context — chat gets TOOLS.md for self-awareness
  const workspacePath = resolveWorkspacePath(agentId, config);
  const workspaceContext = getCachedWorkspaceContext(agentId, workspacePath, 'chat', sourceContext?.channel);
  let systemContent = specialist?.systemPrompt ?? 'You are a helpful AI assistant. Respond naturally and concisely.';
  if (workspaceContext) {
    systemContent += '\n\n' + workspaceContext;
  }
  if (sourceContext) {
    systemContent += `\n\nCurrent message context: The user is messaging from channel="${sourceContext.channel}"${sourceContext.guildId ? `, guildId="${sourceContext.guildId}"` : ''}.`;
  }
  if (isVoice) {
    systemContent += '\n\nIMPORTANT: This is a voice conversation. Your response will be spoken aloud via TTS. Keep responses concise. Do NOT use emojis, markdown formatting, bullet points, or special characters — they will be verbalized. Use plain conversational English only.';
  }
  if (statePreamble) {
    systemContent += '\n\n' + statePreamble;
  }
  if (userPriming) {
    systemContent += '\n\n' + userPriming;
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

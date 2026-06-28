import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { Cron } from 'croner';
import type { LocalClawConfig } from './config/types.js';
import type { ChannelAdapterConfig, InboundMessage } from './channels/types.js';
import { OllamaClient } from './ollama/client.js';
import { createInferenceClient } from './ollama/multi-backend.js';
import { ToolRegistry } from './tools/registry.js';
import { ChannelRegistry } from './channels/registry.js';
import { SessionStore } from './sessions/store.js';
import { CronStore } from './cron/store.js';
import { CronService } from './cron/service.js';
import { TaskStore } from './tasks/store.js';
import { dispatchMessage } from './dispatch.js';
import { resolveRoute } from './agents/resolve-route.js';
import { registerAllTools } from './tools/register-all.js';
import { bootstrapWorkspace } from './agents/workspace.js';
import { resolveWorkspacePath } from './agents/scope.js';
import type { EmbeddingStore } from './memory/embeddings.js';
import { FactStore } from './memory/fact-store.js';
import type { FactInput } from './config/types.js';
import { TTSService } from './services/tts.js';
import { STTService } from './services/stt.js';
import { VisionService } from './services/vision.js';
import { saveAttachment } from './services/attachments.js';
import { ollamaUnreachable, toolExecutionError, LocalClawError } from './errors.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { registerAllPipelines } from './pipeline/definitions/index.js';
import { ExecutionMetricsStore } from './metrics/execution-store.js';
import { appendFileSync } from 'node:fs';
import type { ConsoleApiDeps } from './console/types.js';
import { enrichTasks, getAutoActions, filterForModel, formatTaskBoard, enrichCalendarOutput } from './temporal/urgency.js';
import { GraphMemoryStore } from './memory/graph-store.js';
import type { WebApiAdapter } from './channels/web/adapter.js';
// Pipeline utilities kept in src/services/tts-stream.ts for future use with slower TTS models

// Extracted utilities — imported from dedicated modules
import { extractMediaAttachments } from './services/media-extraction.js';
import { stripThinkingTags } from './utils/text.js';
import { splitFinalMessage } from './utils/text.js';
import { extractTrainingPairs } from './learnings/training-collector.js';
import { isCommand, getCommandName } from './commands/router.js';
import { RateLimiter } from './services/rate-limiter.js';
import { MediaDebouncer } from './services/media-debouncer.js';
import { MessageDebouncer } from './services/message-debouncer.js';
import { runHeartbeat } from './services/heartbeat-service.js';
import { runBriefing } from './services/briefing-service.js';

// Rate limiting and media debouncing now handled by extracted services

export class Orchestrator {
  private client: OllamaClient;
  private toolRegistry: ToolRegistry;
  private channelRegistry: ChannelRegistry;
  private sessionStore: SessionStore;
  private cronService?: CronService;
  private ttsService: TTSService;
  private sttService: STTService;
  private visionService: VisionService;
  private config: LocalClawConfig;
  private rateLimiter = new RateLimiter();
  private mediaDebouncer = new MediaDebouncer();
  private messageDebouncer = new MessageDebouncer();
  private heartbeatCron?: Cron;
  private embeddingStore?: EmbeddingStore;
  private factStore?: FactStore;
  private graphMemory?: GraphMemoryStore;
  private taskStore?: TaskStore;
  private pipelineRegistry: PipelineRegistry;
  executionMetrics: ExecutionMetricsStore;

  constructor(config: LocalClawConfig) {
    this.config = config;
    this.client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends);
    this.toolRegistry = new ToolRegistry();
    this.channelRegistry = new ChannelRegistry();
    this.sessionStore = new SessionStore(config.session.transcriptDir);
    this.ttsService = new TTSService(config.tts);
    this.sttService = new STTService(config.stt);
    this.visionService = new VisionService(config.vision, config.ollama.url);
    this.pipelineRegistry = new PipelineRegistry();
    registerAllPipelines(this.pipelineRegistry);
    this.executionMetrics = new ExecutionMetricsStore('data/metrics/execution.db');
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getChannelRegistry(): ChannelRegistry {
    return this.channelRegistry;
  }

  async start(): Promise<void> {
    // Check Ollama
    const available = await this.client.isAvailable();
    if (!available) {
      throw ollamaUnreachable(this.config.ollama.url);
    }

    // Bootstrap workspaces
    for (const agent of this.config.agents.list) {
      const ws = resolveWorkspacePath(agent.id, this.config);
      bootstrapWorkspace(ws, agent.name);
    }

    // Initialize FactStore (legacy) + GraphMemoryStore
    const defaultWorkspacePath = resolveWorkspacePath(this.config.agents.default, this.config);
    this.factStore = new FactStore(defaultWorkspacePath, this.client);

    // Initialize graph memory (FalkorDB) — non-blocking, falls back to FactStore if unavailable
    this.graphMemory = new GraphMemoryStore(this.client, { nerModel: this.config.memory?.nerModel });
    this.graphMemory.connect().then(() => {
      console.log('[Orchestrator] Graph memory connected');
    }).catch(err => {
      console.warn('[Orchestrator] Graph memory unavailable, using flat FactStore:', err instanceof Error ? err.message : err);
      this.graphMemory = undefined;
    });

    // Set up cron service
    if (this.config.cron.enabled) {
      const cronStore = new CronStore(this.config.cron.store);
      this.cronService = new CronService({
        store: cronStore,
        timezone: this.config.timezone,
        onTrigger: async (job) => {
          // No sessionStore — cron runs are stateless so each trigger
          // starts fresh without accumulating history from previous runs
          // If category is "cron" (generic default), let the router classify the message
          // to find the right pipeline. Explicit categories (web_search, research, etc.) are respected.
          const effectiveCategory = job.category === 'cron' ? undefined : job.category;

          const result = await dispatchMessage({
            client: this.client,
            registry: this.toolRegistry,
            config: this.config,
            message: job.message,
            overrideCategory: effectiveCategory,
            cronMode: true,
            pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
            sourceContext: {
              channel: job.delivery.channel,
              channelId: job.delivery.target ?? '',
            },
          });

          if (job.delivery.target) {
            // Extract [FILE:]/[IMAGE:] tokens into real attachments (same as the normal message
            // path) — otherwise a cron that produces a PDF leaks the raw token into the chat text
            // and never delivers the file.
            const media = extractMediaAttachments(result.answer);
            await this.channelRegistry.send(
              { channel: job.delivery.channel, channelId: job.delivery.target },
              {
                text: `[Cron: ${job.name}]\n${media.cleanText || result.answer}`,
                attachments: media.attachments.length > 0 ? media.attachments : undefined,
              },
            );
          }
        },
        onFailure: async (job, error) => {
          if (job.delivery.target) {
            await this.channelRegistry.send(
              { channel: job.delivery.channel, channelId: job.delivery.target },
              { text: `[Cron: ${job.name}] Failed after 3 attempts: ${error}` },
            ).catch((err) => { console.warn('[Cron] Failed to send failure notification:', err instanceof Error ? err.message : err); });
          }
        },
      });
    }

    // Set up task store
    const defaultWorkspace = resolveWorkspacePath(this.config.agents.default, this.config);
    this.taskStore = new TaskStore(
      join(defaultWorkspace, 'tasks.json'),
      join(defaultWorkspace, 'TASKS.md'),
    );
    const taskStore = this.taskStore;

    // Register all tools
    const { embeddingStore } = await registerAllTools(this.toolRegistry, this.config, {
      cronService: this.cronService,
      channelRegistry: this.channelRegistry,
      ollamaClient: this.client,
      taskStore,
      heartbeatConfig: this.config.heartbeat,
      factStore: this.factStore,
      graphMemory: this.graphMemory,
    });
    this.embeddingStore = embeddingStore;

    // Set up message handler
    this.channelRegistry.onMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    // Connect all enabled channels
    const channelConfigs: Record<string, ChannelAdapterConfig> = {};
    for (const [id, cfg] of Object.entries(this.config.channels)) {
      channelConfigs[id] = cfg as ChannelAdapterConfig;
    }
    await this.channelRegistry.connectAll(channelConfigs);

    // Inject console API deps into web adapter
    const webAdapter = this.channelRegistry.get('web') as WebApiAdapter | undefined;
    if (webAdapter?.injectDeps) {
      const consoleDeps: ConsoleApiDeps = {
        config: this.config,
        ollamaClient: this.client,
        toolRegistry: this.toolRegistry,
        channelRegistry: this.channelRegistry,
        sessionStore: this.sessionStore,
        taskStore: this.taskStore!,
        cronService: this.cronService,
        factStore: this.factStore,
        graphMemory: this.graphMemory,
        visionService: this.visionService,
        executionMetrics: this.executionMetrics,
        dispatch: (params) => dispatchMessage({
          client: this.client,
          registry: this.toolRegistry,
          config: this.config,
          pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
          ...params,
        }),
      };
      webAdapter.injectDeps(consoleDeps);
    }

    // Start cron
    if (this.cronService) {
      await this.cronService.start();
    }

    // Set up heartbeat (maintenance only — transcript review, cleanup, promotion)
    if (this.config.heartbeat?.enabled) {
      const hb = this.config.heartbeat;
      this.heartbeatCron = new Cron(hb.schedule, { timezone: this.config.timezone }, async () => {
        await this.runHeartbeat();
      });
      const next = this.heartbeatCron.nextRun();
      console.log(`[Heartbeat] Scheduled (${hb.schedule}) — next run: ${next?.toISOString() ?? 'unknown'}`);

      // Briefings — separate schedule: 8:00am, 1:15pm, 5:00pm
      const briefingSchedule = '0 8 * * *;15 13 * * *;0 17 * * *';
      for (const schedule of briefingSchedule.split(';')) {
        new Cron(schedule.trim(), { timezone: this.config.timezone }, async () => {
          await this.runBriefing();
        });
      }
      console.log('[Briefing] Scheduled at 8:00am, 1:15pm, 5:00pm');
    }

    const models = await this.client.listModels();
    console.log(`[Orchestrator] Models: ${models.length} | Tools: ${this.toolRegistry.list().length} | Channels: ${this.channelRegistry.list().join(', ') || 'none'}`);
    console.log('[Orchestrator] Started');
  }

  async stop(): Promise<void> {
    this.heartbeatCron?.stop();
    this.cronService?.stop();
    this.embeddingStore?.close();
    await this.channelRegistry.disconnectAll();
    console.log('[Orchestrator] Stopped');
  }

  /** Heartbeat — delegates to extracted HeartbeatService */
  private async runHeartbeat(): Promise<void> {
    await runHeartbeat({
      config: this.config,
      client: this.client,
      toolRegistry: this.toolRegistry,
      channelRegistry: this.channelRegistry,
      sessionStore: this.sessionStore,
      factStore: this.factStore,
      graphMemory: this.graphMemory,
      taskStore: this.taskStore,
      cronService: this.cronService,
      extractFacts: this.extractFacts.bind(this),
      reviewTranscripts: this.reviewTranscripts.bind(this),
      promoteRecurringLearnings: this.promoteRecurringLearnings.bind(this),
      cleanupOldMedia: this.cleanupOldMedia.bind(this),
      heartbeatPendingPath: this.heartbeatPendingPath.bind(this),
    });
  }

  /** Briefing — delegates to extracted BriefingService */
  private async runBriefing(): Promise<void> {
    await runBriefing({
      config: this.config,
      client: this.client,
      toolRegistry: this.toolRegistry,
      channelRegistry: this.channelRegistry,
      factStore: this.factStore,
      taskStore: this.taskStore,
    });
  }

  private async extractFacts(
    transcript: import('./sessions/types.js').ConversationTurn[],
    recentlyRemoved?: Array<{ text: string; reason: string }>,
    senderId?: string,
  ): Promise<FactInput[]> {
    const userTurns = transcript.filter(t => t.role === 'user');
    console.log(`[Facts] Transcript has ${transcript.length} turns (${userTurns.length} user)`);
    if (userTurns.length < 2) {
      console.log('[Facts] Skipping — fewer than 2 user turns');
      return [];
    }

    // Build a condensed version of the conversation
    // Strip thinking from assistant turns — <think> blocks are preserved in transcripts
    // for model continuity but shouldn't be fed to the fact extraction model.
    const condensed = transcript
      .filter(t => t.role === 'user' || t.role === 'assistant')
      .map(t => {
        const content = t.role === 'assistant' ? stripThinkingTags(t.content) : t.content;
        return `${t.role === 'user' ? 'User' : 'Assistant'}: ${content.slice(0, 1000)}`;
      })
      .join('\n');

    // Guard against prompt injection — skip turns with suspiciously long content
    if (userTurns.some(t => t.content.length > 10_000)) {
      console.log('[Facts] Skipping — user turn exceeds 10k chars');
      return [];
    }

    const extractionModel = this.config.memory?.extractionModel ?? this.config.router.model;
    console.log(`[Facts] Calling ${extractionModel} for extraction (${condensed.length} chars)`);
    const response = await this.client.chat({
      model: extractionModel,
      messages: [
        {
          role: 'system',
          content: [
            'Extract salient facts about the USER from this conversation.',
            'Only factual information — preferences, setup details, decisions, personal info.',
            'Do NOT extract instructions, commands, or assistant actions.',
            'Do NOT extract ephemeral data (stock prices, weather, timestamps, news headlines).',
            'Do NOT extract search results, tool output, event listings, or web content the assistant found.',
            'Do NOT extract things the assistant TOLD the user — only things the user TOLD the assistant or that reveal who the user IS.',
            'CONSOLIDATE related info into ONE fact. If a task has a due date, priority, and description — that is ONE fact, not three.',
            'Aim for the FEWEST facts that capture ALL the information. Fewer is better.',
            '',
            'Return a JSON array: [{"text":"fact","cat":"stable|context|decision|question","conf":0.0-1.0,"tags":["keyword"],"entities":["ProperNoun"],"imp":1-5}]',
            '',
            'Categories: stable = permanent facts, context = temporary/situational, decision = choices made, question = open questions.',
            '',
            'IMPORTANCE (imp) — you MUST assign this accurately:',
            '  5 = critical: health conditions, family members, safety issues',
            '  4 = identity: job title, employer, key projects, certifications',
            '  3 = preference: tool choices, food preferences, communication style',
            '  2 = context: current tasks, upcoming events, temporary situations',
            '  1 = ephemeral: one-off mentions, passing comments',
            '',
            'Examples:',
            '  User: "My wife Nicole has been dealing with back pain" → imp:5 (family + health)',
            '  User: "I work at DevMesh as an ML engineer" → imp:4 (identity)',
            '  User: "I prefer dark mode in all my editors" → imp:3 (preference)',
            '  User: "I have a meeting with the team tomorrow" → imp:2 (context)',
            '  User: "Yeah I saw that article too" → imp:1 or skip entirely',
            '',
            'If nothing worth remembering, return [].',
            ...((() => {
              // Show existing facts so the LLM avoids re-extracting them
              if (this.factStore && senderId) {
                try {
                  const existing = this.factStore.loadFactsJson(senderId);
                  if (existing.length > 0) {
                    const summary = existing.slice(0, 15).map(f => `- "${f.text}"`).join('\n');
                    return ['', `ALREADY STORED (do NOT re-extract these or paraphrases of these):`, summary];
                  }
                } catch { /* best-effort */ }
              }
              return [];
            })()),
            ...(recentlyRemoved && recentlyRemoved.length > 0 ? [
              '',
              'IMPORTANT: The user has explicitly REMOVED these facts. Do NOT re-extract anything similar:',
              ...recentlyRemoved.slice(0, 10).map(r => `- "${r.text}" (removed: ${r.reason})`),
            ] : []),
          ].join('\n'),
        },
        { role: 'user', content: condensed },
      ],
      options: { temperature: 0.1, num_predict: 1024 },
    });

    const raw = response.message.content.trim();
    console.log(`[Facts] Model response: ${raw.slice(0, 300)}`);
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log('[Facts] No JSON array found in response');
        return [];
      }
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      // Support both structured objects and plain strings (backward compat)
      const facts: FactInput[] = parsed
        .filter((f: unknown) => f && (typeof f === 'string' || typeof f === 'object'))
        .map((f: unknown): FactInput => {
          if (typeof f === 'string') {
            return { text: f, category: 'stable', confidence: 0.8, tags: [], entities: [] };
          }
          const obj = f as Record<string, unknown>;
          const tags = Array.isArray(obj.tags)
            ? obj.tags.filter((t: unknown): t is string => typeof t === 'string')
            : [];
          const entities = Array.isArray(obj.entities)
            ? obj.entities.filter((e: unknown): e is string => typeof e === 'string')
            : [];
          return {
            text: String(obj.text ?? ''),
            category: (['stable', 'context', 'decision', 'question'].includes(obj.cat as string)
              ? obj.cat as FactInput['category']
              : 'stable'),
            confidence: typeof obj.conf === 'number' ? Math.min(1, Math.max(0, obj.conf)) : 0.8,
            importance: typeof obj.imp === 'number'
              ? Math.min(5, Math.max(1, Math.round(obj.imp)))
              : (console.warn(`[Facts] Missing imp for "${String(obj.text).slice(0, 50)}" — defaulting to 2`), 2),
            tags,
            entities,
          };
        })
        .filter(f => f.text.length > 0);

      console.log(`[Facts] Extracted ${facts.length} fact(s)`);
      return facts;
    } catch {
      console.warn('[Facts] Failed to parse model response as JSON');
      return [];
    }
  }

  private pendingPath(workspacePath: string, senderId: string): string {
    return join(workspacePath, 'memory', senderId, 'pending.json');
  }

  private heartbeatPendingPath(workspacePath: string, senderId: string): string {
    return join(workspacePath, 'memory', senderId, 'heartbeat-pending.json');
  }

  /**
   * Review recent session transcripts and extract facts via FactStore.
   * Called by the heartbeat — autonomous, no user approval needed.
   */
  /**
   * Scan error store for recurring patterns (3+ occurrences) and promote
   * them to LEARNINGS.md in the workspace root for injection into context.
   */
  /** Delete generated media files older than 7 days. Returns count of files removed. */
  private cleanupOldMedia(): number {
    const MEDIA_DIRS = ['data/media/documents', 'data/media/browser'];
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    let removed = 0;

    for (const dir of MEDIA_DIRS) {
      if (!existsSync(dir)) continue;
      try {
        for (const file of readdirSync(dir)) {
          const filePath = join(dir, file);
          try {
            const stat = statSync(filePath);
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
              unlinkSync(filePath);
              removed++;
            }
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }
    }

    // Also clean old research HTML files (not the workspace, just research output)
    const researchDir = 'data/workspaces/main/research';
    if (existsSync(researchDir)) {
      try {
        for (const entry of readdirSync(researchDir)) {
          const entryPath = join(researchDir, entry);
          try {
            const stat = statSync(entryPath);
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
              unlinkSync(entryPath);
              removed++;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    return removed;
  }

  private async promoteRecurringLearnings(workspacePath: string): Promise<number> {
    try {
      const { ErrorLearningStore } = await import('./learnings/error-store.js');
      const store = new ErrorLearningStore(workspacePath);
      const entries = store.loadAll();
      if (entries.length === 0) return 0;

      // Group by tool + normalized error prefix (first 60 chars)
      const groups = new Map<string, { tool: string; error: string; count: number }>();
      for (const e of entries) {
        const key = `${e.tool}:${e.error.slice(0, 60).toLowerCase().trim()}`;
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
        } else {
          groups.set(key, { tool: e.tool, error: e.error.slice(0, 150), count: 1 });
        }
      }

      // Filter to patterns with 3+ occurrences
      const recurring = [...groups.values()].filter(g => g.count >= 3);
      if (recurring.length === 0) return 0;

      // Read existing LEARNINGS.md for dedup
      const learningsPath = join(workspacePath, 'LEARNINGS.md');
      let existing = '';
      try { existing = readFileSync(learningsPath, 'utf-8'); } catch { /* doesn't exist yet */ }

      const newLines: string[] = [];
      for (const r of recurring) {
        const line = `- **${r.tool}**: ${r.error} (${r.count}x)`;
        // Dedup: skip if tool+error prefix already in file
        if (existing.includes(r.tool) && existing.includes(r.error.slice(0, 40))) continue;
        newLines.push(line);
      }

      if (newLines.length === 0) return 0;

      const content = existing
        ? existing.trimEnd() + '\n' + newLines.join('\n') + '\n'
        : `# Learnings\n\nRecurring error patterns promoted from tool execution history.\n\n${newLines.join('\n')}\n`;

      writeFileSync(learningsPath, content);
      return newLines.length;
    } catch (err) {
      console.warn('[Heartbeat] Learning promotion failed:', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  private async reviewTranscripts(workspacePath: string, agentId: string): Promise<FactInput[]> {
    const sessionsDir = join(this.config.session.transcriptDir, agentId);
    if (!existsSync(sessionsDir)) return [];

    // Load last review timestamp
    const markerPath = join(workspacePath, 'memory', 'last-review.json');
    let lastReviewAt = 0;
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      lastReviewAt = new Date(marker.reviewedAt).getTime();
    } catch { /* first run */ }

    // Find session files modified since last review
    const sessionFiles = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json') && !f.endsWith('.summary.json'));

    const allFacts: FactInput[] = [];

    for (const file of sessionFiles) {
      const filePath = join(sessionsDir, file);
      const stat = statSync(filePath);
      if (stat.mtimeMs <= lastReviewAt) continue;

      // Extract senderId from session filename (format: agentId:channel:...:senderId.json)
      const sessionKey = file.replace(/\.json$/, '');
      const parts = sessionKey.split(':');
      const senderId = parts.length > 0 ? parts[parts.length - 1] : 'unknown';

      try {
        const data = readFileSync(filePath, 'utf-8');
        const transcript = JSON.parse(data) as import('./sessions/types.js').ConversationTurn[];
        if (!Array.isArray(transcript) || transcript.length === 0) continue;

        // Load recently-removed facts to suppress re-extraction
        const recentlyRemoved = this.factStore?.loadRecentlyRemoved(senderId) ?? [];
        const facts = await this.extractFacts(transcript, recentlyRemoved, senderId);
        if (facts.length > 0) {
          allFacts.push(...facts);
          console.log(`[Heartbeat] Extracted ${facts.length} facts from ${file} (user: ${senderId})`);

          // Write through FactStore (flat) + GraphMemory (graph)
          if (this.factStore) {
            await this.factStore.writeFactsBatch(facts, senderId, `session/${file}`);
            this.factStore.rebuildFacts(senderId);
          }
          if (this.graphMemory) {
            for (const fact of facts) {
              try {
                await this.graphMemory.addFact(fact, senderId, sessionKey);
              } catch (err) {
                console.warn(`[Heartbeat] Graph write failed for "${fact.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
              }
            }
          }
        }
      } catch {
        // Skip unreadable/corrupt transcripts
      }
    }

    // Update marker
    mkdirSync(join(workspacePath, 'memory'), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ reviewedAt: new Date().toISOString() }));

    return allFacts;
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    // Media debounce: batch rapid media-only messages from the same sender
    if (this.mediaDebouncer.tryBatch(msg, (batchedMsg) => this.handleMessage(batchedMsg))) {
      return; // Message collected, waiting for batch timer
    }

    // Text debounce: reassemble a long paste that the channel split into multiple messages,
    // so it routes as ONE job instead of scattering across categories.
    if (this.messageDebouncer.tryBatch(msg, (batchedMsg) => this.handleMessage(batchedMsg))) {
      return;
    }

    if (this.rateLimiter.isLimited(msg.senderId)) {
      console.log(`[Orchestrator] Rate limited: ${msg.senderId}`);
      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'You\'re sending messages too quickly. Please wait a moment.' },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send rate-limit notice:', err instanceof Error ? err.message : err);
      });
      return;
    }

    // Handle slash commands
    const trimmed = msg.content.trim().toLowerCase();
    if (trimmed === '!new' || trimmed === '!reset') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);

      // Load transcript BEFORE clearing
      const transcript = this.sessionStore.loadTranscript(route.agentId, route.sessionKey);

      // Preserve training data before clearing
      try { extractTrainingPairs(transcript); } catch { /* best-effort */ }

      this.sessionStore.clearSession(route.agentId, route.sessionKey);

      // Clear frozen workspace snapshot so next dispatch loads fresh context
      const { clearWorkspaceCache, clearCompactionCache } = await import('./dispatch.js');
      clearWorkspaceCache(route.sessionKey);
      clearCompactionCache(route.agentId, route.sessionKey);

      // Extract facts from the conversation
      let replyText = 'Session cleared. Starting fresh!';
      try {
        const facts = await this.extractFacts(transcript, undefined, msg.senderId);
        if (facts.length > 0) {
          const userMemDir = join(workspacePath, 'memory', msg.senderId);
          mkdirSync(userMemDir, { recursive: true });
          const pending = {
            extractedAt: new Date().toISOString(),
            channel: msg.channel,
            channelId: msg.channelId,
            senderId: msg.senderId,
            facts,
          };
          writeFileSync(this.pendingPath(workspacePath, msg.senderId), JSON.stringify(pending, null, 2));
          const factList = facts.map((f, i) => `${i + 1}. [${f.category}] ${f.text} (conf: ${f.confidence})`).join('\n');
          replyText = `Session cleared. I noticed some things worth remembering:\n\n${factList}\n\nReply **!save** to keep or **!discard** to skip.`;
        }
      } catch (err) {
        console.warn('[Orchestrator] Fact extraction failed:', err instanceof Error ? err.message : err);
      }

      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: replyText },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send session-reset reply:', err instanceof Error ? err.message : err);
      });
      return;
    }

    if (trimmed === '!save') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);
      const pendingFile = this.pendingPath(workspacePath, msg.senderId);

      let replyText: string;
      try {
        const raw = readFileSync(pendingFile, 'utf-8');
        const pending = JSON.parse(raw) as { facts: FactInput[]; senderId?: string };
        const senderId = pending.senderId ?? msg.senderId;

        // Write through FactStore (flat) + GraphMemory (graph)
        if (this.factStore) {
          await this.factStore.writeFactsBatch(pending.facts, senderId, 'user/approved');
          this.factStore.rebuildFacts(senderId);
        }
        if (this.graphMemory) {
          for (const fact of pending.facts) {
            try {
              await this.graphMemory.addFact(fact, senderId, route.sessionKey);
            } catch (err) {
              console.warn(`[Facts] Graph write failed for "${fact.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
            }
          }
        }

        // Clean up pending
        unlinkSync(pendingFile);
        replyText = `Saved ${pending.facts.length} fact${pending.facts.length === 1 ? '' : 's'} to memory.`;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          replyText = 'Nothing pending to save.';
        } else {
          console.warn('[Orchestrator] Failed to save facts:', err instanceof Error ? err.message : err);
          replyText = 'Failed to save facts. Try again?';
        }
      }

      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: replyText },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send save reply:', err instanceof Error ? err.message : err);
      });
      return;
    }

    if (trimmed === '!discard') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);
      const pendingFile = this.pendingPath(workspacePath, msg.senderId);

      let replyText: string;
      try {
        unlinkSync(pendingFile);
        replyText = 'Discarded. Nothing saved.';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          replyText = 'Nothing pending to discard.';
        } else {
          console.warn('[Orchestrator] Failed to discard pending:', err instanceof Error ? err.message : err);
          replyText = 'Failed to discard. Try again?';
        }
      }

      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: replyText },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send discard reply:', err instanceof Error ? err.message : err);
      });
      return;
    }

    // Handle pending file choice (user replies "1" or "2" after text file upload)
    if (trimmed === '1' || trimmed === '2') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);
      const pendingFilePath = join(workspacePath, 'memory', msg.senderId, 'pending-file.json');
      try {
        const raw = readFileSync(pendingFilePath, 'utf-8');
        const pending = JSON.parse(raw) as { filePath: string; filename: string; mimeType: string };
        unlinkSync(pendingFilePath);

        if (trimmed === '1') {
          // Import to knowledge base
          const importTool = this.toolRegistry.get('knowledge_import');
          if (importTool) {
            const result = await importTool.execute({ path: pending.filePath }, {
              agentId: route.agentId,
              sessionKey: route.sessionKey,
              workspacePath,
              senderId: msg.senderId,
            });
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
              { text: `Imported **${pending.filename}** to knowledge base. ${result}` },
            );
          } else {
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
              { text: 'Knowledge import tool not available.' },
            );
          }
        } else {
          // Read as text and inject into next message context
          const { readFileSync: readFs } = await import('node:fs');
          const content = readFs(pending.filePath, 'utf-8');
          const preview = content.length > 5000 ? content.slice(0, 5000) + '\n... [truncated]' : content;
          msg.content = `[File content: ${pending.filename}]\n\n${preview}\n\nUser message: ${msg.content}`;
          // Fall through to normal dispatch below
        }
        if (trimmed === '1') return;
      } catch {
        // No pending file — treat as normal message, fall through
      }
    }

    if (trimmed === '!cleanup') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);

      const cleanupTool = this.toolRegistry.get('memory_cleanup');
      if (!cleanupTool) {
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: 'Memory cleanup tool not available.' },
        ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });
        return;
      }

      try {
        const result = await cleanupTool.execute({}, {
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          workspacePath,
          senderId: msg.senderId,
        });
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: result },
        ).catch((err) => {
          console.warn('[Orchestrator] Failed to send cleanup reply:', err instanceof Error ? err.message : err);
        });
      } catch (err) {
        console.warn('[Orchestrator] Cleanup failed:', err instanceof Error ? err.message : err);
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: 'Memory cleanup failed. Try again later.' },
        ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });
      }
      return;
    }

    if (trimmed.startsWith('!heartbeat')) {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);
      const reviewFile = this.heartbeatPendingPath(workspacePath, msg.senderId);

      let replyText: string;
      try {
        const raw = readFileSync(reviewFile, 'utf-8');
        const pending = JSON.parse(raw) as {
          type: string;
          facts: Array<{ id: string; text: string; category: string }>;
          senderId: string;
        };

        const args = msg.content.trim().slice('!heartbeat'.length).trim().toLowerCase();

        if (args === 'yes' || args === 'confirm') {
          for (const f of pending.facts) {
            this.factStore?.boostConfidence(f.id, pending.senderId);
          }
          this.factStore?.rebuildFacts(pending.senderId);
          unlinkSync(reviewFile);
          replyText = `Confirmed ${pending.facts.length} fact(s). Confidence boosted.`;

        } else if (args.startsWith('no')) {
          const numMatch = args.match(/no\s+(\d+)/);
          const toRemove = numMatch
            ? [pending.facts[parseInt(numMatch[1]) - 1]].filter(Boolean)
            : pending.facts;

          for (const f of toRemove) {
            this.factStore?.removeFact(f.text.slice(0, 40), pending.senderId);
            this.factStore?.recordRemoval(f.text, 'user_denied', pending.senderId);
          }
          this.factStore?.rebuildFacts(pending.senderId);

          if (numMatch && toRemove.length < pending.facts.length) {
            pending.facts = pending.facts.filter(f => !toRemove.includes(f));
            writeFileSync(reviewFile, JSON.stringify(pending, null, 2));
            replyText = `Removed "${toRemove[0]?.text.slice(0, 60)}". ${pending.facts.length} fact(s) still pending review.`;
          } else {
            unlinkSync(reviewFile);
            replyText = `Removed ${toRemove.length} fact(s) from memory. They won't come back.`;
          }

        } else {
          replyText = 'Usage: **!heartbeat yes** (confirm all), **!heartbeat no** (remove all), or **!heartbeat no 2** (remove #2).';
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          replyText = 'No pending memory review. Wait for the next heartbeat.';
        } else {
          console.warn('[Orchestrator] Heartbeat review failed:', err instanceof Error ? err.message : err);
          replyText = 'Failed to process review. Try again.';
        }
      }

      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: replyText },
      ).catch(err => {
        console.warn('[Orchestrator] Failed to send heartbeat review reply:', err instanceof Error ? err.message : err);
      });
      return;
    }

    if (trimmed === '!promote') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);

      const promoted = await this.promoteRecurringLearnings(workspacePath);
      const replyText = promoted > 0
        ? `Promoted ${promoted} recurring error patterns to LEARNINGS.md.`
        : 'No recurring patterns found to promote (need 3+ occurrences of the same error).';

      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: replyText },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send promote reply:', err instanceof Error ? err.message : err);
      });
      return;
    }

    if (trimmed.startsWith('!forget')) {
      const query = msg.content.trim().slice('!forget'.length).trim();
      if (!query || query.length < 3) {
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: 'Usage: **!forget <search term>** — removes facts containing that text.' },
        ).catch(() => {});
        return;
      }

      let removed = 0;
      // Graph memory
      if (this.graphMemory) {
        try { removed += await this.graphMemory.removeFact(query, msg.senderId); } catch { /* best-effort */ }
      }
      // Flat store
      if (this.factStore) {
        removed += this.factStore.removeFact(query, msg.senderId);
        this.factStore.recordRemoval(query, 'user_denied', msg.senderId);
      }

      const replyText = removed > 0
        ? `Removed ${removed} fact(s) matching "${query}" from memory.`
        : `No facts found matching "${query}". Try a different search term.`;

      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: replyText },
      ).catch(() => {});
      return;
    }

    if (trimmed.startsWith('!research')) {
      const topic = msg.content.trim().slice('!research'.length).trim();

      if (!topic) {
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: 'Usage: `!research <topic>`\n\nExample: `!research AI regulation trends in 2026`\nProduces a researched PDF report.' },
        );
        return;
      }

      const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );

      // Send progress indicator
      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: `🔬 Researching: **${topic}**\nThis may take a few minutes...` },
      ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });

      try {
        const today = new Date().toISOString().split('T')[0];
        const enhancedMessage = `[RESEARCH PIPELINE]\nTopic: ${topic}\nOutput slug: ${slug}\nCurrent date: ${today}\n\nProduce a thorough researched PDF report on this topic using the most recent data available (search for ${new Date().getFullYear()} data first).`;

        const result = await dispatchMessage({
          client: this.client,
          registry: this.toolRegistry,
          config: this.config,
          message: enhancedMessage,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          sessionStore: this.sessionStore,
          overrideCategory: 'research',
          pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
          sourceContext: {
            channel: msg.channel,
            channelId: msg.channelId ?? '',
            guildId: msg.guildId,
            senderId: msg.senderId,
          },
          factStore: this.factStore,
        });

        console.log(`[Orchestrator] Research complete: ${result.category} (${result.iterations} steps)`);

        // Check if a deck was generated
        const deckPath = `research/${slug}.html`;
        const workspacePath = resolveWorkspacePath(route.agentId, this.config);
        const fullDeckPath = join(workspacePath, deckPath);
        const deckExists = existsSync(fullDeckPath);

        let response = result.answer;
        if (deckExists) {
          response += `\n\n📊 **View your deck:** /console/api/files/${deckPath}`;
        }

        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId },
          { text: response },
        );
      } catch (err) {
        const wrapped = err instanceof LocalClawError ? err : new LocalClawError('TOOL_EXECUTION_ERROR', 'Research pipeline failed', err);
        console.error(`[Orchestrator] Research failed: ${wrapped.code}: ${wrapped.message}`);
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId },
          { text: `Research failed: ${wrapped.message}` },
        ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });
      }
      return;
    }

    // STT pre-processing: transcribe voice messages to text
    const hadAudio = !!msg.audio;
    if (msg.audio && this.sttService.enabled) {
      const transcription = await this.sttService.transcribe(msg.audio.data, msg.audio.mimeType);
      if (transcription) {
        console.log(`[Orchestrator] STT transcribed: "${transcription.slice(0, 80)}${transcription.length > 80 ? '...' : ''}"`);
        msg.content = transcription;
        msg.onProgress?.('stt', { transcript: transcription });
      } else {
        console.warn('[Orchestrator] STT transcription failed, using original content');
      }
    }

    // Attachment pre-processing: save files, route by file type
    let hasImageAttachment = false;
    let fileOverrideCategory: string | undefined;
    const DATA_EXTENSIONS = new Set(['csv', 'xlsx', 'xls', 'json', 'tsv']);
    const TEXT_EXTENSIONS = new Set(['md', 'txt', 'html', 'htm', 'log', 'xml', 'yaml', 'yml']);
    const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v']);

    // The user's actual instruction, captured before any attachment text is prepended — used
    // for routing so a document's contents can't hijack keyword/override classification.
    const userCaption = msg.content;

    if (msg.attachments?.length) {
      const prefixes: string[] = [];
      const suffixes: string[] = [];

      for (const att of msg.attachments) {
        const saved = saveAttachment(att, msg.channel, msg.id);
        if (!saved) continue;

        const ext = saved.filename.split('.').pop()?.toLowerCase() ?? '';

        if (saved.isImage) {
          hasImageAttachment = true;
          if (this.visionService.enabled) {
            console.log(`[Orchestrator] Running vision on ${saved.filename} (${att.data.length} bytes, ${att.mimeType})`);
            const description = await this.visionService.describe(att.data, att.mimeType);
            if (description) {
              console.log(`[Orchestrator] Vision result: "${description.slice(0, 100)}..."`);
              prefixes.push(`[The user attached an image. Vision analysis: ${description}]\nUse the above description to answer the user's question about the image.`);
            } else {
              console.log('[Orchestrator] Vision returned null');
              prefixes.push(`[The user attached an image (${saved.filename}) but vision analysis was unavailable.]`);
            }
          } else {
            prefixes.push(`[The user attached an image (${saved.filename}) but vision is not enabled.]`);
          }
        } else if (att.mimeType === 'application/pdf') {
          try {
            const pdfParse = (await import('pdf-parse')).default;
            const pdf = await pdfParse(att.data);
            const text = pdf.text.trim();
            if (text) {
              console.log(`[Orchestrator] Extracted ${text.length} chars from PDF: ${saved.filename}`);
              prefixes.push(`[The user attached a PDF: ${saved.filename}. Extracted text below:]\n\n${text}`);
            } else {
              suffixes.push(`[Attached PDF: ${saved.filename} but no text could be extracted (scanned/image PDF).]`);
            }
          } catch (err) {
            const wrapped = err instanceof LocalClawError ? err : toolExecutionError('pdf-parse', err);
            console.warn(`[Orchestrator] PDF extraction failed for ${saved.filename}: ${wrapped.message}`);
            suffixes.push(`[Attached file: ${saved.localPath}] (${saved.filename}, ${saved.mimeType})`);
          }
        } else if (DATA_EXTENSIONS.has(ext)) {
          // Data files → analytics pipeline
          console.log(`[Orchestrator] Data file detected: ${saved.filename} → analytics`);
          fileOverrideCategory = 'analytics';
          prefixes.push(`[The user uploaded a data file for analysis: ${saved.localPath}] (${saved.filename})`);
          // Store file path for the analytics pipeline to pick up
          msg.content = msg.content || `Analyze this ${ext.toUpperCase()} file`;
          msg.content += `\n[DATA_FILE:${saved.localPath}]`;
        } else if (TEXT_EXTENSIONS.has(ext) || ext === 'docx') {
          // Text-based files → ask user what to do
          console.log(`[Orchestrator] Text file detected: ${saved.filename} — asking user`);
          await this.channelRegistry.send(
            { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
            { text: `I received **${saved.filename}**. Would you like me to:\n1. **Import** it to the knowledge base (searchable across sessions)\n2. **Read** it as text for this conversation\n\nReply **1** or **2**.` },
          );
          // Store pending file choice (similar to !save pending)
          const pendingDir = join(resolveWorkspacePath(this.config.agents.default, this.config), 'memory', msg.senderId);
          mkdirSync(pendingDir, { recursive: true });
          writeFileSync(join(pendingDir, 'pending-file.json'), JSON.stringify({
            filePath: saved.localPath,
            filename: saved.filename,
            mimeType: saved.mimeType,
            channel: msg.channel,
            channelId: msg.channelId,
          }));
          return; // Wait for user's reply
        } else if (VIDEO_EXTENSIONS.has(ext) || att.mimeType.startsWith('video/')) {
          // Videos: save but don't process (no video analysis pipeline yet)
          const sizeMB = (att.size / (1024 * 1024)).toFixed(1);
          console.log(`[Orchestrator] Video saved: ${saved.filename} (${sizeMB} MB)`);
          suffixes.push(`[The user sent a video: ${saved.filename} (${sizeMB} MB). The video has been saved but video analysis is not currently available.]`);
        } else {
          suffixes.push(`[Attached file: ${saved.localPath}] (${saved.filename}, ${saved.mimeType})`);
        }
      }

      if (prefixes.length > 0) {
        msg.content = prefixes.join('\n\n') + '\n\n' + msg.content;
      }
      if (suffixes.length > 0) {
        msg.content = msg.content + '\n' + suffixes.join('\n');
      }
    }

    const route = resolveRoute(
      {
        channel: msg.channel,
        senderId: msg.senderId,
        guildId: msg.guildId,
        channelId: msg.channelId,
      },
      this.config,
    );

    console.log(`[Orchestrator] ${msg.senderName ?? msg.senderId} → agent:${route.agentId} (${route.matchedBy})`);

    try {
      const format = this.config.tts.format;
      const mimeMap: Record<string, string> = { opus: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg' };
      const audioMime = mimeMap[format] ?? 'audio/ogg';

      // Detect confirmation follow-up (user confirming a pending destructive tool action)
      const isConfirmation = /^(confirm|yes,?\s*do it|approved?|go ahead|proceed)\s*[.!]?$/i.test(trimmed);

      // Browser extension injects [PAGE:] context — route to chat, content is already in the message
      const fromExtension = msg.content.includes('[PAGE:');
      if (fromExtension) {
        console.log('[Orchestrator] Browser extension context detected → chat');
      }

      const dispatchBase = {
        client: this.client,
        registry: this.toolRegistry,
        config: this.config,
        message: msg.content,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionStore: this.sessionStore,
        pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
        classifyText: userCaption,
        ...(fromExtension ? { overrideCategory: 'chat' as const }
          : hasImageAttachment ? { overrideCategory: 'chat' as const }
          : fileOverrideCategory ? { overrideCategory: fileOverrideCategory }
          : {}),
        ...(isConfirmation ? { confirmed: true } : {}),
        sourceContext: {
          channel: msg.channel,
          channelId: msg.channelId ?? '',
          guildId: msg.guildId,
          senderId: msg.senderId,
        },
        modelOverride: hadAudio ? this.config.voice.model : undefined,
        factStore: this.factStore,
        graphMemory: this.graphMemory,
      };

      // Voice path: single-shot TTS on full response
      if (hadAudio && this.ttsService.enabled) {
        msg.onProgress?.('thinking');

        const result = await dispatchMessage({ ...dispatchBase });

        console.log(`[Orchestrator] → ${result.category} (${result.iterations} steps, voice)`);

        msg.onProgress?.('tts');
        const audioBuffer = await this.ttsService.synthesize(result.answer);
        const target = { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId, replyToId: msg.id };

        if (audioBuffer) {
          console.log(`[Orchestrator] TTS: ${audioBuffer.length} bytes`);
          await this.channelRegistry.send(target, { text: result.answer, audio: { data: audioBuffer, mimeType: audioMime } });
        } else {
          console.warn('[Orchestrator] TTS synthesis failed');
          await this.channelRegistry.send(target, { text: result.answer });
        }
      } else {
        // Non-voice path: Discord text streaming (existing behavior)
        let streamMsg: any = null;
        let streamBuffer = '';
        let lastEditAt = 0;
        const EDIT_THROTTLE_MS = 1000;

        const onStream = async (delta: string) => {
          streamBuffer += delta;
          const now = Date.now();
          if (now - lastEditAt < EDIT_THROTTLE_MS) return;
          lastEditAt = now;

          try {
            if (!streamMsg) {
              const adapter = this.channelRegistry.get(msg.channel);
              if (adapter && 'getClient' in adapter) {
                const client = (adapter as any).getClient();
                const ch = await client?.channels.fetch(msg.channelId);
                if (ch && 'send' in ch) {
                  const initContent = streamBuffer.length > 1990
                    ? streamBuffer.slice(0, 1990) + ' ...'
                    : streamBuffer + ' ...';
                  streamMsg = await (ch as any).send({
                    content: initContent,
                    reply: { messageReference: msg.id },
                  });
                }
              }
            } else {
              // Discord message limit is 2000 chars — truncate stream preview
              const preview = streamBuffer.length > 1990
                ? streamBuffer.slice(0, 1990) + ' ...'
                : streamBuffer + ' ...';
              await streamMsg.edit(preview);
            }
          } catch (err) {
            console.warn('[Orchestrator] Stream edit failed:', err instanceof Error ? err.message : err);
          }
        };

        msg.onProgress?.('thinking');

        // Step-wise progress: long pipelines emit milestone notes; surface each as its own message
        // so the channel doesn't look dead during multi-minute runs. Fire-and-forget, never blocks.
        const onProgress = (note: string) => {
          this.channelRegistry
            .send({ channel: msg.channel, channelId: msg.channelId! }, { text: note })
            .catch(err => console.warn('[Orchestrator] Progress send failed:', err instanceof Error ? err.message : err));
        };

        const result = await dispatchMessage({ ...dispatchBase, onStream, onProgress });

        console.log(`[Orchestrator] → ${result.category} (${result.iterations} steps)`);

        if (streamMsg) {
          const media = extractMediaAttachments(result.answer);
          const chunks = splitFinalMessage(media.cleanText || result.answer, 2000);
          // Always do final edit — stream preview has " ..." suffix that needs to be replaced
          await streamMsg.edit(chunks[0]);
          if (chunks.length > 1) {
            for (let i = 1; i < chunks.length; i++) {
              const adapter = this.channelRegistry.get(msg.channel);
              if (adapter) {
                await adapter.send(
                  { channel: msg.channel, channelId: msg.channelId! },
                  { text: chunks[i] },
                );
              }
            }
          }
          // Send image attachments as follow-up (can't attach to edited stream message)
          if (media.attachments.length > 0) {
            const adapter = this.channelRegistry.get(msg.channel);
            if (adapter) {
              await adapter.send(
                { channel: msg.channel, channelId: msg.channelId! },
                { text: '', attachments: media.attachments },
              );
            }
          }
        } else {
          const media = extractMediaAttachments(result.answer);
          const text = media.cleanText || result.answer;
          const chunks = splitFinalMessage(text, 2000);
          const target = { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId, replyToId: msg.id };
          await this.channelRegistry.send(target, {
            text: chunks[0],
            attachments: media.attachments.length > 0 ? media.attachments : undefined,
          });
          for (let i = 1; i < chunks.length; i++) {
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId! },
              { text: chunks[i] },
            );
          }
        }
      }

      // Cross-channel notification: forward WhatsApp conversations to Discord DM
      if (msg.channel === 'whatsapp' && this.config.heartbeat?.delivery) {
        const ownerWhatsAppIds = (this.config.channels?.whatsapp as any)?.security?.trustedUsers as string[] | undefined;
        const isOwner = ownerWhatsAppIds?.includes(msg.senderId);
        if (!isOwner) {
          const { channel: notifyChannel, target: notifyTarget } = this.config.heartbeat.delivery;
          const senderLabel = msg.senderName ?? msg.senderId;
          const preview = msg.content.length > 200 ? msg.content.slice(0, 200) + '...' : msg.content;
          const notification = `📱 **WhatsApp** — ${senderLabel}:\n> ${preview}`;
          try {
            await this.channelRegistry.send(
              { channel: notifyChannel, channelId: notifyTarget },
              { text: notification },
            );
          } catch (notifyErr) {
            console.warn('[Orchestrator] WhatsApp notification failed:', notifyErr instanceof Error ? notifyErr.message : notifyErr);
          }
        }
      }
    } catch (err) {
      const wrapped = err instanceof LocalClawError ? err : new LocalClawError('TOOL_EXECUTION_ERROR', 'Message handling failed', err);
      console.error(`[Orchestrator] ${wrapped.code}: ${wrapped.message}`);
      try {
        await this.channelRegistry.send(
          {
            channel: msg.channel,
            channelId: msg.channelId!,
            guildId: msg.guildId,
            replyToId: msg.id,
          },
          { text: 'Sorry, I encountered an error processing your request.' },
        );
      } catch (sendErr) {
        console.warn('[Orchestrator] Failed to send error response:', sendErr instanceof Error ? sendErr.message : sendErr);
      }
    }
  }
}

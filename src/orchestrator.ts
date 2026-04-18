import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { Cron } from 'croner';
import type { LocalClawConfig } from './config/types.js';
import type { ChannelAdapterConfig, InboundMessage } from './channels/types.js';
import { OllamaClient } from './ollama/client.js';
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
import { saveAttachment, isImageMime } from './services/attachments.js';
import { ollamaUnreachable, toolExecutionError, LocalClawError } from './errors.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { registerAllPipelines } from './pipeline/definitions/index.js';
import { ExecutionMetricsStore } from './metrics/execution-store.js';
import { appendFileSync } from 'node:fs';
import type { ConsoleApiDeps } from './console/types.js';
import type { WebApiAdapter } from './channels/web/adapter.js';
// Pipeline utilities kept in src/services/tts-stream.ts for future use with slower TTS models

const IMAGE_TOKEN_RE = /\[IMAGE:([^\]]+)\]/g;
const FILE_TOKEN_RE = /\[FILE:([^\]]+)\]/g;

/**
 * Extract [IMAGE:path] tokens from text, read files, return attachments + cleaned text.
 */
function extractMediaAttachments(text: string): {
  cleanText: string;
  attachments: Array<{ data: Buffer; mimeType: string; filename: string }>;
} {
  const attachments: Array<{ data: Buffer; mimeType: string; filename: string }> = [];
  const mimeMap: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    csv: 'text/csv', txt: 'text/plain', html: 'text/html',
  };

  let cleanText = text.replace(IMAGE_TOKEN_RE, (match, filePath: string) => {
    try {
      const data = readFileSync(filePath.trim());
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
      attachments.push({ data, mimeType: mimeMap[ext] ?? 'image/png', filename: filePath.split('/').pop() ?? 'image.png' });
      return '';
    } catch { return match; }
  });

  cleanText = cleanText.replace(FILE_TOKEN_RE, (match, filePath: string) => {
    try {
      const data = readFileSync(filePath.trim());
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
      attachments.push({ data, mimeType: mimeMap[ext] ?? 'application/octet-stream', filename: filePath.split('/').pop() ?? 'file' });
      return '';
    } catch { return match; }
  });

  // Catch document file paths the model may have reformatted (markdown links, plain mentions)
  // Matches paths like data/media/documents/name.pdf or absolute paths to media/documents/
  const docPathRe = /(?:\[([^\]]*)\]\([^)]*\)|(?:^|\s))((?:\/[^\s]*|data)\/media\/documents\/[^\s)]+\.(?:pdf|docx|xlsx|pptx|csv))/gim;
  const seenPaths = new Set(attachments.map(a => a.filename));
  for (const m of cleanText.matchAll(docPathRe)) {
    const filePath = (m[2] || '').trim();
    const filename = filePath.split('/').pop() ?? 'file';
    if (seenPaths.has(filename)) continue;
    try {
      const data = readFileSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
      attachments.push({ data, mimeType: mimeMap[ext] ?? 'application/octet-stream', filename });
      seenPaths.add(filename);
      // Strip the markdown link or path reference from text
      cleanText = cleanText.replace(m[0], '').trim();
    } catch { /* file doesn't exist at this path */ }
  }

  cleanText = cleanText.trim();

  return { cleanText, attachments };
}

/** Append (message, category) training pairs from a transcript before it's cleared. */
function extractTrainingPairs(transcript: Array<{ role: string; content: string; category?: string }>): void {
  const TRAINING_FILE = 'data/training/router-pairs.jsonl';
  const pairs: string[] = [];

  for (const entry of transcript) {
    if (entry.role !== 'user' || !entry.category || !entry.content?.trim()) continue;
    const content = entry.content.trim();
    // Skip synthetic/system messages
    if (content.startsWith('[RESEARCH PIPELINE]')) continue;
    if (content.startsWith('[DEVMESH')) continue;
    if (content.startsWith('!')) continue;
    if (content.length < 5) continue;

    pairs.push(JSON.stringify({ message: content, category: entry.category }));
  }

  if (pairs.length > 0) {
    mkdirSync('data/training', { recursive: true });
    appendFileSync(TRAINING_FILE, pairs.join('\n') + '\n');
    console.log(`[Training] Extracted ${pairs.length} router pairs before session reset`);
  }
}

function splitFinalMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt === -1 || splitAt < limit / 2) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt === -1 || splitAt < limit / 2) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // max messages per window per user

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
  private rateLimits = new Map<string, number[]>();
  private heartbeatCron?: Cron;
  private embeddingStore?: EmbeddingStore;
  private factStore?: FactStore;
  private taskStore?: TaskStore;
  private pipelineRegistry: PipelineRegistry;
  executionMetrics: ExecutionMetricsStore;

  constructor(config: LocalClawConfig) {
    this.config = config;
    this.client = new OllamaClient(config.ollama.url, config.ollama.keepAlive);
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

    // Initialize FactStore
    const defaultWorkspacePath = resolveWorkspacePath(this.config.agents.default, this.config);
    this.factStore = new FactStore(defaultWorkspacePath);

    // Set up cron service
    if (this.config.cron.enabled) {
      const cronStore = new CronStore(this.config.cron.store);
      this.cronService = new CronService({
        store: cronStore,
        timezone: this.config.timezone,
        onTrigger: async (job) => {
          // No sessionStore — cron runs are stateless so each trigger
          // starts fresh without accumulating history from previous runs
          const result = await dispatchMessage({
            client: this.client,
            registry: this.toolRegistry,
            config: this.config,
            message: job.message,
            overrideCategory: job.category,
            cronMode: true,
            pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
            sourceContext: {
              channel: job.delivery.channel,
              channelId: job.delivery.target ?? '',
            },
          });

          if (job.delivery.target) {
            await this.channelRegistry.send(
              { channel: job.delivery.channel, channelId: job.delivery.target },
              { text: `[Cron: ${job.name}]\n${result.answer}` },
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

  private async runHeartbeat(): Promise<void> {
    const hb = this.config.heartbeat;
    if (!hb) return;

    console.log('[Heartbeat] Running...');

    try {
      const workspacePath = resolveWorkspacePath(this.config.agents.default, this.config);

      // Review recent session transcripts and extract facts
      const extractedFacts = await this.reviewTranscripts(workspacePath, this.config.agents.default);
      if (extractedFacts.length > 0) {
        console.log(`[Heartbeat] Committed ${extractedFacts.length} facts from transcript review`);
      }

      // Promote recurring error patterns to LEARNINGS.md
      const promoted = await this.promoteRecurringLearnings(workspacePath);
      if (promoted > 0) {
        console.log(`[Heartbeat] Promoted ${promoted} learnings from error patterns`);
      }

      // Clean up old generated media files (PDFs, screenshots, research decks)
      const cleaned = this.cleanupOldMedia();
      if (cleaned > 0) {
        console.log(`[Heartbeat] Cleaned up ${cleaned} old media files`);
      }

      // --- Intelligent memory management ---
      const senderId = hb.delivery.target;

      // Auto-expire stale date-referenced facts
      if (this.factStore && senderId) {
        const expired = this.factStore.expireStaleDateFacts(senderId);
        if (expired.length > 0) {
          for (const e of expired) {
            this.factStore.recordRemoval(e.text, 'date_expired', senderId);
          }
          console.log(`[Heartbeat] Auto-expired ${expired.length} stale date-referenced fact(s)`);
        }
      }

      // Select facts for user review (only during waking hours — 8am to 10pm)
      const localHour = parseInt(new Date().toLocaleString('en-US', { timeZone: this.config.timezone, hour: 'numeric', hour12: false }));
      const isWakingHours = localHour >= 8 && localHour <= 22;
      let reviewCandidates: import('./config/types.js').FactEntry[] = [];
      if (this.factStore && senderId && isWakingHours) {
        reviewCandidates = this.factStore.selectReviewCandidates(senderId, 3);
        if (reviewCandidates.length > 0) {
          const pendingReview = {
            type: 'heartbeat_review',
            createdAt: new Date().toISOString(),
            senderId,
            facts: reviewCandidates.map(f => ({ id: f.id, text: f.text, category: f.category })),
          };
          writeFileSync(this.heartbeatPendingPath(workspacePath, senderId), JSON.stringify(pendingReview, null, 2));
        }
      }

      // --- Maintenance tasks ---
      const executor = this.toolRegistry.createExecutor();
      const toolCtx = { agentId: this.config.agents.default, sessionKey: 'heartbeat', workspacePath, senderId: hb.delivery.target };

      // Memory cleanup (best-effort)
      try {
        const cleanupResult = await executor('memory_cleanup', {}, toolCtx);
        if (cleanupResult && !cleanupResult.includes('0 substring') && !cleanupResult.includes('No duplicates')) {
          console.log(`[Heartbeat] Memory cleanup: ${cleanupResult.slice(0, 100)}`);
        }
      } catch { /* best-effort */ }

      // Query heartbeat tasks and dispatch report
      const heartbeatTasks = this.cronService?.listByType('heartbeat') ?? [];

      let taskInstructions: string;
      if (heartbeatTasks.length > 0) {
        taskInstructions = heartbeatTasks
          .map((t, i) => `${i + 1}. **${t.name}**: ${t.message}`)
          .join('\n');
      } else {
        const heartbeatPath = join(workspacePath, 'HEARTBEAT.md');
        try { taskInstructions = readFileSync(heartbeatPath, 'utf-8'); } catch { taskInstructions = ''; }
      }

      if (taskInstructions) {
        const now = new Date();
        const tz = this.config.timezone;
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
        const dayOfWeek = formatter.format(now);
        const dateStr = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

        let currentTasks = '';
        try { currentTasks = readFileSync(join(workspacePath, 'TASKS.md'), 'utf-8'); } catch { /* no tasks file */ }

        const prompt = [
          `Current date/time: ${dateStr} (${dayOfWeek})`,
          `The current YEAR is ${now.getFullYear()}. The current MONTH is ${now.getMonth() + 1}. Use these to determine if dates are past or future.`,
          '',
          'Execute each heartbeat task below using the available tools. Rules:',
          '- Keep each task result SEPARATE with a clear header.',
          '- Report ONLY what the tool returns. Do NOT add commentary, opinions, or suggestions.',
          '- Do NOT create, add, or duplicate tasks. You are READ-ONLY.',
          '- NEVER ask questions. This is a one-way report.',
          '- If cleanup or action is needed, state the command (e.g., "send !cleanup to consolidate").',
          '- A task is overdue ONLY if its due date is BEFORE today.',
          '',
          '## Current Task Board',
          currentTasks || '_Empty_',
          '',
          '## Heartbeat Tasks',
          taskInstructions,
        ].join('\n');

        const result = await dispatchMessage({
          client: this.client,
          registry: this.toolRegistry,
          config: this.config,
          message: prompt,
          overrideCategory: 'multi',
          cronMode: true,
          pipelineRegistry: this.pipelineRegistry,
          executionMetrics: this.executionMetrics,
          sourceContext: hb.delivery.target ? {
            channel: hb.delivery.channel,
            channelId: hb.delivery.target,
            senderId: hb.delivery.target,
          } : undefined,
          factStore: this.factStore,
        });

        console.log(`[Heartbeat] Completed (${result.iterations} steps)`);

        if (hb.delivery.target) {
          let reportText = `**[Heartbeat Report]**\n${result.answer}`;

          // Append memory review section if there are candidates
          if (reviewCandidates.length > 0) {
            const reviewSection = reviewCandidates
              .map((f, i) => `${i + 1}. [${f.category}] "${f.text}"`)
              .join('\n');
            reportText += `\n\n**Memory check** — still accurate?\n${reviewSection}\nReply **!heartbeat yes** to confirm all, or **!heartbeat no 2** to remove #2.`;
          }

          await this.channelRegistry.send(
            { channel: hb.delivery.channel, channelId: hb.delivery.target },
            { text: reportText },
          );
        }
      }

      // Update lastRunAt
      if (this.cronService) {
        for (const task of heartbeatTasks) {
          this.cronService.updateLastRun(task.id);
        }
      }
    } catch (err) {
      const wrapped = err instanceof LocalClawError ? err : new LocalClawError('TOOL_EXECUTION_ERROR', 'Heartbeat failed', err);
      console.error(`[Heartbeat] ${wrapped.code}: ${wrapped.message}`);
    }
  }

  /** Proactive briefing — gathers calendar, tasks, memory and reasons about what matters. */
  private async runBriefing(): Promise<void> {
    const hb = this.config.heartbeat;
    if (!hb?.delivery.target) return;

    const now = new Date();
    const tz = this.config.timezone;
    const localHour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
    const timeOfDay = localHour <= 10 ? 'morning' : localHour <= 16 ? 'afternoon' : 'evening';
    const dateStr = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

    console.log(`[Briefing] Running ${timeOfDay} briefing...`);

    try {
      const workspacePath = resolveWorkspacePath(this.config.agents.default, this.config);
      const executor = this.toolRegistry.createExecutor();
      const toolCtx = { agentId: this.config.agents.default, sessionKey: 'briefing', workspacePath, senderId: hb.delivery.target };

      // Gather context
      let taskBoard = '';
      try { taskBoard = await executor('task_list', {}, toolCtx); } catch { taskBoard = '(could not load tasks)'; }

      let calendar = '';
      try { calendar = await executor('calendar_list', { days: timeOfDay === 'evening' ? 2 : 1 }, toolCtx); } catch { calendar = '(calendar not available)'; }

      let memory = '';
      try { memory = await executor('memory_search', { query: 'recent activity decisions context' }, toolCtx); } catch { memory = '(memory not available)'; }

      // Check for stale facts (non-stable, older than 10 days)
      let staleFacts = '';
      if (this.factStore && hb.delivery.target) {
        try {
          const allFacts = this.factStore.loadFactsJson(hb.delivery.target);
          const now = Date.now();
          const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
          const staleList = allFacts.filter(f => f.category !== 'stable' && (now - new Date(f.createdAt).getTime()) > TEN_DAYS);
          if (staleList.length > 0) {
            staleFacts = staleList.map(f => `- [${f.category}] "${f.text}" (from ${f.createdAt.slice(0, 10)})`).join('\n');
          }
        } catch { /* best-effort */ }
      }

      console.log(`[Briefing] Context: calendar=${calendar.length} chars, tasks=${taskBoard.length} chars, memory=${memory.length} chars`);

      // CoT reasoning pass — use specialist model (not reasoning/thinking model which wraps output in <think> tags)
      const briefingModel = 'qwen3-coder:30b';

      const timeFrames: Record<string, string> = {
        morning: "Focus on today's schedule. What should the user prepare for? Flag early meetings, deadlines, or things that need attention before the day gets busy.",
        afternoon: "Focus on what's left today. Anything urgent that hasn't been addressed? Any prep needed for tomorrow?",
        evening: "Focus on tomorrow. What's coming up? Anything to prep tonight? Flag early morning commitments.",
      };

      const response = await this.client.chat({
        model: briefingModel,
        messages: [{
          role: 'user',
          content: `You are a proactive personal assistant. It is ${dateStr}. This is the ${timeOfDay} check-in.

## Calendar
${calendar}

## Task Board
${taskBoard}

## Recent Memory
${memory}
${staleFacts ? `\n## Stale Context (may be outdated — mention if relevant)\n${staleFacts}` : ''}

Think step by step:
1. Look for facts that are CONNECTED. If two things in the context relate to each other, reason about what that combination means. Don't just list items — think about how they interact and what the implication is for the user.
2. Schedule conflicts or tight transitions?
3. Tasks approaching due dates without progress?
4. Anything that seems off or worth flagging?
5. ${timeFrames[timeOfDay]}

Write a SHORT, useful ${timeOfDay} update. Rules:
- Only surface what MATTERS. Don't list everything.
- Be specific: dates, times, names, locations.
- If nothing notable, say so in one sentence.
- NEVER ask questions. This is a one-way notification.
- Plain language, conversational tone. No headers or heavy formatting.
- If cleanup or action is needed, state the command.
- Your response should be at least 2-3 sentences. If there's genuinely nothing to report, explain why (e.g., "No events today, task board is clear, nothing flagged in memory.").
- After your reasoning, write your final update OUTSIDE of any think tags.`,
        }],
        options: { temperature: 0.6, num_predict: 1024 },
      });

      const raw = response.message?.content ?? '';
      // Extract content after </think> if present, otherwise use full response
      let insight: string;
      const thinkEnd = raw.indexOf('</think>');
      if (thinkEnd !== -1) {
        insight = raw.slice(thinkEnd + '</think>'.length).trim();
      } else {
        insight = raw.replace(/<think>[\s\S]*$/g, '').trim(); // unclosed think tag — take what's before it
      }
      // If still empty, the model put everything in think tags — extract the reasoning as the output
      if (!insight && raw.includes('<think>')) {
        insight = raw.replace(/<\/?think>/g, '').trim();
        console.log(`[Briefing] Model put everything in <think> tags — extracting reasoning as output`);
      }
      console.log(`[Briefing] ${timeOfDay} complete (${insight.length} chars)`);

      if (insight) {
        await this.channelRegistry.send(
          { channel: hb.delivery.channel, channelId: hb.delivery.target },
          { text: insight },
        );
      }
    } catch (err) {
      console.warn('[Briefing] Failed:', err instanceof Error ? err.message : err);
    }
  }

  private async extractFacts(
    transcript: import('./sessions/types.js').ConversationTurn[],
    recentlyRemoved?: Array<{ text: string; reason: string }>,
  ): Promise<FactInput[]> {
    const userTurns = transcript.filter(t => t.role === 'user');
    console.log(`[Facts] Transcript has ${transcript.length} turns (${userTurns.length} user)`);
    if (userTurns.length < 2) {
      console.log('[Facts] Skipping — fewer than 2 user turns');
      return [];
    }

    // Build a condensed version of the conversation
    const condensed = transcript
      .filter(t => t.role === 'user' || t.role === 'assistant')
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 1000)}`)
      .join('\n');

    // Guard against prompt injection — skip turns with suspiciously long content
    if (userTurns.some(t => t.content.length > 10_000)) {
      console.log('[Facts] Skipping — user turn exceeds 10k chars');
      return [];
    }

    console.log(`[Facts] Calling ${this.config.router.model} for extraction (${condensed.length} chars)`);
    const response = await this.client.chat({
      model: this.config.router.model,
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
            'Return a JSON array: [{"text":"fact","cat":"stable|context|decision|question","conf":0.0-1.0,"tags":["keyword"],"entities":["ProperNoun"]}]',
            'Categories: stable = permanent facts (name, location, job, preferences), context = temporary/situational, decision = choices the user made, question = open questions.',
            'If nothing worth remembering, return [].',
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
        const facts = await this.extractFacts(transcript, recentlyRemoved);
        if (facts.length > 0) {
          allFacts.push(...facts);
          console.log(`[Heartbeat] Extracted ${facts.length} facts from ${file} (user: ${senderId})`);

          // Write through FactStore
          if (this.factStore) {
            this.factStore.writeFactsBatch(facts, senderId, `session/${file}`);
            this.factStore.rebuildFacts(senderId);
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

  private isRateLimited(userId: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimits.get(userId) ?? [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    this.rateLimits.set(userId, recent);
    return recent.length > RATE_LIMIT_MAX;
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    if (this.isRateLimited(msg.senderId)) {
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
      const { clearWorkspaceCache } = await import('./dispatch.js');
      clearWorkspaceCache(route.sessionKey);

      // Extract facts from the conversation
      let replyText = 'Session cleared. Starting fresh!';
      try {
        const facts = await this.extractFacts(transcript);
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

        // Write through FactStore
        if (this.factStore) {
          this.factStore.writeFactsBatch(pending.facts, senderId, 'user/approved');
          this.factStore.rebuildFacts(senderId);
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
        ).catch(() => {});
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
        ).catch(() => {});
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

    if (trimmed.startsWith('!research')) {
      const rawArgs = msg.content.trim().slice('!research'.length).trim();

      // Parse --type flag
      const typeMatch = rawArgs.match(/^--(\w+)\s+/);
      const validTypes = ['deck', 'brief', 'deepdive', 'market', 'teardown', 'memo', 'report'];
      const artifactType = typeMatch && validTypes.includes(typeMatch[1]) ? typeMatch[1] : 'memo';
      const topic = typeMatch ? rawArgs.slice(typeMatch[0].length).trim() : rawArgs;

      if (!topic) {
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: 'Usage: `!research [--deck|--brief|--deepdive|--market|--teardown|--memo|--report] <topic>`\n\nExample: `!research --report AI regulation trends`' },
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
        { text: `🔬 Researching: **${topic}** (${artifactType})\nThis may take a few minutes...` },
      ).catch(() => {});

      try {
        const today = new Date().toISOString().split('T')[0];
        const enhancedMessage = `[RESEARCH PIPELINE]\nArtifact type: ${artifactType}\nTopic: ${topic}\nOutput slug: ${slug}\nCurrent date: ${today}\n\nProduce a research deck on this topic using the MOST RECENT data available. Search for ${new Date().getFullYear()} data first. Follow your pipeline stages exactly.`;

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
        ).catch(() => {});
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

    // Attachment pre-processing: save files, run vision on images
    let hasImageAttachment = false;
    if (msg.attachments?.length) {
      const prefixes: string[] = [];
      const suffixes: string[] = [];

      for (const att of msg.attachments) {
        const saved = saveAttachment(att, msg.channel, msg.id);
        if (!saved) continue;

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
        ...(hasImageAttachment ? { overrideCategory: 'chat' as const } : {}),
        ...(isConfirmation ? { confirmed: true } : {}),
        sourceContext: {
          channel: msg.channel,
          channelId: msg.channelId ?? '',
          guildId: msg.guildId,
          senderId: msg.senderId,
        },
        modelOverride: hadAudio ? this.config.voice.model : undefined,
        factStore: this.factStore,
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
                  streamMsg = await (ch as any).send({
                    content: streamBuffer + ' ...',
                    reply: { messageReference: msg.id },
                  });
                }
              }
            } else {
              await streamMsg.edit(streamBuffer + ' ...');
            }
          } catch (err) {
            console.warn('[Orchestrator] Stream edit failed:', err instanceof Error ? err.message : err);
          }
        };

        msg.onProgress?.('thinking');

        const result = await dispatchMessage({ ...dispatchBase, onStream });

        console.log(`[Orchestrator] → ${result.category} (${result.iterations} steps)`);

        if (streamMsg) {
          const media = extractMediaAttachments(result.answer);
          const chunks = splitFinalMessage(media.cleanText || result.answer, 2000);
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
          await this.channelRegistry.send(
            { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId, replyToId: msg.id },
            { text: media.cleanText || result.answer, attachments: media.attachments.length > 0 ? media.attachments : undefined },
          );
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

import { join } from 'node:path';
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
import { TTSService } from './services/tts.js';
import { STTService } from './services/stt.js';
import { VisionService } from './services/vision.js';
import { saveAttachment, isImageMime } from './services/attachments.js';

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
const VOICE_MODEL = 'qwen2.5:7b'; // Fast model for voice-originated messages

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

  constructor(config: LocalClawConfig) {
    this.config = config;
    this.client = new OllamaClient(config.ollama.url, config.ollama.keepAlive);
    this.toolRegistry = new ToolRegistry();
    this.channelRegistry = new ChannelRegistry();
    this.sessionStore = new SessionStore(config.session.transcriptDir);
    this.ttsService = new TTSService(config.tts);
    this.sttService = new STTService(config.stt);
    this.visionService = new VisionService(config.vision, config.ollama.url);
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
      console.error(`[Orchestrator] Cannot reach Ollama at ${this.config.ollama.url}`);
      throw new Error('Ollama unreachable');
    }

    // Bootstrap workspaces
    for (const agent of this.config.agents.list) {
      const ws = resolveWorkspacePath(agent.id, this.config);
      bootstrapWorkspace(ws, agent.name);
    }

    // Set up cron service
    if (this.config.cron.enabled) {
      const cronStore = new CronStore(this.config.cron.store);
      this.cronService = new CronService({
        store: cronStore,
        onTrigger: async (job) => {
          const result = await dispatchMessage({
            client: this.client,
            registry: this.toolRegistry,
            config: this.config,
            message: job.message,
            overrideCategory: job.category,
            sessionStore: this.sessionStore,
          });

          if (job.delivery.target) {
            await this.channelRegistry.send(
              { channel: job.delivery.channel, channelId: job.delivery.target },
              { text: `[Cron: ${job.name}]\n${result.answer}` },
            );
          }
        },
      });
    }

    // Set up task store
    const defaultWorkspace = resolveWorkspacePath(this.config.agents.default, this.config);
    const taskStore = new TaskStore(
      join(defaultWorkspace, 'tasks.json'),
      join(defaultWorkspace, 'TASKS.md'),
    );

    // Register all tools
    await registerAllTools(this.toolRegistry, this.config, {
      cronService: this.cronService,
      channelRegistry: this.channelRegistry,
      ollamaClient: this.client,
      taskStore,
    });

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

    // Start cron
    if (this.cronService) {
      await this.cronService.start();
    }

    const models = await this.client.listModels();
    console.log(`[Orchestrator] Models: ${models.length} | Tools: ${this.toolRegistry.list().length} | Channels: ${this.channelRegistry.list().join(', ') || 'none'}`);
    console.log('[Orchestrator] Started');
  }

  async stop(): Promise<void> {
    this.cronService?.stop();
    await this.channelRegistry.disconnectAll();
    console.log('[Orchestrator] Stopped');
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
      ).catch(() => {});
      return;
    }

    // Handle slash commands
    const trimmed = msg.content.trim().toLowerCase();
    if (trimmed === '!new' || trimmed === '!reset') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      this.sessionStore.clearSession(route.agentId, route.sessionKey);
      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'Session cleared. Starting fresh!' },
      ).catch(() => {});
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
    if (msg.attachments?.length) {
      const prefixes: string[] = [];
      const suffixes: string[] = [];

      for (const att of msg.attachments) {
        const saved = saveAttachment(att, msg.channel, msg.id);
        if (!saved) continue;

        if (saved.isImage) {
          if (this.visionService.enabled) {
            const description = await this.visionService.describe(att.data, att.mimeType);
            if (description) {
              prefixes.push(`[Image: ${saved.filename}]\n${description}`);
            } else {
              prefixes.push(`[Attached image: ${saved.localPath}]`);
            }
          } else {
            prefixes.push(`[Attached image: ${saved.localPath}]`);
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
      // Streaming: send a placeholder message, edit it as content arrives
      let streamMsg: any = null;
      let streamBuffer = '';
      let lastEditAt = 0;
      const EDIT_THROTTLE_MS = 1000; // Discord rate limit friendly

      const onStream = async (delta: string) => {
        streamBuffer += delta;
        const now = Date.now();
        if (now - lastEditAt < EDIT_THROTTLE_MS) return;
        lastEditAt = now;

        try {
          if (!streamMsg) {
            // Get the Discord channel and send initial message
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
        } catch {
          // Ignore edit failures
        }
      };

      msg.onProgress?.('thinking');

      const result = await dispatchMessage({
        client: this.client,
        registry: this.toolRegistry,
        config: this.config,
        message: msg.content,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionStore: this.sessionStore,
        sourceContext: {
          channel: msg.channel,
          channelId: msg.channelId ?? '',
          guildId: msg.guildId,
          senderId: msg.senderId,
        },
        onStream,
        modelOverride: hadAudio ? VOICE_MODEL : undefined,
      });

      console.log(`[Orchestrator] → ${result.category} (${result.iterations} steps)`);

      // TTS post-processing: voice in → voice out (skip if streaming — audio can't attach to edits)
      let responseAudio: { data: Buffer; mimeType: string } | undefined;
      if (hadAudio && this.ttsService.enabled && !streamMsg) {
        msg.onProgress?.('tts');
        const audioBuffer = await this.ttsService.synthesize(result.answer);
        if (audioBuffer) {
          const format = this.config.tts.format;
          const mimeMap: Record<string, string> = { opus: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg' };
          responseAudio = { data: audioBuffer, mimeType: mimeMap[format] ?? 'audio/ogg' };
          console.log(`[Orchestrator] TTS: ${audioBuffer.length} bytes`);
        } else {
          console.warn('[Orchestrator] TTS synthesis failed');
        }
      }

      // Final update: edit the stream message or send a new one
      if (streamMsg) {
        const chunks = splitFinalMessage(result.answer, 2000);
        await streamMsg.edit(chunks[0]);
        // Send remaining chunks as new messages if needed
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
      } else {
        await this.channelRegistry.send(
          {
            channel: msg.channel,
            channelId: msg.channelId!,
            guildId: msg.guildId,
            replyToId: msg.id,
          },
          { text: result.answer, audio: responseAudio },
        );
      }
    } catch (err) {
      console.error('[Orchestrator] Error:', err instanceof Error ? err.message : err);
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
      } catch {
        // Swallow send failure
      }
    }
  }
}

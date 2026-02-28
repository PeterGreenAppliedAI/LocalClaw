# LocalClaw

**A local-model-first AI agent framework that actually works with Ollama.**

LocalClaw runs entirely on your own hardware. No cloud APIs, no per-token costs, no data leaving your machine. It connects to Discord (and any other platform via pluggable adapters) and handles complex multi-tool tasks using local models through a **Router + Specialist** architecture.

## The Problem

Existing agent frameworks (LangChain, CrewAI, AutoGen, etc.) are built for GPT-4 and Claude — models that reliably handle 15+ tools, complex system prompts, and structured JSON output. Local models (7B-30B parameters) can't do this. They:

- **Narrate** tool calls instead of executing them ("I would search for...")
- **Hallucinate** tool names when given too many options
- **Burn tokens** on internal reasoning, returning empty responses
- **Fail JSON parsing** with complex schemas

## The Solution

Instead of giving one model all the tools, LocalClaw splits the work:

1. **Router** — A tiny fast model (phi4-mini, ~50ms) classifies intent into categories
2. **Specialist** — The message goes to a focused specialist that sees only 1-3 relevant tools
3. **Execute** — Native Ollama tool calling API with fallback text parser
4. **Respond** — Results flow back through the channel adapter

```
User → Router (phi4-mini) → Category → Specialist (qwen3-coder:30b) → Tools → Answer
```

Each specialist gets a short system prompt and a handful of tools. Even a 30B model handles this reliably because it only decides between 1-3 options, not 15+.

## Features

| Capability | Tools | Description |
|-----------|-------|-------------|
| Web Search | `web_search`, `web_fetch`, `browser` | Brave Search, Readability extraction, headless Chromium |
| Memory | `memory_save`, `memory_search`, `memory_get` | Vector embeddings + keyword fallback, persisted in SQLite |
| Execution | `exec`, `read_file`, `write_file` | Allowlisted shell commands, safe file I/O |
| Scheduling | `cron_add`, `cron_list`, `cron_remove`, `cron_edit` | Real cron expressions, timezone-aware, persistent |
| Task Board | `task_add`, `task_list`, `task_update`, `task_done`, `task_remove` | Persistent kanban-style task system with TASKS.md rendering |
| Reasoning | `reason` | Hand off to a dedicated thinking model for deep analysis and content synthesis |
| Config | `cron_edit`, `workspace_read`, `workspace_write` | Self-administration — edit cron jobs, read/write workspace files |
| Messaging | `send_message` | Cross-channel message delivery |
| Browsing | `browser` | Playwright headless Chromium — navigate, snapshot, screenshot |
| Vision | *(automatic)* | Image analysis via multimodal model — descriptions injected into context for natural Q&A |
| Voice | TTS/STT | QwenTTS + faster-whisper STT — voice in, voice out |
| Multi-task | *(decomposed)* | Complex requests split into sub-tasks across specialists |
| Heartbeat | *(autonomous)* | Scheduled autonomous task checks, memory cleanup, and status reports |
| Context Compaction | *(automatic)* | Budget-aware history summarization with memory flush |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Ollama](https://ollama.ai/) running locally (or on your network)
- Required models pulled:
  ```bash
  ollama pull phi4-mini
  ollama pull qwen3-coder:30b
  ollama pull qwen3-embedding:8b
  ollama pull nemotron-3-nano:30b   # optional — for reasoning model
  ```

### Install

```bash
git clone https://github.com/PeterGreenAppliedAI/LocalClaw.git
cd LocalClaw
npm install
```

### Setup Wizard (Recommended)

The interactive setup wizard walks you through Ollama connectivity, model selection, channel configuration, workspace bootstrap, and config generation:

```bash
npm run setup
```

This creates `localclaw.config.json5` and `.env` with your settings. You can re-run it anytime to reconfigure.

### Manual Configuration

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
OLLAMA_URL=http://127.0.0.1:11434
DISCORD_BOT_TOKEN=your_bot_token
BRAVE_API_KEY=your_brave_key        # optional — for web search
```

### Run

```bash
# Discord bot mode (when Discord token is configured)
npx tsx src/index.ts

# CLI REPL mode (when no channels are enabled)
npx tsx src/index.ts

# Run tests
npm test
```

## Architecture

```
localclaw/
├── src/
│   ├── index.ts              # Entry point
│   ├── orchestrator.ts       # Lifecycle, rate limiting, streaming
│   ├── dispatch.ts           # Router → Specialist pipeline
│   ├── config/               # JSON5 config + Zod validation
│   ├── router/               # Intent classification (3-tier fallback)
│   ├── tool-loop/            # Tool-calling loop engine
│   ├── ollama/               # Ollama HTTP client (chat, stream, embed)
│   ├── channels/             # Pluggable adapters (Discord, Telegram, Web, Slack, Gmail, Microsoft Graph, WhatsApp)
│   ├── services/             # TTS (QwenTTS) and STT (Whisper) services
│   ├── tasks/                # Task board (types + JSON/Markdown store)
│   ├── tools/                # 22 tool implementations
│   ├── agents/               # Workspace files + routing
│   ├── context/              # Token estimation, budget calculator, history compaction
│   ├── sessions/             # Transcript persistence + compaction summaries
│   ├── cron/                 # Scheduling service
│   ├── memory/               # Vector + keyword search (SQLite)
│   └── browser/              # Playwright wrapper
├── test/                     # 94 tests across 9 suites
├── CLAUDE.md                 # AI code generation guidelines (for Claude Code)
├── localclaw.config.json5    # Full configuration
└── .env                      # API keys and tokens
```

### Router Classification (3-tier fallback)

1. **Model** — phi4-mini classifies into categories (~50ms)
2. **Keywords** — Pattern matching when model fails or times out
3. **Default** — Falls back to `chat`

### Pluggable Channel Adapters

Any messaging platform can be added by implementing 5 methods:

```typescript
interface ChannelAdapter {
  readonly id: string;
  connect(config): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler): void;
  send(target, content): Promise<void>;
}
```

Currently implemented: **Discord**, **Telegram**, **Web API**, **Slack**, **Gmail**, **Microsoft Graph**, **WhatsApp**.

Adding a new adapter requires zero core code changes — implement the interface, register it, add config.

### Voice (TTS/STT)

LocalClaw supports voice input and output through an optional TTS/STT service layer:

- **STT (Speech-to-Text)** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server on your inference node. Incoming voice messages are automatically transcribed before processing.
- **TTS (Text-to-Speech)** — [QwenTTS](https://github.com/QwenLM/Qwen2.5-Omni) on your inference node. When a user sends a voice message, the response is synthesized back as audio.

Both use OpenAI-compatible HTTP APIs (no extra npm packages). The rule is simple: **voice in → voice out, text in → text out**. Adapters that don't support audio (Gmail, Microsoft Graph) gracefully ignore it.

#### Web Voice UI

The web adapter includes a built-in voice interface at `http://localhost:3100`. Hold the mic button (or hold Space) to record, release to send. The endpoint uses **Server-Sent Events (SSE)** to stream progress back in real-time:

```
Transcribing... → "What you said" → Thinking... → Generating speech... → Audio plays
```

The UI also includes a **New Session** button to reset conversation history.

#### Voice Model Override

Voice interactions use a faster, lighter model (`qwen2.5:7b` by default) for chat responses to minimize latency. Tool-using categories (web search, memory, exec, etc.) still use the full specialist model for reliable tool calling. The voice model is configured in `src/orchestrator.ts` via the `VOICE_MODEL` constant.

**Voice setup requires two services on your inference node:**

1. **QwenTTS** — OpenAI-compatible TTS endpoint (port 5005)
   ```bash
   python -m qwen_tts.server --port 5005
   ```
2. **faster-whisper** — OpenAI-compatible STT endpoint (port 8000)
   ```bash
   faster-whisper-server --model large-v3 --device cuda
   ```

**Important:** The QwenTTS server must convert output to OGG Opus format (required for WhatsApp voice notes). Ensure ffmpeg is installed on the inference node for the WAV→Opus conversion.

Configure in `.env`:
```env
QWEN_TTS_URL=http://your-gpu-node:5005
WHISPER_URL=http://your-gpu-node:8000
```

Enable in `localclaw.config.json5`:
```json5
tts: { enabled: true, url: "${QWEN_TTS_URL}", voice: "serena", format: "opus" },
stt: { enabled: true, url: "${WHISPER_URL}", model: "whisper-large-v3", language: "en" },
```

### Vision (Image Analysis)

When a user sends an image, LocalClaw automatically runs it through a multimodal vision model (`qwen3-vl:8b` by default) via Ollama. The vision description is injected into the message context so the specialist can answer questions about the image naturally — no special commands needed.

**How it works:**

1. **Attachment saved** — The image is downloaded and stored locally
2. **Vision model** — The image is sent as base64 to the vision model, which returns a text description
3. **Context injection** — The description is prepended to the user's message so the router sees it as "answerable from context" and routes to `chat`
4. **Natural response** — The chat specialist uses the vision description to answer the user's question directly

If the vision model is unavailable or fails, the message is still processed — the user just gets a note that image analysis wasn't available.

**Configuration** (in `localclaw.config.json5`):

```json5
vision: {
  enabled: true,
  model: "qwen3-vl:8b",
  prompt: "Describe this image in detail. Include text content, visual elements, layout, and any relevant context.",
  maxTokens: 512,
},
```

### WhatsApp

LocalClaw connects to WhatsApp using [Baileys](https://github.com/WhiskeySockets/Baileys), a lightweight WebSocket-based library (no Puppeteer/Chrome required).

**First-time setup:**

1. Enable WhatsApp in `localclaw.config.json5`:
   ```json5
   whatsapp: { enabled: true },
   ```
2. Start the bot: `npm run dev`
3. A QR code will appear in the terminal
4. On your phone, open **WhatsApp > Settings > Linked Devices > Link a Device**
5. Scan the QR code using WhatsApp's built-in scanner (not your phone camera)
6. The bot will connect and start receiving messages

**Session persistence:** After the first scan, the session is saved to `.baileys_auth/`. Future restarts reconnect automatically — no re-scanning needed.

**Re-linking:** If you need to re-link (session expired, device removed), delete `.baileys_auth/` and restart:
```bash
rm -rf .baileys_auth && npm run dev
```

**Note:** WhatsApp may disconnect linked devices after ~14 days of inactivity. The bot handles reconnection automatically, but a full logout requires re-scanning.

### Workspace System

Each agent has persistent markdown files injected into context:

- **SOUL.md** — Persona, communication style, and channel-specific behavior rules
- **TOOLS.md** — What the bot can do (editable at runtime, no restart)
- **USER.md** — Owner profile and preferences
- **IDENTITY.md** — Agent name and per-channel identity
- **MEMORY.md** — Long-term memory
- **HEARTBEAT.md** — Periodic task instructions
- **TASKS.md** — Rendered task board (auto-generated, protected)

The workspace system supports **channel-aware behavior** — the bot receives the source channel (`discord`, `whatsapp`, etc.) with each message, so SOUL.md can define different rules per platform (e.g., act as the owner's assistant on WhatsApp, act as a community bot on Discord).

### Context Compaction

Long conversations hit context limits quickly. Instead of simply dropping old turns, LocalClaw uses **budget-aware compaction** — a sliding window with summary prefix and memory flush.

**How it works:**

1. **Token budget** — Before loading history, the system calculates how many tokens are available for conversation history (context window minus system prompt, workspace context, current message, and output reserve)
2. **Short conversations** — If the full transcript fits within budget, it's passed through as-is (zero overhead)
3. **Long conversations** — When over budget, the transcript is split into two zones:
   - **Recent zone** — The last N turns (default 6) are kept verbatim for immediate conversational context
   - **Archive zone** — Everything older gets processed:
     - **Memory flush** — Key facts (user preferences, names, dates, decisions) are extracted and appended to MEMORY.md for long-term persistence
     - **Summary** — The archive is condensed into a compact summary that preserves conversational flow
4. **Tool loop trimming** — During multi-step tool calls, older tool observations are truncated in-place to prevent within-request overflow

**Configuration** (in `localclaw.config.json5`):

```json5
session: {
  contextSize: 32768,      // model context window size
  recentTurnsToKeep: 6,    // turns kept verbatim (3 exchanges)
  maxHistoryTurns: 100,    // coarse safety net for transcript persistence
},
```

**Graceful degradation:** If the compaction model call fails, it falls back to simple turn-count truncation. Raw transcripts are never modified — summaries are stored separately and can be regenerated.

### Task Board

A persistent kanban-style task system that both users and the bot can use. Tasks are stored in `tasks.json` and rendered to `TASKS.md` with kanban sections (Todo, In Progress, Done, Cancelled).

**Tools:** `task_add`, `task_list`, `task_update`, `task_done`, `task_remove`

**Usage:**
- "Add a task to buy groceries" → creates a task
- "Show my tasks" → lists todo + in-progress
- "Mark a1b2c3d4 done" → completes a task

Tasks support priority levels (low/medium/high), assignees, due dates, and tags. The Done section is capped at 20 items to prevent bloat. `TASKS.md` is a protected file — the bot can only modify it through the TaskStore, not by directly writing to it.

### Heartbeat (Autonomous Scheduled Tasks)

LocalClaw includes an autonomous heartbeat system that periodically reads `HEARTBEAT.md` from the workspace and executes the tasks defined in it — checking the task board for overdue items, reviewing memory for stale entries, and delivering a report to a configured Discord channel (or DM).

**How it works:**

1. **Schedule** — A cron job (default: every 2 hours) triggers the heartbeat
2. **Read** — The orchestrator reads `HEARTBEAT.md` from the default agent's workspace
3. **Dispatch** — The instructions are dispatched through the `multi` category, which decomposes them into sub-tasks across specialists (task checks, memory searches, etc.)
4. **Deliver** — Results are sent to the configured Discord channel or user DM

No new specialists or tools are required — the heartbeat reuses the existing `multi` decomposition pipeline and all standard tools (`task_list`, `memory_search`, etc.).

**Configuration** (in `localclaw.config.json5`):

```json5
heartbeat: {
  enabled: true,
  schedule: "0 */2 * * *",  // every 2 hours (cron expression)
  delivery: {
    channel: "discord",
    target: "415030165005926401",  // Discord channel ID or user ID for DMs
  },
},
```

**`HEARTBEAT.md`** defines the tasks the model should execute each run. Edit it to customize what the heartbeat checks:

```markdown
## Every Run
- Check the task board (task_list) — report overdue or high-priority items

## Daily (morning runs only)
- Review if there are stale memory entries that should be consolidated or removed

## Weekly (Monday morning only)
- Summarize key activities from the past week
```

The Discord adapter automatically detects whether the `target` is a server channel ID or a user ID. If the channel fetch fails, it falls back to opening a DM with the user.

### Reasoning Model

Certain specialists can hand off to a dedicated reasoning model for deep analysis, planning, and content synthesis. The reasoning model (`nemotron-3-nano:30b` by default) never calls tools — it only thinks and returns text.

**How it works:**

1. **Step-back planning** — When the `reason` tool is available, the tool loop asks the specialist to plan its approach before executing. This prevents unstructured outputs.
2. **Forced reasoning pass** — After the specialist gathers data (2+ tool calls), if it didn't call `reason` itself, the system automatically routes the accumulated observations through the reasoning model for a clean synthesis.

This means research-heavy flows (e.g., "search for AI news and write an article") automatically get a polished output from the reasoning model, even if the specialist forgets to invoke it.

**Configuration:**

```json5
reasoning: {
  model: "nemotron-3-nano:30b",
  maxTokens: 8192,
  temperature: 0.6,
},
```

Add `"reason"` to any specialist's `tools` array to enable the reasoning pass for that category. Specialists without `reason` in their tools are unaffected — zero overhead.

## AI-Assisted Development

LocalClaw includes a `CLAUDE.md` file that provides project-level guidelines for AI code generation tools (Claude Code, etc.). When you open this repo in Claude Code, it automatically reads `CLAUDE.md` and follows the project's architecture, code standards, error handling patterns, and security rules.

This means AI-generated code will:
- Use the error factory in `src/errors.ts` instead of ad-hoc try/catch
- Follow the `LocalClawTool` interface and tool registration pattern
- Respect the dispatch security pipeline
- Derive TypeScript types from Zod schemas (never duplicate)
- Place new code in the correct directories

See `CLAUDE.md` for the full set of patterns, anti-patterns, and review checklist.

## Extending LocalClaw

### Add a new tool

1. Create `src/tools/my-tool.ts` implementing `LocalClawTool`
2. Register in `src/tools/register-all.ts`
3. Add to a specialist's `tools` array in config

### Add a new channel adapter

1. Create `src/channels/myplatform/adapter.ts` implementing `ChannelAdapter`
2. Add dynamic import in `src/index.ts`
3. Add config: `myplatform: { enabled: true, token: "..." }`

### Add a new specialist category

1. Add category to `router.categories` in config
2. Add specialist config to `specialists` in config
3. *(Optional)* Add keyword patterns in `src/router/classifier.ts`

## Safety

- **Exec allowlist** — Only approved commands can run
- **SSRF protection** — Scheme whitelist, DNS pre-flight, redirect hop checking
- **Path traversal prevention** — Writes validated to stay within workspace
- **Rate limiting** — 10 messages per minute per user
- **TLS safety** — Verification enabled by default, opt-in override only
- **Atomic writes** — tmp + rename for crash safety

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.7 (strict) |
| AI Backend | Ollama |
| Router Model | phi4-mini |
| Specialist Model | qwen3-coder:30b |
| Embedding Model | qwen3-embedding:8b |
| Reasoning Model | nemotron-3-nano:30b (optional) |
| Voice Chat Model | qwen2.5:7b (for low-latency voice responses) |
| Discord | discord.js 14 |
| Browser | playwright-core |
| Scheduling | croner |
| Vector Store | better-sqlite3 |
| WhatsApp | @whiskeysockets/baileys |
| TTS | QwenTTS (HTTP) |
| STT | faster-whisper (HTTP) |
| Config | JSON5 + Zod |
| Testing | Vitest |

## License

MIT

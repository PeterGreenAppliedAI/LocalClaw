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
| Config | `cron_edit`, `workspace_read`, `workspace_write` | Self-administration — edit cron jobs, read/write workspace files |
| Messaging | `send_message` | Cross-channel message delivery |
| Browsing | `browser` | Playwright headless Chromium — navigate, snapshot, screenshot |
| Voice | TTS/STT | Orpheus TTS + faster-whisper STT — voice in, voice out |
| Multi-task | *(decomposed)* | Complex requests split into sub-tasks across specialists |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Ollama](https://ollama.ai/) running locally (or on your network)
- Required models pulled:
  ```bash
  ollama pull phi4-mini
  ollama pull qwen3-coder:30b
  ollama pull qwen3-embedding:8b
  ```

### Install

```bash
git clone https://github.com/PeterGreenAppliedAI/LocalClaw.git
cd LocalClaw
npm install
```

### Configure

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
│   ├── services/             # TTS (Orpheus) and STT (Whisper) services
│   ├── tools/                # 16 tool implementations
│   ├── agents/               # Workspace files + routing
│   ├── sessions/             # Transcript persistence
│   ├── cron/                 # Scheduling service
│   ├── memory/               # Vector + keyword search (SQLite)
│   └── browser/              # Playwright wrapper
├── test/                     # 63 tests across 7 suites
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
- **TTS (Text-to-Speech)** — [Orpheus TTS](https://github.com/canopyai/orpheus-tts) with [llama.cpp](https://github.com/ggerganov/llama.cpp) backend on your inference node. When a user sends a voice message, the response is synthesized back as audio.

Both use OpenAI-compatible HTTP APIs (no extra npm packages). The rule is simple: **voice in → voice out, text in → text out**. Adapters that don't support audio (Gmail, Microsoft Graph) gracefully ignore it.

**Voice setup requires three services on your inference node:**

1. **llama-server** — Serves the Orpheus-3b model (port 8080)
   ```bash
   ./llama-server -m orpheus-3b-0.1-ft-q4_k_m.gguf -c 2048 -ngl 99 --flash-attn --port 8080
   ```
2. **Orpheus TTS FastAPI** — Converts LLM tokens to audio via SNAC codec (port 5005)
   ```bash
   cd orpheus-tts && python api/app.py
   ```
3. **faster-whisper** — OpenAI-compatible STT endpoint (port 8000)
   ```bash
   faster-whisper-server --model large-v3 --device cuda
   ```

**Important:** The Orpheus FastAPI server must convert output to OGG Opus format (required for WhatsApp voice notes). Ensure ffmpeg is installed on the inference node for the WAV→Opus conversion.

Configure in `.env`:
```env
ORPHEUS_URL=http://your-gpu-node:5005
WHISPER_URL=http://your-gpu-node:8000
```

Enable in `localclaw.config.json5`:
```json5
tts: { enabled: true, url: "${ORPHEUS_URL}", voice: "tara", format: "opus" },
stt: { enabled: true, url: "${WHISPER_URL}", model: "whisper-large-v3", language: "en" },
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

The workspace system supports **channel-aware behavior** — the bot receives the source channel (`discord`, `whatsapp`, etc.) with each message, so SOUL.md can define different rules per platform (e.g., act as the owner's assistant on WhatsApp, act as a community bot on Discord).

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
| Discord | discord.js 14 |
| Browser | playwright-core |
| Scheduling | croner |
| Vector Store | better-sqlite3 |
| WhatsApp | @whiskeysockets/baileys |
| TTS | Orpheus TTS (HTTP) |
| STT | faster-whisper (HTTP) |
| Config | JSON5 + Zod |
| Testing | Vitest |

## License

MIT

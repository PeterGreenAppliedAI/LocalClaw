# LocalClaw

**A local-model-first AI agent framework that actually works with Ollama.**

LocalClaw runs entirely on your own hardware. No cloud APIs, no per-token costs, no data leaving your machine. It connects to Discord, Telegram, WhatsApp, and more via pluggable adapters — and handles complex multi-tool tasks using local models through a **Router + Specialist** architecture.

## The Problem

Existing agent frameworks (LangChain, CrewAI, AutoGen, etc.) are built for GPT-4 and Claude — models that reliably handle 15+ tools, complex system prompts, and structured JSON output. Local models (7B-30B parameters) can't do this. They:

- **Narrate** tool calls instead of executing them ("I would search for...")
- **Hallucinate** tool names when given too many options
- **Burn tokens** on internal reasoning, returning empty responses
- **Fail JSON parsing** with complex schemas

## The Solution

Instead of giving one model all the tools, LocalClaw splits the work:

1. **Router** — A fast model (phi4:14b) classifies intent into categories
2. **Pipeline or Specialist** — Most categories use **deterministic pipelines** where code controls the workflow and the LLM only extracts parameters or synthesizes text. Open-ended categories fall back to a ReAct tool loop.
3. **Execute** — Tools are called by the pipeline (deterministic) or via native Ollama tool calling API with fallback text parser (ReAct)
4. **Respond** — Results flow back through the channel adapter

```
User → Router (phi4-mini) → Category
  → Pipeline (deterministic stages)    # task, memory, cron, web_search, exec, message, website, research
  → ReAct loop (model decides)         # multi, config, chat
```

**Templated Pipelines** define the exact workflow in code — extract params, call tools, format results — so the model never decides "what step next." This eliminates hallucinated actions, wrong tool ordering, and wasted iterations. The ReAct loop remains as fallback for genuinely open-ended categories.

## Management Console

LocalClaw includes a full web-based management console at `http://localhost:3100/console/`.

<img width="2554" height="1302" alt="image" src="https://github.com/user-attachments/assets/a309e3d2-0bd5-4cf0-9806-0cbfeb1f0663" />


**Pages:**

- **Dashboard** — System status, Ollama health, channel connections, cron/memory stats
- **Chat** — Full chat interface with markdown rendering, inline chart display, file uploads (images, PDFs), and toggle voice mode with VAD (voice activity detection)
- **Sessions** — Browse and inspect all conversation transcripts across channels, with tool call details
- **Tasks** — Kanban board with drag-to-advance, add/delete, priority levels
- **Cron & Heartbeats** — View, toggle, run now, or delete scheduled jobs
- **Memory** — Search facts by sender, browse categories/tags/entities, consolidate
- **Channels** — Live connection status with reconnect buttons
- **Tools** — Browse all registered tools grouped by category with parameter schemas
- **Config** — Collapsible tree view of the running configuration (secrets redacted)

The console uses React + Vite + TailwindCSS, served as static files from the same HTTP server. No separate process needed.

## Features

| Capability | Tools | Description |
|-----------|-------|-------------|
| Web Search | `web_search`, `web_fetch`, `browser` | Brave/Perplexity/Grok/Tavily search, Readability extraction, headless Chromium |
| Research | `web_search`, `web_fetch`, `code_session`, `reason` | Deep research with data analysis, chart generation (matplotlib/seaborn), and inline visualization |
| Memory | `memory_save`, `memory_search`, `memory_get` | Per-user structured facts with categories, tags, entities, and confidence scores |
| Execution | `exec`, `code_session`, `read_file`, `write_file` | Allowlisted shell commands, persistent Python/Node/Bash REPL sessions, safe file I/O |
| Scheduling | `cron_add`, `cron_list`, `cron_remove`, `cron_edit` | Real cron expressions, timezone-aware, persistent |
| Task Board | `task_add`, `task_list`, `task_update`, `task_done`, `task_remove` | Persistent kanban-style task system with TASKS.md rendering |
| Reasoning | `reason` | Hand off to a dedicated thinking model for deep analysis and content synthesis |
| Config | `cron_edit`, `workspace_read`, `workspace_write` | Self-administration — edit cron jobs, read/write workspace files |
| Messaging | `send_message` | Cross-channel message delivery |
| Browsing | `browser` | Dual-mode browser: DOM-first with automatic visual escalation (Xvfb + vision model). Click, type, select, fill forms on any site including SPAs |
| Vision | *(automatic)* | Image analysis via multimodal model — descriptions injected into context for natural Q&A |
| Voice | TTS/STT | Kokoro TTS + faster-whisper STT — voice in, voice out, with toggle hands-free mode |
| Multi-task | `plan` pipeline | LLM decomposes goal into steps, self-reflects, code executes with browser/tools, learns from success |
| Skills | *(automatic)* | Self-improving procedural memory — successful plan executions are saved and reused for similar future tasks |
| Heartbeat | *(autonomous)* | Scheduled autonomous task checks, memory cleanup, and status reports |
| Knowledge Import | `knowledge_import` | Import PDFs, CSVs, markdown into vector-searchable knowledge base |
| Context Compaction | *(automatic)* | Structured compression (Goal/Progress/Next Steps), proactive at 50% budget, tool-pair sanitization |
| Document Gen | `document` | Create and convert documents via LibreOffice headless — HTML/CSV → PDF/DOCX/XLSX/PPTX |
| Self-Improvement | *(automatic)* | Error learning store, pattern matching, drift detection, learning promotion via heartbeat |
| CLI | `npm run cli` | Terminal interface with streaming, slash commands, markdown rendering, session persistence |

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
- Python 3 with data science packages (for research/charting):
  ```bash
  pip3 install matplotlib seaborn pandas numpy yfinance requests scipy
  ```

### Install

```bash
git clone https://github.com/PeterGreenAppliedAI/LocalClaw.git
cd LocalClaw
npm install
cd console && npm install && npm run build && cd ..
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
# Start the bot (Discord, Telegram, WhatsApp, Web console — all configured channels)
npx tsx src/index.ts

# CLI REPL mode (when no channels are enabled)
npx tsx src/index.ts

# Run tests
npm test
```

The management console is available at `http://localhost:3100/console/` when the web channel is enabled.

## Architecture

```
localclaw/
├── src/
│   ├── index.ts              # Entry point
│   ├── orchestrator.ts       # Lifecycle, rate limiting, streaming
│   ├── dispatch.ts           # Router → Specialist pipeline
│   ├── config/               # JSON5 config + Zod validation
│   ├── router/               # Intent classification (3-tier fallback + pre-model overrides)
│   ├── pipeline/             # Deterministic pipeline engine
│   │   ├── executor.ts       # Stage runner (extract, tool, llm, code, branch, llm_branch, loop, parallel_tool)
│   │   ├── registry.ts       # Pipeline registry
│   │   ├── types.ts          # Stage types, PipelineContext, PipelineResult
│   │   ├── extractor.ts      # LLM-based parameter extraction with JSON repair
│   │   └── definitions/      # Pipeline definitions per category
│   ├── tool-loop/            # ReAct tool-calling loop engine (fallback for open-ended categories)
│   ├── browser/              # Dual-mode browser client (DOM + Visual via Xvfb)
│   ├── skills/               # Self-improving procedural memory (store + keyword matcher)
│   ├── cli/                  # Terminal interface (streaming, commands, markdown rendering)
│   ├── ollama/               # Ollama HTTP client (chat, stream, embed)
│   ├── channels/             # Pluggable adapters (Discord, Telegram, Web, Slack, Gmail, Microsoft Graph, WhatsApp)
│   ├── console/              # Management console API (handlers, helpers, file serving)
│   ├── services/             # TTS (Kokoro), STT (Whisper), Vision
│   ├── tasks/                # Task board (types + JSON/Markdown store)
│   ├── learnings/            # Self-improvement (error store, pattern matcher)
│   ├── tools/                # 29 tool implementations
│   ├── agents/               # Workspace files + routing (frozen snapshots per session)
│   ├── context/              # Token estimation, budget calculator, structured compaction
│   ├── sessions/             # Transcript persistence + compaction summaries
│   ├── cron/                 # Scheduling service
│   ├── memory/               # Structured fact store (char-bounded), keyword search, vector search
│   └── exec/                 # Docker sandbox + persistent code sessions
├── console/                  # React + Vite + TailwindCSS management console
│   ├── src/pages/            # Dashboard, Chat, Sessions, Tasks, Cron, Memory, Channels, Tools, Config
│   ├── src/api/              # API client + React Query hooks
│   └── dist/                 # Built static files (served by web adapter)
├── test/                     # 226 tests across 20 suites
├── CLAUDE.md                 # AI code generation guidelines (for Claude Code)
├── localclaw.config.json5    # Full configuration
└── .env                      # API keys and tokens
```

### Router Classification (3-tier fallback)

1. **Pre-model overrides** — High-confidence keyword patterns for new categories (e.g., research)
2. **Model** — phi4-mini classifies into categories (~50ms)
3. **Keywords** — Pattern matching when model fails or times out
4. **Default** — Falls back to `chat`

Categories: `chat`, `web_search`, `memory`, `exec`, `cron`, `message`, `website`, `task`, `multi`, `config`, `research`

### Templated Pipeline Engine

Most categories run through **deterministic pipelines** instead of letting the model decide the workflow. Each pipeline is a sequence of typed stages:

| Stage Type | Purpose | LLM? |
|-----------|---------|------|
| `extract` | Extract structured params from user message | Yes (focused, low-temp) |
| `tool` | Call a specific tool with computed params | No |
| `parallel_tool` | Call a tool N times concurrently (e.g., 5 searches at once) | No |
| `llm` | Synthesize, analyze, or format text | Yes |
| `code` | Deterministic logic (date math, filtering, formatting) | No |
| `branch` | Route to sub-pipeline based on a sync function | No |
| `llm_branch` | Single-word LLM classification to pick a branch (uses router model) | Yes (constrained) |
| `loop` | Repeat stages N times or until condition | No |

**Pipelined categories:**

| Category | Pipeline | Flow |
|----------|----------|------|
| `task` | Branched (5) | llm_branch → extract (with task context) → tool → confirm |
| `memory` | Branched (2) | llm_branch → extract → tool → format |
| `cron` | Branched (4) | llm_branch → extract → tool → confirm |
| `web_search` | Linear | extract → search → parallel fetch → synthesize |
| `multi` | Plan | llm plan → self-reflect → execute loop (dynamic tools + visual browser) → smart select → verify → summarize |
| `research` | Complex | plan queries → parallel search → parallel fetch → synthesize → charts → branch (deck OR report PDF) |
| `exec` | Linear | extract → tool → format |
| `message` | Linear | extract → tool → confirm |
| `website` | Linear | extract → tool → format |

**ReAct fallback** categories (`config`, `chat`) still use the model-decides-everything loop.

### Research Flow

The `research` pipeline produces polished slide decks or styled PDF reports through a fully templated workflow:

1. **Plan** — LLM generates 3-5 targeted search queries from the topic
2. **Search** — All queries run concurrently via `parallel_tool` (5 searches at once)
3. **Fetch** — Top 8 URLs fetched concurrently. If 3+ fail (403, timeout), a supplementary search + fetch round runs automatically
4. **Synthesize** — LLM analyzes findings and produces a structured outline with thesis, sections, sources, and chart specifications. Report mode requests full paragraphs instead of bullet points
5. **Visualize** — LLM generates matplotlib/seaborn chart code, executed in a Python code session
6. **Branch** — Routes to deck (reveal.js) or report (styled PDF) based on artifact type
7. **Render** — LLM generates the complete HTML from the outline
8. **Quality Review** (report only) — Router model checks content completeness, source citations, and substance. If issues found, a single revision pass runs before PDF conversion
9. **Convert** (report only) — LibreOffice headless converts styled HTML to PDF
10. **Deliver** — Deck written to file with link, or PDF attached to the channel message via `[FILE:]` token

Supports artifact types: `memo`, `brief`, `deck`, `market`, `teardown`, `deepdive`, `report` — each with a different structure guide. The `report` type produces professional CSS-styled PDFs with executive summaries, full paragraphs, data tables, and numbered source citations. Charts use a dark theme for decks and are embedded with absolute paths for PDF rendering.

### Plan Pipeline (Autonomous Task Execution)

The `plan` pipeline handles complex multi-step tasks that require browser interaction, web searches, and tool coordination. Instead of asking the model to orchestrate 10+ tool calls (which local models can't do reliably), the pipeline uses a hybrid approach:

1. **Skill Check** — Before planning, searches saved skills for a matching execution pattern. If found, skips plan generation and uses the proven recipe
2. **Plan** — LLM generates a step-by-step plan as a JSON array of `{tool, params, purpose}` objects
3. **Self-Reflection** — LLM critiques its own plan: checks for missing snapshots, bad ordering, unrealistic assumptions, generic placeholders, wrong browser mode, and blind first-result selection. Revises the plan if issues found
4. **Execute loop** — Code iterates through the plan, calling tools directly via `ctx.executor()`:
   - **Smart selection** — Grabs fresh rendered page text (`innerText`) and asks the LLM to pick the most relevant content item, not just the first result
   - **Dynamic param resolution** — Extracts real data (event names, dates, URLs) from the rendered page text when creating tasks or saving memory
   - **DOM-first browser** — Tries DOM interactions first (fast, cheap). Automatically escalates to visual mode (vision model + pixel coordinates) only when DOM fails
5. **Verify** — After each step, checks success; on failure, LLM generates an adjusted step
6. **Summarize** — LLM synthesizes outcomes into a conversational response (streamed)
7. **Skill Save** — If execution was successful (>60% step success rate, 3+ steps), saves the plan as a reusable skill. Next similar request loads the skill instead of planning from scratch

**Dual-mode browser:**
- **DOM mode** (default) — Walks the DOM, labels interactive elements with indices (`[1: button]`, `[2: input]`). Uses `innerText` for reading SPA content. Fast and deterministic.
- **Visual mode** (escalation) — Renders on Xvfb virtual display, screenshots to vision model (qwen3.5:35b), clicks at pixel coordinates. Only invoked when DOM click/type fails. Logged: `[Browser] DOM click failed → Escalating to visual mode`.

**Example:** "Search Eventbrite for tech events near Huntington Station NY, then add one to my task list":
```
[Skill check] → No match (first run)
[Plan] → 10 steps generated
[Reflect] → 4 issues found, plan revised
Step 1: browser open eventbrite.com
Step 2: browser snapshot → see interactive elements
Step 3: browser type "Search events input" → "tech events Huntington Station NY"
Step 4: browser click "Search button" → execute search
Step 5: browser text_content → read 4441 chars of rendered results
Step 6: [Smart Selection] → picks "Long Island Hiring Event" (most relevant)
Step 7: browser click → navigate to event
Step 8: browser text_content → read event details
Step 9: task_add → "Long Island Hiring Event" due 2026-04-13
[Skill saved] → go-to-eventbrite-com-and-search-for-tech-events-ne (success_count: 1)

Second similar request:
[Skill match] → score 19, using saved plan (skips LLM plan generation + reflection)
[Skill success] → success_count: 2
```

**Foreman handoffs:** Each specialist receives a structured briefing — its specific task, the overall goal, what prior steps accomplished (status + artifact file paths), and available artifacts (URLs, file paths). Full step results are written to disk as `.plan-artifacts/step-N.txt` — specialists can `read_file` to access complete content without prompt bloat. No extra model calls — handoff construction is pure code.

**Context isolation:** All pipeline dispatches (plan, research, exec, etc.) run with fresh context (no parent history) to prevent prior session topics from biasing results. Progressive workspace disclosure (~300 bytes instead of 4-6KB) maximizes the context budget for tool results.

### Self-Improving Skills

After a successful plan execution, the bot saves the steps as a reusable skill in `workspace/skills/*.md`. Each skill has:
- YAML frontmatter (name, description, success count, last used)
- Ordered step list with tool, params, and purpose
- Learned notes from execution (e.g., "Use text_content for SPAs", "Smart selection needed")

**Progressive disclosure** (3 tiers): list shows name + description only → full load includes steps and notes → individual referenced files on demand. This saves tokens for local models with small context windows.

**Matching:** Keyword overlap scoring against skill names and descriptions, with bonus points for high success counts. Threshold prevents weak matches from firing.

### CLI

LocalClaw includes a terminal interface (`npm run cli`) for direct interaction without channel adapters:

```
❯ /status
  Ollama: connected | Models: 39 | Tools: 20 | Pipelines: 10
  Router: phi4:14b | Agent: main

❯ /help
  /reset     Clear session and start fresh
  /status    System status (models, tools, channels)
  /model     Switch or show current model
  /tools     List registered tools
  /pipelines List registered pipelines
  /tasks     Show task board
  /sessions  List recent sessions
  /research  Run a research pipeline
  /compress  Trigger context compression

❯ hey whats up
  [chat (model) | 1 step | model:qwen3.5:9b]
  Hey there! How can I help you today?
```

Features: streaming output, markdown rendering (headers, bold, code blocks), color-coded display, tool call visualization, session persistence.

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

Currently implemented: **Discord**, **Telegram**, **Web API + Console**, **Slack**, **Gmail**, **Microsoft Graph**, **WhatsApp**, **iMessage** (via BlueBubbles). All adapters support file attachment delivery (PDFs, images, documents).

Adding a new adapter requires zero core code changes — implement the interface, register it, add config.

### Console API

The management console exposes a REST API at `/console/api/`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | System health, model count, channel statuses |
| GET | `/models` | List available Ollama models |
| GET | `/config` | Running configuration (secrets redacted) |
| GET | `/channels` | Channel connection statuses |
| POST | `/channels/:id/reconnect` | Reconnect a channel |
| GET | `/sessions` | List all conversation sessions |
| GET | `/sessions/:agent/:key` | Load session transcript |
| DELETE | `/sessions/:agent/:key` | Delete a session |
| GET/POST/PATCH/DELETE | `/tasks[/:id]` | Task CRUD |
| GET/POST/PATCH/DELETE | `/cron[/:id]` | Cron job CRUD |
| POST | `/cron/:id/run` | Run a cron job immediately |
| GET | `/facts/all` | List facts (filterable by sender, query) |
| POST | `/facts/consolidate` | Consolidate duplicate facts |
| GET | `/memory/senders` | List known memory senders |
| GET | `/tools` | List all registered tools with schemas |
| POST | `/chat` | SSE-streaming chat (with image extraction) |
| POST | `/chat/reset` | Clear console session |
| GET | `/files/:path` | Serve workspace files (charts, etc.) |

### Voice (TTS/STT)

LocalClaw supports voice input and output through an optional TTS/STT service layer:

- **STT (Speech-to-Text)** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server on your inference node. Incoming voice messages are automatically transcribed before processing.
- **TTS (Text-to-Speech)** — [Kokoro](https://github.com/remsky/Kokoro-FastAPI) on your inference node. Near-real-time synthesis (~150ms per sentence). When a user sends a voice message, the response is synthesized back as audio. Voice responses get a TTS-friendly prompt injection (no emojis, no markdown, plain conversational English).

Both use OpenAI-compatible HTTP APIs (no extra npm packages). The rule is simple: **voice in → voice out, text in → text out**. Adapters that don't support audio (Gmail, Microsoft Graph) gracefully ignore it.

#### Console Voice Mode

The management console chat includes a **toggle voice mode** — tap the mic button once to enter hands-free mode. Voice Activity Detection (VAD) automatically detects when you stop speaking, sends the audio for transcription, dispatches the message, and plays back the TTS response. Recording auto-resumes after playback for a natural conversational loop.

#### Web Voice UI

The web adapter also includes a standalone voice interface at `http://localhost:3100`. Hold the mic button (or hold Space) to record, release to send. The endpoint uses **Server-Sent Events (SSE)** to stream progress back in real-time:

```
Transcribing... → "What you said" → Thinking... → Generating speech... → Audio plays
```

#### Voice Model Override

Voice interactions use a faster, lighter model (`qwen2.5:7b` by default) for chat responses to minimize latency. Tool-using categories (web search, memory, exec, etc.) still use the full specialist model for reliable tool calling. The voice model is configured in `src/orchestrator.ts` via the `VOICE_MODEL` constant.

**Voice setup requires two services on your inference node:**

1. **Kokoro TTS** — OpenAI-compatible TTS endpoint (port 5005)
   ```bash
   # Via Kokoro-FastAPI (recommended)
   docker run -p 5005:8880 ghcr.io/remsky/kokoro-fastapi
   ```
2. **faster-whisper** — OpenAI-compatible STT endpoint (port 8000)
   ```bash
   faster-whisper-server --model large-v3 --device cuda
   ```

Configure in `.env`:
```env
QWEN_TTS_URL=http://your-gpu-node:5005
WHISPER_URL=http://your-gpu-node:8000
```

Enable in `localclaw.config.json5`:
```json5
tts: { enabled: true, url: "${QWEN_TTS_URL}", voice: "af_bella", format: "mp3" },
stt: { enabled: true, url: "${WHISPER_URL}", model: "whisper-large-v3", language: "en" },
```

### Vision (Image Analysis)

When a user sends an image, LocalClaw automatically runs it through a multimodal vision model (`qwen3-vl:8b` by default) via Ollama. The vision description is injected into the message context so the specialist can answer questions about the image naturally — no special commands needed.

**How it works:**

1. **Attachment saved** — The image is downloaded and stored locally
2. **Vision model** — The image is sent as base64 to the vision model, which returns a text description
3. **Context injection** — The description is prepended to the user's message so the router sees it as "answerable from context" and routes to `chat`
4. **Natural response** — The chat specialist uses the vision description to answer the user's question directly

If the vision model is unavailable or fails, the message is still processed — the user just gets a note that image analysis wasn't available. Images can also be uploaded directly in the management console chat via the paperclip button, paste, or drag & drop.

**Configuration** (in `localclaw.config.json5`):

```json5
vision: {
  enabled: true,
  model: "qwen3-vl:8b",
  prompt: "Describe this image in detail. Include text content, visual elements, layout, and any relevant context.",
  maxTokens: 512,
},
```

### Memory System

Memory uses **structured facts** with per-user isolation — no embedding dependency for core memory.

**Storage layout:**
```
workspace/memory/
  <senderId>/
    FACTS.md          # Consolidated searchable index
    2026-03-05.md     # Dated audit trail (append-only)
    pending.json      # Fact candidates awaiting user approval
```

**Two extraction paths:**
1. **`!reset` (user-approved)** — On session clear, facts extracted and shown for approval (`!save` / `!discard`)
2. **Heartbeat (autonomous)** — Every 2 hours, scans transcripts and writes facts directly

Each fact has: category (`stable`/`context`/`decision`/`question`), confidence score, tags, entities, source, and optional expiration. The console Memory page lets you browse, search, and consolidate facts across all senders.

### Self-Improvement System

LocalClaw learns from its own mistakes through a 5-layer feedback system:

1. **Error Learning Store** — When a tool fails, the error is recorded to `.learnings/errors.jsonl` with tool name, params, error message, and step number. Before executing a tool, the engine checks for past errors with matching tool+params and prepends hints to guide the model.

2. **Error Pattern Matching** — After every tool execution, the observation is scanned for 8 known error patterns (permission denied, module not found, connection refused, timeout, HTTP 4xx, rate limiting, stack traces, OOM). Detected patterns are enriched with suggestions and past learnings.

3. **Context Drift Detection** — Monitors for three drift signals during tool-loop execution: repeating tool calls (same tool+params twice), hedging language (4+ instances of "I think", "perhaps", "maybe"), and growing responses without progress. When detected, injects a re-anchor prompt with the original request. Fires once per loop run.

4. **Post-Task Self-Review** — After tool-heavy specialists complete (exec, multi, web_search with 2+ tool calls), the router model runs a quality check on the response. Corrections are logged internally for learning.

5. **Learning Promotion** — Every heartbeat cycle, the error store is scanned for recurring patterns (3+ occurrences of same tool + error). These are promoted to `LEARNINGS.md` in the workspace root, which is loaded into specialist context alongside SOUL.md and IDENTITY.md.

### Document Generation

LocalClaw generates professional documents using LibreOffice headless:

```
document[{"action": "create", "content": "<h1>Report</h1>...", "format": "pdf", "filename": "report"}]
document[{"action": "convert", "inputPath": "data.csv", "format": "xlsx"}]
```

**Supported formats:** PDF, DOCX, XLSX, PPTX, HTML, CSV, TXT, ODT, ODS, ODP

Output files are delivered as attachments through the channel adapters. The `[FILE:path]` token system ensures files are stripped from model observations (preventing the model from rewriting paths) and re-appended to the final answer for the media extraction pipeline to pick up.

**Requirements:** LibreOffice installed (`brew install --cask libreoffice` on macOS). Path configurable via `SOFFICE_PATH` env var.

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
     - **Memory flush** — Key facts are extracted and appended to MEMORY.md (hash-based dedup prevents duplicates)
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

Tasks support priority levels (low/medium/high), assignees, due dates, and tags. The Done section is capped at 20 items to prevent bloat. `TASKS.md` is a protected file — the bot can only modify it through the TaskStore, not by directly writing to it. Tasks are also viewable as a kanban board in the management console.

### Heartbeat (Autonomous Scheduled Tasks)

LocalClaw includes an autonomous heartbeat system that periodically checks the task board, reviews memory, and delivers a report to a configured Discord channel (or DM).

**How it works:**

1. **Schedule** — A cron job (default: every 2 hours) triggers the heartbeat
2. **Fetch tasks** — The `heartbeat` pipeline calls `task_list` to get all tasks
3. **Analyze dates in code** — JavaScript compares due dates against today (no LLM date reasoning — this eliminates the "2027 is overdue in 2026" hallucination)
4. **Fetch memory** — Searches recent context from the memory store
5. **Format report** — Deterministic code builds the report with overdue, upcoming, and in-progress sections
6. **Deliver** — Results are sent to the configured Discord channel or user DM

The heartbeat runs in `cronMode` which strips mutation tools — it's strictly read-only (no creating duplicate tasks or modifying state). It also promotes recurring error patterns to `LEARNINGS.md` and cleans up generated media files older than 7 days.

**Commands:**
- `!cleanup` — Manually trigger memory consolidation (substring dedup + LLM semantic dedup)
- `!promote` — Manually promote recurring error patterns from the learning store to `LEARNINGS.md`

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

- **Exec allowlist** — Only approved commands can run (or Docker sandbox mode)
- **SSRF protection** — Scheme whitelist, DNS pre-flight, redirect hop checking
- **Path traversal prevention** — Writes validated to stay within workspace; file serving endpoint validates resolved paths
- **Rate limiting** — 10 messages per minute per user
- **Cron safety** — Automated tasks run in `cronMode` which strips mutation tools (`write_file`, `task_add`, `task_update`, `memory_save`, etc.) — cron jobs report, they don't modify. Jobs retry up to 2 times with exponential backoff on failure, and notify the delivery channel on final failure
- **Confirmation mode** — Configurable `confirmTools` per channel — listed tools return a preview instead of executing, requiring user confirmation before proceeding
- **Channel security** — Per-channel category restrictions, tool blocking, and per-user trust levels
- **Web API auth** — Bearer token validation on HTTP endpoints
- **TLS safety** — Verification enabled by default, opt-in override only
- **Atomic writes** — tmp + rename for crash safety

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.7 (strict) |
| AI Backend | Ollama |
| Router Model | phi4:14b |
| Specialist Model | qwen3-coder:30b |
| Embedding Model | qwen3-embedding:8b |
| Reasoning Model | nemotron-3-nano:30b (optional) |
| Voice Chat Model | qwen2.5:7b (for low-latency voice responses) |
| Console Frontend | React 19 + Vite + TailwindCSS 4 |
| Console Markdown | react-markdown + remark-gfm |
| Data Viz | matplotlib + seaborn + yfinance (Python) |
| Discord | discord.js 14 |
| Telegram | grammy |
| WhatsApp | @whiskeysockets/baileys |
| Browser | playwright-core |
| Document Gen | LibreOffice (headless) |
| iMessage | BlueBubbles (REST API) |
| Scheduling | croner |
| Knowledge Store | better-sqlite3 (vector embeddings for imported documents) |
| TTS | Kokoro TTS (HTTP, OpenAI-compatible) |
| STT | faster-whisper (HTTP) |
| Config | JSON5 + Zod |
| Testing | Vitest |

## Attribution

Several architectural patterns in LocalClaw were adapted from open source agent frameworks:

| Project | What We Adapted |
|---------|----------------|
| **[Hermes Agent](https://github.com/nousresearch/hermes-agent)** (NousResearch) | Self-improving skills system (procedural memory with progressive disclosure), structured context compression (Goal/Progress/Next Steps template), frozen memory snapshots (loaded once per session), character-bounded memory, smart model routing (simple messages → fast model), tool-pair sanitization after compression, CLI inspiration |
| **[Deep Agents](https://github.com/langchain-ai/deepagents)** (LangChain) | Progressive skill disclosure (compact index, read on demand), subagent context isolation (fresh context for plan pipeline), tool argument truncation in older messages |
| **[agent-reasoning](https://github.com/jasperan/agent-reasoning)** (jasperan) | Self-reflection stage for plan pipeline (draft → critique → improve), inspired by peer-reviewed cognitive architecture research (Chain-of-Thought, Tree of Thoughts, ReAct) |

These frameworks solve similar problems but assume frontier models (GPT-4, Claude) are driving the agent. LocalClaw's contribution is adapting these patterns for local models (7B-30B parameters) running on Ollama, where the model can't reliably orchestrate its own workflow — deterministic pipelines control the flow, and the model only extracts parameters and synthesizes text.

## License

MIT

# LocalClaw

**A local-model-first AI agent framework that actually works with Ollama.**

LocalClaw runs entirely on your own hardware. No cloud APIs, no per-token costs, no data leaving your machine. It connects to Discord (and any other platform via pluggable adapters) and handles complex multi-tool tasks using local models through a Router + Specialist architecture.

---

## The Problem

Existing agent frameworks (like OpenClaw, LangChain agents, etc.) are built for GPT-4 and Claude — models that can reliably handle 15+ tools, complex system prompts, and structured JSON output. Local models (7B-30B parameters) can't do this. They:

- **Narrate** tool calls instead of executing them ("I would search for...")
- **Hallucinate** tool names when given too many options
- **Burn tokens** on internal reasoning, returning empty responses
- **Fail JSON parsing** with complex schemas

LocalClaw solves this with an architecture designed specifically for local model capabilities.

---

## The Solution: Router + Specialist

Instead of giving one model all the tools and hoping for the best, LocalClaw:

1. **Routes** — A tiny fast model (phi4-mini, ~50ms) classifies the user's intent into one of 8 categories
2. **Dispatches** — The message goes to a focused specialist that sees only 1-3 relevant tools
3. **Executes** — The specialist uses Ollama's native tool calling API (not text parsing) to call tools
4. **Responds** — Results flow back through the channel adapter to the user

```
User -> Router (phi4-mini) -> Category -> Specialist (qwen3-coder:30b) -> Tools -> Answer
```

Each specialist gets a short system prompt and a handful of tools. Even a 30B model handles this reliably because it only needs to decide between 1-3 options, not 15+.

---

## What It Can Do

| Capability | Tools | How It Works |
|-----------|-------|-------------|
| **Web Search** | web_search, web_fetch, browser | Brave Search API, Readability extraction, headless Chromium |
| **Memory** | memory_save, memory_search, memory_get | Semantic search via embeddings (qwen3-embedding:8b) + keyword fallback |
| **Execution** | exec, read_file, write_file | Allowlisted shell commands, safe file I/O |
| **Scheduling** | cron_add, cron_list, cron_remove | Real cron expressions via croner, timezone-aware, persistent |
| **Messaging** | send_message | Cross-channel message delivery |
| **Browsing** | browser | Playwright headless Chromium — open, navigate, snapshot, screenshot |
| **Multi-task** | (decomposed) | Complex requests split into sub-tasks, dispatched to specialists, results aggregated |

---

## Architecture

### Specialist Categories

| Category | Model | Tools | Purpose |
|----------|-------|-------|---------|
| chat | qwen3-coder:30b | (none) | Conversation — bypasses tool loop entirely |
| web_search | qwen3-coder:30b | web_search, web_fetch, browser | Internet research (up to 8 iterations) |
| memory | qwen3-coder:30b | memory_search, memory_get, memory_save | Persistent knowledge across sessions |
| exec | qwen3-coder:30b | exec, read_file, write_file | System operations |
| cron | qwen3-coder:30b | cron_add, cron_list, cron_remove | Task scheduling |
| message | qwen3-coder:30b | send_message | Cross-channel messaging |
| website | qwen3-coder:30b | website_query | Custom API integration |
| multi | qwen3-coder:30b | (decomposed) | Complex multi-step orchestration |

### Router Classification (3-tier fallback)

1. **Model** — phi4-mini classifies into categories (~50ms)
2. **Keywords** — Pattern matching when model fails or times out
3. **Default** — Falls back to `chat`

### Tool Calling Strategy

Uses Ollama's native `tools` parameter — structured `tool_calls` responses, not text parsing. When models non-deterministically narrate instead of calling (qwen3-coder does this ~10% of the time), a fallback parser catches XML-style and Action-style narrations.

### Pluggable Adapters

Any messaging platform can be added by implementing 5 methods:

```typescript
interface ChannelAdapter {
  readonly id: string;
  connect(config): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler): void;
  send(target, content): Promise<void>;
  status(): ChannelStatus;
}
```

Currently implemented: **Discord**, **Telegram**, **Web API**. Adding Slack, SharePoint, Google Drive, email — implement the interface, register it, add config. Zero core code changes.

### Workspace System

Each agent gets persistent workspace files that are injected into every system prompt:

- **SOUL.md** — Persona, boundaries, communication style
- **TOOLS.md** — What the bot can do (editable, no restart needed)
- **USER.md** — User profile (learned over time)
- **IDENTITY.md** — Agent name and personality
- **MEMORY.md** — Long-term memory (auto-appended by memory_save)
- **AGENTS.md** — Operating instructions
- **HEARTBEAT.md** — Periodic task instructions
- **BOOTSTRAP.md** — First-run onboarding ritual

### Memory (Dual-Layer)

- **Vector search** — Ollama embeddings (qwen3-embedding:8b) with cosine similarity
- **Keyword fallback** — Markdown section splitting with keyword density scoring
- Saved content is both appended to markdown (human-readable) and embedded in the vector store (machine-searchable)

### Session Persistence

- JSON transcripts per agent/session with atomic writes (crash-safe)
- Last 20 turns loaded into context on each request
- `!new` / `!reset` commands clear session history

### Cron Scheduling

- Real cron expressions (not intervals) via croner library
- Timezone-aware (America/New_York)
- Jobs persisted to JSON, survive restarts
- Triggers dispatch directly to stored category (skips router)
- Results delivered to originating channel

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.7 (strict) |
| AI Backend | Ollama (local inference) |
| Router Model | phi4-mini |
| Specialist Model | qwen3-coder:30b |
| Embedding Model | qwen3-embedding:8b |
| Discord | discord.js 14 |
| Browser | playwright-core (headless Chromium) |
| Scheduling | croner |
| Config | JSON5 with env var interpolation |
| Validation | Zod |
| Testing | Vitest (63 tests) |

---

## Safety

- **Exec allowlist** — Only approved commands can run (ls, cat, python3, node, git)
- **SSRF protection** — DNS pre-flight blocks private IP access
- **Path traversal prevention** — Memory writes validated to stay within workspace
- **Rate limiting** — 10 messages per minute per user
- **Atomic file writes** — tmp + rename pattern for crash safety

---

## Key Design Decisions

### Why not text-based ReAct?
Text-based ReAct ("Thought: ... Action: ... Observation: ...") fails with local models because they narrate instead of following the format. Native tool calling through Ollama's API is deterministic — the model either returns `tool_calls` or content, never ambiguous.

### Why a router instead of one big model?
A single model with 15+ tools gets confused and picks wrong tools or hallucinates tool names. A router + specialist pattern means each model only sees 1-3 tools. Classification is a simpler task than execution, so a small fast model (phi4-mini) handles it perfectly.

### Why workspace files instead of config prompts?
Workspace files (SOUL.md, TOOLS.md, etc.) can be edited at runtime without restarting the bot. They're human-readable markdown. They give the model persistent identity and context. And they're the same pattern that works in production agent systems.

### Why not LangChain / CrewAI / AutoGen?
Those frameworks assume cloud model capabilities. Their agent loops, prompt templates, and tool schemas are designed for GPT-4-class models. LocalClaw is built ground-up for the constraints and strengths of local models.

---

## Running It

```bash
# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your Ollama URL, API keys, Discord token

# Start (Discord bot mode)
npx tsx src/index.ts

# Start (CLI REPL mode — when no channels are enabled)
npx tsx src/index.ts

# Test
npm test
```

---

## Project Structure

```
localclaw/
├── src/
│   ├── index.ts              Entry point
│   ├── orchestrator.ts       Lifecycle + message handling
│   ├── dispatch.ts           Router -> Specialist pipeline
│   ├── errors.ts             Error types
│   ├── config/               JSON5 config + Zod validation
│   ├── router/               Intent classification
│   ├── tool-loop/            Tool-calling loop engine
│   ├── ollama/               Ollama HTTP client
│   ├── channels/             Pluggable adapters (Discord, Telegram, Web)
│   ├── tools/                13 tool implementations
│   ├── agents/               Workspace bootstrap + routing
│   ├── sessions/             Transcript persistence
│   ├── cron/                 Scheduling service
│   ├── memory/               Keyword + vector search
│   └── browser/              Playwright wrapper
├── test/                     63 tests across 7 files
├── data/
│   ├── workspaces/main/      Agent workspace (SOUL.md, TOOLS.md, etc.)
│   ├── sessions/             Conversation transcripts
│   └── cron.json             Scheduled jobs
├── localclaw.config.json5    Configuration
└── .env                      API keys and tokens
```

---

## Extending LocalClaw

### Add a new tool
1. Create `src/tools/my-tool.ts` implementing `LocalClawTool`
2. Register in `src/tools/register-all.ts`
3. Add to a specialist's `tools` array in config

### Add a new channel adapter
1. Create `src/channels/myplatform/adapter.ts` implementing `ChannelAdapter` (5 methods)
2. Add dynamic import in `src/index.ts`
3. Add config: `myplatform: { enabled: true, token: "..." }`

### Add a new specialist category
1. Add category to `router.categories` in config
2. Add specialist config to `specialists` in config
3. (Optional) Add keyword patterns in `src/router/classifier.ts`

No core engine changes needed for any of these.

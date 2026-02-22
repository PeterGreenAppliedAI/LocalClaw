# LocalClaw Architecture

## Overview

LocalClaw is a local-model-first AI agent framework that runs entirely on your own hardware via Ollama. It solves a fundamental problem: foundation-model agent frameworks (like OpenClaw) fail with local models because local models narrate tool use instead of executing it, system prompts are too complex, and native function calling is unreliable with 15+ tools.

LocalClaw uses a **Router + Specialist** architecture where a small fast model classifies intent and dispatches to focused specialists that each see only 1-3 tools via Ollama's native tool calling API.

## Design Principles

1. **Work with the model, not against it** — Short prompts, few tools per specialist, native tool calling
2. **Deterministic execution** — No reliance on the model outputting correctly formatted text; structured API calls with fallback parsing
3. **Open/Closed** — New tools register, new adapters implement an interface; core engine never changes
4. **Local-first** — Zero cloud dependencies, no API costs, all data stays on your hardware
5. **Fail gracefully** — Keyword heuristic fallback when router fails, text parsing fallback when tool calling narrates, synthesis when max iterations hit

## System Architecture

```
                    Discord / Telegram / Web / (any adapter)
                                    |
                                    v
                    +-----------------------------------+
                    |          Orchestrator              |
                    |  - Rate limiting (10/min/user)     |
                    |  - Typing indicators               |
                    |  - Streaming response edits        |
                    |  - Command handling (!new, !reset) |
                    +-----------------------------------+
                                    |
                                    v
                    +-----------------------------------+
                    |        resolveRoute()              |
                    |  peer -> guild -> channel -> default|
                    |  Returns: agentId + sessionKey     |
                    +-----------------------------------+
                                    |
                                    v
                    +-----------------------------------+
                    |        dispatchMessage()           |
                    |  1. Load session transcript        |
                    |  2. Classify (router)              |
                    |  3. Route to specialist            |
                    |  4. Save turns to session          |
                    +-----------------------------------+
                            |               |
                    +-------+               +--------+
                    v                                v
        +-------------------+           +-------------------+
        |   Router           |           | Bare Chat         |
        |   (phi4-mini)      |           | (no tools)        |
        |                    |           | + workspace       |
        |   3-tier classify: |           |   context         |
        |   model -> keyword |           +-------------------+
        |   -> default       |
        +-------------------+
                    |
                    v (category)
        +-------------------+
        |   Specialist       |
        |   (qwen3-coder)    |
        |                    |
        |   ReAct Loop:      |
        |   1. chat(tools)   |
        |   2. tool_calls?   |
        |      -> execute    |
        |      -> observe    |
        |      -> loop       |
        |   3. content?      |
        |      -> answer     |
        +-------------------+
```

## Request Flow (Detailed)

```
User sends "@Teaching Bot what's the latest AI news?" in Discord
    |
    v
DiscordAdapter.messageCreate
    - Filter: not bot, allowed, mentioned (or ! command)
    - Strip mention tags
    - Start typing indicator (refresh every 5s)
    |
    v
Orchestrator.handleMessage
    - Rate limit check (10 msg/min/user)
    - resolveRoute() -> agentId="main", sessionKey="discord:guild:channel"
    |
    v
dispatchMessage()
    - Load last 20 turns from session transcript
    - classifyMessage() with phi4-mini
        Router prompt: "Classify into: chat, web_search, memory, exec, cron, message, website, multi"
        Returns: { category: "web_search", confidence: "model" }
    |
    v
runSpecialist()
    - Lookup specialist config: model=qwen3-coder:30b, tools=[web_search, web_fetch, browser]
    - Build system prompt + workspace context (SOUL.md, TOOLS.md, USER.md, etc.)
    - Inject source context for delivery targeting
    |
    v
runReActLoop()
    - Convert tools to Ollama format
    - POST /api/chat { model, messages, tools }
    |
    v
    Iteration 1: model returns tool_calls: [{ web_search: { query: "latest AI news 2026" } }]
        -> Execute web_search tool (Brave API)
        -> Observation: "1. OpenAI announces... 2. Google releases..."
        -> Append tool result to messages
    |
    v
    Iteration 2: model returns content: "Here are the latest AI developments..."
        -> Final answer
    |
    v
Save turns to session -> Send response to Discord
```

## Module Map

```
src/
├── index.ts                    Entry point (orchestrator or REPL)
├── orchestrator.ts             Lifecycle, channels, rate limiting, streaming
├── dispatch.ts                 Router -> Specialist pipeline
├── errors.ts                   Error codes and factory functions
│
├── config/
│   ├── loader.ts               JSON5 config with env var interpolation
│   ├── schema.ts               Zod validation schemas
│   └── types.ts                TypeScript types (Zod-inferred)
│
├── router/
│   ├── classifier.ts           3-tier classification (model -> keyword -> default)
│   └── prompt.ts               Router prompt builder
│
├── react/
│   ├── engine.ts               Tool-calling loop (native + fallback parser)
│   ├── parser.ts               Text-based tool call extraction
│   └── types.ts                ReActStep, ReActResult, ReActConfig
│
├── ollama/
│   ├── client.ts               HTTP client (chat, generate, embed, stream)
│   └── types.ts                Ollama API types
│
├── channels/
│   ├── registry.ts             Adapter registry + message routing
│   ├── types.ts                ChannelAdapter interface (5 methods)
│   ├── discord/adapter.ts      Discord.js integration
│   ├── telegram/adapter.ts     Grammy integration
│   └── web/adapter.ts          REST API adapter
│
├── tools/
│   ├── registry.ts             Tool registration + executor factory
│   ├── types.ts                LocalClawTool interface
│   ├── register-all.ts         Central registration point
│   ├── ssrf.ts                 SSRF protection
│   ├── web-search.ts           Brave/Perplexity/Grok/Tavily search
│   ├── web-fetch.ts            URL fetch + Readability extraction
│   ├── web-fetch-utils.ts      HTML/markdown utilities
│   ├── web-shared.ts           Response cache
│   ├── browser.ts              Playwright headless browser
│   ├── memory-search.ts        Keyword + vector search
│   ├── memory-get.ts           File read from workspace
│   ├── memory-save.ts          Append + embedding generation
│   ├── exec.ts                 Shell execution (allowlisted)
│   ├── read-file.ts            Safe file read
│   ├── write-file.ts           Safe file write
│   ├── cron-add.ts             Schedule jobs
│   ├── cron-list.ts            List jobs
│   ├── cron-remove.ts          Delete jobs
│   ├── send-message.ts         Cross-channel messaging
│   └── website-query.ts        Custom website API
│
├── agents/
│   ├── workspace.ts            Bootstrap 8 workspace files
│   ├── resolve-route.ts        Agent binding resolution
│   └── scope.ts                Workspace path helpers
│
├── sessions/
│   ├── store.ts                Atomic JSON transcript persistence
│   └── types.ts                ConversationTurn, SessionMetadata
│
├── cron/
│   ├── service.ts              Croner-based scheduling (timezone-aware)
│   ├── store.ts                JSON persistence
│   └── types.ts                CronJob, CronJobCreate
│
├── memory/
│   ├── search.ts               Keyword scoring on markdown sections
│   └── embeddings.ts           Vector store + cosine similarity
│
└── browser/
    └── client.ts               Playwright wrapper (snapshot, screenshot, navigate)
```

## Specialist System

| Category | Model | Tools | Purpose |
|----------|-------|-------|---------|
| chat | qwen3-coder:30b | (none) | Conversation, no tool loop |
| web_search | qwen3-coder:30b | web_search, web_fetch, browser | Internet research |
| memory | qwen3-coder:30b | memory_search, memory_get, memory_save | Persistent knowledge |
| exec | qwen3-coder:30b | exec, read_file, write_file | System operations |
| cron | qwen3-coder:30b | cron_add, cron_list, cron_remove | Task scheduling |
| message | qwen3-coder:30b | send_message | Cross-channel messaging |
| website | qwen3-coder:30b | website_query | Custom API integration |
| multi | qwen3-coder:30b | (decomposed) | Complex multi-step tasks |

**Why this works with local models:**
- Each specialist sees 1-3 tools maximum (not 15+)
- System prompts are short and focused
- Native tool calling via Ollama API (not text parsing)
- The model only needs to decide between a few options, not many

## Router Classification

Three-tier fallback:

1. **Model** (phi4-mini, ~50ms) — Fast small model classifies into one of 8 categories
2. **Keyword heuristics** — Pattern matching when model fails or times out
3. **Default** — Falls back to `chat` when nothing matches

Keyword patterns are ordered by specificity (exec before web_search) to prevent false positives.

## Tool Calling Strategy

LocalClaw uses Ollama's native `tools` parameter in `/api/chat`:

```typescript
// Tools sent to Ollama in OpenAI-compatible format
{
  model: "qwen3-coder:30b",
  messages: [...],
  tools: [{
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" }
        },
        required: ["query"]
      }
    }
  }]
}
```

**Fallback parser:** When models narrate tool calls instead of using structured `tool_calls` (non-deterministic behavior with qwen3-coder), the engine parses:
- XML-style: `<function=name><parameter=key>value</parameter></function>`
- Action-style: `Action: tool_name[{"key": "value"}]`

**Parameter unwrapping:** Some gateways nest args as `{"function":"name","parameters":{...}}` — the engine unwraps automatically.

## Adapter System

Adding a new channel adapter requires implementing 5 methods:

```typescript
interface ChannelAdapter {
  readonly id: string;
  connect(config: ChannelAdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  send(target: MessageTarget, content: MessageContent): Promise<void>;
  status(): ChannelStatus;
}
```

Then register it in `src/index.ts`:
```typescript
case 'slack': {
  const { SlackAdapter } = await import('./channels/slack/adapter.js');
  channelRegistry.register(new SlackAdapter());
  break;
}
```

And add config:
```json5
channels: {
  slack: { enabled: true, token: "${SLACK_BOT_TOKEN}" }
}
```

No core code changes. No type unions to extend.

## Workspace System

Each agent gets a workspace directory with 8 bootstrap files:

| File | Purpose | Injected Into |
|------|---------|---------------|
| SOUL.md | Persona, boundaries, vibe | All specialists |
| AGENTS.md | Operating instructions | All specialists |
| USER.md | User profile | All specialists |
| IDENTITY.md | Agent name, personality | All specialists |
| TOOLS.md | Capabilities description | All specialists |
| MEMORY.md | Long-term memory | Via memory_search tool |
| HEARTBEAT.md | Periodic task instructions | Cron triggers |
| BOOTSTRAP.md | First-run ritual | First conversations |

These files are injected into the system prompt on every request, giving the model persistent context about who it is, who the user is, and what it can do.

## Memory Architecture

**Dual-layer search:**

1. **Vector search** (primary) — Ollama `qwen3-embedding:8b` generates embeddings, stored in `data/embeddings.json`, retrieved via cosine similarity
2. **Keyword search** (fallback) — Markdown section splitting, keyword density scoring

When `memory_save` is called, content is:
- Appended to the markdown file (human-readable)
- Embedded and indexed in the vector store (machine-searchable)

## Session Management

- Transcripts stored as JSON arrays of `ConversationTurn` objects
- Atomic writes: write to `.tmp` file, then `rename()` (crash-safe)
- Last N turns loaded into specialist context (configurable, default 20)
- Session key derived from route: `discord:guildId:channelId` or `discord:dm:userId`
- `!new` / `!reset` commands clear the session file

## Cron System

- **Croner** library for real cron expression parsing
- Timezone-aware: `America/New_York` (EST/EDT)
- Jobs persisted to `data/cron.json`
- Trigger dispatches directly to stored category (skips router)
- Results delivered to the originating Discord channel

## Safety

- **Exec allowlist** — Only `ls`, `cat`, `python3`, `node`, `git` by default
- **SSRF protection** — DNS pre-flight blocks private IPs before fetch
- **Path traversal** — `memory_save` validates paths stay within workspace
- **Rate limiting** — 10 messages per minute per user
- **Atomic writes** — Session files use tmp+rename pattern
- **TLS** — `NODE_TLS_REJECT_UNAUTHORIZED=0` for dev (system CA bundle incomplete)

## Configuration

Single `localclaw.config.json5` file with environment variable interpolation (`${ENV_VAR}`):

```json5
{
  ollama: { url: "${OLLAMA_URL}", keepAlive: "30m" },
  router: { model: "phi4-mini", timeout: 2000, defaultCategory: "chat" },
  specialists: {
    chat: { model: "qwen3-coder:30b", tools: [], ... },
    web_search: { model: "qwen3-coder:30b", tools: ["web_search", "web_fetch", "browser"], ... },
    // ...
  },
  channels: {
    discord: { enabled: true, token: "${DISCORD_BOT_TOKEN}" },
  },
  // ...
}
```

## Technology Stack

- **Runtime:** Node.js 22+ (ESM)
- **Language:** TypeScript 5.7 (strict mode)
- **AI Backend:** Ollama (local inference)
- **Models:** phi4-mini (router), qwen3-coder:30b (specialists), qwen3-embedding:8b (memory)
- **Discord:** discord.js 14
- **Browser:** playwright-core (headless Chromium)
- **Scheduling:** croner
- **Validation:** zod
- **Config:** json5
- **Testing:** vitest (63 tests, 7 files)
- **Build:** tsdown

## Test Coverage

| Module | Tests | Coverage |
|--------|-------|----------|
| Config loader | 6 | Loading, defaults, env vars |
| Router classifier | 9 | Model, keywords, fallback |
| ReAct parser | 12 | Actions, final answers, malformed input |
| ReAct engine | 6 | Tool calls, errors, max iterations, multi-step |
| Dispatch pipeline | 5 | Categories, history, heuristics |
| Channel registry | 7 | Register, connect, disconnect, routing |
| SSRF protection | 18 | Private IPs, blocked hosts, edge cases |
| **Total** | **63** | |

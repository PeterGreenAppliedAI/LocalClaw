# CLAUDE.md — LocalClaw AI Code Generation Guidelines

## Architecture

LocalClaw uses a **Router + Specialist** pattern with a **tool-loop (ReAct) engine** and **deterministic pipelines**.

```
Channel (Discord/Telegram/Slack/Web/Gmail/WhatsApp/MS Graph/iMessage)
  -> Router (phi4:14b, classifies intent into one category)
    -> Pipeline (deterministic stages — most categories)
    -> OR Specialist (config-assigned model + ReAct tool-loop — chat, config, personal)
      -> Tool Executor (sandboxed via Docker or allowlist)
        -> Response back to channel
```

**Key components:**
- **Router** — phi4:14b, single-word classification into categories: `chat`, `web_search`, `memory`, `exec`, `cron`, `message`, `website`, `multi`, `config`, `task`, `research`, `personal`. Pre-model overrides for high-confidence patterns (PDF reports, calendar queries). Fallback to `defaultCategory` on timeout/parse failure. Implemented in `src/router/classifier.ts`.
- **Pipeline engine** — `src/pipeline/executor.ts`. Deterministic stage-based workflows: extract, tool, parallel_tool, llm, code, branch, llm_branch, loop. Most categories use pipelines instead of letting the model decide the workflow.
- **Plan pipeline** — `src/pipeline/definitions/plan.ts`. LLM decomposes goals into specialist sub-tasks, self-reflects, executes via foreman handoffs with write-through artifacts. Used by `multi` category.
- **Research pipeline** — `src/pipeline/definitions/research.ts`. Parallel search + fetch + synthesis + charts. Branches to reveal.js deck or styled PDF report with quality review.
- **Tool-loop engine** — `runToolLoop()` in `src/tool-loop/engine.ts`. ReAct-style loop with native Ollama tool calls + regex fallback parser. Includes hallucination detection, drift detection, error learning hints.
- **Dispatch pipeline** — `src/dispatch.ts` routes classified messages to specialists/pipelines. Handles 6-layer security enforcement, tool stripping, context isolation.
- **Briefing system** — `src/orchestrator.ts`. Separate from heartbeat. Runs at 8am/1:15pm/5pm. Gathers calendar + tasks + memory, runs CoT reasoning via qwen3-coder:30b, delivers contextual insights.
- **OllamaClient** — `src/ollama/client.ts`, REST API wrapper with single retry on connection failure.
- **DockerBackend** — `src/exec/docker-backend.ts`, sandboxed command execution.

**Data flow:** Channel message -> session resolution -> Router classification (pre-model overrides → model → keyword fallback) -> Security filtering (6 layers) -> Pipeline or Specialist dispatch -> tool-loop execution -> [FILE:] token extraction -> response to channel -> transcript persistence.

### Memory System

Memory uses **structured facts** with per-user isolation — JSONL index + consolidated JSON/Markdown.

**Storage layout (per-user):**
```
workspace/
  memory/
    last-review.json                # Marker: timestamp of last heartbeat transcript review
    <senderId>/
      raw/YYYY-MM-DD/mem_<ts>.md    # Append-only raw facts with YAML frontmatter
      index/YYYY-MM-DD.jsonl        # One JSONL line per FactEntry (fast scan)
      facts/facts.json              # Machine-readable FactEntry[]
      facts/facts.md                # Human-readable, sectioned by category
      pending.json                  # Temp: fact candidates awaiting user approval (from !reset)
  .learnings/
    errors.jsonl                    # Tool execution error history (for error learning)
  LEARNINGS.md                      # Promoted recurring error patterns (loaded into specialist context)
```

**Fact extraction paths:**
1. **`!reset` (user-approved)** — On session clear, facts extracted via router model, candidates shown. User replies `!save` or `!discard`.
2. **Heartbeat (autonomous)** — Every 2 hours, `reviewTranscripts()` scans sessions, extracts facts, writes directly.
3. **`memory_forget`** — Removes facts by text match. Pipeline branch: save/recall/forget.

**Search:** `memory_search` checks per-user `facts/facts.json` first (keyword scoring with tag/entity boost), then shared facts, then workspace markdown files. `source="knowledge"` for vector search over imported documents.

**Self-improvement store:** `.learnings/errors.jsonl` records tool failures. Before tool execution, `findHints()` checks for matching past errors and prepends hints. `enrichObservation()` scans tool output for 8 known error patterns (permission denied, timeout, 404, rate limit, etc.) and enriches with suggestions. Recurring patterns (3+ occurrences) promoted to `LEARNINGS.md` via heartbeat.

---

## Code Standards

### Error Handling

Use the error factory in `src/errors.ts` — never ad-hoc try/catch with raw `Error` or `console.error`.

```typescript
// CORRECT — use factory functions
import { toolExecutionError, ollamaUnreachable } from './errors.js';
throw toolExecutionError('web_search', cause);

// WRONG — ad-hoc error
throw new Error('Tool failed');
console.error('Something broke:', err);
```

**Available error codes:** `ROUTER_TIMEOUT`, `ROUTER_PARSE_FAILURE`, `REACT_MAX_ITERATIONS`, `REACT_PARSE_FAILURE`, `TOOL_EXECUTION_ERROR`, `TOOL_NOT_FOUND`, `OLLAMA_UNREACHABLE`, `OLLAMA_INFERENCE_ERROR`, `CONFIG_INVALID`, `CHANNEL_CONNECT_ERROR`, `CHANNEL_SEND_ERROR`, `SSRF_BLOCKED`, `SESSION_IO_ERROR`, `PIPELINE_STAGE_ERROR`, `PIPELINE_EXTRACT_FAILURE`.

Each has a corresponding factory function. All errors are `LocalClawError` instances with a `code` property.

### Module System

**ESM only.** Never use `require()`. Always use `import`/`export` with `.js` extensions on relative imports.

```typescript
// CORRECT
import { writeFileSync } from 'node:fs';
import { FactStore } from '../memory/fact-store.js';

// WRONG
const fs = require('node:fs');
```

### Security

Channel security is enforced in `src/dispatch.ts` via 6 layered filters applied in order:

1. `allowedCategories` — whitelist of categories this channel can access
2. `restrictedCategories` — blocked for untrusted users
3. `ownerOnlyTools` — stripped for everyone except `config.ownerId` (code gate, not model-level)
4. `blockedTools` — stripped for everyone on this channel
5. `restrictedTools` — stripped for untrusted users
6. `confirmTools` — preview before execution, requires user confirmation

**Owner-only tier:** `ownerId` in config is a single string (not a list). Tools in `ownerOnlyTools` are completely invisible to non-owners — the model never sees them in the tool list. This is a **code gate** checked before any model involvement.

Additional security:
- SSRF protection in `src/tools/ssrf.ts` — all URL-fetching tools must use it.
- Exec security: Docker sandbox or command allowlist, configured per `config.tools.exec.security`.
- Cron safety: `cronMode` strips write tools. Jobs retry 2x with exponential backoff + notify on final failure.
- Pipeline isolation: all pipeline dispatches get fresh context (no parent session history).

### SOLID / DRY / YAGNI / KISS

- **Single responsibility** per module. Tools do one thing. Adapters implement 5 methods. Router classifies.
- **Open/Closed** — New tools implement `LocalClawTool` interface without changing core. New adapters implement `ChannelAdapter` without changing core.
- **No speculative features** — Only build what has a real use case now.
- **Reuse existing utilities** — Check `src/tools/`, `src/errors.ts`, `src/config/` before creating new abstractions.
- **Simple systems fail predictably** — Prefer straightforward logic over clever abstractions.

### Contracts & Types

- Zod schemas in `src/config/schema.ts` are the **source of truth** for configuration.
- TypeScript types are inferred from Zod: `type LocalClawConfig = z.infer<typeof LocalClawConfigSchema>` (in `src/config/types.ts`).
- **Never duplicate types** — always derive from Zod schemas using `z.infer<>`.
- Config flow: JSON5 file -> env variable interpolation -> Zod parse/validate -> TypeScript types.

### Tools

- Must implement the `LocalClawTool` interface from `src/tools/types.ts`:
  ```typescript
  interface LocalClawTool {
    name: string;
    description: string;
    parameterDescription: string;
    parameters?: ToolParameterSchema;  // structured params for native tool calling
    example?: string;
    category: string;
    execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  }
  ```
- Each tool is created by a factory function: `createXxxTool(deps) -> LocalClawTool`.
- Register new tools in `src/tools/register-all.ts` via `registry.register(tool)`.
- Tool descriptions should include: WHEN TO USE, DO NOT, and common chain patterns.
- Tool results are truncated to `MAX_TOOL_RESULT_CHARS` (2000, 8000 for browser) by the tool-loop engine.
- Tool params are validated and type-coerced at runtime (`validateToolParams()` in engine.ts).
- `[FILE:path]` tokens in tool output are stripped before the model sees them and re-appended after the final answer for media delivery.

### Dependencies

- No new dependencies without justification. Node 22+ built-ins preferred.
- Current stack: zod, discord.js, better-sqlite3, croner, json5, playwright-core, googleapis, @slack/bolt, @whiskeysockets/baileys, @azure/identity.

---

## File Map

```
src/
  index.ts                  # Entry point (REPL or Orchestrator mode)
  orchestrator.ts           # Main class: lifecycle, heartbeat, briefing, commands
  dispatch.ts               # Router → Specialist/Pipeline + 6-layer security
  errors.ts                 # Error codes + factory functions (single choke point)
  metrics.ts                # Logging/telemetry

  config/                   # Configuration
    schema.ts               #   Zod schemas (source of truth)
    types.ts                #   z.infer<> type exports
    loader.ts               #   JSON5 config loading + env interpolation

  pipeline/                 # Deterministic pipeline engine
    executor.ts             #   Stage runner (extract, tool, llm, code, branch, loop, parallel_tool)
    registry.ts             #   Pipeline registry
    types.ts                #   Stage types, PipelineContext
    extractor.ts            #   LLM-based parameter extraction with JSON repair
    definitions/            #   Pipeline definitions per category
      plan.ts               #     Plan pipeline (foreman handoffs, skill check, reflection)
      research.ts           #     Research pipeline (parallel search, charts, deck/report branch)
      heartbeat.ts          #     Deterministic heartbeat (task board + memory, no LLM date reasoning)
      cron.ts, task.ts, memory.ts, web-search.ts, exec.ts, message.ts, website.ts

  tool-loop/                # ReAct execution engine
    engine.ts               #   runToolLoop() — core loop + drift detection + error learning
    parser.ts               #   parseReActResponse() — regex parser + JSON5 repair
    prompt-builder.ts       #   buildReActSystemPrompt(), buildScratchpad()
    types.ts                #   ReActStep, ReActResult, ReActConfig

  tools/                    # 34 tool implementations
    types.ts                #   LocalClawTool, ToolContext, ToolExecutor interfaces
    registry.ts             #   ToolRegistry class
    register-all.ts         #   registerAllTools() — wires all tools
    ssrf.ts                 #   SSRF protection for URL-fetching tools
    document.ts             #   LibreOffice headless document creation/conversion
    gmail-read.ts           #   Gmail search + read (OAuth2, read-only)
    calendar-read.ts        #   Google Calendar list + search (OAuth2, read-only)
    memory-forget.ts        #   Remove facts by text match
    *.ts                    #   Individual tool factories (createXxxTool)

  learnings/                # Self-improvement system
    error-store.ts          #   ErrorLearningStore — JSONL store for tool failures
    pattern-matcher.ts      #   detectErrorPattern() + enrichObservation()

  channels/                 # Channel adapters (all support file attachments)
    types.ts                #   ChannelAdapter, InboundMessage, MessageTarget, MessageContent
    registry.ts             #   ChannelRegistry class
    discord/                #   Discord adapter (discord.js)
    telegram/               #   Telegram adapter (grammy)
    slack/                  #   Slack adapter (@slack/bolt)
    web/                    #   Web API adapter + voice UI
    gmail/                  #   Gmail adapter (googleapis)
    msgraph/                #   MS Graph adapter (@azure/identity)
    whatsapp/               #   WhatsApp adapter (@whiskeysockets/baileys)
    imessage/               #   iMessage adapter (BlueBubbles REST API)

  router/                   # Message classification
    classifier.ts           #   classifyMessage() — pre-model overrides → model → keyword fallback
    prompt.ts               #   Router prompt template

  ollama/                   # LLM inference
    client.ts               #   OllamaClient (REST API wrapper, single retry on connection failure)
    types.ts                #   OllamaMessage, OllamaTool, OllamaToolCall

  skills/                   # Self-improving procedural memory
    store.ts                #   SkillStore — save/load/update skill files
    matcher.ts              #   findMatchingSkill() — keyword scoring with threshold + ratio check

  agents/                   # Agent routing & workspace
    resolve-route.ts        #   Binding-based agent routing
    scope.ts                #   Workspace path resolution
    workspace.ts            #   Workspace bootstrap + context building (LEARNINGS.md in minimal)

  exec/                     # Command execution
    docker-backend.ts       #   DockerBackend (sandboxed exec)
    session-manager.ts      #   SessionManager for code sessions

  context/                  # Context management
    budget.ts               #   computeBudget()
    compactor.ts            #   buildCompactedHistory()
    tokens.ts               #   estimateTokens() — word-aware heuristic

  memory/                   # Memory system
    fact-store.ts           #   FactStore (JSONL index, dedup, TTL, consolidation, removeFact)
    embeddings.ts           #   EmbeddingStore (SQLite + vectors, used for knowledge_import)
    consolidation.ts        #   consolidateFactsWithLLM() — LLM-driven dedup
    search.ts               #   searchMarkdownFiles() — keyword search over workspace .md files

  cron/                     # Scheduling
    service.ts              #   CronService (retry 2x with exponential backoff)
    store.ts                #   CronStore

  sessions/                 # Session persistence
    store.ts                #   SessionStore (JSON transcripts)

  services/                 # Shared services
    attachments.ts          #   saveAttachment(), isImageMime()
    tts.ts, stt.ts          #   Text-to-speech, speech-to-text
    vision.ts               #   VisionService

  console/                  # Management console API
    api.ts                  #   Route handler
    handlers/               #   Per-resource handlers (status, channels, cron, tasks, tools, etc.)

  tasks/                    # Task management
    store.ts                #   TaskStore

  setup/                    # Interactive setup wizard
    index.ts                #   Entry point
    steps/                  #   Individual setup steps
```

---

## Patterns to Follow

### Error factory pattern (`src/errors.ts`)
All errors use `LocalClawError` with a typed `ErrorCode`. One factory function per error type.
```typescript
export const toolExecutionError = (tool: string, cause: unknown) =>
  new LocalClawError('TOOL_EXECUTION_ERROR', `Tool "${tool}" failed`, cause);
```

### Tool registration pattern (`src/tools/register-all.ts`)
Each tool is a factory function that takes dependencies and returns a `LocalClawTool`. Tools are conditionally registered based on config/availability.
```typescript
const webSearch = createWebSearchTool(config.tools?.web?.search);
registry.register(webSearch);
```

### Tool description pattern
Tool descriptions include WHEN TO USE, DO NOT, and common chains:
```typescript
description: `Read file contents. WHEN TO USE: Need to read a file from a prior step.
DO NOT use exec[cat] — always use read_file.`
```

### Channel adapter pattern (`src/channels/registry.ts`)
5-method `ChannelAdapter` interface. All adapters must handle `content.attachments` for file delivery. Open/Closed: add new adapter = implement interface + register.

### Config flow
JSON5 -> env interpolation -> Zod validation -> TypeScript types. Never hand-write config types — always `z.infer<typeof XxxSchema>`.

### Security enforcement in dispatch (`src/dispatch.ts`)
6-layer filtering: allowedCategories → ownerOnlyTools (code gate) → restrictedCategories (untrusted) → blockedTools → restrictedTools (untrusted) → confirmTools (preview). Each layer narrows what a message can do.

### [FILE:] token pattern
Document/media tools return `[FILE:path]` tokens. These are:
1. **Stripped** from tool observations before the model sees them (engine.ts)
2. **Stripped** from plan pipeline results before summarization LLM (plan.ts)
3. **Re-appended** to the final answer after all LLM processing
4. **Extracted** by `extractMediaAttachments()` in orchestrator.ts for channel delivery

### Foreman handoff pattern (`src/pipeline/definitions/plan.ts`)
Plan pipeline sub-dispatches use structured briefings (not raw result dumps):
- Write full step results to `.plan-artifacts/step-N.txt`
- Build handoff message with: task, plan context, completed steps (status + artifact paths), available artifacts
- Specialists use `read_file` to access prior step content on demand

### Pipeline isolation
All pipeline dispatches get fresh context — no parent session history. Prevents prior conversation topics from biasing pipeline execution.

### Context priority layers (`src/agents/workspace.ts`)
Tool-using specialists get `minimal` workspace context (SOUL.md + IDENTITY.md + LEARNINGS.md) to preserve token budget. Chat gets `full` context.

### Tool-loop guardrails (`src/tool-loop/engine.ts`)
- **Hallucination detection** — catches models claiming actions without tool calls. Repair prompt sent once.
- **Drift detection** — catches repeating tool calls, hedging language, growing responses. Re-anchor prompt after 3+ iterations.
- **Error learning** — records failures, hints before execution, enriches observations with pattern suggestions.
- **Param validation** — runtime type coercion (string→number, string→boolean) + enum + required field checks before execution.

### Heartbeat vs Briefing
- **Heartbeat** (every 2h): maintenance only — transcript review, fact extraction, learning promotion, media cleanup, memory consolidation. Dispatches report via plan pipeline.
- **Briefing** (8am, 1:15pm, 5pm): gathers calendar + tasks + memory directly via tool executor, runs CoT reasoning, delivers contextual insight. Separate cron, separate method.

---

## Patterns to Avoid

### Silent error swallowing
```typescript
// BAD
).catch(() => {});

// GOOD
).catch(err => console.warn('[Context] Send failed:', err instanceof Error ? err.message : err));
```

### Duplicating types instead of using Zod inference
```typescript
// BAD
interface MyConfig { url: string; timeout: number; }

// GOOD
const MyConfigSchema = z.object({ url: z.string(), timeout: z.number() });
type MyConfig = z.infer<typeof MyConfigSchema>;
```

### Using require() in ESM
```typescript
// BAD
const { writeFileSync } = require('node:fs');

// GOOD
import { writeFileSync } from 'node:fs';
```

### Passing [FILE:] tokens to the model
Never let the model see `[FILE:path]` tokens — it will rewrite them into fake markdown links. Strip before the model sees the observation, re-append after the model produces the final answer.

### Heartbeat/cron matching saved skills
System operations (heartbeat, cron) should never match or save user-facing skills. Check for heartbeat signatures in `skill_check` and `skill_save` stages.

---

## Testing

- **Framework:** Vitest (`npm test` / `vitest run`)
- **Type checking:** `npx tsc --noEmit`
- **CI:** GitHub Actions runs type check + tests + build on every push/PR to main
- **Current:** 226 tests across 20 files
- **What needs tests** (Tier 2+ per code_rubric):
  - Auth/authz logic (owner-only tier, security filtering)
  - Networking (Ollama client, web fetch, SSRF checks)
  - Persistence (session store, memory, cron store, error learning store)
  - Concurrency (tool-loop iteration limits, timeouts)
  - Error handling changes (error factory coverage)
  - Security controls (dispatch filtering, exec sandboxing)
  - New tools (document tool, Gmail/Calendar tools)
- Tier 0-1 (docs, formatting, UI text) — tests optional.
- Tier 3 (security controls, PII, remote execution) — mandatory full coverage.

---

## Review Checklist

Condensed from the Universal Code Review Rubric (9 gates):

1. **Intent** — Does the change match what was asked? No scope creep?
2. **Correctness** — Contracts honored? Zod schemas updated if config changes? Types derived, not duplicated?
3. **Failure semantics** — Uses error factory? No silent catches? Timeouts bounded? Retries idempotent?
4. **Security** — All 6 dispatch layers intact? Owner-only gate checked? SSRF on URLs? Exec sandboxed? No trust escalation?
5. **Data integrity** — State mutations atomic? Session/memory writes consistent? No partial updates on error?
6. **Concurrency** — Tool-loop bounded by maxIterations? Async operations properly awaited? No race conditions?
7. **Observability** — Errors have codes? Key operations logged? Metrics updated?
8. **Tests** — Tier 2+ changes have test evidence? Edge cases covered?
9. **Maintainability** — Single responsibility? Reuses existing patterns? No speculative abstractions? ESM imports (no require)?

**Merge rules:** Any blocker = no merge. Tier 2+: all 9 gates pass. Tier 3: security + failure gates must be strong.

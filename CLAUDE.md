# CLAUDE.md — LocalClaw AI Code Generation Guidelines

## Architecture

LocalClaw uses a **Router + Specialist** pattern with a **tool-loop (ReAct) engine**.

```
Channel (Discord/Telegram/Slack/Web/Gmail/WhatsApp/MS Graph)
  -> Router (phi4-mini, classifies intent into one category)
    -> Specialist (config-assigned model + focused tool-loop, 1-3 tools)
      -> Tool Executor (sandboxed via Docker or allowlist)
        -> Response back to channel
```

**Key components:**
- **Router** — Small fast model, single-word classification into categories: `chat`, `web_search`, `memory`, `exec`, `cron`, `message`, `website`, `multi`. Fallback to `defaultCategory` on timeout/parse failure. Implemented in `src/router/classifier.ts`.
- **Tool-loop engine** — `runToolLoop()` in `src/tool-loop/engine.ts`. ReAct-style loop: build prompt, call Ollama, parse response (native tool calls or regex fallback via `parseReActResponse()`), execute tool, repeat until Final Answer or max iterations.
- **Dispatch pipeline** — `src/dispatch.ts` routes classified messages to specialists. Handles channel security enforcement, tool stripping, and multi-orchestration.
- **OllamaClient** — `src/ollama/client.ts`, REST API wrapper for local model inference.
- **DockerBackend** — `src/exec/docker-backend.ts`, sandboxed command execution.

**Data flow:** Channel message -> session resolution -> Router classification -> Specialist dispatch -> tool-loop execution -> response to channel -> transcript persistence.

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

**Available error codes:** `ROUTER_TIMEOUT`, `ROUTER_PARSE_FAILURE`, `REACT_MAX_ITERATIONS`, `REACT_PARSE_FAILURE`, `TOOL_EXECUTION_ERROR`, `TOOL_NOT_FOUND`, `OLLAMA_UNREACHABLE`, `OLLAMA_INFERENCE_ERROR`, `CONFIG_INVALID`, `CHANNEL_CONNECT_ERROR`, `CHANNEL_SEND_ERROR`, `SSRF_BLOCKED`, `SESSION_IO_ERROR`.

Each has a corresponding factory function (e.g., `routerTimeout(ms)`, `toolExecutionError(tool, cause)`). All errors are `LocalClawError` instances with a `code` property.

### Security

- Channel security is enforced in `src/dispatch.ts` (lines 139-178). Never bypass this pipeline.
- `allowedCategories` restricts which categories a channel can access.
- `blockedTools` strips tools from specialists for a channel.
- `restrictedTools` strips tools for untrusted users.
- `restrictedCategories` blocks categories for untrusted users.
- SSRF protection in `src/tools/ssrf.ts` — all URL-fetching tools must use it.
- Exec security: Docker sandbox or command allowlist, configured per `config.tools.exec.security`.

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
    category: string;
    execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  }
  ```
- Each tool is created by a factory function: `createXxxTool(deps) -> LocalClawTool`.
- Register new tools in `src/tools/register-all.ts` via `registry.register(tool)`.
- Tool results are truncated to `MAX_TOOL_RESULT_CHARS` (2000) by the tool-loop engine.

### Dependencies

- No new dependencies without justification. Node 22+ built-ins preferred.
- Current stack: zod, discord.js, better-sqlite3, croner, json5, playwright-core, googleapis, @slack/bolt, @whiskeysockets/baileys, @azure/identity.

---

## File Map

```
src/
  index.ts                  # Entry point (REPL or Orchestrator mode)
  orchestrator.ts           # Main class: wires all components together
  dispatch.ts               # Router -> Specialist pipeline + security enforcement
  errors.ts                 # Error codes + factory functions (single choke point)
  metrics.ts                # Logging/telemetry

  config/                   # Configuration
    schema.ts               #   Zod schemas (source of truth)
    types.ts                #   z.infer<> type exports
    loader.ts               #   JSON5 config loading + env interpolation

  tool-loop/                # ReAct execution engine (PRD calls this "react/")
    engine.ts               #   runToolLoop() — core loop
    parser.ts               #   parseReActResponse() — regex parser + JSON5 repair
    prompt-builder.ts       #   buildReActSystemPrompt(), buildScratchpad()
    types.ts                #   ReActStep, ReActResult, ReActConfig

  tools/                    # Tool implementations
    types.ts                #   LocalClawTool, ToolContext, ToolExecutor interfaces
    registry.ts             #   ToolRegistry class
    register-all.ts         #   registerAllTools() — wires all tools
    ssrf.ts                 #   SSRF protection for URL-fetching tools
    *.ts                    #   Individual tool factories (createXxxTool)

  channels/                 # Channel adapters
    types.ts                #   ChannelAdapter, InboundMessage, MessageTarget
    registry.ts             #   ChannelRegistry class
    discord/                #   Discord adapter (discord.js)
    telegram/               #   Telegram adapter
    slack/                  #   Slack adapter (@slack/bolt)
    web/                    #   Web API adapter + voice UI
    gmail/                  #   Gmail adapter (googleapis)
    msgraph/                #   MS Graph adapter (@azure/identity)
    whatsapp/               #   WhatsApp adapter (@whiskeysockets/baileys)

  router/                   # Message classification
    classifier.ts           #   classifyMessage()
    prompt.ts               #   Router prompt template

  ollama/                   # LLM inference
    client.ts               #   OllamaClient (REST API wrapper)
    types.ts                #   OllamaMessage, OllamaTool, OllamaToolCall

  agents/                   # Agent routing & workspace
    resolve-route.ts        #   Binding-based agent routing
    scope.ts                #   Workspace path resolution
    workspace.ts            #   Workspace bootstrap + context building

  exec/                     # Command execution
    docker-backend.ts       #   DockerBackend (sandboxed exec)
    session-manager.ts      #   SessionManager for code sessions

  context/                  # Context management
    budget.ts               #   computeBudget()
    compactor.ts            #   buildCompactedHistory()
    tokens.ts               #   estimateMessagesTokens()

  memory/                   # Memory system
    embeddings.ts           #   EmbeddingStore (SQLite + vectors)
    consolidation.ts        #   Memory consolidation
    search.ts               #   Search utilities

  cron/                     # Scheduling
    service.ts              #   CronService
    store.ts                #   CronStore

  sessions/                 # Session persistence
    store.ts                #   SessionStore (JSON transcripts)

  services/                 # Shared services
    attachments.ts          #   saveAttachment(), isImageMime()
    tts.ts, stt.ts          #   Text-to-speech, speech-to-text
    vision.ts               #   VisionService

  setup/                    # Interactive setup wizard
    index.ts                #   Entry point
    steps/                  #   Individual setup steps

  tasks/                    # Task management
    store.ts                #   TaskStore
```

---

## Patterns to Follow

### Error factory pattern (`src/errors.ts`)
All errors use `LocalClawError` with a typed `ErrorCode`. One factory function per error type. Single choke point per AI_principles section 8.
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

### Channel adapter pattern (`src/channels/registry.ts`)
5-method `ChannelAdapter` interface. Open/Closed: add new adapter = implement interface + register. Zero core code changes.

### Config flow
JSON5 -> env interpolation -> Zod validation -> TypeScript types. Never hand-write config types — always `z.infer<typeof XxxSchema>`.

### Security enforcement in dispatch (`src/dispatch.ts:139-178`)
Layered filtering: allowedCategories -> restrictedCategories (untrusted) -> blockedTools -> restrictedTools (untrusted). Each layer narrows what a message can do.

### Tool-loop with hallucination detection (`src/tool-loop/engine.ts`)
Action hallucination detector catches models that claim to perform actions without actually calling tools. Repair prompt sent once. Only the FIRST parsed tool call is executed per iteration to prevent hallucination chains.

---

## Patterns to Avoid

### Silent error swallowing
```typescript
// BAD — found in orchestrator.ts:268, :283, :395, :477
).catch(() => {});
```
Silently swallowing errors hides failures. Use error factory + structured logging.

### console.error instead of error factory
```typescript
// BAD — found in orchestrator.ts:79, :249, :337, :466
console.error('[Orchestrator] PDF extraction failed:', err);
throw new Error('Ollama unreachable');  // should be ollamaUnreachable()
```
Always wrap errors in `LocalClawError` using the factory functions.

### Ad-hoc try/catch without domain error wrapping
```typescript
// BAD — found in orchestrator.ts:248-250, :204-206, :465-480
} catch (err) {
  console.error('[Heartbeat] Error:', err instanceof Error ? err.message : err);
}
```
Catch blocks must wrap in domain errors (`LocalClawError`) and use structured error codes.

### Duplicating types instead of using Zod inference
```typescript
// BAD
interface MyConfig { url: string; timeout: number; }

// GOOD
const MyConfigSchema = z.object({ url: z.string(), timeout: z.number() });
type MyConfig = z.infer<typeof MyConfigSchema>;
```

---

## Testing

- **Framework:** Vitest (`npm test` / `vitest run`)
- **Type checking:** `npx tsc --noEmit`
- **What needs tests** (Tier 2+ per code_rubric):
  - Auth/authz logic
  - Networking (Ollama client, web fetch, SSRF checks)
  - Persistence (session store, memory, cron store)
  - Concurrency (tool-loop iteration limits, timeouts)
  - Error handling changes (error factory coverage)
  - Security controls (dispatch filtering, exec sandboxing)
- Tier 0-1 (docs, formatting, UI text, internal logic behind existing interfaces) — tests optional but appreciated.
- Tier 3 (security controls, crypto, PII, remote execution) — mandatory full coverage, security + failure gates must score 2/2.

---

## Review Checklist

Condensed from the Universal Code Review Rubric (9 gates):

1. **Intent** — Does the change match what was asked? No scope creep?
2. **Correctness** — Contracts honored? Zod schemas updated if config changes? Types derived, not duplicated?
3. **Failure semantics** — Uses error factory? No silent catches? Timeouts bounded? Retries idempotent?
4. **Security** — Dispatch filtering intact? SSRF checks on URLs? Exec sandboxed? No trust escalation?
5. **Data integrity** — State mutations atomic? Session/memory writes consistent? No partial updates on error?
6. **Concurrency** — Tool-loop bounded by maxIterations? Async operations properly awaited? No race conditions?
7. **Observability** — Errors have codes? Key operations logged? Metrics updated?
8. **Tests** — Tier 2+ changes have test evidence? Edge cases covered?
9. **Maintainability** — Single responsibility? Reuses existing patterns? No speculative abstractions?

**Merge rules:** Any blocker = no merge. Tier 2+: all 9 gates pass. Tier 3: security + failure gates must be strong.

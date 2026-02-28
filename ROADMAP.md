# LocalClaw Roadmap

LocalClaw is a local-model-first AI agent framework running on personal infrastructure (DGX Spark, A5000 GPU node). It handles Discord, WhatsApp, and Web voice with a Router + Specialist architecture on Ollama. The core loop works — now it's time to harden, extend, and make it smarter.

This roadmap organizes the next phase of development into prioritized milestones.

> **Note:** The PRD refers to `src/react/` but the implementation directory is `src/tool-loop/`. The architecture is the same (ReAct-style loop), the naming evolved during implementation to avoid confusion with the React UI framework.

---

## Completed

- **Setup Wizard** — Interactive `npm run setup` flow that walks through Ollama connectivity, model selection, channel configuration, workspace bootstrap, and config generation. Implemented in `src/setup/`.

---

## Milestone 1: Auth & Security Hardening

**Why first:** Everything else (new adapters, multi-user, external integrations) depends on a solid auth foundation.

### 1.1 Formalize RBAC Config

- Replace binary trusted/untrusted with named roles (`owner`, `admin`, `user`, `guest`)
- Define per-role permissions: categories, tools, rate limits
- Add role config to `ChannelSecuritySchema` alongside existing `trustedUsers`
- **Files:** `src/config/schema.ts`, `src/config/types.ts`, `src/dispatch.ts`

### 1.2 Audit Logging

- Log all security decisions, tool executions, and user actions to `data/audit.jsonl`
- Include: timestamp, userId, channel, category, tools used, outcome
- Rotation: daily files, configurable retention
- **Files:** New `src/services/audit.ts`, hooks in `src/dispatch.ts` and `src/orchestrator.ts`

### 1.3 Web API Authentication

- Add API key auth for `POST /api/message` and `POST /api/voice`
- Bearer token validation middleware
- Rate limit per API key (not just per userId)
- **Files:** `src/channels/web/adapter.ts`, `src/config/schema.ts`

### 1.4 OAuth2 Token Vault

- Centralized encrypted store for external service tokens (GSuite, CRM, etc.)
- Refresh token rotation for OAuth2 flows
- Token-per-service config in `localclaw.config.json5`
- **Files:** New `src/auth/token-vault.ts`, `src/config/schema.ts`

### 1.5 Multi-User Identity (Future)

- User accounts with login (web UI)
- Per-user permission profiles
- Cross-channel user linking (same person on Discord + WhatsApp)
- **Depends on:** 1.1, 1.3

---

## Milestone 2: Context Engineering

**Why next:** Workspace context can drown out actual results. This is the highest-leverage improvement for response quality.

### 2.1 Context Priority Layers

- Implement weighted priority: tool results > conversation history > workspace context
- Reduce workspace injection for tool-using specialists (web_search, exec) to SOUL.md only
- Keep full workspace context for chat specialist
- **Files:** `src/agents/workspace.ts` (`buildWorkspaceContext`), `src/dispatch.ts`

### 2.2 Dynamic Context Budget

- Measure actual token usage per context section (workspace, history, tools)
- Auto-shrink lower-priority sections when budget is tight
- Add telemetry: log token allocation per request for tuning
- **Files:** `src/context/budget.ts`, `src/context/compactor.ts`

### 2.3 Smarter Compaction

- Fix compaction loop that produced 15+ duplicate entries in MEMORY.md
- Deduplicate compaction flushes before writing (hash-based check)
- Add compaction quality metric: measure info preservation vs. compression ratio
- **Files:** `src/context/compactor.ts`, `src/memory/consolidation.ts`

### 2.4 Source Attribution

- Tag context sections so the model knows origin (workspace vs. search result vs. memory)
- Wrap injected context in labeled blocks: `[SOURCE: web_search] ...`, `[SOURCE: workspace] ...`
- Helps model prioritize external data over self-description
- **Files:** `src/dispatch.ts`, `src/tool-loop/engine.ts`

---

## Milestone 3: Memory Engineering

**Why:** Memory is the long-term brain. Current implementation works but has scaling and retrieval quality issues.

### 3.1 Memory Namespacing

- Separate memory spaces: `facts`, `preferences`, `conversations`, `knowledge`
- Allow scoped search (e.g., "search only facts" vs. "search everything")
- Add namespace field to `memory_chunks` table
- **Files:** `src/memory/embeddings.ts`, `src/tools/memory-save.ts`, `src/tools/memory-search.ts`

### 3.2 Memory Decay & Relevance

- Add access tracking: `last_accessed_at`, `access_count` fields
- Decay score for old, unused entries
- Auto-archive entries below relevance threshold
- **Files:** `src/memory/embeddings.ts`, new `src/memory/decay.ts`

### 3.3 Hybrid Retrieval (BM25 + Vector)

- Add BM25/TF-IDF scoring alongside vector cosine similarity
- Reciprocal rank fusion to merge results
- Better handling of exact keyword matches (names, dates, IDs)
- **Files:** `src/memory/search.ts`, `src/memory/embeddings.ts`

### 3.4 Memory Import/Export

- Bulk import from JSON/CSV for bootstrapping
- Export memory graph for backup/migration
- **Files:** New `src/memory/import-export.ts`, `src/tools/memory-save.ts`

---

## Milestone 4: GSuite Integration

**Why:** Full GSuite turns the bot into a productivity hub — calendar awareness, doc access, spreadsheet data.

### 4.1 Google Calendar Tools

- Read events, create events, check availability
- Implemented as **tools** (not a channel adapter — Calendar doesn't receive messages)
- Tools: `calendar_list`, `calendar_create`, `calendar_check`
- OAuth2 via token vault (M1.4)
- **Files:** New `src/tools/google-calendar.ts`, `src/tools/register-all.ts`

### 4.2 Google Drive Tools

- Search files, read doc content, list recent files
- Tools: `drive_search`, `drive_read`, `drive_list`
- Support Docs, Sheets, and PDF export
- **Files:** New `src/tools/google-drive.ts`

### 4.3 Google Sheets Tools

- Read/write cells, append rows, read ranges
- Tools: `sheets_read`, `sheets_write`, `sheets_append`
- Useful for CRM data, pipeline tracking, reporting
- **Files:** New `src/tools/google-sheets.ts`

### 4.4 Gmail Enhancement

- Existing adapter handles inbound — add outbound compose tool
- Tool: `email_send` (compose and send via Gmail API)
- Template support for common email types
- **Files:** `src/channels/gmail/adapter.ts`, new `src/tools/email-send.ts`

---

## Priority Order

| Phase | Milestone | Effort | Impact |
|-------|-----------|--------|--------|
| 1 | Auth & Security (M1.1–1.3) | Medium | Foundation for everything |
| 2 | Context Engineering (M2) | Medium | Biggest quality improvement |
| 3 | Memory Engineering (M3) | Medium | Long-term intelligence |
| 4 | GSuite Integration (M4) | Medium | Productivity multiplier |

---

## Delivery

- **ROADMAP.md** committed to repo root for living reference
- **GitHub Issues** created per sub-item, organized into Milestone labels
- Issues tagged by area: `auth`, `context`, `memory`, `integration`

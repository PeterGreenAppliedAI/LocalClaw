# LocalClaw Architecture

## Overview

LocalClaw is a local-model-first AI agent framework running entirely on personal hardware. Foreground reasoning runs on a large model (MiniMax-M2.7) served by **vLLM**; small utility/modality models run behind an **Ollama-compatible gateway**. It uses a **Router + Specialist** architecture with **deterministic pipelines** — code controls the workflow, models only extract parameters and synthesize text.

9+ models across two inference backends (vLLM + Ollama gateway), 39 tools, 12 pipelines, 15 categories, 8 channel adapters (including Chrome extension with browser control), FalkorDB graph memory with 1,000+ nodes, 389 tests across 26 suites. Web search runs on a self-hosted **SearXNG** metasearch instance (no API key, no rate limit); Brave/Perplexity/Grok/Tavily remain config-selectable fallbacks.

## Design Principles

1. **Code decides, model executes** — Deterministic pipelines for most categories. The model never decides tool ordering, parallel execution, or error recovery.
2. **Specialist isolation** — Each specialist sees 3-6 tools. No model chooses from 39 tools.
3. **Code computes, model interprets** — Numbers, aggregations, temporal logic computed in code. The model only adds "so what" — interpretation, risk assessment, recommendations.
4. **Fail predictably** — Each pipeline fails in its own lane. A broken analytics pipeline doesn't affect chat or web search.
5. **Local-first** — Zero cloud dependencies, no API costs, all data stays on your hardware.

## System Flow

```
Channel (Discord / Telegram / WhatsApp / Web / Gmail / Slack / iMessage / Chrome Extension)
  ↓
Orchestrator
  - Rate limiting (10/min/user)
  - Attachment pre-processing (images → vision, PDFs → text, data files → analytics)
  - Typing indicators, streaming
  - Commands (!reset, !save, !forget, !heartbeat)
  ↓
resolveRoute() → agentId + sessionKey
  ↓
dispatchMessage()
  - Load session history (budget-aware compaction)
  - Router classification (pre-model overrides → phi4:14b → keywords → default)
  - 6-layer security filtering
  - Memory auto-injection (FalkorDB vector KNN + entity traversal)
  - Conversational guard (prevents pipeline misroutes mid-conversation)
  ↓
Pipeline (deterministic)          OR          ReAct Loop (model-driven)
  - web_search, research,                      - chat, config, personal,
    exec, task, memory,                          image, website
    cron, message, analytics,
    plan, code_gen, heartbeat
  ↓
Response → channel (thinking stripped) → transcript (thinking preserved)
```

## Multi-Model Strategy (two backends)

Foreground reasoning runs on **MiniMax-M2.7** via **vLLM** (192K context) on the DGX Spark.
Small utility + modality models run on the **A5000 node behind an OpenAI-compatible gateway**
(Ollama wire protocol). A `MultiBackendClient` routes each call by model id — purely additive,
so the Ollama path is unchanged. See "Inference Routing" below.

| Role | Model | Backend | Why |
|------|-------|---------|-----|
| Chat + all foreground specialists (web_search, exec, memory, multi, research, analytics, image, code_gen, etc.) | MiniMax-M2.7-AWQ-4bit | vLLM / Spark | Strong multi-step reasoning + tool sequencing; 192K context |
| Reasoning (`reason` tool) | MiniMax-M2.7 | vLLM / Spark | One model for foreground reasoning — no separate reasoning model |
| Router | phi4:14b | gateway / A5000 | Fast classification (~50ms), few-shot |
| Fact Extraction | phi4:14b | gateway / A5000 | Dense, reliable JSON |
| NER | phi4-mini | gateway / A5000 | Entity typing with bootstrapped graph context |
| Embedding | qwen3-embedding:8b | gateway / A5000 | 4096-dim vectors for memory search |
| Vision | qwen3.6:27b (multimodal) | gateway / A5000 | Image analysis |
| Briefing + Heartbeat reasoning | qwen3.6:27b | gateway / A5000 | Background reasoning, keeps the Spark free for foreground |
| Voice fast-path | qwen2.5:7b | gateway / A5000 | Small + fast for voice-originated messages |

**Context:** `session.contextSize` raised to 128K (was 32K). Per-specialist `contextSize` override
in the schema lets small-context models stay low. MiniMax ignores `num_ctx` (vLLM serves 192K at launch),
so the value mainly drives the compaction budget.

## Inference Routing

```
client.chat({ model })
  model matches inference.backends[].models  → OpenAICompatClient → vLLM /v1/chat/completions
  everything else (phi4, qwen3.6:27b, embedding) → OllamaClient → gateway /api/chat
embed() always → Ollama gateway
```

`OpenAICompatClient` (src/ollama/openai-client.ts) translates Ollama↔OpenAI: maps `options.*` to
top-level params, JSON-parses tool-call arguments (vLLM returns a string, Ollama an object), stitches
`tool_call_id`s onto tool-result messages, SSE streaming, `usage`→token counts. `MultiBackendClient`
(src/ollama/multi-backend.ts) extends OllamaClient and routes by model id — a drop-in replacement.

## Router Classification (4-tier)

1. **Pre-model overrides** — URLs → website, PDFs → research, calendar/email → personal
2. **Model** — phi4:14b classifies into 15 categories (~50ms)
3. **Keywords** — Pattern matching when model fails or times out
4. **Default** — Falls back to `chat`

Post-classification layers: sticky routing (keeps follow-ups on chat), conversational guard (blocks pipeline misroutes), silent re-route (if chat specialist admits capability gap).

## Pipelined Categories

| Category | Pipeline | Flow |
|----------|----------|------|
| web_search | Linear | extract → search → pick URLs → parallel fetch → synthesize → quality review → [revision] |
| research | Complex | decompose → per-facet research (search+fetch+synthesize) → gap-fill → analytical synthesis → claim verification (cited-source + Tier-1 cross-check) → charts → render PDF |
| analytics | Data-driven | extract file → pandas report (code) → charts (code) → LLM interpretation |
| exec | Linear | extract → tool → format |
| task | Branched (5) | llm_branch → extract → tool → confirm |
| memory | Branched (2) | llm_branch → extract → tool → format |
| cron | Branched (4) | llm_branch → extract → tool → confirm |
| message | Linear | extract → tool → confirm |
| plan (multi) | Meta | LLM plan → self-reflect → execute loop (sub-dispatches) → summarize |
| code_gen | Linear | list projects → enrich → build → verify → [fix] → report |
| heartbeat | Deterministic | fact diff (code) → LLM reasoning → task board (code) → LLM summary |
| website | ReAct | web_fetch → browser fallback → summarize |

## Research Claim Verification

After the research pipeline drafts its markdown report, an evidence-verification stage (`src/pipeline/verification.ts`) checks it before rendering. Principle: **no claim should outrun its evidence.**

1. **Extract** atomic, checkable claims (fast model), prioritizing corporate events / market-share over routine specs.
2. **Cited-source check** — each claim is judged against the *cached* pages that actually mention it (research persists fetched page text, so zero new searches). Overstated/single-sourced claims are **hedged or attributed** ("according to X") — never deleted.
3. **Tier-1 cross-check** — a bounded set of high-impact, falsifiable claims (corporate events, market-share; capped at `maxCrossChecks`) get ONE independent search each; an authoritative contradiction (e.g. "license" vs "acquisition") flips the claim to `CONTRADICTED → correct`.
4. **Correction pass** (MiniMax) edits only the affected sentences; strikethrough/tracked-changes artifacts are stripped at render. Publishes with a `## Verification` appendix + auditable `verification.json`.

Config-gated via the `verification` block (`enabled`, `crossCheck` — both default on). Known ceiling: cited-source checking can't disprove a faithfully-cited wrong fact without the Tier-1 pass; Tier-1 itself trusts a single independent source, so disputed claims are better attributed than silently rewritten.

## Memory System (FalkorDB)

```
FalkorDB (Docker, localhost:6379)
  Graph: localclaw_memory

  (:Fact {text, importance, embedding, category, confidence})
    -[:ABOUT]->      (:Entity {name, canonical, type})
    -[:TAGGED]->     (:Tag {name})
    -[:SUPERSEDES]-> (:Fact)           // temporal evolution
    -[:EXTRACTED_FROM]-> (:Turn)       // provenance

  (:Turn {text, role, sessionKey})
    -[:MENTIONS]->   (:Entity)         // conversation linking

  (:UserModel {communicationStyle, decisionPattern, topicInterests})
```

**Auto-injection:** Every message triggers vector KNN + entity traversal. Relevant facts silently injected into specialist context. Multi-signal scoring: `similarity * 0.5 + recency * 0.2 + importance * 0.3`.

**Entity extraction:** NER with typed taxonomy (person, organization, hardware, software, etc.). Bootstrapped from graph — existing typed entities injected as reference for consistent classification. Canonical normalization prevents duplicates.

**Importance tiers:** 5=critical (health/family), 4=identity (job/projects), 3=preference, 2=context, 1=ephemeral. Few-shot examples in extraction prompt.

## Thinking Tag Handling

Models that emit thinking blocks (`<think>` for Qwen, `<|channel>thought` for Gemma 4) have thinking preserved in session transcripts for model continuity across turns. Stripped only for: channel delivery, graph memory, session state, continuation context, handoff summaries, and when feeding to other LLMs (compactor, extractor, NER).

## Autonomous Systems

- **Heartbeat** (every 2h) — Transcript review, fact extraction, learning promotion, media cleanup, memory consolidation, task urgency computation, review candidates
- **Briefing** (8am, 1:15pm, 5pm) — Calendar + tasks + memory → CoT reasoning → contextual insights
- **Cron** — User-defined recurring tasks with retry (2x exponential backoff) + failure notification

## Security (6 layers in dispatch)

1. `allowedCategories` — whitelist per channel
2. `ownerOnlyTools` — code gate, not model-level. Tools invisible to non-owners
3. `restrictedCategories` — blocked for untrusted users
4. `blockedTools` — stripped for everyone on this channel
5. `restrictedTools` — stripped for untrusted users
6. `confirmTools` — preview before execution, requires confirmation

## Chrome Extension (Browser Companion)

```
Chrome Side Panel (React) → HTTP fetch (SSE streaming) → LocalClaw Web API (localhost:3100)
  ├── Content script extracts: URL, title, selected text, page content (~10K chars)
  ├── [PAGE:] token injected → console/api/chat detects → overrideCategory: chat
  ├── Context menus: "Ask LocalClaw about '%s'" (selection), "Summarize this page" (page)
  └── No fetching needed — model reads injected page content directly
```

Built with WXT (Manifest V3), React, TypeScript. Connects to existing Web channel API — no new backend. Works cross-network (extension on Windows, LocalClaw on Mac Mini).

## File Type Routing (Orchestrator)

```
attachment → check extension
  → image (.png, .jpg, .gif, .webp)  → vision → inject description → chat
  → PDF (.pdf)                         → extract text → inject → route normally
  → data (.csv, .xlsx, .json)          → analytics pipeline (auto)
  → text (.md, .txt, .html, .log)     → ask user: knowledge base or read as text?
  → unknown                            → ask user same choice
```

## Execution Isolation

```
Isolation Layer          What It Protects              Status
─────────────────────────────────────────────────────────────
Docker sandbox           Exec tool commands            Active — allowlisted commands only
Cron mode                Automated task execution      Active — strips write tools
Pipeline isolation       Pipeline dispatches           Active — fresh context per dispatch
Owner-only code gate     Sensitive tools               Active — tools invisible to non-owners
6-layer security         Channel + user permissions    Active — static per config
Session-scoped perms     Per-conversation access       Planned
Ephemeral micro-VMs      Untrusted agent execution     Roadmap — Firecracker
Resource limits          CPU/memory per exec           Roadmap
```

**Current gaps:**
- Docker container persists between exec calls (not ephemeral)
- No CPU/memory resource limits on exec tool
- No network isolation for exec (can reach any host the container can)
- Browser control via extension runs in user's actual Chrome (no sandbox)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.7 (strict) |
| AI Backend | vLLM (foreground reasoning) + Ollama gateway (utility/modality models) |
| Web Search | SearXNG (self-hosted, primary) — Brave/Perplexity/Grok/Tavily selectable |
| Graph Memory | FalkorDB (Redis wire protocol, HNSW vectors) |
| Knowledge Store | better-sqlite3 (vector embeddings) |
| Discord | discord.js 14 |
| Telegram | grammy |
| WhatsApp | @whiskeysockets/baileys |
| Browser | playwright-core |
| Charts | matplotlib + seaborn (Python) |
| Document Gen | LibreOffice (headless) |
| Scheduling | croner |
| Config | JSON5 + Zod |
| Chrome Extension | WXT + React + TypeScript (Manifest V3) |
| Testing | Vitest (389 tests, 26 files) |

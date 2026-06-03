# LocalClaw Architecture

## Overview

LocalClaw is a local-model-first AI agent framework running entirely on personal hardware via Ollama. It uses a **Router + Specialist** architecture with **deterministic pipelines** — code controls the workflow, models only extract parameters and synthesize text.

9 models, 39 tools, 12 pipelines, 15 categories, 8 channel adapters (including Chrome extension), FalkorDB graph memory with 1,000+ nodes.

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

## Multi-Model Strategy

| Role | Model | Why |
|------|-------|-----|
| Router | phi4:14b | Fast classification (~50ms), few-shot, 200 tokens/decision |
| Specialists | qwen3-coder:30b | Reliable tool sequencing, native tool calling |
| Chat | gemma4:26b (MoE) | 3.8B active / 25.2B total. Fast tok/s, clean output |
| Briefing | qwen3.6:35b | Better reasoning, respects pre-labeled data |
| Analytics | gemma4:26b | Interpretation-only (code computes all numbers) |
| Fact Extraction | phi4:14b | Dense, no thinking overhead, reliable JSON |
| NER | phi4-mini | Entity typing with bootstrapped graph context |
| Embedding | qwen3-embedding:8b | 4096-dim vectors for memory search |
| Vision | qwen3-vl:8b | Image analysis |

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
| research | Complex | plan queries → parallel search → parallel fetch → synthesize → charts → branch(deck/report) → render |
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

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.7 (strict) |
| AI Backend | Ollama |
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
| Testing | Vitest (266 tests, 21 files) |

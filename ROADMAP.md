# LocalClaw Roadmap

LocalClaw is a local-model-first AI agent framework running on personal infrastructure (DGX Spark, Mac Mini, A5000). It handles Discord, Telegram, WhatsApp, and Web with a Router + Specialist architecture on Ollama. 48 models, 39 tools, 12 pipelines, FalkorDB graph memory, autonomous heartbeats and briefings.

---

## Completed

- **Setup Wizard** — Interactive `npm run setup` with prerequisites check, auto-install (FalkorDB, OpenCode), model detection, channel security, heartbeat config, and complete production-ready config generation
- **FalkorDB Graph Memory** — Replaced flat JSONL with graph database. HNSW vector search, entity linking, SUPERSEDES chains, multi-hop traversal, bootstrapped NER, canonical entity normalization, importance-scored auto-injection
- **Analytics Pipeline** — Upload CSV/Excel/JSON → pandas computes all numbers → matplotlib charts → LLM executive interpretation. Code handles "what", model handles "so what"
- **Thinking Preservation** — Raw model output stored in transcripts for continuity across turns. Stripped only at display boundaries. Handles Qwen and Gemma 4 formats
- **Gemma4:26b for Chat** — MoE (3.8B active), replaced qwen3.5:9b which had self-prompting artifacts
- **Website Specialist** — URL pre-model override, web_fetch → browser fallback for JS-heavy sites
- **Context Compaction** — Budget-aware structured compression with memory flush and summary prefix
- **Observation Summarization** — LLM-based summarization for old tool observations instead of hard truncation
- **Non-streaming Message Splitting** — Long responses split correctly on all code paths
- **Conversational Guard** — Lightweight length-based guard for short ambiguous messages. Replaced keyword-based task intent matching (too fragile). Speculative language ("I wonder", "what if") routed to chat via pre-model override
- **Chrome Extension** — Browser companion side panel (WXT + React + Manifest V3). Content script extracts page context, streams to LocalClaw via existing Web API. Right-click context menus. Works cross-network (extension on Windows, LocalClaw on Mac Mini)
- **Browser Control** — Remote browser bridge: model calls browser tool → extension executes DOM actions on user's real Chrome tab. Screenshot + vision for JS-heavy sites. Guided ReAct with action dedup (deterministic pipeline attempted and reverted — documented in DECISIONS.md)
- **Memory Decay + Contradiction Eviction** — Automatic confidence decay by importance tier. Contradiction detection on addFact() via phi4-mini. Human-in-the-loop fact review via heartbeat
- **Token Economics Monitoring** — Capture eval_count/prompt_eval_count from Ollama responses, log per dispatch
- **LLM-as-Judge Quality Scoring** — Post-dispatch quality check for pipeline categories, scores to JSONL
- **Security Hardening** — Path traversal fixes (relative() check), scoped tool executor, session agentId sanitization, Telegram allowFrom, web API warning
- **Orchestrator Decomposition** — 2,019 → 1,347 lines. Extracted: heartbeat service, briefing service, rate limiter, media debouncer, command router, text utilities, media extraction, training collector
- **Latency Optimization** — Parallel memory + router (800-1500ms saved), async compaction cache, tool-loop streaming with status events, web-fetch page caching, expanded pre-model overrides
- **Routing Test Corpus** — 347 tests covering pre-model overrides, keyword fallback, sticky routing, speculative language, security
- **Media Burst Handling** — Vision queue (sequential, not parallel), 3-second media debounce, video file path, rate limiter adjustment

---

## Next Up

| Priority | Feature | Description |
|----------|---------|-------------|
| Next | **SearXNG integration** | Self-hosted meta-search engine replacing paid Brave API. Zero cost, no rate limits |
| Next | **Firecrawl integration** | Self-hosted web fetching between web_fetch (basic) and browser (heavy). Handles JS rendering without full Chromium |
| Next | **Provider abstraction** | LLM client trait supporting Ollama, vLLM, LM Studio, and any OpenAI-compatible endpoint. Enables multi-backend routing |
| Planned | **Proactive actions** | Agent initiates actions based on observations (heartbeat findings, memory patterns) instead of just reporting. Human-in-the-loop confirmation gate |
| Planned | **Cross-channel sessions** | Map user IDs across Discord/Telegram/WhatsApp to shared sessions. Continue conversations across platforms |
| Planned | **Rebrand** | Rename from LocalClaw to new identity (plan exists, 357 references mapped across 80 files) |

---

## Backlog

| Feature | Description |
|---------|-------------|
| **Router fine-tuning** | Fine-tune phi4-mini on collected training pairs (data/training/router-pairs.jsonl) for faster, more accurate routing |
| **RBAC** | Named roles (owner/admin/user/guest) replacing binary trusted/untrusted. Per-role permissions |
| **Audit logging** | Structured log of all security decisions, tool executions, user actions |
| **Google Sheets tools** | Read/write cells, append rows. Useful for CRM and reporting |
| **Gmail compose** | Outbound email tool (currently read-only) |
| **MCP client support** | Consume external MCP servers as tools (Jira, Notion, GitHub) |
| **Video pipeline** | Multimodal video/meeting summarization via nemotron |
| **Memory namespacing** | Scoped search across facts, preferences, conversations, knowledge |
| **Hybrid retrieval** | BM25 + vector fusion for exact keyword matches alongside semantic search |

---

## Known Issues

- **Double message delivery on Discord** — Intermittent duplicate messages from stream preview + final send race condition
- **WhatsApp connection drops** — Baileys disconnect can trigger unhandled rejection, crashing the process. Needs global rejection handler

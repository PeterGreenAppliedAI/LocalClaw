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
- **Conversational Guard** — Prevents pipeline misroutes mid-conversation

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

# Architectural Decisions & Lessons Learned

A log of significant decisions, failed experiments, and why things are the way they are. Prevents re-trying things that already failed and documents the reasoning behind current architecture.

---

## Model Evaluations

### Gemma4:26b for chat (May 2026)
**Context:** Chat was on qwen3.5:9b (thinking model). Analysis of conversation transcripts revealed the model self-prompting — asking follow-up questions then answering them in the same turn via `<think>` blocks. The orphaned `</think>` tags were also leaking into continuation context previews.
**Decision:** Switched chat to gemma4:26b (MoE, 3.8B active / 25.2B total). Kept qwen3-coder:30b for tool-calling specialists.
**Why gemma4 for chat:** MoE architecture means only 3.8B active params → faster tok/s than the dense 9B qwen, while being a smarter model overall. DGX Spark hardware gives better throughput. No self-prompting artifacts. Cleaner conversational output.
**Sampling:** Per Gemma 4 best practices: temperature=1.0, top_p=0.95, top_k=64.
**Note:** Gemma 4 docs explicitly say "No Thinking Content in History" for multi-turn conversations. The thinking preservation in transcripts still benefits qwen3 specialists (tool-loop reasoning chains), but gemma4 chat sessions should have thinking stripped from history.
**Status:** Active for chat. qwen3-coder:30b remains for all tool-calling specialists.

### Gemma4:26b as specialist replacement (April 2026)
**Tried:** Swapped qwen3-coder:30b for gemma4:26b as the specialist model. Benchmarks showed 85% on agentic tasks vs qwen3-coder's 65%.
**Result:** Tool calling worked, but tool **sequencing** was worse. Model answered before using tools, wandered to irrelevant sites, didn't complete multi-step chains. Reverted after testing.
**Lesson:** Benchmarks don't tell you about tool sequencing discipline. A model can call tools correctly in isolation but fail at knowing when to stop talking and start calling.
**Status:** Under re-evaluation now that Ollama has updated. gemma4:26b stays available for future testing pipeline-by-pipeline.

### qwen3.6:35b for briefing (May 2026)
**Tried:** Swapped qwen3-coder:30b for qwen3.6:35b on the briefing reasoning pass.
**Result:** Immediate quality improvement. No fabricated events, respects pre-labeled data, cleaner synthesis, less filler.
**Gotcha:** qwen3.6 defaults to thinking mode, which consumed the entire `num_predict` budget leaving content empty — same root cause that killed nemotron earlier (see "Low num_predict starving thinking models"). Fix: bumped `num_predict` from 1024 to 8192.
**Status:** Active. Briefings now run on qwen3.6:35b.

### Nemotron for briefing (April 2026)
**Tried:** Used nemotron-3-nano:30b for briefing CoT reasoning.
**Result:** All output went into `<think>` tags with nothing outside. Empty briefings delivered.
**Root cause (discovered later):** Likely the same `num_predict: 1024` starvation issue — see "Low num_predict starving thinking models" below. Nemotron is a thinking model that uses internal reasoning tokens. At 1024, it spent all tokens thinking and produced no visible output. The model may have worked fine with adequate headroom.
**Status:** Switched to qwen3-coder, then to qwen3.6. Worth re-evaluating with `num_predict: 8192`.

### phi4-mini as smart router (April 2026)
**Tried:** Used phi4-mini for short messages mid-conversation to save latency.
**Result:** Produced "As an AI developed by Microsoft" responses. Also broke mid-conversation routing by classifying follow-up messages as new intents.
**Lesson:** Smart routing based on message length is fragile. Short messages mid-conversation need context, not a cheaper model.
**Status:** Removed entirely. All routing goes through phi4:14b.

### Low num_predict starving thinking models (May 2026)
**Problem:** Multiple models (nemotron, qwen3.6) produced empty or truncated output. We blamed the models and swapped them out.
**Root cause:** `num_predict: 1024` was too low for thinking models. These models use internal reasoning tokens (think tags) before producing visible output. At 1024 tokens, the model spent its entire budget thinking and had nothing left for the actual response.
**Impact:** Nemotron was wrongly dismissed for briefings. qwen3.6 initially appeared broken. Any thinking model evaluated under these constraints was handicapped.
**Fix:** Bumped briefing `num_predict` to 8192. Gateway updated to surface thinking content as fallback when content is empty.
**Lesson:** Before blaming a model's capability, check if you're giving it enough room to work. Thinking models need headroom for internal reasoning on top of the output tokens. Audit `num_predict` values when onboarding any new model.

---

## Architecture Decisions

### Thinking preservation in transcripts (May 2026)
**Problem:** Models that emit `<think>` blocks had their reasoning stripped before storing in session transcripts. On subsequent turns, the model only saw its own terse answers — not the reasoning chain that produced them. Quality degraded over multi-turn conversations as the model lost context about _why_ it said what it said. Session state (known facts, open questions) was a poor substitute for the model's actual internal reasoning.
**Decision:** Store raw model output (with thinking blocks) in the transcript. Strip thinking only at display boundaries: channel delivery, graph memory turns, session state updates, continuation context previews, handoff summarization, and when feeding transcript content to other LLMs (compactor summarizer, semantic extractor, fact extraction).
**Why not strip everywhere:** The model benefits from seeing its own reasoning on subsequent turns — it maintains coherence and builds on prior analysis. But other LLMs that consume transcript content (summarizers, extractors) shouldn't see nested thinking blocks.
**Also fixed:** Orphaned `</think>` regex was unlimited (`[\s\S]*?`) — tightened to `{0,500}` to prevent eating half the response if a stray `</think>` appears deep in the text. Added Gemma 4 thinking format (`<|channel>thought\n...<channel|>`) to all strip functions.
**Also added:** `num_ctx` passthrough from `config.session.contextSize` to Ollama via `buildOllamaOptions()` and bare chat options — ensures Ollama allocates enough context for the larger history.
**Status:** Active.

### Exec pipeline vs ReAct loop (April 2026)
**Tried:** Removed the exec pipeline to let the model reason freely about 6 exec tools in a ReAct loop.
**Result:** Model used 8 steps for `ls data` -- called exec correctly but then tried `find`, `chmod`, `which` before stopping. Massive over-exploration.
**Lesson:** Local models can't self-regulate in open-ended tool loops for simple tasks. Pipeline for simple commands, ReAct for complex multi-tool tasks.
**Status:** Exec pipeline restored.

### Sticky routing evolution (April-May 2026)
**Original problem:** Sticky routing kept follow-up messages on the same specialist across all categories. Fixed: restricted to chat/memory only.
**Second problem (May 2026):** Broad keyword hints ("what is", "who is") broke sticky for casual questions. "What are the privacy implications of NotebookLM?" triggered web_search keyword hint → broke sticky → model classified as research/multi → full report instead of chat.
**Third problem:** Even when sticky held, the model classifier could override it. Conversational messages with technical keywords got classified as research/multi/web_search.
**Fix (keyword hints):** Removed "what is" and "who is" from web_search keyword hint. These are questions, not search actions.
**Fix (dispatch guard):** Added dispatch-level conversational guard: if classified as non-chat but session has prior turns (turnCount > 0) AND message has no explicit task intent (create, search for, generate, etc.), downgrade to chat. Catches ALL pipeline misroutes from conversational context — research, multi, web_search, everything.
**What breaks through:** Explicit task intent always wins — "search for X", "create a report", "generate an image". Pre-model overrides (calendar, email, PDF) still fire. First messages (no session) unaffected. Cron jobs unaffected.
**Status:** Active. Three layers: keyword tightening + task intent check for long messages + dispatch-level guard.

### Session isolation for pipelines (April 2026)
**Decision:** All pipeline dispatches (plan, research, exec) run with fresh context -- no parent session history.
**Why:** Research results were being biased by prior conversation topics. A research task about "AI news" would incorporate topics from a prior chat about healthcare because the session history was shared.
**Status:** Active. Context isolation is enforced for all pipeline dispatches.

### Code-driven temporal intelligence (May 2026)
**Decision:** Task urgency and calendar day labels computed in TypeScript, not by the model.
**Why:** qwen3-coder said "264 days remaining, requiring attention soon." It showed events on wrong days. It couldn't distinguish events from deliverables. Three separate prompt rewrites failed to fix it.
**Lesson:** If a model fails at something deterministic after 3+ prompt attempts, move it to code. The model's job is synthesis, not arithmetic.
**Status:** Active. `src/temporal/urgency.ts` handles all temporal reasoning. Model receives pre-labeled data with authoritative tags.

### Heartbeat: code curates, model reasons (April-May 2026)
**Decision:** Heartbeat uses snapshot-based fact diffing (code) then sends structured diff to LLM for reasoning. Task board uses urgency tiers (code) then sends pre-labeled board to LLM for summary.
**Why:** Original approach let the model search memory randomly -- each run surfaced different facts with different formatting. Plan pipeline heartbeat matched wrong skills (137 inflated success count on one skill). Model-driven task board said everything was urgent.
**Lesson:** Code handles the "what" (which facts changed, which tasks matter). Model handles the "so what" (what does it mean, what's connected).
**Status:** Active. Pattern applied to both memory and task board.

### Hallucination detector: verb-aware (May 2026)
**Decision:** Hallucination detection now checks claimed action verbs against actual tool calls made.
**Why:** Image generation tool took ~60 seconds. After the tool completed, the model summarized "I've generated the image." Detector flagged this as hallucination (model claiming action without tool call), triggered a repair prompt, model generated the image a second time.
**Lesson:** "Claims action without tool call" needs context -- if the model DID call the tool, its summary is legitimate.
**Status:** Active. `TOOL_ACTION_VERBS` map in `src/tool-loop/engine.ts`.

### [FILE:] token flow (March 2026)
**Decision:** File tokens stripped from model observations before model sees them, collected, re-appended after final answer.
**Why:** Model rewrites `[FILE:path]` into fake markdown links like `[Download report](path)`. Once the model touches the token, the path format breaks and media extraction fails.
**Status:** Active. Two strip points: tool-loop engine (observations) and plan pipeline (before summarization LLM).

---

## Failed Approaches

### Phone call integration (April 2026)
**Explored:** macOS Continuity for intercepting phone calls, BlackHole audio routing for system audio capture.
**Why abandoned:** No public API for macOS Continuity calls. BlackHole routing is fragile and requires manual audio config. Twilio Media Streams is the clean path but adds cost.
**Conclusion:** Shelved. Better use case is business appointment scheduling, not personal call handling.

### Skill matching catching everything (April 2026)
**Problem:** The skill "generate-report-from-web" matched 73 consecutive heartbeat dispatches, inflating to 137 success count.
**Root cause:** Skill matcher thresholds too low, no exclusion for system operations.
**Fix:** Threshold raised to 8, 30% keyword ratio required, success bonus capped at +2, heartbeat dispatches skip skill check/save entirely.

### Briefing on heartbeat cron (April 2026)
**Problem:** Briefing was triggered inside the heartbeat cron (even hours). The briefing wanted to run at 8am, 1:15pm, 5pm -- which never aligned with even-hour heartbeat runs.
**Fix:** Separated briefing into its own cron schedules. Heartbeat and briefing are independent systems.

### Memory facts surfacing irrelevant context (April 2026)
**Problem:** User priming injected LLC/career facts during a health conversation. Briefing memory search pulled colonoscopy info into every daily briefing.
**Fix (priming):** Changed header to "Background context (do NOT reference unless directly relevant)."
**Fix (briefing):** Added explicit rule: "Calendar is the ONLY source of truth for events. NEVER invent or recall events from memory."
**Lesson:** Broad memory search queries like "recent activity decisions context" pull everything. The model can't filter relevance -- it tries to use everything it sees.

### Memory system overhaul: flat store to graph database (May 2026)

**Problem:** The JSONL-based FactStore accumulated 14 near-duplicate facts about the same topic. Layered dedup defenses (hash, substring, embedding similarity) were individually weak. Memory facts only surfaced in briefings, never in conversations. No relationship modeling between facts.

**Evolution (Phases 1-4 on flat store):**
1. Embedding dedup on write (cosine > 0.85 rejected via qwen3-embedding)
2. Importance tiers (1-5) driving TTL and retrieval priority
3. Auto-injection: embedding search on every message, contextually relevant facts silently injected into specialist context
4. Extraction awareness: existing facts shown to extraction LLM to prevent re-extraction

**Decision: FalkorDB graph database (Phase 5)**

Replaced the flat JSONL fact store with FalkorDB — a Redis-compatible graph database with native HNSW vector search.

**Why FalkorDB over alternatives:**
- vs Neo4j: Free (MIT-adjacent), ~85MB vs 2.6GB memory, sub-ms lookups, native vector search. Neo4j Community can't cluster.
- vs SQLite (existing EmbeddingStore): No graph traversal, no relationship modeling, brute-force vector search.
- vs Memgraph: No native vector search.

**What the graph enables that flat storage can't:**
- SUPERSEDES edges: fact evolution with history ("ML engineer" → "Senior ML engineer")
- Temporal queries: "what did I know last month?" via createdAt filters + SUPERSEDES chain
- Multi-hop reasoning: traverse shared entities to find connected facts (DevMesh → AI → career fair)
- Community detection: clusters of related facts by entity co-occurrence (work cluster, health cluster, hobby cluster)
- Native vector KNN: O(log n) via HNSW index, not O(n) brute-force

**Infrastructure:** FalkorDB runs in Docker on the Mac Mini alongside LocalClaw. ~85MB for the graph at current scale (~1,067 nodes).

**Status:** Fully integrated. Auto-injection, memory tools, and migration complete.

**Early results (May 10, 2026):**
- Cookie preference test: bot knew "soft chocolate chip cookies with precise measurements" without being asked
- FalkorDB discussion: bot held multi-turn technical conversation, correctly pulled user's ML engineer role and DGX Spark setup from graph memory for context
- Migration dedup: caught 2 paraphrased duplicates during 23-fact migration that flat store had missed
- Narrated tool call detection: added to capability gap detector after chat faked a `[brave_search()]` call
- Personalized conversation: "What would you like to talk about?" → bot built a menu from graph memory (open-source models, DGX Spark, edge AI, Long Island events, System Prompt podcast). Zero prompting from user.
- Unity AI discussion: bot autonomously connected Unity research to user's LocalClaw setup and edge computing interests via auto-injected graph facts
- FalkorDB discussion: multi-turn technical conversation where bot correctly pulled user's ML engineer role and infrastructure context
- `!forget register agent` working with flexible word matching after exact CONTAINS failed on "registered agent" vs "register agent change"

### OpenCode integration — workspace isolation (May 2026)
**Problem:** OpenCode's headless server treats its startup directory as the project root. When started from the LocalClaw directory, it overwrote `package.json` (replaced all dependencies with Express) and `README.md` (replaced with Express API docs). Prompt instructions to "only write to builds/" were ignored by the model.
**Root cause:** OpenCode is a model-driven agent with full filesystem access within its project directory. Prompt-based directory constraints are not enforceable — the model writes wherever it decides.
**Fix:** Start `opencode serve` from a separate `data/workspaces/main/builds/` directory. OpenCode can only see and modify files within that directory. LocalClaw connects to the existing server via SDK — it doesn't manage the server lifecycle.
**Lesson:** Never give a model-driven coding agent write access to your production codebase. Isolate its workspace at the process level, not the prompt level.
**Status:** Active. User starts `opencode serve` from builds directory manually. LocalClaw tool detects and connects to the running server.

### OpenCode pipeline evolution (May 2026)
**Phase 1 (ReAct):** Specialist called opencode_build in a ReAct loop. Model retried 2-3x despite "call once" instructions.
**Phase 2 (Pipeline):** Deterministic extract → build → report. Extract stage mangled user intent. Replaced with LLM enrichment stage.
**Phase 3 (Verify/Fix):** Added verify (run tests), fix (send errors to same session), re-verify stages. Uses `when` guards for conditional execution. Session reuse via `sessionId` parameter.
**Phase 4 (Iterative builds):** Session persistence (`.opencode-session.json` per project). `list_projects` code stage scans existing projects. Enrich LLM outputs `[MODIFY] <slug>` for modifications vs new project name. `resolveParams` loads saved session data for reuse.
**Key pattern:** Each stage does ONE thing. Code controls the flow. Model executes within constraints. No model decisions about retry/flow.
**Status:** Active. Full pipeline: list_projects → enrich → build → verify → [fix] → [re-verify] → report.

### OpenCode specialist retry behavior (May 2026)
**Problem:** Despite system prompt saying "Call opencode_build ONCE", the specialist calls it 2-3 times:
- First call: build succeeds, returns file listing
- Specialist reviews output, decides tests aren't good enough, starts second build
- Or: first call times out (fetch failed), specialist retries with new session
**Attempted fixes:**
- System prompt: "Do NOT call opencode_build multiple times" — model ignores it
- maxIterations: 3 → still retries. Need to drop to 2 (one build + one answer)
- Content previews truncated at 2000 chars → specialist thought build was incomplete → retried. Fixed: bumped to 8000 char limit
**Lesson:** Local models don't reliably follow "call this tool exactly once" instructions. Constrain via maxIterations, not prompts.
**Status:** maxIterations set to 2 to force single build + answer.

### Tool-specific error recovery (May 2026)
**Problem:** Tool errors returned generic "Try a different approach or tool" regardless of which tool failed or why. The 8 error patterns in `enrichObservation()` had generic suggestions (e.g., "Check file permissions") that didn't help the model recover.
**Fix:** Added `TOOL_RECOVERY_MAP` — a lookup table mapping (toolName, errorType) → actionable recovery instruction. When `web_fetch` gets a 404, model is told "Use web_search to find the correct URL." When `exec` gets EACCES, model is told to try Docker backend.
**Why this matters:** Goose's architecture treats errors as prompts — recovery instructions tailored to the specific failure. LocalClaw already had `enrichObservation()` but it was generic. Now it's tool-aware.
**Status:** Active. `src/learnings/pattern-matcher.ts`.

### Structured sub-dispatch results (May 2026)
**Problem:** Plan pipeline sub-dispatches returned raw text strings. File paths and URLs were regex-extracted post-hoc from the answer, which was fragile and could miss paths in unexpected formats.
**Fix:** Added `SubDispatchResult` typed interface. Dispatch layer now extracts paths/URLs at source (where it has the full answer) and returns structured metadata. Plan pipeline uses typed fields instead of regex.
**Why this matters:** Separates data extraction from orchestration. Foreman handoffs are now based on structured data, not text parsing.
**Status:** Active. `src/pipeline/types.ts`, `src/dispatch.ts`, `src/pipeline/definitions/plan.ts`.

### LLM-based observation summarization (May 2026)
**Decision:** Added optional LLM summarization for old tool observations in the tool-loop context trimmer.
**How it works:** When context budget is tight (>85%), observations >1000 chars are summarized by a fast model (router model by default) before truncation. Observations 300-1000 chars hard-truncate as before. Controlled by `session.summarizeToolObservations` config flag.
**Why:** Hard truncation to 300 chars loses key data (errors, file paths, status codes) buried in middle of output. Smart summarization preserves what matters. Goose uses LLM-based summarization too but for full session compaction — this is more targeted (per-observation).
**Fallback:** If LLM call fails, falls back to hard truncation. Zero risk of breaking existing behavior.
**Status:** Active. Enabled in config.

### Graph memory quality: importance, entity typing, entity dedup (May 2026)
**Problem:** Three data quality issues in the knowledge graph:
1. All facts had importance=2 — extraction LLM (phi4:14b) never returned the `imp` field, fallback defaulted to 2. The 30% importance weight in auto-injection scoring was dead weight.
2. All entities had type="unknown" — NER prompt only asked for names as flat strings, MERGE hardcoded `type = 'unknown'`.
3. Duplicate entities from string variations — "open-source model" vs "open-source models", "Poly Markets" vs "Polymarket" created separate nodes, fragmenting the graph.

**Fix (importance):** Added few-shot examples to extraction prompt showing concrete importance levels (wife+health=5, job=4, preference=3, context=2, ephemeral=1). Added warning log when `imp` is missing.
**Fix (entity typing):** Changed NER prompt from flat `["string"]` to typed `[{name, type}]` with closed taxonomy (person, organization, technology, hardware, software, place, event, concept). MERGE uses extracted type, ON MATCH upgrades `unknown` → real type.
**Fix (bootstrapped NER):** NER prompt now queries existing typed entities from the graph and injects them as reference context: "Known entities: DGX Spark → hardware, DevMesh → organization...". Creates a self-improving loop — correctly typed entities teach the model to classify new ones consistently. Without this, phi4-mini classified blind (DGX Spark → software, Solutions Architect → person). Rollback: remove the `knownEntitiesBlock` query in `graph-store.ts addFact()` and revert to static examples.
**Fix (entity dedup):** Added `normalizeEntityName()` for canonical form computation (lowercase, collapse whitespace, simple plural stripping). MERGE matches on canonical property. Display name preserved separately. Startup migration backfills canonical on existing entities. NER prompt instructs model to use singular/canonical forms.
**Status:** Active.

### Graph memory maintenance: entity quality gate + orphan cleanup (June 2026)
**Problem:** First graph audit (1 month in, 1,067 nodes) revealed three categories of junk: (1) garbage entities — "user", "user's", "230s" created as entity nodes, (2) duplicate entities — same canonical name but different types (DevMesh as both `organization` and `unknown`) creating separate nodes, (3) orphaned entities — fact deletions left entity nodes with no ABOUT edges pointing to them. Also found 30+ entities still typed `unknown` from before bootstrapped NER was added, and misclassifications (SOUL.md → hardware, ERA blocks → software).
**Fix (quality gate):** Added `isGarbageEntity()` filter before graph insertion — rejects generic pronouns ("user", "user's", "they"), pure numbers ("230s"), and single-char strings. Runs after NER extraction, before MERGE.
**Fix (orphan cleanup):** After `removeFact()`, automatically sweeps entities with no remaining ABOUT or MENTIONS edges. Best-effort, non-blocking.
**Not fixed with TTL:** Fact expiry stays human-in-the-loop via heartbeat review candidates — the user knows if "interested in Polymarket" is still relevant, the model doesn't.
**Lesson:** Graph databases need periodic maintenance just like any other data store. Plan for a monthly audit cycle — the bootstrapped NER and quality gates reduce future junk, but won't eliminate it entirely.
**Status:** Active. First cleanup: 73→50 facts, 97→75 entities, 0 unknown types remaining.

### Chrome extension: console API bypasses orchestrator (June 2026)
**Problem:** Chrome extension sends messages to `/console/api/chat`, which calls `dispatchMessage()` directly — not through the orchestrator's `handleMessage()`. Page context override (`[PAGE:]` → force chat category) added to the orchestrator had no effect. Messages with injected page content were routed to `website` or `web_search`, which used `web_fetch`/`browser` to re-fetch pages the user was already looking at.
**Root cause:** Two dispatch paths exist: orchestrator (channels) and console API (web/extension). The override was only in the orchestrator.
**Fix:** Added `[PAGE:]` detection in `src/console/handlers/chat.ts` with `overrideCategory: 'chat'`. When the extension injects page context, the model reads the injected content directly — no tools, no fetching.
**Also fixed:** Extension manifest had `host_permissions: ['http://localhost:*/*']` only — content script injection silently failed on HTTPS pages (all of them). Added `https://*/*`. Changed from programmatic `executeScript` injection to declarative content script with active message listener for reliability.
**Lesson:** When adding routing overrides, check ALL dispatch paths — not just the main orchestrator flow. The console API is a separate entry point.
**Status:** Active.

### !save writing to both FactStore and GraphMemory (May 2026)
**Problem:** The `!save` command (user-approved fact storage after `!reset`) only wrote to the flat JSONL FactStore, never to FalkorDB. Facts only reached the graph via heartbeat transcript review — a separate extraction pass that could produce different results.
**Fix:** `!save` now writes each fact to both stores. GraphMemory `addFact()` runs entity extraction, NER with typing, canonical normalization, and vector embedding.
**Status:** Active.

### URL routing: website specialist with fetch→browser fallback (May 2026)
**Problem:** Pasting a URL into chat caused the router to classify it as `web_search`, which searched for related content instead of fetching the actual URL. The `website` category existed but used a broken `website_query` tool (required `tools.website.baseUrl` config that was never set).
**Fix:** Added pre-model override in `classifier.ts`: any message containing a URL routes to `website`. Rebuilt the `website` specialist to use `web_fetch` → `browser` fallback (ReAct loop, no pipeline). Reddit and other JS-heavy sites that block `web_fetch` get rendered by the headless browser automatically.
**Status:** Active.

### Setup wizard overhaul (May 2026)
**Problem:** The setup wizard generated a ~60 line config that silently disabled most features. No graph memory, no heartbeat, no security, no research/image/personal specialists, no pipeline fields. Preflight said "All checks passed!" with a severely incomplete config.
**Fix:** Complete rewrite of `generate.ts` to produce a production-ready config (~200 lines). Added prompts for: ownerId, trusted users, FalkorDB (with auto-install), OpenCode (with auto-install), heartbeat, reasoning model, image generation. Added prerequisites check (Docker) at wizard start. Preflight now warns about missing ownerId, no trusted users, disabled heartbeat, unavailable graph memory.
**Status:** Active.

### Analytics pipeline: code computes, model interprets (May 2026)
**Problem:** When users upload data files (CSV/Excel), the model hallucinated numbers. Tried multiple approaches: letting the model compute from pandas output (invented $1.2M totals), providing "authoritative data" labels (model ignored them), stricter prompts (still fabricated breakdowns). The model cannot reliably copy numbers from structured data.
**Decision:** Complete separation — Python computes ALL numbers (totals, breakdowns, top items, distributions) as a formatted markdown report. The LLM ONLY interprets the pre-built report, adding executive analysis, risk assessment, and recommendations. Same pattern as heartbeat: code handles "what", model handles "so what".
**Pipeline:** extract_file → report (Python/pandas) → generate_charts (matplotlib) → interpret (LLM) → attach_charts. Smart column selection: prefers "Total" over "Unit Cost", groups by "Category" not "Date", labels by "Item Description" not "Vendor". Python runs via /tmp scripts to avoid exec tool cwd path issues.
**Key bugs found:** JS template literals eating Python f-string `{}` braces, exec tool doubling workspace paths, matplotlib crashing on NaN in categorical data, column keyword matching order (column-first vs keyword-first).
**Status:** Active. File type routing in orchestrator: .csv/.xlsx/.json auto-route to analytics, text files prompt user for knowledge base vs read-as-text.

---

## Known Issues

### Double message delivery on Discord (intermittent)
**Problem:** Occasionally the bot sends the same response twice in Discord — the stream preview message AND a separate final message, resulting in duplicate content.
**Frequency:** Rare, observed twice in extended testing sessions.
**Suspected cause:** Race condition between stream message edit and the channelRegistry.send fallback path. May also relate to silent re-route or capability gap detection triggering a second dispatch.
**Impact:** Cosmetic — the response content is correct, just duplicated.
**Status:** Logged for investigation. Not blocking daily use.

---

## Future Ideas (Stashed)

### MFLUX + Pillow programmatic diagram generation
**Idea:** Use MFLUX (Apple MLX port of FLUX) to generate cyberpunk/stylized backgrounds locally, then composite text blocks, neon borders, and connection lines with Pillow. Produces architecture diagrams, system maps, status dashboards — all locally, no API.
**Why it fits:** Already have Flux on the infrastructure for image_generate. This extends it from "generate a picture" to "generate a technical visual." Could become a LocalClaw tool or pipeline stage.
**Inspiration:** Seen in another local AI setup that generated cyberpunk architecture diagrams this way.
**Status:** Stashed. Circle back when image pipeline is more mature.

### DevMesh integration into LocalClaw
**Idea:** LocalClaw becomes the control plane for DevMesh outreach platform. Phase 1: status/control tools (manage from Discord). Phase 2: pipeline convergence (shared search, LLM routing, cron, CRM tools).
**Why it fits:** Both systems share Ollama, cron, web search. LocalClaw's memory + calendar awareness can drive smarter outreach decisions.
**Status:** Stashed. Plan light integration first. See `memory/project_devmesh.md`.

---

## Ollama Version Issues

### Image generation API broken on 0.23.1 (May 2026)
**Problem:** Flux model on second Mac Mini returned empty progress lines (4/4 steps in milliseconds) with no image data via API. Worked fine via `ollama run` locally.
**Fix:** Downgraded to Ollama 0.21.2. Image generation works correctly over API on this version.
**Status:** Pinned at 0.21.2 on image gen Mac Mini. Monitor future Ollama releases for fix.

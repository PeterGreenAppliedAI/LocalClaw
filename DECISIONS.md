# Architectural Decisions & Lessons Learned

A log of significant decisions, failed experiments, and why things are the way they are. Prevents re-trying things that already failed and documents the reasoning behind current architecture.

---

## Multi-Backend Inference & MiniMax Swap (June 2026)

### vLLM backend, additive (June 2026)
**Decision:** Add OpenAI-compatible inference (vLLM serving MiniMax-M2.7) alongside Ollama, not replace it.
**How:** `MultiBackendClient extends OllamaClient` routes `chat`/`chatStream` to `OpenAICompatClient` when the model id matches `inference.backends[].models`, else falls through to Ollama. `embed`/`generate`/`listModels` always use Ollama. Drop-in — every `client: OllamaClient` call site is unchanged.
**Translation handled in OpenAICompatClient:** `options.{temperature,top_p,num_predict}`→top-level; tool-call `arguments` string→object (vLLM returns a JSON string, Ollama an object); `tool_call_id` stitched onto tool-result messages (OpenAI requires it, the ReAct engine doesn't emit it); SSE streaming; `usage`→`eval_count`/`prompt_eval_count`.
**Status:** Active.

### Model split: foreground on Spark, utility on A5000 (June 2026)
**Decision:** MiniMax-M2.7 (vLLM, Spark) for all foreground specialists + chat + multi + the `reason` tool. qwen3.6:27b (A5000 gateway) for vision + briefing + heartbeat (background). phi4/phi4-mini/qwen3-embedding stay on the gateway (router/NER/extraction/embedding). qwen2.5:7b stays for the voice fast-path; whisper/flux unchanged.
**Why:** MiniMax reasons far better than qwen3-coder:30b/gemma4:26b; the hardware split keeps the Spark free for foreground while the A5000 handles small/modality models. Vision can't move to MiniMax (text-only) — qwen3.6:27b is multimodal and covers it.
**Gotcha:** the `reason` tool's model lives in its own `reasoning` config block and was missed in the first swap pass — it pointed at a non-existent `nemotron-3-nano:30b` and hung every forced-reasoning pass on a timeout loop. Fixed to MiniMax. Lesson: model strings live in several config blocks (specialists, reasoning, vision, voice, briefing, heartbeat, opencode) — swap them all.
**Deferred:** OpenCode `defaultModel` stays `ollama/qwen3-coder:30b` — its `provider/model` slash-split collides with MiniMax's slashed id (`cyankiwi/MiniMax-...`); needs its own provider wiring.
**Status:** Active.

### Context window raised to 128K (June 2026)
**Decision:** `session.contextSize` 32K→131072; added optional per-specialist `contextSize` override.
**Why:** 32K forced compaction every message. MiniMax serves 192K. The global value drives the compaction budget (safe to raise — router/vision/embedding set their own `num_ctx`; MiniMax ignores `num_ctx` since vLLM fixes context at launch). Per-specialist override is the lever to *lower* context for any future small-context Ollama specialist.
**Status:** Active.

## Memory Integrity (June 2026)

### FactStore importance-aware char bound (June 2026)
**Problem:** Root-caused a real data loss — the user's wife's name (and other imp-4/5 family facts) lived in USER.md + historical raw extractions but were absent from facts.json and the graph. `enforceCharBound` capped facts.json at 3000 chars (~12 facts) and evicted the *lowest-confidence* facts, ignoring importance — so a critical identity fact with moderate confidence got dropped before an ephemeral high-confidence one. Logs showed "trimmed 92 low-confidence facts."
**Fix:** Eviction orders by importance first, confidence as tiebreak; imp≥4 never evicted; `MAX_FACTS_CHARS` 3000→20000.
**Status:** Active. Backfill of historical facts into the graph deliberately NOT automated — the raw set contains time-sensitive/sensitive personal facts (a pregnancy, a hospitalization, a pet's death) and contradictions; re-asserting them as current is a user decision.

### Graph provenance edges wired (June 2026)
**Problem:** `EXTRACTED_FROM` and `SUPERSEDES` were defined in the schema but never created (live graph showed 0 of each). `addFact`'s `sourceSession` was optional and no caller passed it; the contradiction check set `superseded=true` but created no edge.
**Fix:** Session key threaded through all `addFact` callers (heartbeat, !save, memory_save); SUPERSEDES edge created (new→old) after the new Fact node exists.
**Status:** Active.

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
- vs Memgraph: Lacked native vector search at time of evaluation (has since added it).

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
**Revision (June 2026):** Removed the forced `overrideCategory: 'chat'` for extension messages. Let the router classify naturally — it correctly sends "summarize this page" to chat and "click the search bar" to website. Keyword-based intent detection was tried and abandoned (too fragile, false positives on "search for").
**Status:** Active. Router classifies, no overrides.

### Browser control via Chrome extension — evolution (June 2026)
**Problem:** The extension reads page content but can't interact with it. User wants browser control (click, type, navigate) through the extension on their Windows PC, controlled by LocalClaw on the Mac Mini.

**Approach 1 (rejected): CDP over network.** Playwright on Mac Mini connects to Chrome on Windows via `--remote-debugging-port`. Works but exposes Chrome's debug port across the network — real security concern. Built and removed.

**Approach 2 (rejected): Extension parses LLM action tokens.** LocalClaw responds with `[ACTION: click | ref=3]` tokens, extension parses and executes. Same antipattern as letting models decide tool ordering — fragile, retry-prone.

**Approach 3 (active): Remote browser bridge.** Model calls the browser tool normally. If extension is connected (`remoteBridge.isConnected()` + `channel === 'console'`), the tool forwards the structured command to the extension via a poll/POST queue instead of Playwright. Extension content script executes DOM actions. The extension is a dumb executor — same pattern as Docker for exec.

**Architecture:** `model → browser tool → remote bridge queue → extension polls GET /browser/action → background relays to content script → content script executes → POST result → tool promise resolves → model sees result`

**Bugs hit during implementation:**
1. **Content script dies on navigate.** `window.location.href` kills the content script. Fix: navigate delegated to background via `chrome.tabs.update()`.
2. **Content script not loaded on tab.** After navigation or tab switch, content script doesn't exist. Fix: background pings content script, injects on-demand via `chrome.scripting.executeScript()` if missing.
3. **Navigate timing.** Navigate returns instantly but new page hasn't loaded. Next action (snapshot) fails. Fix: 3-second delay after navigate actions.
4. **"Illegal invocation" on type.** Native setter used wrong prototype for `<textarea>` vs `<input>`. Fix: check element tag, try/catch fallback.
5. **Conversational guard blocking website.** Guard downgraded `website` → `chat` on follow-up messages (no task intent detected for "go to reddit.com"). Fix: skip guard for console channel.
6. **qwen3-coder repeated snapshots.** Model called snapshot 8x in a row without acting on results. Can't self-regulate multi-step browser interactions.
7. **gemma4:26b froze on browser control.** Switched from qwen3-coder hoping better reasoning would help. Instead: (a) thinking tags parsed as final answer — parser didn't strip `<|channel>thought` blocks, ending loop at step 4, (b) temperature clamp to 0.3 killed MoE performance (needs 1.0), (c) even with both fixes, model froze generating massive thinking blocks with 16K token headroom instead of acting. gemma4 reasons too much and acts too slowly for rapid browser interaction.
8. **qwen3.6:35b works.** Better reasoning than qwen3-coder, faster than gemma4. Uses direct URLs (google.com/search?q=...) instead of multi-step UI interaction. Searches across multiple vendors (Google, eBay, Amazon). Only issue: retried 404 URLs instead of skipping them.
9. **web_fetch competing with browser tool.** Model had web_fetch, browser, and web_search available. Defaulted to web_fetch (simpler) instead of using the browser to navigate pages the user can see. Fix: strip web_fetch from tool list in browser control mode — forces the model to use browser for navigation.
10. **Page content bloated compaction.** 10K chars of page content repeated in session history broke compaction. Fix: strip `[PAGE_CONTENT]` from archive after fact extraction but before summary generation.
11. **Drift detector fighting completion.** Model has enough data and tries to synthesize final answer, but drift detector flags "growing text" and re-anchors, forcing more unnecessary actions. Browser control needs different drift thresholds.

**Model evaluation for browser control:**
- qwen3-coder:30b — fast tool calls but can't reason about multi-step sequences. Loops on snapshots.
- gemma4:26b — good reasoning but freezes generating thinking blocks. Too slow for interactive browser actions.
- qwen3.6:35b — best balance. Plans well (direct URLs), acts quickly, recovers from errors. Active choice.

**Lesson:** Browser control is fundamentally different from browser fetching. The website specialist ("fetch and summarize") can't do multi-step automation. Needed: a dedicated prompt (plan before acting, never repeat actions, prefer direct URLs, recovery strategies), a reasoning model (qwen3.6 over qwen3-coder/gemma4), more iterations (25), higher output tokens (16K), and web_fetch stripped from tool list to force browser usage.

### Deterministic pipeline for browser control — FAILED (June 2026)
**Tried:** Replaced the working ReAct browser control with a deterministic pipeline (plan → reflect → execute → synthesize → quality review → revision). Same pattern as analytics/heartbeat/web-search. 280 lines became 601 lines.

**What broke:**
1. **Synthesize stripping cascade** — LLM told to output "synthesize" as final step, `parse_plan` stripped it, `reflect_on_plan` stripped it again from revised plans → plans shrank from 5 steps to 1-2
2. **Plan reflection made plans worse** — saw a 4-step plan, "revised" it to 2 steps. Same model doing action + critique produces rubber stamp effect (confirmed by research)
3. **Per-step reflection JSON parsing failed** — summary field contained page content with unescaped quotes/newlines that broke JSON parsing, even with JSON5. When reflection failed, no summary was captured → synthesis had no data
4. **Reflection injected hallucinated actions** — `sort_results`, `validate_urls`, `check_pagination` despite action validation filter (plan reflection's revised plan bypassed validation initially)
5. **Quality review suggested infrastructure changes** — "use Playwright with waitForSelector" — revision LLM took this literally and wrote a Python tutorial instead of product data
6. **Revision hallucinated data** — with no real data from failed collection, revision invented URLs, prices, and vendor names

**Research findings that explain the failure:**
- Skyvern (45% → 85.8% on WebVoyager) achieved this by adding a **Validator LLM**, not a planner. Upfront planning is a known failure mode.
- Browser-Use uses pure ReAct with code-driven loop detection (action hashing). No separate planner.
- Same model for action + critique produces rubber stamp effect. External signals (DOM mutations, screenshot diffs) are needed for honest validation.
- WebVoyager keeps only 3 most recent observations. Keeping all step results bloats context.

**What worked instead:** Guided ReAct with code guardrails:
- Action dedup via hash comparison (Browser-Use pattern) — blocks identical consecutive tool calls
- Content-aware auto-vision — regex checks for price/product patterns in snapshot, auto-escalates to screenshot+vision when missing
- Skip growing-text drift detection — let model produce long final answers
- 20 iterations max, qwen3.6:35b, web_fetch stripped

**Lesson:** Not everything benefits from a deterministic pipeline. Browser control is inherently reactive — the model needs to see page content before deciding what to do next. Upfront planning commits to a strategy before seeing the data. The pipeline pattern works for categories with predictable workflows (analytics: always load → compute → chart → interpret). Browser control has unpredictable workflows — different sites, different layouts, different failure modes. ReAct with code guardrails (dedup, vision fallback, iteration caps) is the right pattern.

**Status:** Active. Guided ReAct with action dedup, content-aware auto-vision, qwen3.6:35b. 10 steps for multi-vendor comparison with real prices and URLs.

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

### Gateway 429 rate limit under request bursts (June 2026)
**Problem:** The Ollama gateway (10.0.0.20:8001) caps at 100 requests/minute. Everything except MiniMax (router classify, embedding, NER, vision, pipeline quality_review, post-task review, semantic state extraction) hits the gateway. A single web_search message fires several gateway calls; rapid messages + 5 parallel fetches burst past 100/min → `429 rate_limit_exceeded`.
**Observed:** "OLLAMA_INFERENCE_ERROR: Classification failed — 429" + "Post-task review failed — 429".
**Impact:** Degrades gracefully (router falls back to keyword classification, reviews skip) — nothing crashes — but lossy: a 429'd router classification means keyword routing instead of the model, which is exactly when misroutes creep in.
**Potential fixes (NOT yet done):**
1. **Infra:** raise the gateway req/min cap (100 → 300-500) — it's tight for a multi-call pipeline on shared small models.
2. **Client:** add 429 backoff/retry to `OllamaClient.post()` — it currently retries once on *connection* failure but throws immediately on 429. A short exponential backoff (the rate window resets in <60s) would smooth transient limits instead of dropping the call. This is the right resilience fix regardless of the gateway cap.
3. **Reduce burst:** post-task review + quality review add gateway calls per message; consider gating them or batching.
**Status:** Documented, deferred. Fix #2 (client backoff) is the cleanest LocalClaw-side improvement.

### Research / deck pipeline fragile (June 2026)
**Problem:** The research pipeline's deck/PDF rendering path (reveal.js deck + styled PDF branch) is unreliable — "the whole deck thing is kinda broken."
**History:** This path has been fragile since the deck/report branch was added; an earlier deterministic browser-control pipeline in the same family was reverted for similar reasons (see Failed Approaches).
**Impact:** Report/deck generation (`research` category, "make me a report/deck") produces broken or incomplete output. Web_search synthesis (the lighter path) works well.
**Potential fix (NOT yet done):** A focused rebuild of the research pipeline render stages — review the chart-gen → write_file → render_deck flow, the HTML template, and the PDF branch. Worth its own session, not a 1am patch.
**Status:** Documented, deferred to a dedicated session.

### Chat over-promises tool actions (band-aid in place) (June 2026)
**Problem:** The toolless chat specialist sometimes promises actions it can't perform ("Let me search for X", "On it, let me pull together…") and then can't follow through — no tools, no ReAct loop, so hallucination detection (which lives in the tool-loop engine) never runs.
**Current mitigation (band-aid):** The silent re-route (dispatch.ts) now catches future-action promises (search/research verbs) and re-dispatches to a specialist that can actually do it.
**Cleaner fix (NOT yet done):** Strengthen the chat system prompt so it doesn't promise tool actions in the first place — if it needs to search, it should signal a re-route, not narrate intent. Pairs naturally with the research-pipeline work.
**Status:** Band-aid active (catches it post-hoc and does the search); prompt-level fix deferred.

### SearXNG self-hosted search provider (June 2026)
**Problem:** Brave's free tier (~1 req/sec, 2000/month) forced a serialized throttle + 429 backoff and capped the research/verification search budget (bounded Tier-1 cross-checks, sequential facet searches). The rate limit was the recurring bottleneck across the whole research/verification build-out.
**Fix:** Added a `searxng` provider to `src/tools/web-search.ts` (+ `provider` enum and a `baseUrl` field in `WebSearchConfigSchema`). SearXNG is a self-hosted metasearch engine — no API key, no rate limit. Calls `GET {baseUrl}/search?format=json`, maps our `freshness` (day/week/month/year) → SearXNG `time_range` (same vocabulary), slices to `count`. Requires the instance's `settings.yml` to enable the JSON format (`search.formats: [html, json]`) — returns a clear 403 error otherwise. Purely additive; Brave/Tavily/etc. paths unchanged. Runtime config points at the LAN instance (gitignored).
**Status:** Live. With no rate limit, the Brave throttle is effectively bypassed and the Tier-1/facet search budgets can be widened if desired.

### web_search recall depth + freshness effectiveness (June 2026)
**Problem:** Broad multi-vendor survey queries via web_search (single query, now top-5 fetches) can still miss product-specific pages (e.g. missed the DGX Spark article in an Apple/NVIDIA/AMD survey — it ranked below the comparison pieces).
**Mitigations done:** fetch 3→5 pages; freshness forcing on recency-signalling queries.
**Open questions (NOT verified):**
1. Does the search provider (Brave) actually honor the `freshness=month` param? A "recent" query once returned 2019-2023 content even with freshness forced. Needs isolated verification.
2. Broad surveys are really a `research` request (multi-query, 8 fetches, supplementary round), not a `search` one — but "search the web for X" routes to the shallow pipeline. Consider routing multi-entity surveys to research.
**Status:** Documented. Freshness-param verification is the next concrete check.

### Routing latency on the gateway (June 2026)
**Problem:** Router classification (phi4 on the gateway) occasionally takes 4-5s (observed `Routing: 4957ms`). Memory runs in parallel, so it's the classifier itself — almost certainly gateway contention (many models resident on the A5000 node, or phi4 cold-reloading).
**Potential fix (NOT yet done):** `OLLAMA_MAX_LOADED_MODELS` bump or trimming what's resident on the gateway so phi4 stays warm. Infra-side, not code.
**Status:** Documented, watch. Related to the 429 issue — both point at gateway-node pressure.

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

## Conference-Inspired Improvements (June 2026, AI Dev Summit)

### Memory decay (June 2026)
**Source:** Talk 2 (Lamatic AI) — "memory eviction and decay let the agent forget gracefully."
**Problem:** Facts persist forever in the graph store. Low-importance ephemeral facts accumulate, degrading search quality. Flat store has TTL but graph store had none.
**Fix:** `applyDecay()` in GraphMemoryStore. Confidence decays automatically based on importance tier: imp 1 at 0.05/day, imp 2 at 0.02/day, imp 3 at 0.005/day. Identity facts (4-5) never decay. Facts below 0.3 confidence auto-removed. Facts 0.3-0.5 surfaced as review candidates.
**Status:** Active.

### Contradiction eviction (June 2026)
**Source:** Talk 2 (Lamatic AI) — "deleting 'favorite color is red' when user says they hate red."
**Problem:** "I use Ubuntu" and "I switched to Arch" coexisted in the graph until manual heartbeat review.
**Fix:** On `addFact()`, vector search for similar existing facts (cosine distance 0.15-0.4). For each match, phi4-mini judges YES/NO on contradiction. If YES, old fact marked `superseded: true`.
**Status:** Active.

### Token economics monitoring (June 2026)
**Source:** Talk 1 (stealth founder) — "Uber burning annual token budget in four months."
**Problem:** Ollama returns `eval_count` and `prompt_eval_count` in every response but they were completely discarded. No visibility into token consumption per category.
**Fix:** Token counts captured from Ollama responses (both streaming and non-streaming), accumulated per tool loop iteration, logged per dispatch. `[Dispatch] Tokens: 3200 prompt + 800 completion = 4000 total (web_search)`
**Status:** Active.

### LLM-as-judge quality scoring (June 2026)
**Source:** Talk 3 (Ramana) — "LLM-as-judge graded on accuracy, relevance, citation, tone."
**Problem:** Quality review existed only in web_search and research pipelines. No systematic scoring across categories.
**Fix:** Post-dispatch quality check for pipeline categories (web_search, research, analytics, multi, exec, code_gen). Router model scores 1-5 on accuracy, relevance, completeness. Logged to `data/quality/quality-scores.jsonl` for weekly review. Skipped for chat/cron/task/memory (subjective or deterministic).
**Status:** Active.

### Metadata-filtered memory search (June 2026)
**Source:** Talk 3 (Ramana) — "metadata as the filter layer applied before semantic search."
**Problem:** Vector KNN searched ALL facts for a sender. No pre-filtering by importance, category, or age.
**Fix:** `search()` now accepts optional filters: `minImportance`, `categories`, `maxAgeDays`. Cypher WHERE clauses applied before vector KNN. Dispatch can pass context-aware filters per category.
**Status:** Active (filters available, context-aware dispatch filtering ready to wire).

### Specialist use case specs (June 2026)
**Source:** Talk 3 (Ramana) — "12-point spec per use case."
**Fix:** `SPECIALISTS.md` with 12-point specs for top 5 specialists (chat, web_search, research, multi, exec). Includes in/out scope, acceptance criteria, edge cases, known failures, test cases.
**Status:** Active.

### Session-scoped permissions (June 2026)
**Source:** Talk 5 (Architex) — "block by default, approve once scoped to the conversation."
**Fix:** Added `toolGrants` to SessionState. Foundation for per-session tool access with TTL.
**Status:** Schema added, enforcement logic ready to wire in dispatch.

### Progressive tool disclosure (June 2026)
**Source:** Talk 6 (Juwan Lightfoot) — "MCP servers inject ~7000 tokens of tool definitions."
**Fix:** Added `relevanceHints` field to LocalClawTool interface. Foundation for filtering tool injection based on user message context.
**Status:** Interface extended, filtering logic ready to wire in prompt-builder.

### Media burst handling (June 2026)
**Source:** WhatsApp media burst incident.
**Fix:** Vision queue (one call at a time), media debounce (3-second batching), video path (acknowledge and save), rate limiter adjustment.
**Status:** Active.

---

## Security Hardening (June 2026, External Review)

### Web API authentication warning (June 2026)
**Finding (P0):** Web adapter bound to 0.0.0.0 with no token = anyone on the network can exec commands.
**Fix:** Startup warning when no token + 0.0.0.0. Host stays configurable (user accesses from network). README updated with security configuration section and explicit guidance to set a token.
**Status:** Active. Warning on startup, docs updated.

### Session route path traversal (June 2026)
**Finding (P1):** Console API accepts `agentId` from URL path and passes to `join(baseDir, agentId, ...)` unsanitized. `../` in agentId = file access outside sessions directory.
**Fix:** `sanitizePath()` strips `..` and path separators. SessionStore now sanitizes agentId in all path methods (not just sessionKey).
**Status:** Active.

### File containment prefix matching (June 2026)
**Finding (P1):** `startsWith(resolve(workspace))` allows sibling-prefix escapes (`main2` when workspace is `main`).
**Fix (round 1):** Changed to `startsWith(resolve(workspace) + '/')`.
**Fix (round 2):** Replaced with `path.relative()` + `isAbsolute()` check — cross-platform safe (POSIX + Windows). Applied to read_file, write_file, console file serving, and static console serving.
**Status:** Active.

### Telegram allowFrom (June 2026)
**Finding (P2):** Discord and Slack enforce `allowFrom`, Telegram didn't.
**Fix (round 1):** Added `allowFrom` set to TelegramAdapter.
**Fix (round 2):** Fixed to read `allowFrom.users` (schema-compatible `{users?: string[]}`) instead of treating `allowFrom` as a flat array (which never matched the Zod schema).
**Status:** Active.

### Scoped tool executor (June 2026)
**Finding (P1):** ToolRegistry.createExecutor() directly executed any tool. Pipeline stages bypassed dispatch-time filtering.
**Fix:** Added `createScopedExecutor(allowedTools: Set<string>)` — rejects tools not in the allowlist. Wired in both ReAct and pipeline dispatch paths as the final enforcement gate. Cron tool stripping now enforced even in pipelines.
**Status:** Active.

---

## Latency Optimization (June 2026)

### Parallel memory + router (June 2026)
**Problem:** Graph memory queries (embed → KNN → multi-hop → user model) ran sequentially BEFORE router classification. ~800-1500ms of blocking before routing even started.
**Fix:** Router classification and memory injection run as `Promise.all()`. Router starts immediately, memory runs alongside. Memory results injected when they arrive — if memory finishes during routing, wait time is 0ms.
**Also:** Lazy multi-hop — only runs if KNN returns <3 results (inspired by Hermes Agent pattern).
**Measured:** Routing 0-4ms (sticky) with memory priming 235-2900ms in parallel. Previously sequential (additive).
**Status:** Active.

### Async compaction cache → turn-count gated + prewarm (June 2026)
**Problem:** History compaction ran synchronously every message once history exceeded budget (300-1000ms blocking).
**v1:** Cache compaction per session (5-min TTL), serve cached + refresh async.
**v2 (review fix):** TTL-only cache could serve history MISSING the previous exchange. Gated cache validity on SessionStore `turnCount` — reuse only if no new turns since it was built.
**v3 (review fix):** Turn-count gate made the cache miss after every exchange (each response appends 2 turns). Added a **prewarm**: after appending turns, build+cache compaction in the background keyed to the new turn count, so the next message hits a warm, correct cache.
**v4 (review fix):** Removed the cache-hit async refresh entirely — with turn-count gating a cache entry is exact for its turn count (can't drift) and turn count only increases, so the refresh cached an obsolete count and raced the prewarm for the `pendingCompactions` lock. Deleting it fixed the race by removing the path.
**Reset:** `clearSession` resets metadata `turnCount` to 0; `clearCompactionCache()` clears the entry on `!reset`/`!new` so a fresh session can't reuse old compacted history.
**Status:** Active. (Note: with the 128K context raise, compaction's expensive LLM summary rarely fires at all now.)

### Tool-loop streaming (June 2026)
**Problem:** Tool-loop specialists used non-streaming `client.chat()`. User saw "thinking..." for 2-5 seconds with no feedback.
**Fix:** Three streaming points: (1) plain-text tool status events ("Searching...", "Running command...") before each tool execution, (2) max-iterations synthesis via `chatStream()` with `tools: undefined` (safe — no tool-call risk), (3) normal final answer post-hoc streamed after tool calls complete.
**Rule:** Tool-loop model calls stay non-streaming (prevents leaking JSON/function calls). Only stream user-facing natural language.
**Status:** Active.

### Web-fetch page caching + URL key case (June 2026)
**Problem:** Same pages fetched repeatedly across conversations. No caching.
**Fix:** In-memory cache with 1-hour TTL. SSRF validation runs BEFORE cache check, and returns a tool-style `Error:` (not throw). Cache key includes URL + extractMode + maxChars. Non-HTML responses cached too.
**Review fix:** `normalizeCacheKey` lowercased all keys — fine for search queries, wrong for URLs (`/Foo` vs `/foo` collide). Split into `normalizeCacheKey` (queries, lowercase) vs `normalizeUrlKey` (URLs, trim only); `readCache`/`writeCache` now use keys verbatim and callers normalize.
**Status:** Active.

### Search source buckets — removed (June 2026)
**History:** `src/pipeline/search-buckets.ts` mapped query topics to curated-domain buckets and appended `site:` filters (with an anchor convention guaranteeing high-value domains, a `real_estate` bucket, civic open-data spread, etc.).
**Why removed:** In practice the buckets didn't deliver — `site:` filters over-constrained Brave on longer/question-shaped queries (often returning nothing), and the curated domain lists added maintenance and misroute risk (e.g. "AMD/NVIDIA hardware for local inference" landed in ai_tech, not hardware) without improving result quality. Per the user: "the bucket angle just hasn't produced what I thought it would."
**Fix:** Deleted `search-buckets.ts` + its test. `web_search` and `research` now run plain queries with **recency/freshness filtering only** — `freshness=month` is forced when the query signals recency (research applies the same `wantsFreshness` check per angle and on the topic). URLs are taken in result order (no bucket re-prioritization).
**Status:** Buckets gone; recency filter retained.

### Per-domain source-diversity cap — tried and reverted (June 2026)
**What was tried:** Research capped fetches at ≤2 per domain run-wide (+ distinct domains within a facet, exact-URL dedup), to stop runs leaning on one source. It raised the source count (12→16) and the automated quality score (rel 4→5, comp 3→4).
**Why reverted:** Side-by-side, the *capped* report was visibly **worse** — less well-rounded. Root cause: a single genuinely comprehensive survey source (an "enterprise guide" page) had been the backbone of the good run, legitimately informing many facets (ASIC ecosystem, vendors, market size, DGX Spark). The cap throttled exactly that source, forcing reliance on thinner specialized pages — trading breadth for scattered depth. The original "all from one source" complaint was really **cosmetic log noise** (the same URL re-found across facets, already harmless via the `seen`-style dedup), not a quality problem. The automated judge rewarded source count; the human judged substance and preferred the uncapped run.
**Lesson:** Don't cap how much a comprehensive source can contribute. Diversity-by-fetch-cap is the wrong mechanism; a great survey should be allowed to anchor a report. Recency bias + Brave freshness-code mapping (from the same commit) were kept — only the cap was rolled back.
**Status:** Reverted to plain top-3 URLs per facet in result order.

### Evidence verification layer for research (June 2026)
**Problem:** MiniMax synthesizes a confident report from mostly secondary blogs with no check that each statement is supported by its cited source. Live output stated materially false claims as fact — NVIDIA's Dec-2025 Groq arrangement called an "acquisition" (it was a non-exclusive license + hires), Cerebras IPO dated Feb 2026 (actual debut May 14 2026).
**Approach (MVP):** A cited-source-only verification pass between `parse_final` and `generate_visuals` (`src/pipeline/verification.ts` + stages in research.ts). Principle: **no claim should outrun its evidence.** Extract atomic claims (fast model) → check each against the *cached* page it was built from (research now persists `_sourceText`, so zero new searches) → entailment judge returns a controlled verdict (VERIFIED/PARTIALLY_VERIFIED/UNSUPPORTED/VENDOR_CLAIM/AMBIGUOUS) → MiniMax correction pass edits ONLY failed sentences (attribute "according to X" / qualify / remove) → re-extract + diff to catch claims added during revision → publish with a `## Verification` appendix + auditable `verification.json`. Config-gated (`verification` block, on by default); correction stage `when`-skips if all VERIFIED. Never hard-blocks publication.
**Known limit (by design):** cited-source-only catches *overstatement* and enforces *attribution* — it cannot disprove a source that is itself wrong/stale (the Groq/Cerebras blogs get honestly attributed, not corrected to the truth). Independently disproving those needs a **Tier-1 cross-check** (one targeted official-source fetch for high-impact + weak-sourced claims) — designed, deferred to Phase 2 along with benchmark-schema validation, an adversarial synthesis critic, and hard publication gates.
**Live result — DISABLED by default (June 2026):** First live run degraded the report (quality acc 5→3) and deleted true claims (M3 Ultra 512GB, NVIDIA ~92% share, $255B-by-2030, the Groq deal). Three bugs: (1) `verdictToAction` mapped UNSUPPORTED→**remove** instead of attribute/qualify — deletion is the opposite of the "according to X" goal; (2) **citation→source mismatch** — the synthesis model's `[n]` numbering is unreliable and reports synthesize across sources, so checking a claim against its single (mis-)cited URL yields false UNSUPPORTEDs (claims cited to the right page verified fine; misattributed-but-true claims got removed); (3) the revision **claim-diff appendix is noise** — reworded/merged sentences show as "newly added." Flipped `verification.enabled` default to **false** (code retained, fully gated). Fix plan: never auto-remove (UNSUPPORTED→qualify/attribute); check each claim against the **broader cached corpus** (`_sourceText` for all sources, top-K by token overlap) not one cited URL; drop the diff. Re-enable only after a live run shows it *improves* (not degrades) accuracy.
**Precision fixes — RE-ENABLED (June 2026):** Fixed all three on a branch and merged: (1) **never auto-remove** — UNSUPPORTED/AMBIGUOUS → `qualify` (hedge the certainty), VENDOR_CLAIM → `attribute`; any judge-returned `remove` is coerced to a hedge; (2) **broader-corpus check** — `pickRelevantSources()` ranks all cached pages by token/number overlap and the judge sees the top-K that actually mention the claim (plus the cited URL), reporting which source supports it — kills the false-UNSUPPORTEDs; (3) **dropped the revision diff** + concise-hedging instruction (one qualifier per sentence). Second live run: **0 removes** (was 8), 5/12 claims hedged/attributed, all true claims survived (92% share → "According to Intuition Labs…", M3 Ultra 512GB kept + hedged). The automated quality judge still scored it low (acc 3, comp 2) but a human read confirmed the report is comprehensive and well-rounded — **the judge is not a trustworthy signal here** (it also over-rewarded the disliked diversity-cap run). Re-enabled by default.
**Phase 2 — Tier-1 independent cross-check (June 2026):** Added to catch faithfully-cited wrong facts (the Groq-date class). After cited-source verification, a `tier1_crosscheck` stage escalates a bounded set of **high-impact, falsifiable** claims (`corporate_event`/`financial`/`market_share` with named entities, capped at `maxCrossChecks`=4) to ONE independent `web_search` + fetch each. The query is built from entities + key terms **minus the contested value** (so it finds the authoritative source, not echoes of a wrong number). A judge returns CONFIRMED / CONTRADICTED / SILENT: CONTRADICTED → new `CONTRADICTED` verdict + `correct` action (the correction pass replaces the wrong detail using the independent evidence); CONFIRMED → un-hedges a previously qualified claim; SILENT → leaves the cited-source verdict. Bounded search budget (~≤4 searches, absorbed by the Brave throttle). Config: `verification.crossCheck` (default true), `maxCrossChecks` (4).
**Targeting fix (June 2026):** First Tier-1 live run executed correctly (4 cross-checks, bounded, throttle fine) but caught nothing useful — it escalated volatile **product-price** claims (the extractor tags "priced at $X" as `financial`), whose searches returned junk (a Robinhood NVDA stock page → SILENT), and the draft happened to contain no corporate-event claim at all. Narrowed `ESCALATE_TYPES` to **`corporate_event` + `market_share`** only (acquisitions/IPOs/launches/share — the actual Groq/Cerebras/92% class); dropped `financial`. Under this, that run escalates 0 and spends 0 searches — correct.
**Extraction-coverage fix (June 2026):** A later run still slipped a wrong "NVIDIA acquired Groq" past Tier-1 — because `extract_claims` pulled 9 GPU-price claims and never extracted the corporate event, so it never reached the cross-check. Fixed by instructing the extractor to ALWAYS include corporate events (with date, amount, and exact verb "acquired" vs "licensed") and market-share figures BEFORE routine prices/specs.
**Validated (June 2026):** With both fixes, a live run finally produced the end-to-end catch: Tier-1 independently found NVIDIA's own statement ("We haven't acquired Groq. We've taken a non-exclusive license…") → CONTRADICTED → the correction pass rewrote the report from "acquired" to "licensed," and corrected ~92%→94% market share from Jon Peddie Research. Confirmed in `verification.json` and the rendered PDF.
**Render fix (June 2026):** The correction model marked edits Word-style — wrapping old text in GFM strikethrough (`~~…~~`) and adding the replacement beside it; with `gfm` rendering, the PDF showed lines through the (still-present) wrong text. `stripStrikethrough()` removes struck spans/`<del>`/stray markers at the render chokepoint, plus a prompt instruction to replace cleanly.
**Status:** Live and enabled (cited-source + Tier-1), end-to-end catch validated. 389 tests. Caveat (real-world ambiguity, not a bug): the Groq deal is genuinely reported both ways — groq.com says "non-exclusive license," CNBC frames it as a "$20B acquisition" — which is the strongest argument for the verifier *attributing* disputed claims rather than silently rewriting; a future refinement. Trust the human side-by-side read over the judge score ([[feedback_regressions]]).

### web_search over-trigger (June 2026)
**Problem:** Conversational text containing bare "search"/"latest"/"news" (e.g. "uses brave for search") classified as web_search and ran the full pipeline.
**Fix:** Tightened the keyword hint to require intent ("search for/the web/online", "web search", google, look up, find out about); dropped bare search/latest/news. Router-prompt nudge for the model layer (not unit-testable — model layer has 0 corpus cases; needs live verification). Also: web_search forces `freshness=month` when the query signals recency, and the quality judge gained a recency check (was scoring a 2019-2023 retrospective 5/5/5 on a "recent" query).
**Status:** Active.

### Expanded pre-model overrides (June 2026)
**Problem:** Router LLM inference (phi4:14b) takes 400-800ms even for obvious classifications.
**Fix:** Added pre-model overrides: "add/create task" → task, "show/list tasks" → task, "generate/create image" → image. Conservative start-of-message patterns only. Also added speculative language override: "I wonder", "what if", "do you think" → chat (prevents "I wonder if you could create" → multi).
**Status:** Active.

### Conversational guard simplified (June 2026)
**Problem:** Keyword-based task intent matching caused both false positives (blocked "do some web search") and false negatives (let "I wonder if you could create" through). Every keyword fix broke another case.
**Fix:** Replaced 11-line keyword regex with 8-line length check: short messages (<30 chars) mid-conversation downgrade to chat. Long or explicit messages trust the router. No keyword matching.
**Status:** Active.

### Quality judge calibration (June 2026)
**Problem:** LLM-as-judge scored every response against research-report standards. Web search returning structured data with sources scored 2/5 (POOR).
**Fix:** Calibrated prompt per category with scoring guide: "a structured answer with sources is at least a 4." Category name included in prompt so judge knows the expected output format.
**Status:** Active.

---

## Ollama Version Issues

### Image generation API broken on 0.23.1 (May 2026)
**Problem:** Flux model on second Mac Mini returned empty progress lines (4/4 steps in milliseconds) with no image data via API. Worked fine via `ollama run` locally.
**Fix:** Downgraded to Ollama 0.21.2. Image generation works correctly over API on this version.
**Status:** Pinned at 0.21.2 on image gen Mac Mini. Monitor future Ollama releases for fix.

# Architectural Decisions & Lessons Learned

A log of significant decisions, failed experiments, and why things are the way they are. Prevents re-trying things that already failed and documents the reasoning behind current architecture.

---

## Model Evaluations

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

### Exec pipeline vs ReAct loop (April 2026)
**Tried:** Removed the exec pipeline to let the model reason freely about 6 exec tools in a ReAct loop.
**Result:** Model used 8 steps for `ls data` -- called exec correctly but then tried `find`, `chmod`, `which` before stopping. Massive over-exploration.
**Lesson:** Local models can't self-regulate in open-ended tool loops for simple tasks. Pipeline for simple commands, ReAct for complex multi-tool tasks.
**Status:** Exec pipeline restored.

### Sticky routing (April 2026)
**Tried:** Sticky routing kept follow-up messages on the same specialist across all categories.
**Result:** Short messages got trapped in wrong specialists. A greeting after a research task would route to research.
**Lesson:** Sticky routing only makes sense for conversational categories.
**Status:** Restricted to chat/memory only.

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
- vs Neo4j: Free (MIT-adjacent), 20MB vs 2.6GB memory, sub-ms lookups, native vector search. Neo4j Community can't cluster.
- vs SQLite (existing EmbeddingStore): No graph traversal, no relationship modeling, brute-force vector search.
- vs Memgraph: No native vector search.

**What the graph enables that flat storage can't:**
- SUPERSEDES edges: fact evolution with history ("ML engineer" → "Senior ML engineer")
- Temporal queries: "what did I know last month?" via createdAt filters + SUPERSEDES chain
- Multi-hop reasoning: traverse shared entities to find connected facts (DevMesh → AI → career fair)
- Community detection: clusters of related facts by entity co-occurrence (work cluster, health cluster, hobby cluster)
- Native vector KNN: O(log n) via HNSW index, not O(n) brute-force

**Infrastructure:** FalkorDB runs in Docker on the Mac Mini alongside LocalClaw. ~20MB for the graph at current scale.

**Status:** GraphMemoryStore built and tested. Integration into LocalClaw dispatch/orchestrator pending.

---

## Ollama Version Issues

### Image generation API broken on 0.23.1 (May 2026)
**Problem:** Flux model on second Mac Mini returned empty progress lines (4/4 steps in milliseconds) with no image data via API. Worked fine via `ollama run` locally.
**Fix:** Downgraded to Ollama 0.21.2. Image generation works correctly over API on this version.
**Status:** Pinned at 0.21.2 on image gen Mac Mini. Monitor future Ollama releases for fix.

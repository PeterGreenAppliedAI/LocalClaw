# Building a Production Memory System for Local AI Agents with FalkorDB

*How LocalClaw gives local models long-term memory using a graph database, vector search, and deterministic pipelines — all running on personal hardware with zero cloud dependencies.*

---

## The Problem with AI Memory

Most AI agent frameworks treat memory as an afterthought — a vector store you throw embeddings into and hope the right things come back. This falls apart fast:

- **Flat vector stores can't model relationships.** "Peter works at DevMesh" and "DevMesh is building an outreach platform" are two separate embeddings. A vector store can find each individually but can't traverse from Peter → DevMesh → outreach platform.
- **No temporal evolution.** When a user changes jobs, vector stores accumulate contradictory facts. "ML engineer at Company A" and "Senior engineer at Company B" coexist with no signal about which is current.
- **Retrieval is single-hop.** You search for "Peter's job" and get the job fact. But you don't get the related project facts, the technology preferences that informed career decisions, or the meeting notes that led to the change.
- **Dedup is an afterthought.** After a few weeks of conversations, you have 14 near-duplicate facts about the same topic — slightly different phrasings from different sessions.

We needed something better. After 4 phases of iteration on a flat JSONL fact store, we moved to FalkorDB — a GraphBLAS-based graph database with native HNSW vector search, running in a Docker container alongside the agent.

---

## Architecture: Dual-Backend with Write-Through

LocalClaw's memory has two backends:

```
                    ┌─────────────────────────┐
                    │    Memory Write Path     │
                    │                          │
                    │  !save / heartbeat /     │
                    │  memory_save tool        │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │    Write-Through Layer    │
                    │   (both stores in sync)   │
                    └──────┬──────────┬────────┘
                           │          │
              ┌────────────▼──┐  ┌───▼─────────────┐
              │   FalkorDB    │  │   Flat FactStore │
              │   (primary)   │  │   (fallback)     │
              │               │  │                  │
              │ • Graph nodes │  │ • JSONL index    │
              │ • HNSW vectors│  │ • facts.json     │
              │ • Entity links│  │ • Importance TTL  │
              │ • SUPERSEDES  │  │ • Hash dedup     │
              └───────────────┘  └──────────────────┘
```

Every fact write goes to both stores. Graph failures are non-blocking — the flat store always succeeds. This gives us the graph's power for search and reasoning while maintaining a reliable fallback that's just files on disk.

---

## The Graph Schema

FalkorDB uses the Redis wire protocol and runs in ~85MB of memory at our current scale (1,067 nodes across 73 facts, 97 entities, 730 conversation turns, 166 tags). The schema:

```
(:Fact {id, text, senderId, importance, embedding, category, confidence, createdAt, source})
  -[:ABOUT]->        (:Entity {name, canonical, type, senderId})
  -[:TAGGED]->       (:Tag {name})
  -[:SUPERSEDES]->   (:Fact)              // temporal fact evolution
  -[:EXTRACTED_FROM]->(:Turn)             // provenance

(:Turn {id, text, role, senderId, sessionKey, createdAt})
  -[:MENTIONS]->     (:Entity)            // conversation links

(:UserModel {senderId, communicationStyle, decisionPattern, topicInterests})
```

The key relationships:

- **ABOUT** connects facts to entities they reference. This enables multi-hop traversal — find all facts connected to a person, then find all entities connected to those facts.
- **SUPERSEDES** tracks fact evolution. When a user changes jobs, the new fact SUPERSEDES the old one. Both persist with timestamps, enabling temporal queries ("what did I know last month?").
- **EXTRACTED_FROM** traces provenance. Every fact links back to the conversation turn it came from.
- **MENTIONS** links conversation turns to entities, enabling cross-session search ("find all conversations where we discussed FalkorDB").

### Vector Index

```sql
CREATE VECTOR INDEX FOR (f:Fact) ON (f.embedding)
OPTIONS {dimension: 4096, similarityFunction: 'cosine'}
```

4096-dimensional vectors from `qwen3-embedding:8b`, indexed with HNSW for O(log n) nearest-neighbor search. This runs inside FalkorDB — no separate vector database.

---

## Entity Extraction: The Self-Improving Loop

This is where it gets interesting. When a fact is stored, we extract named entities and link them to the graph. But entity extraction by a small local model (phi4-mini) is unreliable — without context, it classifies "DGX Spark" as software instead of hardware, or creates duplicate nodes for "open-source models" vs "open-source model."

We solved this with **bootstrapped NER** — the graph teaches the model how to classify.

### How It Works

Before extracting entities from a new fact, we query the graph for existing typed entities:

```cypher
MATCH (e:Entity {senderId: $senderId})
WHERE e.type <> 'unknown'
RETURN e.name, e.type
ORDER BY e.createdAt DESC LIMIT 30
```

These are grouped by type and injected into the NER prompt:

```
Extract named entities from this text. Return a JSON array of objects.
Types: person, organization, technology, hardware, software, place, event, concept.

Known entities (classify consistently with these):
- "Peter Green", "Sarah" → person
- "DevMesh", "Anthropic" → organization
- "DGX Spark", "Mac Mini", "A5000" → hardware
- "FalkorDB", "Ollama", "LocalClaw" → software
```

Now when phi4-mini sees "DGX Spark" in a new fact, it has graph context showing this is hardware — and classifies correctly. Each correctly typed entity becomes reference context for future extractions. The graph gets smarter over time.

### Canonical Normalization

Entity dedup uses canonical form computation:

```typescript
function normalizeEntityName(name: string): string {
  let n = name.trim().toLowerCase();
  n = n.replace(/[\s\-_]+/g, ' ').trim();
  // Simple plural stripping (skip 'ss', 'us' suffixes)
  if (n.endsWith('s') && n.length > 3 && !n.endsWith('ss') && !n.endsWith('us')) {
    n = n.slice(0, -1);
  }
  return n;
}
```

MERGE operates on `canonical`, so "Open-Source Models" and "open-source model" resolve to the same node. The original display name is preserved separately. Entity type upgrades from `unknown` to a real type on subsequent encounters:

```cypher
MERGE (e:Entity {canonical: $canonical, senderId: $senderId})
ON CREATE SET e.name = $name, e.type = $type, e.createdAt = $now
ON MATCH SET e.type = CASE WHEN e.type = 'unknown' THEN $type ELSE e.type END
```

---

## Fact Extraction: Three Paths

Facts enter the system through three paths, each with different trust levels:

### Path 1: User-Approved (`!reset` → `!save`)

When the user clears a session with `!reset`, the extraction model (phi4:14b) analyzes the transcript and proposes facts. The user sees the candidates and explicitly approves with `!save`. This is the highest-trust path.

The extraction prompt includes:

- **Category definitions** with examples (stable, context, decision, question)
- **Importance tier reference** (5=critical health/family, 4=identity job/projects, 3=preference, 2=context, 1=ephemeral)
- **Already-stored facts** — prevents re-extracting what we already know
- **Recently-removed facts** — prevents re-extracting what the user deleted

The model outputs structured JSON:

```json
[
  {
    "text": "Peter switched from qwen3.5 to gemma4:26b for chat",
    "cat": "decision",
    "conf": 0.9,
    "imp": 4,
    "tags": ["model-selection", "architecture"],
    "entities": ["gemma4", "qwen3.5"]
  }
]
```

### Path 2: Autonomous Heartbeat

Every 2 hours, the heartbeat reviews transcripts modified since the last review. Same extraction logic, but writes directly without user approval. The guard rails:

- Existing facts shown to prevent paraphrased re-extraction
- Recently-removed facts shown to prevent re-extracting deleted content
- Each fact gets a 30-day TTL in `removed.jsonl` after deletion

### Path 3: Explicit Save (memory_save tool)

The user or a specialist explicitly calls `memory_save` with content. Maps category to importance tier (stable→4, context→2, decision→3, question→1) and writes through both backends.

### Write-Through to Both Stores

All three paths use the same write-through:

```typescript
// 1. Flat FactStore (always succeeds — it's just files)
if (factStore) {
  await factStore.writeFactsBatch(facts, senderId, source);
  factStore.rebuildFacts(senderId);
}

// 2. GraphMemory (non-blocking on failure)
if (graphMemory) {
  for (const fact of facts) {
    try {
      await graphMemory.addFact(fact, senderId);
    } catch (err) {
      console.warn('[Memory] Graph write failed:', err.message);
    }
  }
}
```

---

## Deduplication: Triple-Check on Write

Before storing a fact, three dedup checks run in order:

### 1. Semantic Dedup (Graph)

Vector KNN with cosine distance threshold:

```cypher
CALL db.idx.vector.queryNodes('Fact', 'embedding', 1, vecf32($emb))
YIELD node, score
WHERE node.senderId = $senderId AND score < 0.15
```

A cosine distance below 0.15 (similarity above 0.85) means the fact is a near-duplicate. Rejected.

### 2. Hash Exact Match (Flat Store)

SHA256 of normalized text (lowercase, stripped punctuation, collapsed whitespace):

```typescript
const hash = sha256(normalized).slice(0, 16);
if (existingHashes.has(hash)) return null;
```

Catches exact rephrasing with different punctuation or capitalization.

### 3. Substring Inclusion (Flat Store)

If the normalized text of one fact contains the normalized text of another:

```typescript
if (existingNorm.includes(newNorm) || newNorm.includes(existingNorm)) return null;
```

Catches "Peter uses FalkorDB" vs "Peter uses FalkorDB for memory."

### LLM-Driven Consolidation (Heartbeat)

During heartbeat, an LLM reviews pairs of facts with high word overlap (≥50%) and decides:

- **MERGE** — Combine both into one more complete fact
- **REPLACE** — New supersedes old
- **KEEP_SEPARATE** — Distinct facts, both stay

Bounded to 20 pairs per run to limit compute. Uses the router model (phi4:14b) at temperature 0.1.

---

## Search: Multi-Signal Scoring

When a message comes in, the memory system retrieves relevant facts using a multi-signal scoring formula:

```
multiScore = similarity × 0.5 + recency × 0.2 + importance × 0.3
```

Where:

- **Similarity** (50%) — Cosine similarity from HNSW vector search. Range 0-1.
- **Recency** (20%) — Exponential decay with ~7-day half-life: `exp(-ageMs / (7 × 24 × 60 × 60 × 1000))`. Yesterday's facts score ~0.87, last week's score ~0.37, last month's score ~0.02.
- **Importance** (30%) — Normalized tier: `(importance - 1) / 4`. Critical facts (tier 5) score 1.0, ephemeral facts (tier 1) score 0.0.

This means a moderately relevant but critical fact (similarity 0.6, importance 5) scores higher than a highly relevant but ephemeral fact (similarity 0.9, importance 1):

```
Critical:   0.6 × 0.5 + 0.5 × 0.2 + 1.0 × 0.3 = 0.70
Ephemeral:  0.9 × 0.5 + 0.5 × 0.2 + 0.0 × 0.3 = 0.55
```

Your wife's health condition surfaces above yesterday's weather, even if the weather was discussed more recently.

---

## Auto-Injection: Silent Context Enhancement

Every message triggers memory injection before the specialist sees it. Four layers:

### Layer 1: Stable Facts (Identity)

High-importance facts (tier ≥ 4) — job, family, projects, critical health info. Always injected regardless of query relevance. Limited to 5 facts.

### Layer 2: Contextual Facts (Query-Relevant)

Vector search on the current message finds the 5 most relevant facts by multi-signal score. Deduplicated against stable facts.

### Layer 3: Multi-Hop Connected Facts

Starting from vector search results, traverse entity connections to find related facts the vector search missed:

```cypher
-- 1-hop: fact → entity → related fact
MATCH (seed:Fact)-[:ABOUT]->(:Entity)<-[:ABOUT]-(related:Fact)

-- 2-hop: fact → entity → fact → entity → further fact
MATCH (seed)-[:ABOUT]->(:Entity)<-[:ABOUT]-(mid)-[:ABOUT]->(:Entity)<-[:ABOUT]-(far)
```

Scored by distance: 1-hop facts get score 1.0, 2-hop facts get 0.5.

### Layer 4: Behavioral User Model

LLM-derived observations about communication style, decision patterns, topic interests — updated each heartbeat by analyzing recent interactions.

### Injection Format

The context is injected as a preamble before the specialist's system prompt:

```
## Background context about this user (do NOT reference unless directly relevant)
- Peter works at DevMesh as ML engineer
- Peter runs LocalClaw on DGX Spark + Mac Mini + A5000
- Peter's wife prefers soft chocolate chip cookies with precise measurements

## User preferences (adapt your style accordingly)
- communication style: direct and technical, prefers concise answers
- decision pattern: data-driven, iterates through options
```

The header "do NOT reference unless directly relevant" is critical — without it, the model tries to work every fact into its response.

---

## Temporal Intelligence: Fact Evolution

The SUPERSEDES edge enables fact versioning:

```
(:Fact {text: "ML engineer"})
  <-[:SUPERSEDES {at: "2026-05-15"}]-
    (:Fact {text: "Senior ML engineer"})
```

Both facts persist. The old fact is marked `superseded: true` and excluded from active search. But temporal queries can traverse the chain:

```cypher
MATCH (current:Fact)-[:SUPERSEDES*0..10]->(old:Fact)
WHERE current.text CONTAINS $match
RETURN old.text, old.createdAt
```

This answers "what did I know about Peter's role last month?" by walking the SUPERSEDES chain backward.

### Snapshot-Based Diffing

The heartbeat uses deterministic fact diffing — no model involvement:

```typescript
saveSnapshot() → {timestamp, factHashes: string[], factCount}
diffFacts()    → {newFacts, unchangedFacts, removedHashes, snapshotAge}
```

Hash-based comparison between snapshots tells us exactly what changed since the last heartbeat. The model only reasons about the diff — "what do these changes mean?" — never about what changed.

---

## Importance Tiers and TTL

Every fact has an importance tier (1-5) that determines how long it lives:

| Tier | Meaning | TTL | Examples |
|------|---------|-----|----------|
| 5 | Critical | Never expires | Wife's health condition, family members |
| 4 | Identity | Never expires | Job title, major projects, certifications |
| 3 | Preference | 90 days | Tool choices, food preferences, communication style |
| 2 | Context | 30 days | Current tasks, upcoming events |
| 1 | Ephemeral | 7 days | One-off mentions, transient questions |

The extraction prompt teaches the model these tiers with few-shot examples:

```
Importance levels:
- imp 5: "Wife diagnosed with condition X" (critical, health/family)
- imp 4: "Works as Solutions Architect at Company Y" (identity)
- imp 3: "Prefers dark mode in all editors" (preference)
- imp 2: "Has a meeting with team tomorrow" (context)
- imp 1: "Asked about the weather in NYC" (ephemeral)
```

Without these examples, the model defaulted everything to importance 2 — the 30% importance weight in scoring was dead weight.

---

## Cross-Session Conversation Search

The Turn nodes enable searching across all past conversations:

```cypher
-- Find conversations mentioning an entity
MATCH (t:Turn {senderId: $senderId})-[:MENTIONS]->(e:Entity)
WHERE toLower(e.name) CONTAINS toLower($query)
RETURN t.text, t.role, t.sessionKey, t.createdAt
ORDER BY t.createdAt DESC LIMIT 20
```

This lets the agent say "we discussed FalkorDB in three sessions last week" with actual conversation references — not hallucinated memory.

---

## The Flat Store Fallback

When FalkorDB is unavailable, the flat FactStore handles everything:

```
memory/{senderId}/
  raw/2026-06-03/mem_*.md     # Raw markdown with YAML frontmatter
  index/2026-06-03.jsonl      # Append-only index
  facts/facts.json            # Deduplicated machine-readable array
  facts/facts.md              # Human-readable, sectioned by category
  heartbeat-snapshot.json     # Hash tracking for diffing
  removed.jsonl               # Recently-removed (30-day TTL)
```

It handles dedup (hash + substring + optional embedding), importance TTL, review candidate selection, and character-bounded rendering (`MAX_FACTS_CHARS = 3000`). It's not as powerful as the graph — no multi-hop, no SUPERSEDES, no entity linking — but it's files on disk that never fail.

---

## Memory Forget: Respecting User Intent

When a user says `!forget register agent` or uses the `memory_forget` tool:

1. Matching facts removed from both GraphMemory and FactStore
2. Removal recorded to `removed.jsonl` with 30-day TTL
3. Future extraction prompts include removed facts as a guard: "Do NOT re-extract these — the user explicitly removed them"

Word-level matching handles variations — "register agent" matches "registered agent change" through flexible token matching.

---

## What We Learned

### 1. Code computes, model interprets

The model never does arithmetic, date comparisons, or hash-based dedup. Code handles the "what" (which facts changed, which are duplicates, what the urgency scores are). The model handles the "so what" (what do the changes mean, which connections matter).

### 2. Guard the extraction prompt

Without showing existing facts and recently-removed facts to the extraction model, you get re-extraction of known information after every session. The model doesn't know what it already stored — you have to tell it.

### 3. Importance tiers need examples

phi4:14b never returned the `imp` field until we added five concrete examples with emotional weight ("wife diagnosed with condition X" = 5). Without examples, the model treated all facts as equally important.

### 4. Entity typing needs graph context

Blind entity extraction by phi4-mini classified DGX Spark as software, Solutions Architect as a person, and created separate nodes for singular/plural forms. Bootstrapping from the graph's existing typed entities solved all three problems.

### 5. Multi-signal scoring > pure similarity

Pure vector similarity surfaces whatever is semantically closest, regardless of importance or recency. A weather fact from yesterday can outrank a health condition from last week. The 50/20/30 split (similarity/recency/importance) ensures critical facts surface appropriately.

### 6. Dedup is a pipeline, not a check

No single dedup method catches everything. Hash catches exact matches. Substring catches containment. Embedding catches paraphrases. LLM consolidation catches semantic overlap. Each layer is cheap individually; together they keep the graph clean.

### 7. Graph > flat for relationship reasoning

The flat store was good enough for 6 months. But when we needed "find everything connected to DevMesh" or "how has Peter's role evolved," it couldn't help. The graph answers these naturally through traversal. The SUPERSEDES chain alone justified the migration.

---

## Infrastructure

The entire memory system runs on a Mac Mini:

- **FalkorDB** — Docker container, ~85MB memory, Redis wire protocol on port 6379
- **Embedding model** — qwen3-embedding:8b on Ollama, 4096-dimensional vectors
- **NER model** — phi4-mini on Ollama, fast entity typing
- **Extraction model** — phi4:14b on Ollama, fact extraction from transcripts
- **Storage** — Graph in Docker volume, flat files in `data/workspaces/main/memory/`

No cloud services. No API costs. No data leaving the machine. The graph, vectors, entity linking, and fact extraction all run locally.

---

*LocalClaw is an open-source local-model-first AI agent framework. The memory system described here is part of a larger architecture with 39 tools, 12 deterministic pipelines, and 8 channel adapters — all running on personal hardware via Ollama.*

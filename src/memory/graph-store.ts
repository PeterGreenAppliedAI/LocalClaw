import { FalkorDB, Graph } from 'falkordb';
import type { OllamaClient } from '../ollama/client.js';
import type { FactEntry, FactInput } from '../config/types.js';

export interface GraphMemoryConfig {
  host: string;
  port: number;
  graphName?: string;
  embeddingModel?: string;
  embeddingDims?: number;
}

export interface GraphSearchResult {
  text: string;
  importance: number;
  category: string;
  confidence: number;
  score: number;
  createdAt: string;
  entities: string[];
}

const DEFAULT_CONFIG: GraphMemoryConfig = {
  host: 'localhost',
  port: 6379,
  graphName: 'localclaw_memory',
  embeddingModel: 'qwen3-embedding:8b',
  embeddingDims: 4096,
};

/**
 * Normalize entity name to a canonical form for dedup.
 * Preserves display name separately — canonical is for MERGE matching only.
 */
function normalizeEntityName(name: string): string {
  let n = name.trim().toLowerCase();
  // Collapse whitespace, hyphens, underscores
  n = n.replace(/[\s\-_]+/g, ' ').trim();
  // Simple English plural → singular (skip words ending in 'ss' like 'business')
  if (n.endsWith('s') && n.length > 3 && !n.endsWith('ss') && !n.endsWith('us')) {
    n = n.slice(0, -1);
  }
  return n;
}

/** Reject entities that are generic pronouns, pure numbers, or too vague to be useful. */
function isGarbageEntity(name: string): boolean {
  const n = name.trim().toLowerCase();
  // Generic pronouns / references
  if (/^(user|user's|the user|they|them|he|she|it|we|i|me|my)$/.test(n)) return true;
  // Pure numbers or number + suffix (230s, 260s)
  if (/^\d+[a-z]?$/.test(n)) return true;
  // Single character
  if (n.length <= 1) return true;
  return false;
}

export class GraphMemoryStore {
  private db: FalkorDB | null = null;
  private graph: Graph | null = null;
  private config: GraphMemoryConfig;
  private client: OllamaClient;
  private initialized = false;

  constructor(client: OllamaClient, config?: Partial<GraphMemoryConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect(): Promise<void> {
    if (this.db) return;
    this.db = await FalkorDB.connect({
      socket: { host: this.config.host, port: this.config.port },
    });
    this.graph = this.db.selectGraph(this.config.graphName!);
    await this.ensureSchema();
    this.initialized = true;
    console.log(`[GraphMemory] Connected to FalkorDB at ${this.config.host}:${this.config.port} (graph: ${this.config.graphName})`);
  }

  private async ensureSchema(): Promise<void> {
    if (!this.graph) return;

    // Create vector index for semantic search
    try {
      await this.graph.query(
        `CREATE VECTOR INDEX FOR (f:Fact) ON (f.embedding) OPTIONS {dimension: ${this.config.embeddingDims}, similarityFunction: 'cosine'}`
      );
      console.log('[GraphMemory] Vector index created');
    } catch (e: any) {
      if (!e.message?.includes('already')) {
        console.warn('[GraphMemory] Vector index error:', e.message);
      }
    }

    // Migration: backfill canonical property on existing Entity nodes
    try {
      const result = await this.graph.query(
        `MATCH (e:Entity) WHERE e.canonical IS NULL RETURN e.name AS name, e.senderId AS senderId`
      );
      const rows = (result.data ?? []) as Array<{ name: string; senderId: string }>;
      if (rows.length > 0) {
        for (const row of rows) {
          const canonical = normalizeEntityName(row.name);
          await this.graph.query(
            `MATCH (e:Entity {name: $name, senderId: $senderId}) WHERE e.canonical IS NULL SET e.canonical = $canonical`,
            { params: { name: row.name, senderId: row.senderId, canonical } }
          );
        }
        console.log(`[GraphMemory] Migrated ${rows.length} entities with canonical names`);
      }
    } catch (e: any) {
      console.warn('[GraphMemory] Entity canonical migration failed:', e.message);
    }
  }

  /**
   * Add a fact to the graph. Checks for semantic duplicates first.
   * Returns the fact ID if stored, null if deduplicated.
   */
  async addFact(input: FactInput, senderId: string, sourceSession?: string): Promise<string | null> {
    if (!this.graph) await this.connect();

    const text = input.text.trim();
    if (!text) return null;

    // Generate embedding
    const [embedding] = await this.client.embed(text);
    if (!embedding) return null;

    // Check for semantic duplicates (cosine distance < 0.15 = similarity > 0.85)
    const dupeCheck = await this.graph!.query(
      `CALL db.idx.vector.queryNodes('Fact', 'embedding', 1, vecf32($emb))
       YIELD node, score
       WHERE node.senderId = $senderId AND score < 0.15
       RETURN node.text, score`,
      { params: { emb: embedding, senderId } }
    );

    if ((dupeCheck.data ?? []).length > 0) {
      console.log(`[GraphMemory] Dedup: rejected "${text.slice(0, 50)}..." (similar to "${((dupeCheck.data ?? [])[0] as any)['node.text']?.slice(0, 50)}")`);
      return null;
    }

    // Contradiction check: find similar (but not duplicate) facts that might be superseded.
    // Collect IDs here; the SUPERSEDES edges are created after the new Fact node exists (below).
    const supersededIds: string[] = [];
    try {
      const similarCheck = await this.graph!.query(
        `CALL db.idx.vector.queryNodes('Fact', 'embedding', 3, vecf32($emb))
         YIELD node, score
         WHERE node.senderId = $senderId AND score >= 0.15 AND score < 0.4
         RETURN node.id, node.text, score`,
        { params: { emb: embedding, senderId } }
      );

      for (const row of (similarCheck.data ?? []) as any[]) {
        const existingText = row['node.text'] ?? '';
        const existingId = row['node.id'];
        if (!existingText || !existingId) continue;

        // Ask router model: does the new fact contradict/replace the old one?
        try {
          const response = await this.client.chat({
            model: 'phi4-mini:latest',
            messages: [{
              role: 'user',
              content: `Fact A: "${existingText}"\nFact B: "${text}"\nDoes Fact B contradict, update, or replace Fact A? Answer YES or NO only.`,
            }],
            options: { temperature: 0.1, num_predict: 5 },
          });
          const answer = (response.message?.content ?? '').trim().toUpperCase();
          if (answer.startsWith('YES')) {
            supersededIds.push(existingId);
            console.log(`[GraphMemory] Contradiction: "${text.slice(0, 40)}..." supersedes "${existingText.slice(0, 40)}..."`);
          }
        } catch { /* contradiction check is best-effort */ }
      }
    } catch { /* similarity search for contradictions is best-effort */ }

    const id = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const importance = input.importance ?? 2;
    const category = input.category ?? 'stable';
    const confidence = input.confidence ?? 0.8;

    // Create fact node with embedding
    await this.graph!.query(
      `CREATE (:Fact {
        id: $id, text: $text, senderId: $senderId,
        importance: $importance, category: $category, confidence: $confidence,
        createdAt: $createdAt, source: $source,
        embedding: vecf32($emb)
      })`,
      {
        params: {
          id, text, senderId, importance, category, confidence,
          createdAt: now, source: input.source ?? 'unknown',
          emb: embedding,
        },
      }
    );

    // Create SUPERSEDES edges for any contradictions found above (new -> old)
    for (const oldId of supersededIds) {
      try {
        await this.graph!.query(
          `MATCH (newF:Fact {id: $newId}), (old:Fact {id: $oldId})
           CREATE (newF)-[:SUPERSEDES {at: $now}]->(old)
           SET old.superseded = true`,
          { params: { newId: id, oldId, now } }
        );
      } catch { /* best-effort */ }
    }

    // Extract entities via LLM NER when none provided
    let entities: Array<{ name: string; type: string }> = [];
    const rawEntities = input.entities ?? [];
    if (rawEntities.length === 0) {
      try {
        // Bootstrap: pull known entities from graph so the model classifies consistently
        let knownEntitiesBlock = '';
        try {
          const known = await this.graph!.query(
            `MATCH (e:Entity {senderId: $senderId}) WHERE e.type <> 'unknown' RETURN e.name, e.type ORDER BY e.name LIMIT 30`,
            { params: { senderId } }
          );
          const rows = (known.data ?? []) as Array<{ 'e.name': string; 'e.type': string }>;
          if (rows.length > 0) {
            const grouped: Record<string, string[]> = {};
            for (const r of rows) {
              const t = r['e.type'];
              if (!grouped[t]) grouped[t] = [];
              grouped[t].push(`"${r['e.name']}"`);
            }
            knownEntitiesBlock = '\nKnown entities (classify consistently with these):\n'
              + Object.entries(grouped).map(([t, names]) => `- ${names.join(', ')} → ${t}`).join('\n')
              + '\n';
          }
        } catch { /* best-effort */ }

        const nerResponse = await this.client.chat({
          model: 'phi4-mini:latest',
          messages: [{
            role: 'user',
            content: `Extract named entities from this text. Return ONLY a JSON array of objects.
Types: person, organization, technology, hardware, software, place, event, concept.
Use singular forms. Use the most common/official name (e.g., "Polymarket" not "Poly Markets").
${knownEntitiesBlock}
Text: "${text}"

Return: [{"name":"entity","type":"person|organization|technology|..."}]`,
          }],
          options: { temperature: 0, num_predict: 256 },
        });
        const nerRaw = (nerResponse.message?.content ?? '').trim();
        const nerMatch = nerRaw.match(/\[[\s\S]*\]/);
        if (nerMatch) {
          const parsed = JSON.parse(nerMatch[0]);
          if (Array.isArray(parsed)) {
            entities = parsed
              .filter((e: unknown): e is Record<string, unknown> => !!e && typeof e === 'object' && 'name' in e)
              .map((e: Record<string, unknown>) => ({
                name: String(e.name),
                type: typeof e.type === 'string' ? e.type : 'unknown',
              }))
              .filter(e => e.name.length > 1)
              .filter(e => !isGarbageEntity(e.name))
              .slice(0, 5);
          }
        }
      } catch {
        // NER failed — proceed without entities
      }
    } else {
      // Backward compat: input.entities is string[] from the extraction prompt
      entities = rawEntities.map(name => ({ name, type: 'unknown' }));
    }
    for (const entity of entities) {
      const canonical = normalizeEntityName(entity.name);
      await this.graph!.query(
        `MERGE (e:Entity {canonical: $canonical, senderId: $senderId})
         ON CREATE SET e.name = $name, e.type = $type, e.createdAt = $now
         ON MATCH SET e.type = CASE WHEN e.type = 'unknown' THEN $type ELSE e.type END
         WITH e
         MATCH (f:Fact {id: $factId})
         CREATE (f)-[:ABOUT]->(e)`,
        { params: { canonical, name: entity.name, type: entity.type, senderId, now, factId: id } }
      );
    }

    // Extract and link tags
    const tags = input.tags ?? [];
    for (const tagName of tags) {
      await this.graph!.query(
        `MERGE (t:Tag {name: $name, senderId: $senderId})
         WITH t
         MATCH (f:Fact {id: $factId})
         CREATE (f)-[:TAGGED]->(t)`,
        { params: { name: tagName, senderId, factId: id } }
      );
    }

    // Provenance: link fact to the session it was extracted from
    if (sourceSession) {
      try {
        await this.graph!.query(
          `MATCH (f:Fact {id: $factId}), (t:Turn {sessionKey: $session, senderId: $senderId})
           WITH f, t ORDER BY t.createdAt DESC LIMIT 1
           CREATE (f)-[:EXTRACTED_FROM]->(t)`,
          { params: { factId: id, session: sourceSession, senderId } }
        );
      } catch { /* best-effort */ }
    }

    console.log(`[GraphMemory] Stored: "${text.slice(0, 60)}" (imp=${importance}, cat=${category})`);
    return id;
  }

  /**
   * Semantic search — find facts relevant to a query using multi-signal scoring.
   */
  async search(query: string, senderId: string, topK = 5, filters?: {
    minImportance?: number;
    categories?: string[];
    maxAgeDays?: number;
  }): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    const [queryEmb] = await this.client.embed(query);
    if (!queryEmb) return [];

    // Build metadata filter clauses
    const whereClauses = ['node.senderId = $senderId'];
    const filterParams: Record<string, any> = { emb: queryEmb, senderId, topK: topK * 2 };

    if (filters?.minImportance) {
      whereClauses.push('node.importance >= $minImp');
      filterParams.minImp = filters.minImportance;
    }
    if (filters?.categories?.length) {
      whereClauses.push('node.category IN $cats');
      filterParams.cats = filters.categories;
    }
    if (filters?.maxAgeDays) {
      const since = new Date(Date.now() - filters.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      whereClauses.push('node.createdAt >= $since');
      filterParams.since = since;
    }

    // Vector KNN + metadata filters
    const result = await this.graph!.query(
      `CALL db.idx.vector.queryNodes('Fact', 'embedding', $topK, vecf32($emb))
       YIELD node, score
       WHERE ${whereClauses.join(' AND ')}
       RETURN node.text, node.importance, node.category, node.confidence,
              node.createdAt, score, node.id`,
      { params: filterParams }
    );

    const now = Date.now();
    const scored: GraphSearchResult[] = (result.data ?? []).map((row: any) => {
      const similarity = 1 - (row.score ?? 1); // cosine distance → similarity
      const ageMs = now - new Date(row['node.createdAt'] ?? now).getTime();
      const recency = Math.exp(-ageMs / (7 * 24 * 60 * 60 * 1000));
      const importance = ((row['node.importance'] ?? 2) - 1) / 4;

      const multiScore = similarity * 0.5 + recency * 0.2 + importance * 0.3;

      return {
        text: row['node.text'],
        importance: row['node.importance'] ?? 2,
        category: row['node.category'] ?? 'stable',
        confidence: row['node.confidence'] ?? 0.8,
        score: multiScore,
        createdAt: row['node.createdAt'] ?? '',
        entities: [],
      };
    });

    // Fetch entities for top results
    const topResults = scored.sort((a, b) => b.score - a.score).slice(0, topK);
    for (const r of topResults) {
      try {
        const entities = await this.graph!.query(
          `MATCH (f:Fact {text: $text})-[:ABOUT]->(e:Entity) RETURN e.name`,
          { params: { text: r.text } }
        );
        r.entities = (entities.data ?? []).map((e: any) => e['e.name']);
      } catch { /* best-effort */ }
    }

    return topResults;
  }

  /**
   * Get high-importance facts for a user (for user priming / stable injection).
   */
  async getStableFacts(senderId: string, minImportance = 4): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       WHERE f.importance >= $minImp
       RETURN f.text, f.importance, f.category, f.confidence, f.createdAt
       ORDER BY f.importance DESC, f.confidence DESC
       LIMIT 10`,
      { params: { senderId, minImp: minImportance } }
    );

    return (result.data ?? []).map((row: any) => ({
      text: row['f.text'],
      importance: row['f.importance'],
      category: row['f.category'],
      confidence: row['f.confidence'],
      score: 1,
      createdAt: row['f.createdAt'] ?? '',
      entities: [],
    }));
  }

  /**
   * Find connected facts — traverse RELATED_TO and shared Entity edges.
   */
  async findConnected(factText: string, senderId: string, depth = 2): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})-[:ABOUT]->(e:Entity)<-[:ABOUT]-(related:Fact)
       WHERE f.text = $text AND related.text <> $text
       RETURN DISTINCT related.text, related.importance, related.category, related.confidence, related.createdAt
       LIMIT 5`,
      { params: { text: factText, senderId } }
    );

    return (result.data ?? []).map((row: any) => ({
      text: row['related.text'],
      importance: row['related.importance'],
      category: row['related.category'],
      confidence: row['related.confidence'],
      score: 0.5,
      createdAt: row['related.createdAt'] ?? '',
      entities: [],
    }));
  }

  /**
   * Remove a fact by text match.
   */
  async removeFact(textMatch: string, senderId: string): Promise<number> {
    if (!this.graph) await this.connect();

    // Try exact CONTAINS first, then try each word individually for flexible matching
    let result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       WHERE f.text CONTAINS $match
       DETACH DELETE f
       RETURN count(f) as deleted`,
      { params: { senderId, match: textMatch } }
    );

    let deleted = ((result.data ?? [])[0] as any)?.deleted ?? 0;

    // Fallback: if exact match found nothing, try matching key words
    if (deleted === 0) {
      const words = textMatch.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (words.length >= 2) {
        // Match facts containing ALL significant words
        const conditions = words.map((_, i) => `toLower(f.text) CONTAINS $w${i}`).join(' AND ');
        const wordParams: Record<string, string> = { senderId };
        words.forEach((w, i) => { wordParams[`w${i}`] = w; });

        const fallbackResult = await this.graph!.query(
          `MATCH (f:Fact {senderId: $senderId}) WHERE ${conditions} DETACH DELETE f RETURN count(f) as deleted`,
          { params: wordParams }
        );
        deleted = ((fallbackResult.data ?? [])[0] as any)?.deleted ?? 0;
      }
    }

    if (deleted > 0) {
      console.log(`[GraphMemory] Removed ${deleted} fact(s) matching "${textMatch.slice(0, 40)}"`);
      // Clean up orphaned entities (no facts reference them, no turns mention them)
      try {
        const orphans = await this.graph!.query(
          `MATCH (e:Entity {senderId: $senderId})
           OPTIONAL MATCH (e)<-[:ABOUT]-(f:Fact)
           OPTIONAL MATCH (e)<-[:MENTIONS]-(t:Turn)
           WITH e, count(f) AS facts, count(t) AS turns
           WHERE facts = 0 AND turns = 0
           DELETE e
           RETURN count(e) AS cleaned`,
          { params: { senderId } }
        );
        const cleaned = ((orphans.data ?? [])[0] as any)?.cleaned ?? 0;
        if (cleaned > 0) console.log(`[GraphMemory] Cleaned ${cleaned} orphaned entity/entities`);
      } catch { /* best-effort */ }
    }
    return deleted;
  }

  /**
   * Get all facts for a user (for migration, export, heartbeat diff).
   */
  async getAllFacts(senderId: string): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       RETURN f.text, f.importance, f.category, f.confidence, f.createdAt
       ORDER BY f.createdAt DESC`,
      { params: { senderId } }
    );

    return (result.data ?? []).map((row: any) => ({
      text: row['f.text'],
      importance: row['f.importance'],
      category: row['f.category'],
      confidence: row['f.confidence'],
      score: 1,
      createdAt: row['f.createdAt'] ?? '',
      entities: [],
    }));
  }

  /**
   * Get fact count for a user.
   */
  async getFactCount(senderId: string): Promise<number> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId}) RETURN count(f) as cnt`,
      { params: { senderId } }
    );

    return ((result.data ?? [])[0] as any)?.cnt ?? 0;
  }

  // ========== CONVERSATION TURNS — Cross-session search ==========

  /**
   * Store a conversation turn in the graph for cross-session search.
   */
  async addTurn(text: string, role: 'user' | 'assistant', senderId: string, sessionKey: string): Promise<void> {
    if (!this.graph) await this.connect();
    if (!text || text.length < 10) return;

    const stored = text.length > 500 ? text.slice(0, 500) : text;
    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    try {
      await this.graph!.query(
        `CREATE (:Turn {
          id: $id, text: $text, role: $role, senderId: $senderId,
          sessionKey: $sessionKey, createdAt: $now
        })`,
        { params: { id: turnId, text: stored, role, senderId, sessionKey, now: new Date().toISOString() } }
      );

      // Link turn to existing entities mentioned in the text
      try {
        const existingEntities = await this.graph!.query(
          `MATCH (e:Entity {senderId: $senderId}) RETURN e.name`,
          { params: { senderId } }
        );
        for (const row of (existingEntities.data ?? []) as any[]) {
          const entityName = row['e.name'];
          if (entityName && stored.toLowerCase().includes(entityName.toLowerCase())) {
            const canonical = normalizeEntityName(entityName);
            await this.graph!.query(
              `MATCH (t:Turn {id: $turnId}), (e:Entity {senderId: $senderId})
               WHERE e.canonical = $canonical OR e.name = $name
               CREATE (t)-[:MENTIONS]->(e)`,
              { params: { turnId, name: entityName, canonical, senderId } }
            );
          }
        }
      } catch { /* best-effort entity linking */ }
    } catch (err) {
      console.warn('[GraphMemory] Failed to store turn:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Search across all conversation turns via keyword matching.
   */
  async searchTurns(query: string, senderId: string, maxResults = 10): Promise<Array<{
    text: string; role: string; sessionKey: string; createdAt: string;
  }>> {
    if (!this.graph) await this.connect();

    const results: Array<{ text: string; role: string; sessionKey: string; createdAt: string }> = [];
    const seen = new Set<string>();

    // Strategy 1: Entity traversal — find turns that MENTIONS entities matching the query
    try {
      const entityResult = await this.graph!.query(
        `MATCH (t:Turn {senderId: $senderId})-[:MENTIONS]->(e:Entity)
         WHERE toLower(e.name) CONTAINS toLower($query)
         RETURN t.text, t.role, t.sessionKey, t.createdAt
         ORDER BY t.createdAt DESC
         LIMIT ${maxResults}`,
        { params: { senderId, query } }
      );
      for (const row of (entityResult.data ?? []) as any[]) {
        const key = row['t.text'];
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ text: row['t.text'], role: row['t.role'], sessionKey: row['t.sessionKey'], createdAt: row['t.createdAt'] ?? '' });
        }
      }
    } catch { /* entity search optional */ }

    // Strategy 2: Keyword matching (fallback and supplement)
    if (results.length < maxResults) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (words.length > 0) {
        const conditions = words.map((_, i) => `toLower(t.text) CONTAINS $w${i}`).join(' AND ');
        const wordParams: Record<string, string> = { senderId };
        words.forEach((w, i) => { wordParams[`w${i}`] = w; });

        try {
          const keywordResult = await this.graph!.query(
            `MATCH (t:Turn {senderId: $senderId})
             WHERE ${conditions}
             RETURN t.text, t.role, t.sessionKey, t.createdAt
             ORDER BY t.createdAt DESC
             LIMIT ${maxResults}`,
            { params: wordParams }
          );
          for (const row of (keywordResult.data ?? []) as any[]) {
            const key = row['t.text'];
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ text: row['t.text'], role: row['t.role'], sessionKey: row['t.sessionKey'], createdAt: row['t.createdAt'] ?? '' });
            }
          }
        } catch { /* keyword search fallback */ }
      }
    }

    // Strategy 3: If query is empty (used by heartbeat for recent turns), return latest
    if (query === '' && results.length === 0) {
      try {
        const recentResult = await this.graph!.query(
          `MATCH (t:Turn {senderId: $senderId})
           RETURN t.text, t.role, t.sessionKey, t.createdAt
           ORDER BY t.createdAt DESC
           LIMIT ${maxResults}`,
          { params: { senderId } }
        );
        for (const row of (recentResult.data ?? []) as any[]) {
          results.push({ text: row['t.text'], role: row['t.role'], sessionKey: row['t.sessionKey'], createdAt: row['t.createdAt'] ?? '' });
        }
      } catch { /* best-effort */ }
    }

    return results.slice(0, maxResults);
  }

  // ========== SUPERSEDES — Temporal fact evolution ==========

  /**
   * Update a fact by creating a new version and linking with SUPERSEDES edge.
   * Old fact is kept for history. Returns new fact ID.
   */
  async updateFact(oldText: string, newInput: FactInput, senderId: string): Promise<string | null> {
    if (!this.graph) await this.connect();

    // Find the old fact
    const oldResult = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId}) WHERE f.text CONTAINS $match RETURN f.id, f.text LIMIT 1`,
      { params: { senderId, match: oldText } }
    );
    if ((oldResult.data ?? []).length === 0) return null;

    const oldId = (oldResult.data![0] as any)['f.id'];

    // Create the new fact directly (skip dedup — this IS an intentional update)
    const [embedding] = await this.client.embed(newInput.text);
    if (!embedding) return null;

    const newId = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    await this.graph!.query(
      `CREATE (:Fact {
        id: $id, text: $text, senderId: $senderId,
        importance: $importance, category: $category, confidence: $confidence,
        createdAt: $createdAt, source: $source, embedding: vecf32($emb)
      })`,
      {
        params: {
          id: newId, text: newInput.text, senderId,
          importance: newInput.importance ?? 2, category: newInput.category ?? 'stable',
          confidence: newInput.confidence ?? 0.8, createdAt: now,
          source: newInput.source ?? 'update', emb: embedding,
        },
      }
    );

    // Link: new SUPERSEDES old
    await this.graph!.query(
      `MATCH (old:Fact {id: $oldId}), (new:Fact {id: $newId})
       CREATE (new)-[:SUPERSEDES {at: $now}]->(old)
       SET old.superseded = true`,
      { params: { oldId, newId, now: new Date().toISOString() } }
    );

    console.log(`[GraphMemory] Fact updated: "${oldText.slice(0, 40)}" → "${newInput.text.slice(0, 40)}"`);
    return newId;
  }

  /**
   * Get the history of a fact — follow SUPERSEDES chain backwards.
   */
  async getFactHistory(factText: string, senderId: string): Promise<Array<{ text: string; createdAt: string; current: boolean }>> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (current:Fact {senderId: $senderId})-[:SUPERSEDES*0..10]->(old:Fact)
       WHERE current.text CONTAINS $match
       RETURN old.text, old.createdAt, old.superseded
       ORDER BY old.createdAt DESC`,
      { params: { senderId, match: factText } }
    );

    // Also include the current (non-superseded) fact
    const currentResult = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId}) WHERE f.text CONTAINS $match RETURN f.text, f.createdAt, f.superseded ORDER BY f.createdAt DESC LIMIT 1`,
      { params: { senderId, match: factText } }
    );
    const allRows = [...(currentResult.data ?? []), ...(result.data ?? [])];

    const seen = new Set<string>();
    return allRows
      .map((row: any) => {
        const text = row['old.text'] ?? row['f.text'];
        if (seen.has(text)) return null;
        seen.add(text);
        return {
          text,
          createdAt: row['old.createdAt'] ?? row['f.createdAt'] ?? '',
          current: !(row['old.superseded'] ?? row['f.superseded']),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  // ========== TEMPORAL QUERIES ==========

  /**
   * Get facts as they were at a specific point in time.
   */
  async getFactsAt(senderId: string, asOf: Date): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    // Get facts created before asOf that haven't been superseded (or were superseded after asOf)
    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       WHERE f.createdAt <= $asOf
       OPTIONAL MATCH (newer:Fact)-[s:SUPERSEDES]->(f)
       WHERE s.at <= $asOf
       WITH f, newer
       WHERE newer IS NULL
       RETURN f.text, f.importance, f.category, f.confidence, f.createdAt
       ORDER BY f.importance DESC, f.createdAt DESC`,
      { params: { senderId, asOf: asOf.toISOString() } }
    );

    return (result.data ?? []).map((row: any) => ({
      text: row['f.text'],
      importance: row['f.importance'],
      category: row['f.category'],
      confidence: row['f.confidence'],
      score: 1,
      createdAt: row['f.createdAt'] ?? '',
      entities: [],
    }));
  }

  /**
   * Get facts that changed between two dates.
   */
  async getFactChanges(senderId: string, since: Date, until?: Date): Promise<{
    added: GraphSearchResult[];
    superseded: Array<{ oldText: string; newText: string; changedAt: string }>;
  }> {
    if (!this.graph) await this.connect();
    const untilStr = (until ?? new Date()).toISOString();

    // New facts added in the window (not updates of existing facts)
    const addedResult = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       WHERE f.createdAt >= $since AND f.createdAt <= $until
       OPTIONAL MATCH (f)-[:SUPERSEDES]->(old:Fact)
       WITH f, old WHERE old IS NULL
       RETURN f.text, f.importance, f.category, f.confidence, f.createdAt
       ORDER BY f.createdAt DESC`,
      { params: { senderId, since: since.toISOString(), until: untilStr } }
    );

    // Facts that were superseded in the window
    const supersededResult = await this.graph!.query(
      `MATCH (new:Fact {senderId: $senderId})-[s:SUPERSEDES]->(old:Fact)
       WHERE s.at >= $since AND s.at <= $until
       RETURN old.text, new.text, s.at
       ORDER BY s.at DESC`,
      { params: { senderId, since: since.toISOString(), until: untilStr } }
    );

    return {
      added: (addedResult.data ?? []).map((row: any) => ({
        text: row['f.text'],
        importance: row['f.importance'],
        category: row['f.category'],
        confidence: row['f.confidence'],
        score: 1,
        createdAt: row['f.createdAt'] ?? '',
        entities: [],
      })),
      superseded: (supersededResult.data ?? []).map((row: any) => ({
        oldText: row['old.text'],
        newText: row['new.text'],
        changedAt: row['s.at'],
      })),
    };
  }

  // ========== MULTI-HOP REASONING ==========

  /**
   * Find facts connected within N hops through shared entities.
   * "Peter works at DevMesh" → DevMesh → "DevMesh does AI" → AI → "AI career fair next week"
   */
  async findMultiHop(query: string, senderId: string, maxHops = 3, topK = 10): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    // First find the most relevant fact via vector search
    const [queryEmb] = await this.client.embed(query);
    if (!queryEmb) return [];

    const seedResult = await this.graph!.query(
      `CALL db.idx.vector.queryNodes('Fact', 'embedding', 1, vecf32($emb))
       YIELD node, score
       WHERE node.senderId = $senderId
       RETURN node.id, node.text, score`,
      { params: { emb: queryEmb, senderId } }
    );

    if ((seedResult.data ?? []).length === 0) return [];
    const seedId = (seedResult.data![0] as any)['node.id'];

    // Traverse from seed through entities — 1 hop (shared entity)
    const hop1Result = await this.graph!.query(
      `MATCH (seed:Fact {id: $seedId})-[:ABOUT]->(:Entity)<-[:ABOUT]-(related:Fact)
       WHERE related.senderId = $senderId AND related.id <> $seedId
       RETURN DISTINCT related.text AS text, related.importance AS importance,
              related.category AS category, related.confidence AS confidence,
              related.createdAt AS createdAt, 1 AS hops
       LIMIT $topK`,
      { params: { seedId, senderId, topK } }
    );

    // 2 hops (entity → fact → entity → fact)
    const hop2Result = await this.graph!.query(
      `MATCH (seed:Fact {id: $seedId})-[:ABOUT]->(:Entity)<-[:ABOUT]-(mid:Fact)-[:ABOUT]->(:Entity)<-[:ABOUT]-(far:Fact)
       WHERE far.senderId = $senderId AND far.id <> $seedId AND mid.id <> $seedId
       RETURN DISTINCT far.text AS text, far.importance AS importance,
              far.category AS category, far.confidence AS confidence,
              far.createdAt AS createdAt, 2 AS hops
       LIMIT $topK`,
      { params: { seedId, senderId, topK } }
    );

    const allHops = [...(hop1Result.data ?? []), ...(hop2Result.data ?? [])];
    const seen = new Set<string>();

    return allHops
      .map((row: any) => {
        if (seen.has(row.text)) return null;
        seen.add(row.text);
        return {
          text: row.text,
          importance: row.importance ?? 2,
          category: row.category ?? 'stable',
          confidence: row.confidence ?? 0.8,
          score: 1 / (row.hops ?? 1),
          createdAt: row.createdAt ?? '',
          entities: [],
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  // ========== COMMUNITY DETECTION — Fact Clusters ==========

  /**
   * Find clusters of related facts by entity co-occurrence.
   * Returns groups of facts that share entities.
   */
  async getClusters(senderId: string): Promise<Array<{ entity: string; facts: string[]; importance: number }>> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})-[:ABOUT]->(e:Entity)
       WITH e, collect(f.text) AS facts, max(f.importance) AS maxImp, count(f) AS cnt
       WHERE cnt >= 2
       RETURN e.name, facts, maxImp
       ORDER BY maxImp DESC, cnt DESC`,
      { params: { senderId } }
    );

    return (result.data ?? []).map((row: any) => ({
      entity: row['e.name'],
      facts: row['facts'] ?? [],
      importance: row['maxImp'] ?? 2,
    }));
  }

  /**
   * Get a narrative summary of clusters for briefing context.
   * Groups facts by shared entities, returns structured clusters.
   */
  async getClusterSummary(senderId: string): Promise<Array<{ theme: string; entities: string[]; factCount: number; topFacts: string[] }>> {
    if (!this.graph) await this.connect();

    // Find entities that connect multiple facts
    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})-[:ABOUT]->(e:Entity)
       WITH e, collect(DISTINCT f.text) AS facts, count(DISTINCT f) AS cnt
       WHERE cnt >= 2
       RETURN e.name, e.type, facts, cnt
       ORDER BY cnt DESC
       LIMIT 10`,
      { params: { senderId } }
    );

    // Group entities that share facts into themes
    const clusters: Array<{ theme: string; entities: string[]; factCount: number; topFacts: string[] }> = [];
    const seen = new Set<string>();

    for (const row of (result.data ?? []) as any[]) {
      const entity = row['e.name'];
      const facts: string[] = row['facts'] ?? [];
      if (seen.has(entity)) continue;
      seen.add(entity);

      clusters.push({
        theme: entity,
        entities: [entity],
        factCount: facts.length,
        topFacts: facts.slice(0, 3),
      });
    }

    return clusters;
  }

  // ========== USER BEHAVIORAL MODEL ==========

  /**
   * Get or create the user's behavioral model.
   */
  async getUserModel(senderId: string): Promise<Record<string, string> | null> {
    if (!this.graph) await this.connect();

    const result = await this.graph!.query(
      `MATCH (m:UserModel {senderId: $senderId}) RETURN m`,
      { params: { senderId } }
    );

    if ((result.data ?? []).length === 0) return null;
    const row = (result.data![0] as any).m;
    return row?.properties ?? row ?? null;
  }

  /**
   * Update the user's behavioral model with new observations.
   */
  async updateUserModel(senderId: string, updates: Record<string, string>): Promise<void> {
    if (!this.graph) await this.connect();

    // Check if model exists
    const existing = await this.getUserModel(senderId);

    if (!existing) {
      // Create new model
      const props = Object.entries(updates).map(([k, v]) => `${k}: $${k}`).join(', ');
      const params: Record<string, string> = { senderId, now: new Date().toISOString(), ...updates };
      await this.graph!.query(
        `CREATE (:UserModel {senderId: $senderId, updatedAt: $now, ${props}})`,
        { params }
      );
      console.log(`[GraphMemory] Created user model for ${senderId}`);
    } else {
      // Update existing model
      const setClause = Object.keys(updates).map(k => `m.${k} = $${k}`).join(', ');
      const params: Record<string, string> = { senderId, now: new Date().toISOString(), ...updates };
      await this.graph!.query(
        `MATCH (m:UserModel {senderId: $senderId}) SET ${setClause}, m.updatedAt = $now`,
        { params }
      );
      console.log(`[GraphMemory] Updated user model for ${senderId}`);
    }
  }

  /**
   * Get a formatted user model string for injection into specialist context.
   */
  async getUserModelSummary(senderId: string): Promise<string | null> {
    const model = await this.getUserModel(senderId);
    if (!model) return null;

    const skip = new Set(['senderId', 'updatedAt']);
    const lines = Object.entries(model)
      .filter(([k]) => !skip.has(k) && model[k])
      .map(([k, v]) => `- ${k.replace(/([A-Z])/g, ' $1').toLowerCase().trim()}: ${v}`);

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Apply confidence decay to facts based on age and importance tier.
   * Called during heartbeat. Facts below 0.3 are auto-removed.
   * Facts between 0.3-0.5 are returned as review candidates.
   *
   * Decay rates: imp 1 = 0.05/day, imp 2 = 0.02/day, imp 3 = 0.005/day, imp 4-5 = 0
   */
  async applyDecay(senderId: string): Promise<{ removed: number; reviewCandidates: string[] }> {
    if (!this.graph) await this.connect();

    const DECAY_RATES: Record<number, number> = { 1: 0.05, 2: 0.02, 3: 0.005 };
    const now = Date.now();
    let removed = 0;
    const reviewCandidates: string[] = [];

    // Load all non-critical facts (importance 1-3)
    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       WHERE f.importance <= 3
       RETURN f.id, f.text, f.importance, f.confidence, f.createdAt`,
      { params: { senderId } }
    );

    for (const row of (result.data ?? []) as any[]) {
      const importance = row['f.importance'] ?? 2;
      const confidence = row['f.confidence'] ?? 0.8;
      const createdAt = new Date(row['f.createdAt'] ?? now).getTime();
      const ageDays = (now - createdAt) / (24 * 60 * 60 * 1000);
      const decayRate = DECAY_RATES[importance] ?? 0;

      if (decayRate === 0) continue;

      const decayedConfidence = confidence - (decayRate * ageDays);
      const factId = row['f.id'];
      const factText = row['f.text'] ?? '';

      if (decayedConfidence < 0.3) {
        // Auto-remove — confidence too low
        await this.graph!.query(
          `MATCH (f:Fact {id: $id}) DETACH DELETE f`,
          { params: { id: factId } }
        );
        removed++;
        console.log(`[GraphMemory] Decay removed: "${factText.slice(0, 50)}..." (imp=${importance}, conf=${decayedConfidence.toFixed(2)})`);
      } else if (decayedConfidence < 0.5) {
        // Flag for review — confidence getting low
        reviewCandidates.push(factText);
        // Update confidence in graph
        await this.graph!.query(
          `MATCH (f:Fact {id: $id}) SET f.confidence = $conf`,
          { params: { id: factId, conf: Math.round(decayedConfidence * 100) / 100 } }
        );
      } else if (decayedConfidence < confidence - 0.01) {
        // Just update the decayed confidence (significant change only)
        await this.graph!.query(
          `MATCH (f:Fact {id: $id}) SET f.confidence = $conf`,
          { params: { id: factId, conf: Math.round(decayedConfidence * 100) / 100 } }
        );
      }
    }

    if (removed > 0 || reviewCandidates.length > 0) {
      console.log(`[GraphMemory] Decay: removed ${removed}, review candidates: ${reviewCandidates.length}`);
    }

    return { removed, reviewCandidates };
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.graph = null;
      this.initialized = false;
    }
  }
}

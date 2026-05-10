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
  }

  /**
   * Add a fact to the graph. Checks for semantic duplicates first.
   * Returns the fact ID if stored, null if deduplicated.
   */
  async addFact(input: FactInput, senderId: string): Promise<string | null> {
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

    // Extract and link entities
    const entities = input.entities ?? [];
    for (const entityName of entities) {
      await this.graph!.query(
        `MERGE (e:Entity {name: $name, senderId: $senderId})
         ON CREATE SET e.type = 'unknown', e.createdAt = $now
         WITH e
         MATCH (f:Fact {id: $factId})
         CREATE (f)-[:ABOUT]->(e)`,
        { params: { name: entityName, senderId, now, factId: id } }
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

    console.log(`[GraphMemory] Stored: "${text.slice(0, 60)}" (imp=${importance}, cat=${category})`);
    return id;
  }

  /**
   * Semantic search — find facts relevant to a query using multi-signal scoring.
   */
  async search(query: string, senderId: string, topK = 5): Promise<GraphSearchResult[]> {
    if (!this.graph) await this.connect();

    const [queryEmb] = await this.client.embed(query);
    if (!queryEmb) return [];

    // Vector KNN + property retrieval
    const result = await this.graph!.query(
      `CALL db.idx.vector.queryNodes('Fact', 'embedding', $topK, vecf32($emb))
       YIELD node, score
       WHERE node.senderId = $senderId
       RETURN node.text, node.importance, node.category, node.confidence,
              node.createdAt, score, node.id`,
      { params: { emb: queryEmb, senderId, topK: topK * 2 } } // fetch extra to filter
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

    const result = await this.graph!.query(
      `MATCH (f:Fact {senderId: $senderId})
       WHERE f.text CONTAINS $match
       DETACH DELETE f
       RETURN count(f) as deleted`,
      { params: { senderId, match: textMatch } }
    );

    const deleted = ((result.data ?? [])[0] as any)?.deleted ?? 0;
    if (deleted > 0) {
      console.log(`[GraphMemory] Removed ${deleted} fact(s) matching "${textMatch.slice(0, 40)}"`);
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

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.graph = null;
      this.initialized = false;
    }
  }
}

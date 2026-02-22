import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OllamaClient } from '../ollama/client.js';

const DEFAULT_DB_PATH = 'data/memory.db';

export interface MemoryEntry {
  id: string;
  text: string;
  file: string;
  section: string;
  embedding: number[];
  savedAt: string;
}

export interface MemorySearchResult extends MemoryEntry {
  score: number;
}

export class EmbeddingStore {
  private db: Database.Database;

  constructor(dbPath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        section TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_file ON memory_chunks(file)
    `);
  }

  add(entry: MemoryEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_chunks (id, file, section, text, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.file,
      entry.section,
      entry.text,
      float32ToBuffer(entry.embedding),
      entry.savedAt,
    );
  }

  search(queryEmbedding: number[], maxResults = 5, minScore = 0.3): MemorySearchResult[] {
    const rows = this.db.prepare('SELECT * FROM memory_chunks').all() as Array<{
      id: string;
      file: string;
      section: string;
      text: string;
      embedding: Buffer;
      created_at: string;
    }>;

    const scored: MemorySearchResult[] = [];
    for (const row of rows) {
      const storedEmbedding = bufferToFloat32(row.embedding);
      const score = cosineSimilarity(queryEmbedding, storedEmbedding);
      if (score >= minScore) {
        scored.push({
          id: row.id,
          file: row.file,
          section: row.section,
          text: row.text,
          embedding: storedEmbedding,
          score,
          savedAt: row.created_at,
        });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM memory_chunks').get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}

/** Convert float32 array to Buffer for SQLite BLOB storage */
function float32ToBuffer(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i], i * 4);
  }
  return buf;
}

/** Convert Buffer back to float32 array */
function bufferToFloat32(buf: Buffer): number[] {
  const arr: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    arr.push(buf.readFloatLE(i));
  }
  return arr;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Generate an embedding for a text using Ollama.
 */
export async function generateEmbedding(
  client: OllamaClient,
  text: string,
): Promise<number[]> {
  const embeddings = await client.embed(text);
  return embeddings[0] ?? [];
}

/**
 * Generate a unique ID for a memory entry.
 */
export function generateMemoryId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

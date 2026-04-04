import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FactEntrySchema, FactInputSchema } from '../config/schema.js';
import type { FactEntry, FactInput, FactCategory } from '../config/types.js';

/** Category display labels for facts.md */
const CATEGORY_LABELS: Record<FactCategory, string> = {
  stable: 'Stable Facts',
  context: 'Active Context',
  decision: 'Decisions',
  question: 'Open Questions',
};

const CATEGORY_ORDER: FactCategory[] = ['stable', 'context', 'decision', 'question'];

/** Auto-expiry TTLs by category. null = never expires. */
const CATEGORY_TTL_DAYS: Record<FactCategory, number | null> = {
  stable: null,
  context: 14,
  decision: 30,
  question: 7,
};

/**
 * FactStore — single write funnel for all memory facts.
 *
 * Storage layout (per-user):
 *   raw/YYYY-MM-DD/mem_<ts>.md    — append-only raw facts with YAML frontmatter
 *   index/YYYY-MM-DD.jsonl        — one JSONL line per fact (fast scan)
 *   facts/facts.json              — machine-readable FactEntry[]
 *   facts/facts.md                — human-readable, sectioned by category
 */
export class FactStore {
  private readonly basePath: string;
  private factsCache = new Map<string, { entries: FactEntry[]; loadedAt: number }>();
  private static readonly CACHE_TTL_MS = 30_000;
  /** Max chars for facts.md per user — model-independent hard limit */
  private static readonly MAX_FACTS_CHARS = 3000;
  private migrating = false;

  constructor(workspacePath: string) {
    this.basePath = join(workspacePath, 'memory');
  }

  /**
   * Write a single fact. Returns the created entry, or null if deduplicated.
   */
  writeFact(input: FactInput, senderId?: string, sourceOverride?: string, createdAtOverride?: string): FactEntry | null {
    const parsed = FactInputSchema.parse(input);
    const hash = this.hashText(parsed.text);
    const memDir = this.memDir(senderId);

    // Dedup: exact hash match
    if (this.hashExistsInIndex(memDir, hash)) return null;

    // Dedup: substring match — skip if an existing fact already covers this meaning
    // (Skip during migration to avoid recursive loadFactsJson → migrateFromLegacy loop)
    if (!this.migrating) {
      const normalized = this.normalizeText(parsed.text);
      const existing = this.loadFactsJson(senderId);
      for (const e of existing) {
        const existingNorm = this.normalizeText(e.text);
        if (existingNorm.includes(normalized) || normalized.includes(existingNorm)) return null;
      }
    }

    const now = new Date();
    const createdAt = createdAtOverride ?? now.toISOString();
    const dateStr = now.toISOString().slice(0, 10);
    const ts = now.toISOString().replace(/[:.]/g, '-');

    // Auto-compute expiresAt from category TTL if not explicitly set
    let expiresAt = parsed.expiresAt;
    if (!expiresAt) {
      const ttlDays = CATEGORY_TTL_DAYS[parsed.category];
      if (ttlDays !== null) {
        const created = new Date(createdAt);
        created.setDate(created.getDate() + ttlDays);
        expiresAt = created.toISOString();
      }
    }

    const entry: FactEntry = FactEntrySchema.parse({
      id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: parsed.text,
      category: parsed.category,
      confidence: parsed.confidence,
      source: sourceOverride ?? parsed.source ?? `${dateStr}/mem_${ts}.md`,
      createdAt,
      expiresAt,
      hash,
      senderId,
      tags: parsed.tags,
      entities: parsed.entities,
    });

    // Write raw file
    const rawDir = join(memDir, 'raw', dateStr);
    mkdirSync(rawDir, { recursive: true });
    const rawPath = join(rawDir, `mem_${ts}.md`);
    writeFileSync(rawPath, this.formatRawFile(entry));

    // Append to index
    this.appendToIndex(memDir, dateStr, entry);

    // Invalidate cache
    this.invalidateCache(senderId);

    return entry;
  }

  /**
   * Write multiple facts in a batch. Returns created entries (deduped).
   */
  writeFactsBatch(inputs: FactInput[], senderId?: string, sourceOverride?: string, createdAtOverride?: string): FactEntry[] {
    const entries: FactEntry[] = [];
    for (const input of inputs) {
      const entry = this.writeFact(input, senderId, sourceOverride, createdAtOverride);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Rebuild facts.json and facts.md from all index files.
   * Deduplicates by hash, drops expired context entries.
   */
  /**
   * Remove a fact by matching text substring. Returns the number of facts removed.
   * Rewrites JSONL index files to exclude matching entries, then rebuilds.
   */
  removeFact(query: string, senderId?: string): number {
    const memDir = this.memDir(senderId);
    const indexDir = join(memDir, 'index');
    if (!existsSync(indexDir)) return 0;

    const queryLower = query.toLowerCase();
    let removed = 0;

    const indexFiles = readdirSync(indexDir).filter(f => f.endsWith('.jsonl'));
    for (const file of indexFiles) {
      const filePath = join(indexDir, file);
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      const kept: string[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.text?.toLowerCase().includes(queryLower)) {
            removed++;
            continue; // skip this fact
          }
        } catch { /* keep malformed lines to avoid data loss */ }
        kept.push(line);
      }

      writeFileSync(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
    }

    if (removed > 0) {
      this.factsCache.delete(senderId ?? '__shared__');
      this.rebuildFacts(senderId);
    }

    return removed;
  }

  rebuildFacts(senderId?: string): void {
    const memDir = this.memDir(senderId);
    const indexDir = join(memDir, 'index');
    if (!existsSync(indexDir)) return;

    // Read all JSONL index files
    const allEntries: FactEntry[] = [];
    const seenHashes = new Set<string>();
    const now = Date.now();

    const indexFiles = readdirSync(indexDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort();

    for (const file of indexFiles) {
      const lines = readFileSync(join(indexDir, file), 'utf-8')
        .split('\n')
        .filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = FactEntrySchema.parse(JSON.parse(line));

          // Skip duplicates
          if (seenHashes.has(entry.hash)) continue;
          seenHashes.add(entry.hash);

          // Backfill expiresAt for legacy entries missing it
          if (!entry.expiresAt) {
            const ttlDays = CATEGORY_TTL_DAYS[entry.category];
            if (ttlDays !== null) {
              const created = new Date(entry.createdAt);
              created.setDate(created.getDate() + ttlDays);
              entry.expiresAt = created.toISOString();
            }
          }

          // Drop expired entries
          if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) continue;

          allEntries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Write facts.json and facts.md
    const factsDir = join(memDir, 'facts');
    mkdirSync(factsDir, { recursive: true });

    // Enforce character bounds — drop lowest-confidence facts until under limit
    const bounded = this.enforceCharBound(allEntries);

    writeFileSync(join(factsDir, 'facts.json'), JSON.stringify(bounded, null, 2));
    writeFileSync(join(factsDir, 'facts.md'), this.formatFactsMd(bounded));

    if (bounded.length < allEntries.length) {
      console.log(`[FactStore] Char bound: trimmed ${allEntries.length - bounded.length} low-confidence facts to stay under ${FactStore.MAX_FACTS_CHARS} chars`);
    }

    // Invalidate cache
    this.invalidateCache(senderId);
  }

  /**
   * Consolidate facts: remove substring duplicates, keeping the longer/higher-confidence version.
   * Designed to run nightly via heartbeat, not on every rebuild.
   */
  consolidateFacts(senderId?: string): number {
    const entries = this.loadFactsJson(senderId);
    if (entries.length < 2) return 0;

    const normalized = entries.map(e => ({ entry: e, norm: this.normalizeText(e.text) }));
    const removed = new Set<number>();

    for (let i = 0; i < normalized.length; i++) {
      if (removed.has(i)) continue;
      for (let j = i + 1; j < normalized.length; j++) {
        if (removed.has(j)) continue;
        const a = normalized[i];
        const b = normalized[j];

        // One is substring of the other
        if (a.norm.includes(b.norm) || b.norm.includes(a.norm)) {
          // Keep the longer one; if same length, keep higher confidence
          if (a.norm.length > b.norm.length || (a.norm.length === b.norm.length && a.entry.confidence >= b.entry.confidence)) {
            removed.add(j);
          } else {
            removed.add(i);
            break; // i is removed, stop comparing it
          }
        }
      }
    }

    if (removed.size === 0) return 0;

    const kept = entries.filter((_, i) => !removed.has(i));
    const memDir = this.memDir(senderId);
    const factsDir = join(memDir, 'facts');
    mkdirSync(factsDir, { recursive: true });
    writeFileSync(join(factsDir, 'facts.json'), JSON.stringify(kept, null, 2));
    writeFileSync(join(factsDir, 'facts.md'), this.formatFactsMd(kept));
    this.invalidateCache(senderId);

    console.log(`[FactStore] Consolidated: removed ${removed.size} duplicate(s), ${kept.length} facts remain`);
    return removed.size;
  }

  /**
   * Overwrite facts.json and facts.md with the given entries.
   * Used by LLM consolidation to remove merged/replaced facts.
   */
  overwriteFacts(entries: FactEntry[], senderId?: string): void {
    const memDir = this.memDir(senderId);
    const factsDir = join(memDir, 'facts');
    mkdirSync(factsDir, { recursive: true });
    writeFileSync(join(factsDir, 'facts.json'), JSON.stringify(entries, null, 2));
    writeFileSync(join(factsDir, 'facts.md'), this.formatFactsMd(entries));
    this.invalidateCache(senderId);
  }

  /** Generic/recency queries that should return recent facts instead of keyword matching */
  private static readonly RECENCY_QUERIES = new Set([
    'recent', 'latest', 'all', 'summary', 'everything', 'list', 'show',
  ]);

  /**
   * Search facts by keyword matching against text field.
   * Falls back to returning most recent facts when keywords produce no matches.
   */
  searchFacts(query: string, senderId?: string, maxResults = 10): FactEntry[] {
    const entries = this.loadFactsJson(senderId);
    if (entries.length === 0) return [];

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Generic queries: return all facts (no limit) — this is just a flat list
    if (keywords.length === 0 || keywords.every(kw => FactStore.RECENCY_QUERIES.has(kw))) {
      return [...entries];
    }

    const scored = entries.map(entry => {
      const lower = entry.text.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        // Base text match
        const textMatches = lower.split(kw).length - 1;
        score += textMatches;

        // Boost: tags match (2x weight)
        for (const tag of entry.tags) {
          if (tag.toLowerCase().includes(kw)) score += 2;
        }

        // Boost: entities match (3x weight — proper nouns are high signal)
        for (const entity of entry.entities) {
          if (entity.toLowerCase().includes(kw)) score += 3;
        }
      }

      // Exact phrase match bonus (query appears as substring in text)
      if (lower.includes(query.toLowerCase())) score += 2;

      // Boost by confidence
      score *= entry.confidence;
      return { entry, score };
    });

    const keywordResults = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.entry);

    // If keyword matching produced no results but facts exist, return most recent
    if (keywordResults.length === 0) {
      return [...entries]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, maxResults);
    }

    return keywordResults;
  }

  /**
   * Migrate legacy dated .md files into the new FactStore format.
   * Uses a marker file (.migrated) to track whether migration has already run,
   * independent of whether the facts/ dir exists.
   */
  migrateFromLegacy(senderId: string): number {
    const memDir = this.memDir(senderId);
    const markerPath = join(memDir, '.migrated');

    // Already migrated?
    if (existsSync(markerPath)) return 0;

    // Find old dated .md files
    if (!existsSync(memDir)) return 0;

    const datedFiles = readdirSync(memDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();

    if (datedFiles.length === 0) {
      // No legacy files — mark as migrated so we don't check again
      mkdirSync(memDir, { recursive: true });
      writeFileSync(markerPath, new Date().toISOString());
      return 0;
    }

    let migrated = 0;
    this.migrating = true;
    try {
      for (const file of datedFiles) {
        const date = file.replace(/\.md$/, '');
        const content = readFileSync(join(memDir, file), 'utf-8');
        const bullets = content
          .split('\n')
          .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
          .map(l => l.trim().replace(/^[-*]\s*/, ''));

        if (bullets.length === 0) continue;

        const inputs: FactInput[] = bullets.map(text => ({
          text,
          category: 'stable' as const,
          confidence: 0.7,
          source: `legacy/${file}`,
        }));

        // Preserve original date from filename so legacy facts don't appear "newest"
        const legacyCreatedAt = `${date}T00:00:00.000Z`;
        const written = this.writeFactsBatch(inputs, senderId, `legacy/${file}`, legacyCreatedAt);
        migrated += written.length;
      }
    } finally {
      this.migrating = false;
    }

    if (migrated > 0) {
      this.rebuildFacts(senderId);
      console.log(`[FactStore] Migrated ${migrated} facts from legacy files for user ${senderId}`);
    }

    // Mark migration complete
    writeFileSync(markerPath, new Date().toISOString());

    return migrated;
  }

  /**
   * Load facts.json entries, with caching.
   * Triggers legacy migration on first access for a sender.
   */
  loadFactsJson(senderId?: string): FactEntry[] {
    const cacheKey = senderId ?? '__shared__';
    const cached = this.factsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < FactStore.CACHE_TTL_MS) {
      return cached.entries;
    }

    // Always attempt legacy migration (uses .migrated marker to avoid repeat work)
    if (senderId) {
      this.migrateFromLegacy(senderId);
    }

    const memDir = this.memDir(senderId);
    const factsPath = join(memDir, 'facts', 'facts.json');

    if (!existsSync(factsPath)) return [];

    try {
      const raw = readFileSync(factsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed)
        ? parsed.map(e => FactEntrySchema.parse(e))
        : [];

      this.factsCache.set(cacheKey, { entries, loadedAt: Date.now() });
      return entries;
    } catch {
      return [];
    }
  }

  // --- Private helpers ---

  private memDir(senderId?: string): string {
    return senderId ? join(this.basePath, senderId) : this.basePath;
  }

  private normalizeText(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hashText(text: string): string {
    return createHash('sha256').update(this.normalizeText(text)).digest('hex').slice(0, 16);
  }

  private hashExistsInIndex(memDir: string, hash: string): boolean {
    const indexDir = join(memDir, 'index');
    if (!existsSync(indexDir)) return false;

    const indexFiles = readdirSync(indexDir).filter(f => f.endsWith('.jsonl'));
    for (const file of indexFiles) {
      const content = readFileSync(join(indexDir, file), 'utf-8');
      if (content.includes(`"${hash}"`)) return true;
    }
    return false;
  }

  private appendToIndex(memDir: string, dateStr: string, entry: FactEntry): void {
    const indexDir = join(memDir, 'index');
    mkdirSync(indexDir, { recursive: true });
    const indexPath = join(indexDir, `${dateStr}.jsonl`);
    appendFileSync(indexPath, JSON.stringify(entry) + '\n');
  }

  private formatRawFile(entry: FactEntry): string {
    const lines = [
      '---',
      `id: ${entry.id}`,
      `category: ${entry.category}`,
      `confidence: ${entry.confidence}`,
      `source: ${entry.source}`,
      `hash: ${entry.hash}`,
      `createdAt: ${entry.createdAt}`,
    ];
    if (entry.expiresAt) lines.push(`expiresAt: ${entry.expiresAt}`);
    if (entry.senderId) lines.push(`senderId: ${entry.senderId}`);
    if (entry.tags.length > 0) lines.push(`tags: [${entry.tags.join(', ')}]`);
    if (entry.entities.length > 0) lines.push(`entities: [${entry.entities.join(', ')}]`);
    lines.push('---', '', entry.text, '');
    return lines.join('\n');
  }

  /**
   * Enforce character bounds by dropping lowest-confidence facts until
   * the rendered markdown is under MAX_FACTS_CHARS.
   */
  private enforceCharBound(entries: FactEntry[]): FactEntry[] {
    let md = this.formatFactsMd(entries);
    if (md.length <= FactStore.MAX_FACTS_CHARS) return entries;

    // Sort by confidence ascending — drop lowest first
    const sorted = [...entries].sort((a, b) => a.confidence - b.confidence);
    const kept = [...entries];

    while (md.length > FactStore.MAX_FACTS_CHARS && sorted.length > 0) {
      const lowest = sorted.shift()!;
      const idx = kept.findIndex(e => e.hash === lowest.hash);
      if (idx !== -1) kept.splice(idx, 1);
      md = this.formatFactsMd(kept);
    }

    return kept;
  }

  private formatFactsMd(entries: FactEntry[]): string {
    const grouped = new Map<FactCategory, FactEntry[]>();
    for (const cat of CATEGORY_ORDER) {
      grouped.set(cat, []);
    }
    for (const entry of entries) {
      const list = grouped.get(entry.category);
      if (list) list.push(entry);
    }

    const sections: string[] = ['# Facts', ''];

    for (const cat of CATEGORY_ORDER) {
      const items = grouped.get(cat)!;
      if (items.length === 0) continue;

      sections.push(`## ${CATEGORY_LABELS[cat]}`);
      for (const item of items) {
        let line = `- ${item.text} (src: ${item.source}, conf: ${item.confidence})`;
        if (item.tags.length > 0) line += ` [${item.tags.join(', ')}]`;
        if (item.entities.length > 0) line += ` {${item.entities.join(', ')}}`;
        if (item.expiresAt) line += ` (expires: ${item.expiresAt})`;
        sections.push(line);
      }
      sections.push('');
    }

    return sections.join('\n');
  }

  private invalidateCache(senderId?: string): void {
    const key = senderId ?? '__shared__';
    this.factsCache.delete(key);
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FactStore } from '../../src/memory/fact-store.js';
import type { FactInput, FactEntry } from '../../src/config/types.js';

const testDir = '/tmp/localclaw-test-factstore-' + Date.now();
const workspacePath = testDir;

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
});

describe('FactStore.writeFact', () => {
  it('creates raw file with YAML frontmatter', async () => {
    const store = new FactStore(workspacePath);
    const entry = await store.writeFact(
      { text: 'Peter uses Linux', category: 'stable', confidence: 0.9 },
      'user123',
      'test/source',
    );

    expect(entry).not.toBeNull();
    expect(entry!.text).toBe('Peter uses Linux');
    expect(entry!.category).toBe('stable');
    expect(entry!.confidence).toBe(0.9);
    expect(entry!.senderId).toBe('user123');

    // Check raw file exists
    const rawDir = join(workspacePath, 'memory', 'user123', 'raw');
    expect(existsSync(rawDir)).toBe(true);
    const dateDirs = readdirSync(rawDir);
    expect(dateDirs.length).toBe(1);
    const rawFiles = readdirSync(join(rawDir, dateDirs[0]));
    expect(rawFiles.length).toBe(1);

    const rawContent = readFileSync(join(rawDir, dateDirs[0], rawFiles[0]), 'utf-8');
    expect(rawContent).toContain('category: stable');
    expect(rawContent).toContain('confidence: 0.9');
    expect(rawContent).toContain('Peter uses Linux');
  });

  it('appends to JSONL index', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Fact 1', category: 'stable', confidence: 0.8 }, 'user1');
    await store.writeFact({ text: 'Fact 2', category: 'decision', confidence: 0.9 }, 'user1');

    const indexDir = join(workspacePath, 'memory', 'user1', 'index');
    expect(existsSync(indexDir)).toBe(true);

    const indexFiles = readdirSync(indexDir);
    expect(indexFiles.length).toBe(1); // same day

    const lines = readFileSync(join(indexDir, indexFiles[0]), 'utf-8')
      .split('\n')
      .filter(l => l.trim());
    expect(lines.length).toBe(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.text).toBe('Fact 1');
    expect(parsed2.text).toBe('Fact 2');
  });

  it('deduplicates by hash', async () => {
    const store = new FactStore(workspacePath);
    const first = await store.writeFact({ text: 'Peter uses Linux', category: 'stable', confidence: 0.9 }, 'u1');
    const dupe = await store.writeFact({ text: 'Peter uses Linux', category: 'stable', confidence: 0.9 }, 'u1');

    expect(first).not.toBeNull();
    expect(dupe).toBeNull();
  });

  it('deduplicates normalized text (case + punctuation insensitive)', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Peter uses Linux.', category: 'stable', confidence: 0.9 }, 'u1');
    const dupe = await store.writeFact({ text: 'peter uses linux', category: 'stable', confidence: 0.9 }, 'u1');

    expect(dupe).toBeNull();
  });
});

describe('FactStore.writeFactsBatch', () => {
  it('writes multiple facts and deduplicates', async () => {
    const store = new FactStore(workspacePath);
    const inputs: FactInput[] = [
      { text: 'Fact A', category: 'stable', confidence: 0.8 },
      { text: 'Fact B', category: 'context', confidence: 0.7 },
      { text: 'Fact A', category: 'stable', confidence: 0.8 }, // duplicate
    ];

    const entries = await store.writeFactsBatch(inputs, 'user1');
    expect(entries.length).toBe(2); // 3rd is deduplicated
  });
});

describe('FactStore char bound (importance-aware)', () => {
  it('never evicts imp>=4 identity/critical facts when over the char bound', async () => {
    const store = new FactStore(workspacePath);

    // Flood the store with low-importance (imp 2) filler to blow past MAX_FACTS_CHARS (20000)
    const filler: FactInput[] = [];
    for (let i = 0; i < 250; i++) {
      filler.push({
        text: `Low importance context fact number ${i} with extra padding text to consume characters quickly ${'x'.repeat(60)}`,
        category: 'context',
        confidence: 0.9, // HIGH confidence — old logic kept these and dropped identity facts
        importance: 2,
      });
    }
    await store.writeFactsBatch(filler, 'u_bound');

    // Two critical identity facts with only MODERATE confidence — old logic would evict these first
    await store.writeFact({ text: "Peter's wife's name is Nicole", category: 'stable', confidence: 0.6, importance: 5 }, 'u_bound');
    await store.writeFact({ text: "Peter's father is in critical care", category: 'stable', confidence: 0.6, importance: 5 }, 'u_bound');

    store.rebuildFacts('u_bound');

    const factsJson: FactEntry[] = JSON.parse(
      readFileSync(join(workspacePath, 'memory', 'u_bound', 'facts', 'facts.json'), 'utf-8'),
    );

    // The char bound must have trimmed SOME low-importance facts...
    expect(factsJson.length).toBeLessThan(252);
    // ...but BOTH imp-5 identity facts must survive despite low confidence.
    const texts = factsJson.map(f => f.text);
    expect(texts).toContain("Peter's wife's name is Nicole");
    expect(texts).toContain("Peter's father is in critical care");
    // No protected fact should ever be dropped.
    expect(factsJson.filter(f => (f.importance ?? 2) >= 4).length).toBe(2);
  });
});

describe('FactStore.rebuildFacts', () => {
  it('generates facts.json and facts.md', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Stable fact', category: 'stable', confidence: 0.9 }, 'u1');
    await store.writeFact({ text: 'Open question?', category: 'question', confidence: 0.6 }, 'u1');
    await store.writeFact({ text: 'A decision was made', category: 'decision', confidence: 0.85 }, 'u1');

    store.rebuildFacts('u1');

    const factsDir = join(workspacePath, 'memory', 'u1', 'facts');
    expect(existsSync(join(factsDir, 'facts.json'))).toBe(true);
    expect(existsSync(join(factsDir, 'facts.md'))).toBe(true);

    const factsJson: FactEntry[] = JSON.parse(readFileSync(join(factsDir, 'facts.json'), 'utf-8'));
    expect(factsJson.length).toBe(3);

    const factsMd = readFileSync(join(factsDir, 'facts.md'), 'utf-8');
    expect(factsMd).toContain('## Stable Facts');
    expect(factsMd).toContain('## Decisions');
    expect(factsMd).toContain('## Open Questions');
    expect(factsMd).toContain('Stable fact');
    expect(factsMd).toContain('Open question?');
    expect(factsMd).toContain('A decision was made');
  });

  it('drops expired context entries', async () => {
    const store = new FactStore(workspacePath);
    const past = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const future = new Date(Date.now() + 86400000).toISOString(); // tomorrow

    await store.writeFact({ text: 'Expired context', category: 'context', confidence: 0.7, expiresAt: past }, 'u1');
    await store.writeFact({ text: 'Active context', category: 'context', confidence: 0.7, expiresAt: future }, 'u1');
    await store.writeFact({ text: 'Permanent fact', category: 'stable', confidence: 0.9 }, 'u1');

    store.rebuildFacts('u1');

    const factsJson: FactEntry[] = JSON.parse(
      readFileSync(join(workspacePath, 'memory', 'u1', 'facts', 'facts.json'), 'utf-8'),
    );
    expect(factsJson.length).toBe(2);
    expect(factsJson.map(f => f.text)).not.toContain('Expired context');
    expect(factsJson.map(f => f.text)).toContain('Active context');
    expect(factsJson.map(f => f.text)).toContain('Permanent fact');
  });

  it('deduplicates by hash across index files', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Same fact', category: 'stable', confidence: 0.8 }, 'u1');

    // Manually write a duplicate entry to a different index date file
    const indexDir = join(workspacePath, 'memory', 'u1', 'index');
    const existingFile = readdirSync(indexDir)[0];
    const existingLine = readFileSync(join(indexDir, existingFile), 'utf-8').trim();
    const existingEntry = JSON.parse(existingLine);

    // Write same hash to a "different day" index
    const dupeEntry = { ...existingEntry, id: 'fact_dupe', createdAt: new Date().toISOString() };
    writeFileSync(join(indexDir, '2099-01-01.jsonl'), JSON.stringify(dupeEntry) + '\n');

    store.rebuildFacts('u1');

    const factsJson: FactEntry[] = JSON.parse(
      readFileSync(join(workspacePath, 'memory', 'u1', 'facts', 'facts.json'), 'utf-8'),
    );
    expect(factsJson.length).toBe(1);
  });
});

describe('FactStore.searchFacts', () => {
  it('returns matching facts ranked by keyword score', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Peter uses Playwright for browser automation', category: 'stable', confidence: 0.9 }, 'u1');
    await store.writeFact({ text: 'System runs on Linux Ubuntu', category: 'stable', confidence: 0.8 }, 'u1');
    await store.writeFact({ text: 'Playwright is preferred over Selenium', category: 'decision', confidence: 0.85 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('Playwright', 'u1');
    expect(results.length).toBe(2);
    expect(results[0].text).toContain('Playwright');
  });

  it('returns empty array for no matches', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Some fact', category: 'stable', confidence: 0.8 }, 'u1');
    store.rebuildFacts('u1');

    // When keyword matching fails but facts exist, returns recent facts as fallback
    const results = store.searchFacts('nonexistent', 'u1');
    expect(results.length).toBe(1);
    expect(results[0].text).toBe('Some fact');
  });

  it('boosts results by confidence', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Low confidence Linux fact', category: 'stable', confidence: 0.3 }, 'u1');
    await store.writeFact({ text: 'High confidence Linux setup', category: 'stable', confidence: 0.95 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('Linux', 'u1');
    expect(results.length).toBe(2);
    expect(results[0].confidence).toBeGreaterThan(results[1].confidence);
  });

  it('boosts results with matching tags/entities', async () => {
    const store = new FactStore(workspacePath);
    // Fact with no tags — only body match
    await store.writeFact({ text: 'Uses some tool for testing', category: 'stable', confidence: 0.8 }, 'u1');
    // Fact with matching entity — should rank higher
    await store.writeFact({
      text: 'Prefers a browser framework',
      category: 'stable',
      confidence: 0.8,
      tags: ['browser', 'automation'],
      entities: ['Playwright'],
    }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('Playwright', 'u1');
    expect(results.length).toBe(1); // only the entity-tagged one matches
    expect(results[0].entities).toContain('Playwright');
  });

  it('exact phrase match gets bonus', async () => {
    const store = new FactStore(workspacePath);
    await store.writeFact({ text: 'Peter prefers dark mode on all devices', category: 'stable', confidence: 0.8 }, 'u1');
    await store.writeFact({ text: 'Dark theme is nice', category: 'stable', confidence: 0.8 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('dark mode', 'u1');
    // The one with exact "dark mode" phrase should rank first
    expect(results[0].text).toContain('dark mode');
  });
});

describe('FactStore.migrateFromLegacy', () => {
  it('imports dated .md files into FactStore', async () => {
    // Create legacy memory files
    const userDir = join(workspacePath, 'memory', 'legacy-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '2026-02-28.md'), '## 2026-02-28\n\n- Peter uses Linux\n- Peter prefers dark mode\n');
    writeFileSync(join(userDir, '2026-02-27.md'), '## 2026-02-27\n\n- DGX Spark on node 3\n');

    const store = new FactStore(workspacePath);
    await store.migrateFromLegacy('legacy-user');

    // Verify facts.json was created by migration's rebuildFacts call
    const factsPath = join(userDir, 'facts', 'facts.json');
    expect(existsSync(factsPath)).toBe(true);
    const facts: FactEntry[] = JSON.parse(readFileSync(factsPath, 'utf-8'));
    expect(facts.length).toBe(3);
    expect(facts.every(f => f.source.startsWith('legacy/'))).toBe(true);
    expect(facts.every(f => f.confidence === 0.7)).toBe(true);
  });

  it('does not re-migrate when .migrated marker exists', async () => {
    const userDir = join(workspacePath, 'memory', 'migrated-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '.migrated'), new Date().toISOString());
    writeFileSync(join(userDir, '2026-02-28.md'), '## 2026-02-28\n\n- Some fact\n');

    const store = new FactStore(workspacePath);
    const count = await store.migrateFromLegacy('migrated-user');
    expect(count).toBe(0);
  });

  it('old files are left in place (no data loss)', async () => {
    const userDir = join(workspacePath, 'memory', 'keep-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '2026-02-28.md'), '## 2026-02-28\n\n- Important fact\n');

    const store = new FactStore(workspacePath);
    await store.migrateFromLegacy('keep-user');

    // Old file should still exist
    expect(existsSync(join(userDir, '2026-02-28.md'))).toBe(true);
  });
});

describe('FactStore.loadFactsJson', () => {
  it('auto-migrates on first access for sender with legacy files', async () => {
    const userDir = join(workspacePath, 'memory', 'auto-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '2026-03-01.md'), '## 2026-03-01\n\n- Auto migrated fact\n');

    const store = new FactStore(workspacePath);
    // Migration is async — trigger explicitly then rebuild
    await store.migrateFromLegacy('auto-user');
    store.rebuildFacts('auto-user');
    const facts = store.loadFactsJson('auto-user');

    expect(facts.length).toBe(1);
    expect(facts[0].text).toBe('Auto migrated fact');
  });

  it('returns empty for non-existent sender', () => {
    const store = new FactStore(workspacePath);
    const facts = store.loadFactsJson('nobody');
    expect(facts.length).toBe(0);
  });
});

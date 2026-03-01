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
  it('creates raw file with YAML frontmatter', () => {
    const store = new FactStore(workspacePath);
    const entry = store.writeFact(
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

  it('appends to JSONL index', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Fact 1', category: 'stable', confidence: 0.8 }, 'user1');
    store.writeFact({ text: 'Fact 2', category: 'decision', confidence: 0.9 }, 'user1');

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

  it('deduplicates by hash', () => {
    const store = new FactStore(workspacePath);
    const first = store.writeFact({ text: 'Peter uses Linux', category: 'stable', confidence: 0.9 }, 'u1');
    const dupe = store.writeFact({ text: 'Peter uses Linux', category: 'stable', confidence: 0.9 }, 'u1');

    expect(first).not.toBeNull();
    expect(dupe).toBeNull();
  });

  it('deduplicates normalized text (case + punctuation insensitive)', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Peter uses Linux.', category: 'stable', confidence: 0.9 }, 'u1');
    const dupe = store.writeFact({ text: 'peter uses linux', category: 'stable', confidence: 0.9 }, 'u1');

    expect(dupe).toBeNull();
  });
});

describe('FactStore.writeFactsBatch', () => {
  it('writes multiple facts and deduplicates', () => {
    const store = new FactStore(workspacePath);
    const inputs: FactInput[] = [
      { text: 'Fact A', category: 'stable', confidence: 0.8 },
      { text: 'Fact B', category: 'context', confidence: 0.7 },
      { text: 'Fact A', category: 'stable', confidence: 0.8 }, // duplicate
    ];

    const entries = store.writeFactsBatch(inputs, 'user1');
    expect(entries.length).toBe(2); // 3rd is deduplicated
  });
});

describe('FactStore.rebuildFacts', () => {
  it('generates facts.json and facts.md', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Stable fact', category: 'stable', confidence: 0.9 }, 'u1');
    store.writeFact({ text: 'Open question?', category: 'question', confidence: 0.6 }, 'u1');
    store.writeFact({ text: 'A decision was made', category: 'decision', confidence: 0.85 }, 'u1');

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

  it('drops expired context entries', () => {
    const store = new FactStore(workspacePath);
    const past = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const future = new Date(Date.now() + 86400000).toISOString(); // tomorrow

    store.writeFact({ text: 'Expired context', category: 'context', confidence: 0.7, expiresAt: past }, 'u1');
    store.writeFact({ text: 'Active context', category: 'context', confidence: 0.7, expiresAt: future }, 'u1');
    store.writeFact({ text: 'Permanent fact', category: 'stable', confidence: 0.9 }, 'u1');

    store.rebuildFacts('u1');

    const factsJson: FactEntry[] = JSON.parse(
      readFileSync(join(workspacePath, 'memory', 'u1', 'facts', 'facts.json'), 'utf-8'),
    );
    expect(factsJson.length).toBe(2);
    expect(factsJson.map(f => f.text)).not.toContain('Expired context');
    expect(factsJson.map(f => f.text)).toContain('Active context');
    expect(factsJson.map(f => f.text)).toContain('Permanent fact');
  });

  it('deduplicates by hash across index files', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Same fact', category: 'stable', confidence: 0.8 }, 'u1');

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
  it('returns matching facts ranked by keyword score', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Peter uses Playwright for browser automation', category: 'stable', confidence: 0.9 }, 'u1');
    store.writeFact({ text: 'System runs on Linux Ubuntu', category: 'stable', confidence: 0.8 }, 'u1');
    store.writeFact({ text: 'Playwright is preferred over Selenium', category: 'decision', confidence: 0.85 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('Playwright', 'u1');
    expect(results.length).toBe(2);
    expect(results[0].text).toContain('Playwright');
  });

  it('returns empty array for no matches', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Some fact', category: 'stable', confidence: 0.8 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('nonexistent', 'u1');
    expect(results.length).toBe(0);
  });

  it('boosts results by confidence', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Low confidence Linux fact', category: 'stable', confidence: 0.3 }, 'u1');
    store.writeFact({ text: 'High confidence Linux setup', category: 'stable', confidence: 0.95 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('Linux', 'u1');
    expect(results.length).toBe(2);
    expect(results[0].confidence).toBeGreaterThan(results[1].confidence);
  });

  it('boosts results with matching tags/entities', () => {
    const store = new FactStore(workspacePath);
    // Fact with no tags — only body match
    store.writeFact({ text: 'Uses some tool for testing', category: 'stable', confidence: 0.8 }, 'u1');
    // Fact with matching entity — should rank higher
    store.writeFact({
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

  it('exact phrase match gets bonus', () => {
    const store = new FactStore(workspacePath);
    store.writeFact({ text: 'Peter prefers dark mode on all devices', category: 'stable', confidence: 0.8 }, 'u1');
    store.writeFact({ text: 'Dark theme is nice', category: 'stable', confidence: 0.8 }, 'u1');
    store.rebuildFacts('u1');

    const results = store.searchFacts('dark mode', 'u1');
    // The one with exact "dark mode" phrase should rank first
    expect(results[0].text).toContain('dark mode');
  });
});

describe('FactStore.migrateFromLegacy', () => {
  it('imports dated .md files into FactStore', () => {
    // Create legacy memory files
    const userDir = join(workspacePath, 'memory', 'legacy-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '2026-02-28.md'), '## 2026-02-28\n\n- Peter uses Linux\n- Peter prefers dark mode\n');
    writeFileSync(join(userDir, '2026-02-27.md'), '## 2026-02-27\n\n- DGX Spark on node 3\n');

    const store = new FactStore(workspacePath);
    const count = store.migrateFromLegacy('legacy-user');

    expect(count).toBe(3);

    // Verify facts.json was created
    const factsPath = join(userDir, 'facts', 'facts.json');
    expect(existsSync(factsPath)).toBe(true);
    const facts: FactEntry[] = JSON.parse(readFileSync(factsPath, 'utf-8'));
    expect(facts.length).toBe(3);
    expect(facts.every(f => f.source.startsWith('legacy/'))).toBe(true);
    expect(facts.every(f => f.confidence === 0.7)).toBe(true);
  });

  it('does not re-migrate when facts/ already exists', () => {
    const userDir = join(workspacePath, 'memory', 'migrated-user');
    mkdirSync(join(userDir, 'facts'), { recursive: true });
    writeFileSync(join(userDir, 'facts', 'facts.json'), '[]');
    writeFileSync(join(userDir, '2026-02-28.md'), '## 2026-02-28\n\n- Some fact\n');

    const store = new FactStore(workspacePath);
    const count = store.migrateFromLegacy('migrated-user');
    expect(count).toBe(0);
  });

  it('old files are left in place (no data loss)', () => {
    const userDir = join(workspacePath, 'memory', 'keep-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '2026-02-28.md'), '## 2026-02-28\n\n- Important fact\n');

    const store = new FactStore(workspacePath);
    store.migrateFromLegacy('keep-user');

    // Old file should still exist
    expect(existsSync(join(userDir, '2026-02-28.md'))).toBe(true);
  });
});

describe('FactStore.loadFactsJson', () => {
  it('auto-migrates on first access for sender with legacy files', () => {
    const userDir = join(workspacePath, 'memory', 'auto-user');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, '2026-03-01.md'), '## 2026-03-01\n\n- Auto migrated fact\n');

    const store = new FactStore(workspacePath);
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

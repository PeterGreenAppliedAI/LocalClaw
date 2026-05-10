/**
 * Migrate existing facts from flat JSONL FactStore into FalkorDB graph.
 *
 * Usage: npx tsx scripts/migrate-facts-to-graph.ts
 */

import { OllamaClient } from '../src/ollama/client.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';
import { FactStore } from '../src/memory/fact-store.js';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const workspacePath = 'data/workspaces/main';
  const memoryDir = join(workspacePath, 'memory');

  if (!existsSync(memoryDir)) {
    console.log('No memory directory found');
    return;
  }

  const client = new OllamaClient('http://10.0.0.20:8001', '30m');
  const factStore = new FactStore(workspacePath);
  const graphStore = new GraphMemoryStore(client, { graphName: 'localclaw_memory' });
  await graphStore.connect();

  // Find all sender directories
  const senders = readdirSync(memoryDir).filter(d => {
    const p = join(memoryDir, d, 'facts');
    return existsSync(join(p, 'facts.json'));
  });

  console.log(`Found ${senders.length} sender(s) with facts\n`);

  let totalMigrated = 0;
  let totalSkipped = 0;

  for (const senderId of senders) {
    const facts = factStore.loadFactsJson(senderId);
    console.log(`[${senderId}] ${facts.length} facts to migrate`);

    for (const fact of facts) {
      try {
        const id = await graphStore.addFact(
          {
            text: fact.text,
            category: fact.category,
            confidence: fact.confidence,
            importance: (fact as any).importance ?? 2,
            tags: fact.tags ?? [],
            entities: fact.entities ?? [],
            source: fact.source,
          },
          senderId,
        );

        if (id) {
          totalMigrated++;
          console.log(`  [OK] "${fact.text.slice(0, 50)}..." (imp=${(fact as any).importance ?? 2})`);
        } else {
          totalSkipped++;
          console.log(`  [SKIP] "${fact.text.slice(0, 50)}..." (duplicate)`);
        }
      } catch (err) {
        console.warn(`  [FAIL] "${fact.text.slice(0, 50)}...": ${err instanceof Error ? err.message : err}`);
        totalSkipped++;
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    }
    console.log();
  }

  const graphCount = await graphStore.getFactCount(senders[0] ?? '');
  await graphStore.close();

  console.log(`--- Migration Complete ---`);
  console.log(`Migrated: ${totalMigrated}`);
  console.log(`Skipped (dedup): ${totalSkipped}`);
  console.log(`Graph facts for first sender: ${graphCount}`);
}

main().catch(err => { console.error(err); process.exit(1); });

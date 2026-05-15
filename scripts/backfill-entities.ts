/**
 * Backfill entities for existing facts in the graph.
 * Runs LLM NER on each fact that has no ABOUT edges, creates entity nodes.
 *
 * Usage: npx tsx scripts/backfill-entities.ts
 */

import { FalkorDB } from 'falkordb';
import { OllamaClient } from '../src/ollama/client.js';

async function main() {
  const url = process.env.OLLAMA_URL ?? 'http://10.0.0.20:8001';
  console.log(`Using Ollama at: ${url}`);
  const client = new OllamaClient(url, '30m');
  const db = await FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const graph = db.selectGraph('localclaw_memory');

  // Find facts with no ABOUT edges
  const orphans = await graph.query(
    `MATCH (f:Fact)
     OPTIONAL MATCH (f)-[:ABOUT]->(e:Entity)
     WITH f, e WHERE e IS NULL
     RETURN f.id, f.text, f.senderId`
  );

  const facts = (orphans.data ?? []) as any[];
  console.log(`Found ${facts.length} facts without entities\n`);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const factId = fact['f.id'];
    const text = fact['f.text'];
    const senderId = fact['f.senderId'];

    console.log(`[${i + 1}/${facts.length}] "${text.slice(0, 60)}..."`);

    try {
      const response = await client.chat({
        model: 'phi4-mini:latest',
        messages: [{
          role: 'user',
          content: `Extract named entities from this text. Return ONLY a JSON array of strings. Include: people, companies, products, technologies, places, events. Exclude generic words.\n\nText: "${text}"\n\nReturn: ["entity1", "entity2"]`,
        }],
        options: { temperature: 0, num_predict: 128 },
      });

      const raw = (response.message?.content ?? '').trim();
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log(`  [SKIP] No JSON array in response`);
        skipped++;
        continue;
      }

      const entities = JSON.parse(match[0]).filter((e: unknown): e is string =>
        typeof e === 'string' && e.length > 1
      ).slice(0, 5);

      if (entities.length === 0) {
        console.log(`  [SKIP] No entities found`);
        skipped++;
        continue;
      }

      const now = new Date().toISOString();
      for (const entityName of entities) {
        await graph.query(
          `MERGE (e:Entity {name: $name, senderId: $senderId})
           ON CREATE SET e.type = 'unknown', e.createdAt = $now
           WITH e
           MATCH (f:Fact {id: $factId})
           CREATE (f)-[:ABOUT]->(e)`,
          { params: { name: entityName, senderId, now, factId: factId } }
        );
      }

      console.log(`  [OK] ${entities.join(', ')}`);
      created += entities.length;

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.warn(`  [FAIL] ${err instanceof Error ? err.message : err}`);
      skipped++;
    }
  }

  // Also backfill MENTIONS edges for existing turns
  console.log('\n--- Linking turns to entities ---');
  const turns = await graph.query(
    `MATCH (t:Turn)
     OPTIONAL MATCH (t)-[:MENTIONS]->(me:Entity)
     WITH t, me WHERE me IS NULL
     RETURN t.id, t.text, t.senderId`
  );
  const allEntities = await graph.query(`MATCH (e:Entity) RETURN e.name, e.senderId`);
  const entityMap = new Map<string, string[]>();
  for (const row of (allEntities.data ?? []) as any[]) {
    const sid = row['e.senderId'];
    if (!entityMap.has(sid)) entityMap.set(sid, []);
    entityMap.get(sid)!.push(row['e.name']);
  }

  let linked = 0;
  for (const row of (turns.data ?? []) as any[]) {
    const turnId = row['t.id'];
    const text = (row['t.text'] ?? '').toLowerCase();
    const senderId = row['t.senderId'];
    const senderEntities = entityMap.get(senderId) ?? [];

    for (const entityName of senderEntities) {
      if (text.includes(entityName.toLowerCase())) {
        try {
          await graph.query(
            `MATCH (t:Turn {id: $turnId}), (e:Entity {name: $name, senderId: $senderId})
             CREATE (t)-[:MENTIONS]->(e)`,
            { params: { turnId, name: entityName, senderId } }
          );
          linked++;
        } catch { /* skip dupes */ }
      }
    }
  }

  console.log(`Linked ${linked} turn→entity edges`);

  // Summary
  const entityCount = await graph.query('MATCH (e:Entity) RETURN count(e) as cnt');
  const aboutCount = await graph.query('MATCH ()-[r:ABOUT]->() RETURN count(r) as cnt');
  const mentionsCount = await graph.query('MATCH ()-[r:MENTIONS]->() RETURN count(r) as cnt');

  console.log(`\n--- Results ---`);
  console.log(`Entities created: ${created}`);
  console.log(`Facts skipped: ${skipped}`);
  console.log(`Total entities: ${((entityCount.data ?? [])[0] as any)?.cnt}`);
  console.log(`ABOUT edges: ${((aboutCount.data ?? [])[0] as any)?.cnt}`);
  console.log(`MENTIONS edges: ${((mentionsCount.data ?? [])[0] as any)?.cnt}`);

  await db.close();
}

main().catch(err => { console.error(err); process.exit(1); });

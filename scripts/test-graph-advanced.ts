import { OllamaClient } from '../src/ollama/client.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';

async function main() {
  const client = new OllamaClient('http://10.0.0.20:8001', '30m');
  const store = new GraphMemoryStore(client, { graphName: 'test_advanced' });
  await store.connect();

  // === SETUP: Create a rich fact graph ===
  console.log('=== Building fact graph ===');
  await store.addFact({ text: 'Peter is an ML engineer at DevMesh Services', category: 'stable', confidence: 1.0, importance: 4, entities: ['DevMesh', 'ML engineering'] }, 'peter');
  await store.addFact({ text: 'DevMesh builds AI integration and automation tools', category: 'stable', confidence: 0.9, importance: 4, entities: ['DevMesh', 'AI'] }, 'peter');
  await store.addFact({ text: 'Peter is preparing for a career fair on Long Island', category: 'context', confidence: 0.8, importance: 2, entities: ['career fair', 'Long Island'] }, 'peter');
  await store.addFact({ text: 'Peter is interested in Long Island tech events', category: 'stable', confidence: 0.9, importance: 3, entities: ['Long Island', 'tech events'] }, 'peter');
  await store.addFact({ text: 'Peter has a podcast called System Prompt about AI curation', category: 'stable', confidence: 1.0, importance: 4, entities: ['System Prompt', 'AI'] }, 'peter');
  await store.addFact({ text: 'Peter prefers soft chocolate chip cookies', category: 'stable', confidence: 0.9, importance: 3, entities: ['cookies'] }, 'peter');
  await store.addFact({ text: 'Peter does TKD sparring on weekends', category: 'stable', confidence: 0.9, importance: 3, entities: ['TKD'] }, 'peter');

  const count = await store.getFactCount('peter');
  console.log(`\nStored ${count} facts\n`);

  // === 1. SUPERSEDES ===
  console.log('=== SUPERSEDES: Fact evolution ===');
  await store.updateFact(
    'ML engineer at DevMesh',
    { text: 'Peter is a Senior ML engineer at DevMesh Services', category: 'stable', confidence: 1.0, importance: 4, entities: ['DevMesh', 'ML engineering'] },
    'peter'
  );
  const history = await store.getFactHistory('Senior ML engineer', 'peter');
  console.log('Fact history:');
  for (const h of history) {
    console.log(`  ${h.current ? '[CURRENT]' : '[OLD]    '} ${h.text} (${h.createdAt.slice(0, 10)})`);
  }

  // === 2. TEMPORAL QUERIES ===
  console.log('\n=== TEMPORAL: Facts at a point in time ===');
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const changes = await store.getFactChanges('peter', yesterday);
  console.log(`Changes since yesterday: ${changes.added.length} added, ${changes.superseded.length} superseded`);
  for (const s of changes.superseded) {
    console.log(`  Changed: "${s.oldText.slice(0, 40)}" → "${s.newText.slice(0, 40)}"`);
  }

  // === 3. MULTI-HOP REASONING ===
  console.log('\n=== MULTI-HOP: Connected facts ===');
  const hops = await store.findMultiHop('What events are coming up for Peter?', 'peter');
  console.log('Multi-hop results for "What events are coming up?":');
  for (const h of hops) {
    console.log(`  hops=${(1/h.score).toFixed(0)} — ${h.text}`);
  }

  // === 4. COMMUNITY DETECTION ===
  console.log('\n=== CLUSTERS: Fact communities ===');
  const clusters = await store.getClusters('peter');
  for (const c of clusters) {
    console.log(`  [${c.entity}] (${c.facts.length} facts, imp=${c.importance})`);
    for (const f of c.facts) {
      console.log(`    - ${f.slice(0, 60)}`);
    }
  }

  console.log('\n=== CLUSTER SUMMARY (for briefing) ===');
  const summary = await store.getClusterSummary('peter');
  for (const s of summary) {
    console.log(`  Theme: ${s.theme} (${s.factCount} facts)`);
    for (const f of s.topFacts) {
      console.log(`    - ${f.slice(0, 60)}`);
    }
  }

  // Cleanup
  const db = await (await import('falkordb')).FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const graph = db.selectGraph('test_advanced');
  await graph.query('MATCH (n) DETACH DELETE n');
  await db.close();
  await store.close();

  console.log('\nAll advanced features tested!');
}

main().catch(err => { console.error(err); process.exit(1); });

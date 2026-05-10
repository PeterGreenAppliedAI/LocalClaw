import { OllamaClient } from '../src/ollama/client.js';
import { GraphMemoryStore } from '../src/memory/graph-store.js';

async function main() {
  const client = new OllamaClient('http://10.0.0.20:8001', '30m');
  const store = new GraphMemoryStore(client, { graphName: 'test_graph_memory' });

  await store.connect();

  // Add facts
  console.log('\n--- Adding facts ---');
  await store.addFact({ text: 'Peter prefers soft chocolate chip cookies', category: 'stable', confidence: 0.9, importance: 3, tags: ['food'], entities: ['cookies'] }, 'test-user');
  await store.addFact({ text: 'Peter is an ML engineer at DevMesh Services', category: 'stable', confidence: 1.0, importance: 4, entities: ['DevMesh'] }, 'test-user');
  await store.addFact({ text: 'Peter has a podcast called System Prompt', category: 'stable', confidence: 1.0, importance: 4, entities: ['System Prompt'] }, 'test-user');
  await store.addFact({ text: 'Peter prefers dark mode on all devices', category: 'stable', confidence: 0.9, importance: 3, tags: ['preference'] }, 'test-user');

  // Test dedup
  console.log('\n--- Dedup test ---');
  const dupe = await store.addFact({ text: 'Peter likes chocolate chip cookies', category: 'stable', confidence: 0.9, importance: 3 }, 'test-user');
  console.log('Duplicate result:', dupe === null ? 'REJECTED (correct!)' : 'STORED (wrong!)');

  // Semantic search
  console.log('\n--- Search: "What kind of cookies?" ---');
  const cookieResults = await store.search('What kind of cookies should I bake?', 'test-user');
  for (const r of cookieResults) {
    console.log(`  score=${r.score.toFixed(3)} imp=${r.importance} — ${r.text}`);
  }

  console.log('\n--- Search: "What does Peter do for work?" ---');
  const workResults = await store.search('What does Peter do for work?', 'test-user');
  for (const r of workResults) {
    console.log(`  score=${r.score.toFixed(3)} imp=${r.importance} — ${r.text}`);
  }

  // Stable facts
  console.log('\n--- Stable facts (importance >= 4) ---');
  const stable = await store.getStableFacts('test-user');
  for (const r of stable) {
    console.log(`  imp=${r.importance} — ${r.text}`);
  }

  // Connected facts
  console.log('\n--- Connected to "Peter is an ML engineer at DevMesh Services" ---');
  const connected = await store.findConnected('Peter is an ML engineer at DevMesh Services', 'test-user');
  for (const r of connected) {
    console.log(`  — ${r.text}`);
  }
  if (connected.length === 0) console.log('  (no connections — entities need shared edges)');

  // Count
  const count = await store.getFactCount('test-user');
  console.log(`\nTotal facts: ${count}`);

  // Cleanup test graph
  const db = await (await import('falkordb')).FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const graph = db.selectGraph('test_graph_memory');
  await graph.query('MATCH (n) DETACH DELETE n');
  await db.close();
  await store.close();

  console.log('\nGraph memory store test complete!');
}

main().catch(err => { console.error(err); process.exit(1); });

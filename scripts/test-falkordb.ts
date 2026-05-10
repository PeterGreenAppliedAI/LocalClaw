import { FalkorDB } from 'falkordb';

async function main() {
  const db = await FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const graph = db.selectGraph('test_memory');

  // Create fact nodes
  await graph.query(`CREATE (:Fact {text: 'Peter likes chocolate chip cookies', importance: 3, category: 'preference', confidence: 0.9, createdAt: '2026-05-09'})`);
  await graph.query(`CREATE (:Fact {text: 'Peter is an ML engineer at DevMesh', importance: 4, category: 'stable', confidence: 1.0, createdAt: '2026-05-09'})`);

  // Create entity nodes + relationships
  await graph.query(`CREATE (:Entity {name: 'DevMesh', type: 'company'})`);
  await graph.query(`
    MATCH (f:Fact {importance: 4}), (e:Entity {name: 'DevMesh'})
    CREATE (f)-[:ABOUT]->(e)
  `);

  // Query facts
  const facts = await graph.query(`MATCH (f:Fact) RETURN f.text, f.importance, f.category`);
  console.log('Facts:', JSON.stringify(facts.data, null, 2));

  // Traverse relationships
  const related = await graph.query(`
    MATCH (f:Fact)-[:ABOUT]->(e:Entity)
    RETURN f.text, e.name, e.type
  `);
  console.log('Relations:', JSON.stringify(related.data, null, 2));

  // Clean up
  await graph.query('MATCH (n) DETACH DELETE n');
  await db.close();
  console.log('FalkorDB proof-of-concept OK');
}

main().catch(err => { console.error(err); process.exit(1); });

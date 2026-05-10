import { FalkorDB } from 'falkordb';

async function main() {
  const db = await FalkorDB.connect({ socket: { host: 'localhost', port: 6379 } });
  const graph = db.selectGraph('test_vectors');

  // Clean slate
  try { await graph.query('MATCH (n) DETACH DELETE n'); } catch { /* empty graph */ }

  // Create vector index (768 dims for qwen3-embedding)
  try {
    await graph.query(`CREATE VECTOR INDEX FOR (f:Fact) ON (f.embedding) OPTIONS {dimension: 3584, similarityFunction: 'cosine'}`);
    console.log('Vector index created');
  } catch (e: any) {
    console.log('Vector index:', e.message?.includes('already') ? 'already exists' : e.message);
  }

  // Create facts with fake embeddings (3584 dims to match qwen3-embedding)
  const fakeDims = 3584;
  const emb1 = Array.from({ length: fakeDims }, (_, i) => Math.sin(i * 0.1));
  const emb2 = Array.from({ length: fakeDims }, (_, i) => Math.sin(i * 0.1 + 0.01)); // very similar
  const emb3 = Array.from({ length: fakeDims }, (_, i) => Math.cos(i * 0.5)); // different

  await graph.query(
    `CREATE (:Fact {text: 'Peter likes cookies', importance: 3, embedding: vecf32($emb)})`,
    { params: { emb: emb1 } }
  );
  await graph.query(
    `CREATE (:Fact {text: 'Peter prefers chocolate chips', importance: 3, embedding: vecf32($emb)})`,
    { params: { emb: emb2 } }
  );
  await graph.query(
    `CREATE (:Fact {text: 'Peter works at DevMesh', importance: 4, embedding: vecf32($emb)})`,
    { params: { emb: emb3 } }
  );

  // KNN search — find facts similar to emb1 (should rank cookies first)
  const results = await graph.query(
    `CALL db.idx.vector.queryNodes('Fact', 'embedding', 3, vecf32($query)) YIELD node, score RETURN node.text, node.importance, score`,
    { params: { query: emb1 } }
  );

  console.log('KNN results:');
  for (const row of results.data) {
    console.log(`  score=${(row.score as number).toFixed(4)} imp=${row['node.importance']} — ${row['node.text']}`);
  }

  // Clean up
  await graph.query('MATCH (n) DETACH DELETE n');
  await db.close();
  console.log('Vector search OK');
}

main().catch(err => { console.error(err); process.exit(1); });

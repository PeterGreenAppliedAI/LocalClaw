/**
 * Extract (message, category) training pairs from transcripts.
 * Used before session clear to preserve router training data.
 */
import { mkdirSync, appendFileSync } from 'node:fs';

const TRAINING_FILE = 'data/training/router-pairs.jsonl';

export function extractTrainingPairs(transcript: Array<{ role: string; content: string; category?: string }>): void {
  const pairs: string[] = [];

  for (const entry of transcript) {
    if (entry.role !== 'user' || !entry.category || !entry.content?.trim()) continue;
    const content = entry.content.trim();
    // Skip synthetic/system messages
    if (content.startsWith('[RESEARCH PIPELINE]')) continue;
    if (content.startsWith('[DEVMESH')) continue;
    if (content.startsWith('!')) continue;
    if (content.length < 5) continue;

    pairs.push(JSON.stringify({ message: content, category: entry.category }));
  }

  if (pairs.length > 0) {
    mkdirSync('data/training', { recursive: true });
    appendFileSync(TRAINING_FILE, pairs.join('\n') + '\n');
    console.log(`[Training] Extracted ${pairs.length} router pairs before session reset`);
  }
}

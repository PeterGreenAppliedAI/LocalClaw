#!/usr/bin/env npx tsx
/**
 * Extract (message, category) pairs from session transcripts
 * for fine-tuning a router classification model.
 *
 * Usage: npx tsx scripts/extract-training-data.ts
 * Output: data/training/router-pairs.jsonl  (one JSON object per line)
 *         data/training/summary.txt         (category distribution)
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS_DIR = 'data/sessions/main';
const OUTPUT_DIR = 'data/training';

interface SessionEntry {
  role: string;
  content: string;
  category?: string;
  timestamp?: string;
}

interface TrainingPair {
  message: string;
  category: string;
  source: string; // session file for traceability
}

// Filter out synthetic/system messages that aren't real user input
function isRealUserMessage(entry: SessionEntry): boolean {
  if (entry.role !== 'user') return false;
  if (!entry.category) return false;
  if (!entry.content?.trim()) return false;

  const content = entry.content.trim();

  // Skip synthetic dispatch messages (research pipeline, etc.)
  if (content.startsWith('[RESEARCH PIPELINE]')) return false;
  if (content.startsWith('[DEVMESH')) return false;

  // Skip system commands
  if (content.startsWith('!reset')) return false;
  if (content.startsWith('!save')) return false;
  if (content.startsWith('!discard')) return false;

  // Skip very short messages (single word yes/no/ok) — not useful for training
  if (content.length < 5) return false;

  return true;
}

function extractPairs(): TrainingPair[] {
  const pairs: TrainingPair[] = [];
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json') && !f.includes('.meta.') && !f.includes('.state.') && !f.includes('.summary.'));

  for (const file of files) {
    const filePath = join(SESSIONS_DIR, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const entries: SessionEntry[] = JSON.parse(raw);

      for (const entry of entries) {
        if (isRealUserMessage(entry)) {
          pairs.push({
            message: entry.content.trim(),
            category: entry.category!,
            source: file,
          });
        }
      }
    } catch {
      // Skip unparseable files
    }
  }

  return pairs;
}

function dedup(pairs: TrainingPair[]): TrainingPair[] {
  const seen = new Set<string>();
  return pairs.filter(p => {
    const key = `${p.message}::${p.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Main ---
const allPairs = extractPairs();
const uniquePairs = dedup(allPairs);

// Category distribution
const dist = new Map<string, number>();
for (const p of uniquePairs) {
  dist.set(p.category, (dist.get(p.category) ?? 0) + 1);
}

// Sort by count descending
const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);

// Output
mkdirSync(OUTPUT_DIR, { recursive: true });

// JSONL format (standard for fine-tuning)
const jsonlLines = uniquePairs.map(p => JSON.stringify({ message: p.message, category: p.category }));
writeFileSync(join(OUTPUT_DIR, 'router-pairs.jsonl'), jsonlLines.join('\n') + '\n');

// Summary
const summaryLines = [
  `Router Training Data — extracted ${new Date().toISOString().split('T')[0]}`,
  ``,
  `Total pairs: ${allPairs.length} (${uniquePairs.length} unique)`,
  `Categories: ${dist.size}`,
  ``,
  `Distribution:`,
  ...sorted.map(([cat, count]) => `  ${cat.padEnd(15)} ${String(count).padStart(5)}  (${((count / uniquePairs.length) * 100).toFixed(1)}%)`),
  ``,
  `Files scanned: ${readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json') && !f.includes('.meta.')).length}`,
];
writeFileSync(join(OUTPUT_DIR, 'summary.txt'), summaryLines.join('\n') + '\n');

// Print summary
console.log(summaryLines.join('\n'));

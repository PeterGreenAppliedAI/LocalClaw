import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyMessage } from '../../src/router/classifier.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { RouterConfig } from '../../src/config/types.js';

/**
 * Routing evaluation suite — loads a curated test corpus and verifies
 * every routing decision deterministically.
 *
 * Tests run with a FAILING mock client (model always times out) to test
 * pre-model overrides, keyword fallback, sticky routing, and defaults.
 * Model-dependent cases use a mock that returns the expected category.
 *
 * Add new cases to data/training/routing-eval.jsonl whenever a misroute
 * is observed in production. This prevents routing regressions.
 */

interface EvalCase {
  message: string;
  expected: string;
  layer: 'override' | 'sticky' | 'model' | 'keyword' | 'fallback';
  context?: { previousCategory?: string };
  note?: string;
}

function createFailingClient(): OllamaClient {
  return {
    generate: vi.fn().mockRejectedValue(new Error('timeout')),
    chat: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
    embed: vi.fn(),
  } as unknown as OllamaClient;
}

function createMockClient(response: string): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue({ response }),
    chat: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
    embed: vi.fn(),
  } as unknown as OllamaClient;
}

const config: RouterConfig = {
  model: 'phi4:14b',
  timeout: 2000,
  defaultCategory: 'chat',
  categories: {
    chat: { description: 'Conversation' },
    web_search: { description: 'Web search' },
    memory: { description: 'Memory' },
    exec: { description: 'Exec' },
    cron: { description: 'Cron' },
    message: { description: 'Message' },
    website: { description: 'Website' },
    multi: { description: 'Multi' },
    config: { description: 'Config' },
    task: { description: 'Task' },
    research: { description: 'Research' },
    personal: { description: 'Personal' },
    image: { description: 'Image generation' },
    code_gen: { description: 'Code generation' },
    analytics: { description: 'Analytics' },
    document: { description: 'Format provided content into a PDF/DOCX file' },
  },
};

// Load the evaluation corpus
const corpusPath = join(process.cwd(), 'data', 'training', 'routing-eval.jsonl');
const corpus: EvalCase[] = readFileSync(corpusPath, 'utf-8')
  .trim()
  .split('\n')
  .filter(line => line.trim())
  .map(line => JSON.parse(line));

describe('Routing Evaluation Corpus', () => {
  // Group 1: Deterministic — pre-model overrides, keywords, sticky, fallback
  const deterministicCases = corpus.filter(c => c.layer !== 'model');

  describe('Deterministic (no model)', () => {
    for (const tc of deterministicCases) {
      it(`[${tc.layer}] "${tc.message.slice(0, 60)}${tc.message.length > 60 ? '...' : ''}" → ${tc.expected}${tc.note ? ` (${tc.note})` : ''}`, async () => {
        const client = createFailingClient();
        const result = await classifyMessage(
          client,
          config,
          tc.message,
          tc.context?.previousCategory,
        );

        expect(result.category).toBe(tc.expected);

        // Verify the layer that made the decision
        if (tc.layer === 'override') {
          expect(result.confidence).toBe('keyword'); // pre-model overrides report as 'keyword'
        } else if (tc.layer === 'keyword') {
          expect(result.confidence).toBe('keyword');
        } else if (tc.layer === 'sticky') {
          expect(result.confidence).toBe('sticky');
        } else if (tc.layer === 'fallback') {
          expect(result.confidence).toBe('fallback');
        }
      });
    }
  });

  // Group 2: Model-dependent — mock client returns expected category
  const modelCases = corpus.filter(c => c.layer === 'model');

  if (modelCases.length > 0) {
    describe('Model-dependent (mock)', () => {
      for (const tc of modelCases) {
        it(`[model] "${tc.message.slice(0, 60)}${tc.message.length > 60 ? '...' : ''}" → ${tc.expected}`, async () => {
          const client = createMockClient(tc.expected);
          const result = await classifyMessage(
            client,
            config,
            tc.message,
            tc.context?.previousCategory,
          );

          expect(result.category).toBe(tc.expected);
          expect(result.confidence).toBe('model');
        });
      }
    });
  }

  // Summary stats
  it('corpus coverage', () => {
    const layers = new Map<string, number>();
    const categories = new Map<string, number>();
    for (const tc of corpus) {
      layers.set(tc.layer, (layers.get(tc.layer) ?? 0) + 1);
      categories.set(tc.expected, (categories.get(tc.expected) ?? 0) + 1);
    }

    console.log(`\n  Routing eval corpus: ${corpus.length} cases`);
    console.log(`  Layers: ${[...layers.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`  Categories: ${[...categories.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

    // Ensure minimum coverage
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    expect(layers.size).toBeGreaterThanOrEqual(4); // override, keyword, sticky, fallback
    expect(categories.size).toBeGreaterThanOrEqual(8); // at least 8 of 15 categories covered
  });
});

import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from '../../src/pipeline/executor.js';
import type { PipelineContext, PipelineDefinition } from '../../src/pipeline/types.js';

function baseCtx(onProgress: (note: string) => void): PipelineContext {
  return {
    userMessage: 'hi',
    params: {},
    stageResults: {},
    steps: [],
    client: {} as any,
    executor: (async () => '') as any,
    toolContext: { agentId: 'a', sessionKey: 's' },
    model: 'test',
    onProgress,
  };
}

describe('pipeline progress emission', () => {
  it('fires onProgress only for labeled stages, in order', async () => {
    const notes: string[] = [];
    const def: PipelineDefinition = {
      name: 'test',
      stages: [
        { name: 's1', type: 'code', progressLabel: '› First…', execute: () => undefined },
        { name: 's2', type: 'code', execute: () => undefined }, // unlabeled — silent
        { name: 's3', type: 'code', progressLabel: '› Second…', execute: () => undefined },
      ],
    };
    await runPipeline(def, baseCtx(n => notes.push(n)));
    expect(notes).toEqual(['› First…', '› Second…']);
  });

  it('does not fire for a labeled stage skipped by when=false', async () => {
    const notes: string[] = [];
    const def: PipelineDefinition = {
      name: 'test',
      stages: [
        { name: 'skipped', type: 'code', progressLabel: '› Should not show…', when: () => false, execute: () => undefined },
        { name: 'ran', type: 'code', progressLabel: '› Ran…', execute: () => undefined },
      ],
    };
    await runPipeline(def, baseCtx(n => notes.push(n)));
    expect(notes).toEqual(['› Ran…']);
  });

  it('a throwing onProgress does not break the pipeline', async () => {
    const def: PipelineDefinition = {
      name: 'test',
      stages: [
        { name: 's1', type: 'code', progressLabel: '› boom', execute: () => 'ok' },
      ],
    };
    const ctx = baseCtx(() => { throw new Error('channel down'); });
    ctx.answer = 'done';
    const result = await runPipeline(def, ctx);
    expect(result.answer).toBe('done');
  });
});

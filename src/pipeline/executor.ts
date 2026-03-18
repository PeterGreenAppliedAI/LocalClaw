import type {
  PipelineContext,
  PipelineStage,
  PipelineDefinition,
  PipelineResult,
} from './types.js';
import { extractParams } from './extractor.js';
import { pipelineStageError } from '../errors.js';

/**
 * Execute a single pipeline stage against the shared context.
 * Returns the stage result (stored in ctx.stageResults[stage.name]).
 */
async function executeStage(stage: PipelineStage, ctx: PipelineContext): Promise<unknown> {
  // Check skip condition
  if (stage.when && !stage.when(ctx)) {
    console.log(`[Pipeline] Skipping stage "${stage.name}" (when=false)`);
    return undefined;
  }

  console.log(`[Pipeline] Running stage "${stage.name}" (${stage.type})`);

  switch (stage.type) {
    case 'extract': {
      const params = await extractParams(
        ctx.client,
        ctx.model,
        stage.schema,
        ctx.userMessage,
        stage.examples,
      );
      // Merge extracted params into ctx.params
      Object.assign(ctx.params, params);
      return params;
    }

    case 'tool': {
      const params = stage.resolveParams(ctx);
      const observation = await ctx.executor(stage.tool, params, ctx.toolContext);
      ctx.steps.push({ tool: stage.tool, params, observation });
      return observation;
    }

    case 'llm': {
      const { system, user } = stage.buildPrompt(ctx);
      const messages: import('../ollama/types.js').OllamaMessage[] = [
        { role: 'system', content: system },
        ...(ctx.history ?? []),
        { role: 'user', content: user },
      ];
      const chatParams = {
        model: ctx.model,
        messages,
        options: {
          temperature: stage.temperature ?? 0.5,
          num_predict: stage.maxTokens ?? 2048,
        },
      };
      const response = stage.stream && ctx.onStream
        ? await ctx.client.chatStream(chatParams, ctx.onStream)
        : await ctx.client.chat(chatParams);
      const content = response.message?.content ?? '';
      // If this is the last stage-ish, also set answer
      ctx.answer = content;
      return content;
    }

    case 'code': {
      return await stage.execute(ctx);
    }

    case 'branch': {
      const branchKey = stage.decide(ctx);
      const subStages = stage.branches[branchKey];
      if (!subStages) {
        console.warn(`[Pipeline] Branch "${stage.name}" has no handler for key "${branchKey}"`);
        return undefined;
      }
      console.log(`[Pipeline] Branch "${stage.name}" → "${branchKey}" (${subStages.length} stages)`);
      return await executeStages(subStages, ctx);
    }

    case 'loop': {
      let iteration = 0;
      let lastResult: unknown;
      while (iteration < stage.maxIterations && !ctx.abort) {
        ctx.loopIndex = iteration;
        if (iteration > 0 && !stage.continueIf(ctx, iteration)) break;
        lastResult = await executeStages(stage.stages, ctx);
        iteration++;
      }
      ctx.loopIndex = undefined;
      return lastResult;
    }

    case 'parallel_tool': {
      const paramsList = stage.resolveParamsList(ctx);
      console.log(`[Pipeline] Parallel "${stage.name}": ${paramsList.length} concurrent ${stage.tool} calls`);
      const results = await Promise.all(
        paramsList.map(async (params) => {
          const observation = await ctx.executor(stage.tool, params, ctx.toolContext);
          ctx.steps.push({ tool: stage.tool, params, observation });
          return observation;
        }),
      );
      return results;
    }

    default: {
      const _exhaustive: never = stage;
      throw pipelineStageError((stage as any).name, new Error(`Unknown stage type: ${(stage as any).type}`));
    }
  }
}

/**
 * Execute a sequence of stages, storing each result in ctx.stageResults.
 * Stops early if ctx.abort is set.
 */
async function executeStages(stages: PipelineStage[], ctx: PipelineContext): Promise<unknown> {
  let lastResult: unknown;
  for (const stage of stages) {
    if (ctx.abort) break;
    try {
      const result = await executeStage(stage, ctx);
      ctx.stageResults[stage.name] = result;
      lastResult = result;
    } catch (err) {
      throw pipelineStageError(stage.name, err);
    }
  }
  return lastResult;
}

/**
 * Run a full pipeline definition against a context.
 * Returns the pipeline result with answer, step log, and iteration metadata.
 */
export async function runPipeline(
  definition: PipelineDefinition,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  console.log(`[Pipeline] Starting "${definition.name}" (${definition.stages.length} stages)`);

  await executeStages(definition.stages, ctx);

  const answer = ctx.answer ?? '';
  console.log(`[Pipeline] Finished "${definition.name}" — answer length: ${answer.length}`);

  return {
    answer,
    iterations: ctx.steps.length + 1,
    hitMaxIterations: false,
    steps: ctx.steps,
  };
}

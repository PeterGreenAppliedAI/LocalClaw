import type { PipelineDefinition, PipelineContext } from '../types.js';

/**
 * Plan pipeline — decomposes a complex goal into executable steps,
 * runs each step using available tools, verifies results, and adapts.
 *
 * Flow:
 *   1. LLM generates a step-by-step plan as JSON
 *   2. Loop executes each step dynamically (calling tools via ctx.executor)
 *   3. After each step, result is checked and next step is picked
 *   4. LLM summarizes what was accomplished
 */

const PLAN_PROMPT = `You are a task planner. Given the user's goal, create a concrete step-by-step plan.

Available tools you can use in your plan:
- web_search: Search the internet. Params: { query: string }
- web_fetch: Fetch a URL and extract text. Params: { url: string }
- browser: Interactive browser control. Params: { action: "open"|"navigate"|"snapshot"|"click"|"type"|"select", url?, ref?, text? }
  Workflow: open → navigate to URL → snapshot (see numbered elements) → click/type/select by number → snapshot (verify)
- memory_save: Save information. Params: { content: string }
- memory_search: Search saved info. Params: { query: string }
- send_message: Send a message. Params: { channel: string, channelId: string, text: string }
- exec: Run a shell command. Params: { command: string }
- task_add: Create a task. Params: { title: string, priority?: string, dueDate?: string }
- task_list: List tasks. Params: {}

IMPORTANT RULES:
- Each step must have: tool (tool name), params (object), purpose (what this achieves)
- For browser interactions, you MUST include a snapshot step AFTER navigating to see the page elements before interacting
- Be specific with search queries — not generic
- If a step requires information from a previous step, note it in the purpose field with "USES: step N result"
- Keep plans to 10 steps or fewer — do the minimum needed
- For form filling, plan: navigate → snapshot → type into fields → click submit → snapshot to verify

Return ONLY a JSON array of steps. No explanation. Example:
[
  {"tool": "web_search", "params": {"query": "Long Island tech meetups 2026"}, "purpose": "Find meetup groups"},
  {"tool": "browser", "params": {"action": "open", "url": "https://meetup.com/find/?q=tech&location=Huntington+Station+NY"}, "purpose": "Browse Meetup.com listings"},
  {"tool": "browser", "params": {"action": "snapshot"}, "purpose": "See available meetup listings"},
  {"tool": "browser", "params": {"action": "click", "ref": "5"}, "purpose": "Click on first relevant meetup group"}
]`;

const REPLAN_PROMPT = `You are monitoring plan execution. A step just completed. Based on the result, decide what to do next.

If the step succeeded, return the next step from the original plan (adjusted if the result changes things).
If the step failed or returned unexpected results, return an adjusted step.
If the goal is achieved, return: {"done": true, "summary": "what was accomplished"}

Return ONLY a JSON object — either a step {"tool": "...", "params": {...}, "purpose": "..."} or {"done": true, "summary": "..."}`;

interface PlanStep {
  tool: string;
  params: Record<string, unknown>;
  purpose: string;
}

/**
 * Parse a JSON plan from LLM output. Tolerates markdown fences and surrounding text.
 */
function parsePlan(raw: string): PlanStep[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const arr = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (s: any) => s && typeof s.tool === 'string' && typeof s.params === 'object',
    );
  } catch {
    return [];
  }
}

/**
 * Parse a single step or done signal from LLM replan output.
 */
function parseReplanResponse(raw: string): { step?: PlanStep; done?: boolean; summary?: string } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  try {
    const obj = JSON.parse(jsonMatch[0]);
    if (obj.done) return { done: true, summary: obj.summary || '' };
    if (obj.tool && obj.params) return { step: obj as PlanStep };
    return {};
  } catch {
    return {};
  }
}

export const planPipeline: PipelineDefinition = {
  name: 'plan',
  stages: [
    // Stage 1: Generate the plan
    {
      name: 'generate_plan',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 2048,
      buildPrompt: (ctx) => ({
        system: PLAN_PROMPT,
        user: ctx.userMessage,
      }),
    },

    // Stage 2: Parse the plan into steps
    {
      name: 'parse_plan',
      type: 'code',
      execute: (ctx) => {
        const raw = ctx.stageResults.generate_plan as string;
        const steps = parsePlan(raw);
        if (steps.length === 0) {
          ctx.answer = 'I couldn\'t break that down into actionable steps. Could you be more specific about what you want me to do?';
          ctx.abort = true;
          return;
        }
        ctx.params._plan = steps;
        ctx.params._stepIndex = 0;
        ctx.params._results = [] as string[];
        console.log(`[Plan] Generated ${steps.length} steps`);
      },
    },

    // Stage 3: Execute steps in a loop
    {
      name: 'execute_steps',
      type: 'loop',
      maxIterations: 15,
      continueIf: (ctx) => {
        const plan = ctx.params._plan as PlanStep[];
        const stepIndex = ctx.params._stepIndex as number;
        return stepIndex < plan.length && !ctx.params._planDone;
      },
      stages: [
        // Pick and execute the current step
        {
          name: 'run_step',
          type: 'code',
          execute: async (ctx: PipelineContext) => {
            const plan = ctx.params._plan as PlanStep[];
            const stepIndex = ctx.params._stepIndex as number;
            const results = ctx.params._results as string[];

            if (stepIndex >= plan.length) {
              ctx.params._planDone = true;
              return;
            }

            const step = plan[stepIndex];
            console.log(`[Plan] Step ${stepIndex + 1}/${plan.length}: ${step.tool} — ${step.purpose}`);

            try {
              const observation = await ctx.executor(step.tool, step.params, ctx.toolContext);
              ctx.steps.push({ tool: step.tool, params: step.params, observation });
              results.push(`Step ${stepIndex + 1} (${step.tool}): ${step.purpose}\nResult: ${observation}`);
              ctx.params._lastResult = observation;
              ctx.params._lastSuccess = true;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              results.push(`Step ${stepIndex + 1} (${step.tool}): ${step.purpose}\nError: ${errMsg}`);
              ctx.params._lastResult = `Error: ${errMsg}`;
              ctx.params._lastSuccess = false;
            }

            ctx.params._stepIndex = stepIndex + 1;
          },
        },

        // After each step, ask LLM if we should adjust
        {
          name: 'check_progress',
          type: 'code',
          execute: async (ctx: PipelineContext) => {
            const plan = ctx.params._plan as PlanStep[];
            const stepIndex = ctx.params._stepIndex as number;
            const lastResult = ctx.params._lastResult as string;
            const lastSuccess = ctx.params._lastSuccess as boolean;

            // If we finished all steps, mark done
            if (stepIndex >= plan.length) {
              ctx.params._planDone = true;
              return;
            }

            // If step succeeded and next step is straightforward, just continue
            if (lastSuccess && stepIndex < plan.length) {
              return;
            }

            // Step failed — ask LLM to replan
            const remainingSteps = plan.slice(stepIndex).map((s, i) =>
              `${stepIndex + i + 1}. ${s.tool}: ${s.purpose}`,
            ).join('\n');

            const response = await ctx.client.chat({
              model: ctx.routerModel ?? ctx.model,
              messages: [
                { role: 'system', content: REPLAN_PROMPT },
                {
                  role: 'user',
                  content: `Goal: ${ctx.userMessage}\n\nLast step result: ${lastResult}\nSuccess: ${lastSuccess}\n\nRemaining planned steps:\n${remainingSteps}`,
                },
              ],
              options: { temperature: 0.2, num_predict: 512 },
            });

            const raw = response.message?.content ?? '';
            const replan = parseReplanResponse(raw);

            if (replan.done) {
              ctx.params._planDone = true;
              ctx.params._planSummary = replan.summary;
              return;
            }

            if (replan.step) {
              // Insert the adjusted step at the current position
              plan.splice(stepIndex, 0, replan.step);
              ctx.params._plan = plan;
            }
          },
        },
      ],
    },

    // Stage 4: Summarize results
    {
      name: 'summarize',
      type: 'llm',
      stream: true,
      temperature: 0.4,
      maxTokens: 2048,
      buildPrompt: (ctx) => {
        const results = ctx.params._results as string[];
        const planSummary = ctx.params._planSummary as string | undefined;

        return {
          system: `Summarize what you accomplished for the user. Be conversational and specific about what was done vs what couldn't be done. If there were failures, explain what happened and suggest alternatives. Don't list every step — focus on outcomes.`,
          user: `Goal: "${ctx.userMessage}"\n\n${planSummary ? `Plan summary: ${planSummary}\n\n` : ''}Step results:\n${results.join('\n\n')}`,
        };
      },
    },
  ],
};

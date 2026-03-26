import type { PipelineDefinition, PipelineContext } from '../types.js';

/**
 * Plan pipeline — decomposes a complex goal into executable steps,
 * runs each step using available tools, verifies results, and adapts.
 *
 * Flow:
 *   1. LLM generates a step-by-step plan as JSON
 *   2. Self-reflection — LLM critiques the plan for missing steps, bad ordering, etc.
 *   3. Loop executes each step dynamically (calling tools via ctx.executor)
 *   4. After each step, result is checked and next step is picked
 *   5. LLM summarizes what was accomplished
 */

const PLAN_PROMPT = `You are a task planner. Given the user's goal, create a concrete step-by-step plan.

Available tools you can use in your plan:
- web_search: Search the internet. Params: { query: string }
- web_fetch: Fetch a URL and extract text. Params: { url: string }
- browser: Interactive browser control with TWO modes:

  DOM mode (simple pages): Use "snapshot" to see numbered elements, "click"/"type"/"select" by number.
    Params: { action: "open"|"navigate"|"snapshot"|"click"|"type"|"select", url?, ref?, text? }

  Visual mode (JS-heavy pages, SPAs, dynamic sites): Use "visual_snapshot" to see the page through a vision model,
    then "visual_click"/"visual_type" by describing the element in plain language.
    Params: { action: "visual_snapshot"|"visual_click"|"visual_type", url?, target?, text? }

  PREFER VISUAL MODE for: Meetup, LinkedIn, Eventbrite, any modern website with dynamic content.
  Use DOM mode only for simple static pages.

- memory_save: Save information. Params: { content: string }
- memory_search: Search saved info. Params: { query: string }
- send_message: Send a message. Params: { channel: string, channelId: string, text: string }
- exec: Run a shell command. Params: { command: string }
- task_add: Create a task. Params: { title: string, priority?: string, dueDate?: string }
- task_list: List tasks. Params: {}

IMPORTANT RULES:
- Each step must have: tool (tool name), params (object), purpose (what this achieves)
- For browser interactions, you MUST include a visual_snapshot or snapshot step AFTER navigating to see the page before interacting
- For visual_click/visual_type, the "target" param describes the element in plain language (e.g., "Log in button", "Email input field", "Events tab in navigation")
- Be specific with search queries — not generic
- If a step requires information from a previous step, note it in the purpose field with "USES: step N result"
- Keep plans to 10 steps or fewer — do the minimum needed
- For form filling, plan: navigate → visual_snapshot → visual_type fields → visual_click submit → visual_snapshot to verify

Return ONLY a JSON array of steps. No explanation. Example:
[
  {"tool": "web_search", "params": {"query": "Long Island tech meetups 2026"}, "purpose": "Find meetup groups"},
  {"tool": "browser", "params": {"action": "open", "url": "https://meetup.com/find/?q=tech&location=Huntington+Station+NY"}, "purpose": "Browse Meetup.com listings"},
  {"tool": "browser", "params": {"action": "visual_snapshot"}, "purpose": "See available meetup listings"},
  {"tool": "browser", "params": {"action": "visual_click", "target": "First tech meetup group in results"}, "purpose": "Click on most relevant meetup"}
]`;

const REFLECT_PROMPT = `You are a plan reviewer. Critique the proposed plan below and suggest improvements.

Check for these common issues:
1. MISSING SNAPSHOT: Browser interactions MUST have a visual_snapshot or snapshot step AFTER navigation and BEFORE any click/type/select. The agent cannot interact with elements it hasn't seen.
2. WRONG ORDER: Steps that depend on previous results must come after those results are available.
3. UNREALISTIC: Steps that assume information not yet gathered (e.g., clicking element #5 before taking a snapshot to know what #5 is).
4. MISSING VERIFICATION: After form submission or important actions, there should be a visual_snapshot to verify success.
5. TOO VAGUE: Search queries should be specific, not generic like "find things".
6. MISSING STEPS: If the goal includes signing up, there must be form-filling steps (visual_type email, visual_click submit).
7. WRONG MODE: For modern JS-heavy sites (Meetup, LinkedIn, Eventbrite), use visual_click/visual_type instead of DOM-based click/type. Visual mode describes elements in natural language ("Log in button") instead of reference numbers.

Return a JSON object:
{
  "issues": ["list of problems found"],
  "revised_plan": [revised steps array if changes needed],
  "approved": true/false
}

If the plan is good, return: {"issues": [], "revised_plan": [], "approved": true}`;

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

    // Stage 3: Self-reflection — critique the plan before executing
    {
      name: 'reflect',
      type: 'code',
      execute: async (ctx: PipelineContext) => {
        const plan = ctx.params._plan as PlanStep[];
        const planJson = JSON.stringify(plan, null, 2);

        const response = await ctx.client.chat({
          model: ctx.routerModel ?? ctx.model,
          messages: [
            { role: 'system', content: REFLECT_PROMPT },
            { role: 'user', content: `Goal: "${ctx.userMessage}"\n\nProposed plan:\n${planJson}` },
          ],
          options: { temperature: 0.2, num_predict: 2048 },
        });

        const raw = response.message?.content ?? '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.log('[Plan] Reflection: no valid JSON, keeping original plan');
          return;
        }

        try {
          const reflection = JSON.parse(jsonMatch[0]);

          if (reflection.issues?.length > 0) {
            console.log(`[Plan] Reflection found ${reflection.issues.length} issue(s):`);
            for (const issue of reflection.issues) {
              console.log(`[Plan]   - ${issue}`);
            }
          }

          if (!reflection.approved && reflection.revised_plan?.length > 0) {
            const revised = (reflection.revised_plan as any[]).filter(
              (s: any) => s && typeof s.tool === 'string' && typeof s.params === 'object',
            );
            if (revised.length > 0) {
              ctx.params._plan = revised;
              console.log(`[Plan] Reflection revised plan: ${plan.length} → ${revised.length} steps`);
            }
          } else {
            console.log('[Plan] Reflection approved plan as-is');
          }
        } catch {
          console.log('[Plan] Reflection: failed to parse, keeping original plan');
        }
      },
    },

    // Stage 4: Execute steps in a loop
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

    // Stage 5: Summarize results
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

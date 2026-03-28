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
- browser: Interactive browser control. Params: { action, url?, ref?, text? }
    Actions:
    - "open": Launch browser and optionally navigate. Params: { action: "open", url?: string }
    - "navigate": Go to a URL. Params: { action: "navigate", url: string }
    - "snapshot": See the page with numbered interactive elements. Params: { action: "snapshot" }
    - "text_content": Read all visible text on the page (best for reading content on modern sites). Params: { action: "text_content" }
    - "click": Click an element by number from snapshot OR by text description. Params: { action: "click", ref: string }
      ref can be: "3" (element number), "#submit-btn" (CSS selector), or "Events tab" (text description — auto-escalates to visual mode if DOM fails)
    - "type": Type into a field by number or description. Params: { action: "type", ref: string, text: string }
    - "select": Select dropdown option. Params: { action: "select", ref: string, text: string }

- memory_save: Save information. Params: { content: string }
- memory_search: Search saved info. Params: { query: string }
- exec: Run a shell command. Params: { command: string }
- task_add: Create a task on the USER'S LOCAL TASK LIST (not on a website). Params: { title: string, priority?: string, dueDate?: string }
- task_list: List tasks from the user's local task list. Params: {}

RULES:
- Each step must have: tool (tool name), params (object), purpose (what this achieves)
- DO NOT include send_message steps. The user automatically receives your final summary.
- When the user says "add to my task list", use the task_add TOOL — do NOT click a website button. The task list is LOCAL.
- After navigating, use "snapshot" to see interactive elements OR "text_content" to read page text.
- Use "text_content" when you need to READ content (event names, search results, article text).
- Use "snapshot" when you need to SEE interactive elements to click/type.
- For click/type: use element numbers from snapshot when available, text descriptions when not (e.g., "Events tab", "Search button").
- Be specific with search queries — not generic.
- CRITICAL: task_add title must use REAL data from the page — never placeholders like "Attend event". Use text_content to read the actual names/dates first.
- FILTERING: Do NOT blindly pick the first search result. Read results with text_content, then pick the most relevant one.
- Keep plans to 10 steps or fewer.

Return ONLY a JSON array of steps. No explanation. Example:
[
  {"tool": "browser", "params": {"action": "open", "url": "https://eventbrite.com"}, "purpose": "Navigate to Eventbrite"},
  {"tool": "browser", "params": {"action": "type", "ref": "Search events input", "text": "tech events Huntington Station NY"}, "purpose": "Enter search query"},
  {"tool": "browser", "params": {"action": "click", "ref": "Search button"}, "purpose": "Execute search"},
  {"tool": "browser", "params": {"action": "text_content"}, "purpose": "Read search results to find most relevant tech event"},
  {"tool": "task_add", "params": {"title": "USES: event name from step 4", "dueDate": "USES: date from step 4"}, "purpose": "Add the most relevant event to task list"}
]`;

const REFLECT_PROMPT = `You are a plan reviewer. Critique the proposed plan below and suggest improvements.

Check for these common issues:
1. MISSING SNAPSHOT: Browser interactions MUST have a snapshot or text_content step AFTER navigation and BEFORE any click/type. The agent cannot interact with elements it hasn't seen.
2. WRONG ORDER: Steps that depend on previous results must come after those results are available.
3. UNREALISTIC: Steps that assume information not yet gathered (e.g., clicking element #5 before taking a snapshot).
4. MISSING CONTENT READ: Before creating a task or saving to memory, there should be a text_content step to read the actual page content (event names, dates, etc.).
5. TOO VAGUE: Search queries should be specific, not generic like "find things".
6. GENERIC DATA: If task_add uses a placeholder title like "Attend event" instead of referencing real data from a text_content step, flag it.
7. NO FILTERING: If the plan picks the first search result without reading and evaluating results, flag it. There should be a text_content step followed by task_add using the most relevant result.
8. UNNECESSARY STEPS: Don't navigate to event detail pages just to read the name — text_content on the search results page usually has enough info. Keep it simple.
9. SEND_MESSAGE: Plans should NOT include send_message steps. The user receives the summary automatically.

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
        user: `Today's date: ${new Date().toISOString().split('T')[0]}\n\nGoal: ${ctx.userMessage}`,
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

            let step = plan[stepIndex];
            console.log(`[Plan] Step ${stepIndex + 1}/${plan.length}: ${step.tool} — ${step.purpose}`);

            // Cache text_content results for smart selection and param resolution
            if (step.tool === 'browser' && step.params.action === 'text_content') {
              // The text_content result will be stored in stageResults after execution.
              // We also cache it in _lastPageText for downstream use.
              // (The actual caching happens after execution below)
            }

            // Intelligent selection: when a step is about picking/clicking a result from
            // a list (search results, event listings), use the DOM snapshot + LLM to find
            // the most relevant item instead of blindly clicking the first one.
            const isSelectionStep = step.tool === 'browser'
              && step.params.action === 'click'
              && /first|select|pick|choose|relevant|best|result|navigate.*event|navigate.*detail/i.test(step.purpose);
            if (isSelectionStep) {
              // Use cached page text from a previous text_content step, or grab fresh
              let domSnapshot = ctx.params._lastPageText as string | undefined;
              if (!domSnapshot || domSnapshot.length < 200) {
                try {
                  domSnapshot = await ctx.executor('browser', { action: 'text_content' }, ctx.toolContext);
                  ctx.params._lastPageText = domSnapshot;
                  console.log(`[Plan] Smart selection: fresh text grab (${domSnapshot.length} chars)`);
                } catch {
                  // no text available
                }
              } else {
                console.log(`[Plan] Smart selection: using cached text (${domSnapshot.length} chars)`);
              }
            if (domSnapshot) {
              try {
                const selectResponse = await ctx.client.chat({
                  model: ctx.routerModel ?? ctx.model,
                  messages: [
                    {
                      role: 'system',
                      content: `You are selecting the most relevant CONTENT ITEM (event, article, listing, job, result) from a web page. The user's original goal was: "${ctx.userMessage}"\n\nIMPORTANT: Pick an actual content item (event name, listing title, search result) — NOT a navigation button, search bar, or UI element like "Search events" or "Log in".\n\nLook at the page content below and find the content item that BEST matches what the user is looking for. Return ONLY a JSON object:\n{"target": "exact text of the content item to click (e.g., event name, listing title)", "reason": "why this is the best match"}`,
                    },
                    {
                      role: 'user',
                      content: domSnapshot.slice(0, 4000),
                    },
                  ],
                  options: { temperature: 0.1, num_predict: 256 },
                });
                const raw = selectResponse.message?.content ?? '';
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const selection = JSON.parse(jsonMatch[0]);
                  if (selection.target) {
                    step = { ...step, params: { ...step.params, target: selection.target } };
                    console.log(`[Plan] Smart selection: "${selection.target}" — ${selection.reason}`);
                  }
                }
              } catch {
                console.log('[Plan] Smart selection failed, using original target');
              }
            }
            }

            // Dynamic param resolution: for steps that consume page content
            // (task_add, memory_save), ask the LLM to fill in concrete details
            // from the accumulated results so far.
            const needsResolution = ['task_add', 'memory_save'].includes(step.tool)
              && results.length > 0;
            if (needsResolution) {
              try {
                const recentResults = results.slice(-3).join('\n\n');
                // Use cached page text if available, otherwise try to grab fresh
                let pageText = ctx.params._lastPageText as string | undefined;
                if (!pageText || pageText.length < 100) {
                  try {
                    pageText = await ctx.executor('browser', { action: 'text_content' }, ctx.toolContext);
                  } catch { /* browser may be closed */ }
                }
                const domContext = pageText && pageText.length > 100
                  ? `\n\nPage text content:\n${pageText.slice(0, 3000)}`
                  : '';
                const resolveResponse = await ctx.client.chat({
                  model: ctx.routerModel ?? ctx.model,
                  messages: [
                    {
                      role: 'system',
                      content: `You are filling in tool parameters with REAL data from previous step results. Given the step's purpose and recent results, return a JSON object with the correct params. Use SPECIFIC names, dates, titles, and URLs from the results — NEVER use generic placeholders.\n\nToday's date is ${new Date().toISOString().split('T')[0]}. All dates should be in the current year unless explicitly stated otherwise. Use YYYY-MM-DD format for dates.\n\nTool: ${step.tool}\nOriginal params: ${JSON.stringify(step.params)}\nPurpose: ${step.purpose}`,
                    },
                    {
                      role: 'user',
                      content: `Recent step results:\n${recentResults}${domContext}`,
                    },
                  ],
                  options: { temperature: 0.1, num_predict: 256 },
                });
                const raw = resolveResponse.message?.content ?? '';
                const jsonMatch = raw.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const resolved = JSON.parse(jsonMatch[0]);
                  if (resolved && typeof resolved === 'object') {
                    step = { ...step, params: { ...step.params, ...resolved } };
                    console.log(`[Plan] Resolved params for ${step.tool}: ${JSON.stringify(resolved)}`);
                  }
                }
              } catch {
                console.log(`[Plan] Param resolution failed for ${step.tool}, using original params`);
              }
            }

            try {
              const observation = await ctx.executor(step.tool, step.params, ctx.toolContext);
              ctx.steps.push({ tool: step.tool, params: step.params, observation });
              results.push(`Step ${stepIndex + 1} (${step.tool}): ${step.purpose}\nResult: ${observation}`);
              ctx.params._lastResult = observation;
              ctx.params._lastSuccess = true;

              // Cache text_content results for smart selection and param resolution
              if (step.tool === 'browser' && step.params.action === 'text_content') {
                ctx.params._lastPageText = observation;
              }
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

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
- CRITICAL: When creating tasks, saving memory, or reporting to the user, use SPECIFIC information extracted from the page — event names, dates, times, URLs. NEVER use generic placeholders like "Attend event" or "Review opportunity". The visual_snapshot result contains the actual page content — reference it in subsequent steps.
- For "find X and add to task list" goals: visual_snapshot the page → read the ACTUAL event/item name and date from the snapshot → use those exact details in the task_add title and dueDate params
- FILTERING: When search results are shown, do NOT blindly pick the first result. Evaluate results against the user's original query and pick the MOST RELEVANT one. For example, if the user asked for "tech events" and the first result is "Pickleball Heaven", skip it and find an actual tech event. Include a purpose like "FILTER: pick most relevant tech event from results" in the step.

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
8. GENERIC DATA: If task_add or memory_save uses a vague placeholder title like "Attend event" or "Review opportunity" instead of actual data from the page, flag it. The plan must extract real details (names, dates, URLs) from visual_snapshot results before creating tasks.
9. NO FILTERING: If the plan clicks the first search result without evaluating whether it matches the user's query, flag it. There should be a step that reads the results and picks the most relevant one based on the user's original request.

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

            let step = plan[stepIndex];
            console.log(`[Plan] Step ${stepIndex + 1}/${plan.length}: ${step.tool} — ${step.purpose}`);

            // Hybrid snapshot: when the plan calls visual_snapshot for reading/extracting
            // content (not just navigation verification), also run a DOM snapshot to get
            // the actual text. Visual mode sees layout; DOM mode reads text.
            const isReadingSnapshot = step.tool === 'browser'
              && step.params.action === 'visual_snapshot'
              && /extract|read|identify|find|detail|list|content|event|result|search/i.test(step.purpose);
            if (isReadingSnapshot) {
              try {
                // Use text_content (innerText) instead of DOM snapshot — on SPAs the DOM
                // tree has unrendered template variables while innerText returns the actual
                // visible rendered text after JavaScript runs.
                const textResult = await ctx.executor('browser', { action: 'text_content' }, ctx.toolContext);
                ctx.params._lastDomSnapshot = textResult;
                console.log(`[Plan] Hybrid snapshot: added rendered text (${textResult.length} chars) for content extraction`);
              } catch {
                console.log('[Plan] Hybrid snapshot: text extraction failed, continuing with visual only');
              }
            }

            // Intelligent selection: when a step is about picking/clicking a result from
            // a list (search results, event listings), use the DOM snapshot + LLM to find
            // the most relevant item instead of blindly clicking the first one.
            const isSelectionStep = step.tool === 'browser'
              && (step.params.action === 'visual_click' || step.params.action === 'click')
              && /first|select|pick|choose|relevant|best|result|navigate.*event|navigate.*detail/i.test(step.purpose);
            if (isSelectionStep) {
              // Always grab fresh rendered text at selection time — cached snapshots
              // may be stale (SPA hadn't loaded results yet when earlier snapshot ran)
              let domSnapshot: string | undefined;
              try {
                domSnapshot = await ctx.executor('browser', { action: 'text_content' }, ctx.toolContext);
                console.log(`[Plan] Smart selection: fresh text grab (${domSnapshot.length} chars)`);
              } catch {
                domSnapshot = ctx.params._lastDomSnapshot as string | undefined;
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
                // Grab fresh rendered text for param resolution — cached may be stale
                let freshText = '';
                try {
                  freshText = await ctx.executor('browser', { action: 'text_content' }, ctx.toolContext);
                } catch { /* browser may be closed */ }
                const domContext = freshText.length > 100
                  ? `\n\nCurrent page text content:\n${freshText.slice(0, 3000)}`
                  : '';
                const resolveResponse = await ctx.client.chat({
                  model: ctx.routerModel ?? ctx.model,
                  messages: [
                    {
                      role: 'system',
                      content: `You are filling in tool parameters with REAL data from previous step results. Given the step's purpose and recent results, return a JSON object with the correct params. Use SPECIFIC names, dates, titles, and URLs from the results — NEVER use generic placeholders.\n\nTool: ${step.tool}\nOriginal params: ${JSON.stringify(step.params)}\nPurpose: ${step.purpose}`,
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

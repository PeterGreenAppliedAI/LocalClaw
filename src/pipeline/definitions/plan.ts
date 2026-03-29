import type { PipelineDefinition, PipelineContext } from '../types.js';
import { SkillStore } from '../../skills/store.js';
import { findMatchingSkill } from '../../skills/matcher.js';

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

const PLAN_PROMPT = `You are a task decomposer. Break the user's goal into concrete executable steps using the available tools. Choose the SIMPLEST tools that get the job done — don't use the browser when web_search or web_fetch would work.

Available tools:
- web_search: Search the internet. Fast, no browser needed. Params: { query: string }
- web_fetch: Fetch a URL and extract text content. Fast, no browser needed. Params: { url: string }
- browser: Interactive browser for sites that REQUIRE clicking, typing, or form filling. ONLY use when web_search/web_fetch can't do the job (e.g., signing up, filling forms, navigating SPAs).
    Actions: "open", "navigate", "snapshot", "text_content", "click", "type", "select"
    For click/type: use element numbers from snapshot, CSS selectors, or text descriptions.
- memory_save: Save information for later. Params: { content: string }
- memory_search: Search saved info. Params: { query: string }
- task_add: Add to user's LOCAL task list. Params: { title: string, priority?: string, dueDate?: string }
- task_list: Show current tasks. Params: {}
- cron_add: Schedule a recurring job. Params: { name, schedule, category, message, channel, target }
- cron_list: Show scheduled jobs. Params: {}
- exec: Run a shell command. Params: { command: string }
- code_session: Run code in a persistent REPL session (Python, Node, or Bash). Params: { action: "start"|"run"|"stop", session?: string, runtime?: "python"|"node"|"bash", code?: string }
  Use for: data processing, scraping scripts, analysis, file generation, anything that needs code execution.
  Start a session first, then run code in it. Sessions persist between steps.
- write_file: Write content to a file. Params: { path: string, content: string }
- read_file: Read a file. Params: { path: string }

TOOL SELECTION GUIDE:
- "Find info about X" → web_search (fast, reliable)
- "What's on this website" → web_fetch with the URL (fast, no browser)
- "Research X and give me a summary" → web_search + web_fetch (parallel fetches)
- "Go to X site and sign up" → browser (needs interaction)
- "Fill out this form" → browser (needs typing/clicking)
- "Search X site and add to tasks" → browser (site-specific search) + task_add
- "Schedule a daily X" → cron_add
- "Remember that X" → memory_save
- "Find X and schedule weekly updates" → web_search + cron_add (decomposed)

RULES:
- Each step: { tool, params, purpose }
- Choose the CHEAPEST tool that works. web_search > web_fetch > browser.
- Only use task_add when user EXPLICITLY asked to add to their task list.
- Only use browser when the task genuinely requires clicking, typing, or navigating a site interactively.
- DO NOT include send_message steps. User receives your summary automatically.
- Keep plans to 10 steps or fewer.
- Be specific with search queries.
- LINKS: Always capture URLs. Final summary MUST include links so the user can go there directly.
- task_add titles must use REAL data — never placeholders.

Return ONLY a JSON array of steps. No explanation.

Example 1 — information gathering (no browser needed):
[
  {"tool": "web_search", "params": {"query": "top AI news today March 2026"}, "purpose": "Find current AI headlines"},
  {"tool": "web_fetch", "params": {"url": "USES: top result URL from step 1"}, "purpose": "Read the full article"}
]

Example 2 — compound task with scheduling:
[
  {"tool": "web_search", "params": {"query": "AI news sources daily digest"}, "purpose": "Find best AI news aggregators"},
  {"tool": "cron_add", "params": {"name": "Daily AI News", "schedule": "0 16 * * *", "category": "web_search", "message": "Search for top 10 AI news stories today and summarize"}, "purpose": "Schedule daily 4pm news digest"}
]

Example 3 — site interaction (browser needed):
[
  {"tool": "browser", "params": {"action": "open", "url": "https://eventbrite.com"}, "purpose": "Navigate to Eventbrite"},
  {"tool": "browser", "params": {"action": "type", "ref": "Search events input", "text": "tech events Huntington Station NY"}, "purpose": "Enter search query"},
  {"tool": "browser", "params": {"action": "click", "ref": "Search button"}, "purpose": "Execute search"},
  {"tool": "browser", "params": {"action": "text_content"}, "purpose": "Read search results"}
]

Example 4 — add to task list (user explicitly asked):
[
  {"tool": "web_search", "params": {"query": "tech meetups Huntington Station NY"}, "purpose": "Find upcoming tech meetups"},
  {"tool": "task_add", "params": {"title": "USES: meetup name from step 1", "dueDate": "USES: date from step 1"}, "purpose": "Add meetup to task list (user requested)"}
]

Example 5 — data processing with code:
[
  {"tool": "web_search", "params": {"query": "top 10 AI companies by funding 2026"}, "purpose": "Find AI company data"},
  {"tool": "web_fetch", "params": {"url": "USES: best source URL from step 1"}, "purpose": "Get detailed funding data"},
  {"tool": "code_session", "params": {"action": "start", "session": "analysis", "runtime": "python"}, "purpose": "Start Python session for data processing"},
  {"tool": "code_session", "params": {"action": "run", "session": "analysis", "code": "USES: Python script to parse and analyze data from step 2"}, "purpose": "Process and analyze the data"},
  {"tool": "write_file", "params": {"path": "USES: output filename", "content": "USES: processed results"}, "purpose": "Save results to file"}
]`;

const REFLECT_PROMPT = `You are a plan reviewer. Critique the proposed plan below and suggest improvements.

Check for these common issues:
1. OVERKILL TOOL: If the plan uses browser when web_search or web_fetch would work, flag it. Browser is expensive and slow — only use it when the task requires clicking, typing, or form interaction. "Find information" = web_search. "Read a page" = web_fetch.
2. MISSING SNAPSHOT: Browser click/type MUST have a snapshot or text_content step first. The agent can't interact with elements it hasn't seen.
3. WRONG ORDER: Steps that depend on previous results must come after those results.
4. UNREALISTIC: Steps that assume information not yet gathered.
5. TOO VAGUE: Search queries should be specific.
6. GENERIC DATA: task_add with placeholder titles like "Attend event" instead of real data.
7. NO FILTERING: Picking the first result without evaluating relevance.
8. UNNECESSARY TASK: task_add when user didn't explicitly ask to add to their task list. "Find X" should just present results, not create tasks.
9. SEND_MESSAGE: Plans should NOT include send_message steps.
10. TOO MANY STEPS: If the plan can be done in fewer steps with simpler tools, simplify it.

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
    // Stage 0: Check for matching skill before generating a new plan
    {
      name: 'skill_check',
      type: 'code',
      execute: (ctx) => {
        const workspacePath = ctx.toolContext.workspacePath;
        if (!workspacePath) return;

        try {
          const store = new SkillStore(workspacePath);
          const match = findMatchingSkill(store, ctx.userMessage);
          if (match) {
            const skill = store.get(match.slug);
            if (skill && skill.steps.length > 0) {
              ctx.params._skillMatch = match;
              ctx.params._skillSteps = skill.steps;
              ctx.params._skillNotes = skill.notes;
              ctx.params._skillSlug = match.slug;
              console.log(`[Plan] Skill match: "${skill.name}" (${skill.successCount} successes) — using saved plan`);

              // Track skill reuse in metrics
              if (ctx.metricsCollector) {
                ctx.metricsCollector.planSource = 'saved_skill';
                ctx.metricsCollector.skillSlug = match.slug;
                ctx.metricsCollector.skillMatchScore = match.score;
              }
            }
          }
        } catch {
          // No skills directory or read error — continue with LLM planning
        }
      },
    },

    // Stage 1: Generate the plan (skipped if skill matched)
    {
      name: 'generate_plan',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 2048,
      // Skip if a skill was matched — use the saved steps instead
      when: (ctx) => !ctx.params._skillSteps,
      buildPrompt: (ctx) => ({
        system: PLAN_PROMPT,
        user: `Today's date: ${new Date().toISOString().split('T')[0]}\n\nGoal: ${ctx.userMessage}`,
      }),
    },

    // Stage 2: Parse the plan into steps (or use skill steps)
    {
      name: 'parse_plan',
      type: 'code',
      execute: (ctx) => {
        // Use skill steps if available, otherwise parse LLM output
        const skillSteps = ctx.params._skillSteps as PlanStep[] | undefined;
        if (skillSteps && skillSteps.length > 0) {
          ctx.params._plan = skillSteps;
          ctx.params._stepIndex = 0;
          ctx.params._results = [] as string[];
          const notes = ctx.params._skillNotes as string[] | undefined;
          if (notes && notes.length > 0) {
            console.log(`[Plan] Skill notes: ${notes.join('; ')}`);
          }
          console.log(`[Plan] Using saved skill: ${skillSteps.length} steps`);
          return;
        }

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
            if (ctx.metricsCollector) {
              ctx.metricsCollector.reflectionIssueCount = reflection.issues.length;
            }
          }

          if (!reflection.approved && reflection.revised_plan?.length > 0) {
            const revised = (reflection.revised_plan as any[]).filter(
              (s: any) => s && typeof s.tool === 'string' && typeof s.params === 'object',
            );
            if (revised.length > 0) {
              ctx.params._plan = revised;
              console.log(`[Plan] Reflection revised plan: ${plan.length} → ${revised.length} steps`);
              if (ctx.metricsCollector) {
                ctx.metricsCollector.reflectionRevisedPlan = true;
              }
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
                    if (ctx.metricsCollector) {
                      ctx.metricsCollector.smartSelectionUsed = true;
                      ctx.metricsCollector.smartSelectionTarget = selection.target;
                    }
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
                    if (ctx.metricsCollector) ctx.metricsCollector.paramResolutionCount++;
                  }
                }
              } catch {
                console.log(`[Plan] Param resolution failed for ${step.tool}, using original params`);
              }
            }

            const stepStart = Date.now();
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

              // Track step metrics + browser mode detection
              const isClick = step.tool === 'browser' && (step.params.action === 'click' || step.params.action === 'type');
              const wasEscalated = isClick && observation.includes('coordinates');
              if (isClick && ctx.metricsCollector) {
                if (wasEscalated) {
                  ctx.metricsCollector.trackVisualEscalation(true);
                } else {
                  ctx.metricsCollector.trackDomClick(true);
                }
              }
              ctx.metricsCollector?.trackStep({
                index: stepIndex,
                tool: step.tool,
                purpose: step.purpose,
                resultClass: observation.length > 0 ? 'success' : 'empty',
                escalated: wasEscalated,
                durationMs: Date.now() - stepStart,
                observation,
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              results.push(`Step ${stepIndex + 1} (${step.tool}): ${step.purpose}\nError: ${errMsg}`);
              ctx.params._lastResult = `Error: ${errMsg}`;
              ctx.params._lastSuccess = false;

              // Track failed step
              ctx.metricsCollector?.trackStep({
                index: stepIndex,
                tool: step.tool,
                purpose: step.purpose,
                resultClass: 'error',
                durationMs: Date.now() - stepStart,
                observation: errMsg,
              });
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
          system: `Summarize what you accomplished for the user. Be conversational and specific about what was done vs what couldn't be done. If there were failures, explain what happened and suggest alternatives. Don't list every step — focus on outcomes.

IMPORTANT RULES:
- ALWAYS include relevant URLs/links in your response. If you visited a page or found an article/event, include the link so the user can go there directly.
- Format links as: [Title](URL) or just include the URL inline.
- If the browser was on a page, the URL is in the step results (look for "Page:" or "URL:" or "Navigated to").`,
          user: `Goal: "${ctx.userMessage}"\n\n${planSummary ? `Plan summary: ${planSummary}\n\n` : ''}Step results:\n${results.join('\n\n')}`,
        };
      },
    },

    // Stage 6: Save as skill if successful
    {
      name: 'skill_save',
      type: 'code',
      execute: async (ctx: PipelineContext) => {
        const workspacePath = ctx.toolContext.workspacePath;
        if (!workspacePath) return;

        const plan = ctx.params._plan as PlanStep[] | undefined;
        const results = ctx.params._results as string[] | undefined;
        if (!plan || !results || plan.length < 3) return;

        // Check if we already used a saved skill — if so, just record success
        const skillSlug = ctx.params._skillSlug as string | undefined;
        if (skillSlug) {
          try {
            const store = new SkillStore(workspacePath);
            store.recordSuccess(skillSlug);
            console.log(`[Plan] Recorded skill success: ${skillSlug}`);
          } catch { /* ignore */ }
          return;
        }

        // Count failures — only save if mostly successful
        const failCount = results.filter(r => r.includes('Error:')).length;
        const successRate = 1 - (failCount / results.length);
        if (successRate < 0.6) {
          console.log(`[Plan] Skipping skill save — success rate too low (${Math.round(successRate * 100)}%)`);
          return;
        }

        // Extract learned notes from execution
        const notes: string[] = [];
        for (const r of results) {
          if (r.includes('Escalating to visual mode')) notes.push('Some elements need visual mode fallback');
          if (r.includes('text_content')) notes.push('Use text_content for reading SPA content');
          if (r.includes('Smart selection')) notes.push('Smart selection needed for picking relevant results');
        }

        try {
          const store = new SkillStore(workspacePath);

          // Use LLM to generalize the skill into a reusable pattern
          // instead of saving the raw user message as the description
          const toolSequence = plan.map(s => s.tool).join(' → ');
          const generalizeResponse = await ctx.client.chat({
            model: ctx.routerModel ?? ctx.model,
            messages: [
              {
                role: 'system',
                content: `You are naming a reusable workflow pattern. Given the user's specific request and the tools used, create a GENERAL pattern name and description that would match similar future requests — not just this specific one.

Examples:
- "Go to eventbrite and find tech events" → name: "browse-site-and-add-to-tasks", description: "Navigate to a website, search or browse for content, pick the most relevant item, and add it to the task list"
- "Search LinkedIn for AI jobs and save top 3" → name: "search-site-and-collect-results", description: "Search a website for items matching a query, evaluate results, and save the best matches"
- "Go to meetup.com and sign me up" → name: "browse-and-fill-form", description: "Navigate to a website, find a form or signup page, and fill in user details"

Return ONLY a JSON object: {"name": "pattern-name-slug", "description": "General description of the workflow pattern"}`,
              },
              {
                role: 'user',
                content: `Request: "${ctx.userMessage}"\nTools used: ${toolSequence}`,
              },
            ],
            options: { temperature: 0.2, num_predict: 200 },
          });

          let skillName = 'unnamed-skill';
          let skillDescription = ctx.userMessage.slice(0, 200);

          const genRaw = generalizeResponse.message?.content ?? '';
          const genMatch = genRaw.match(/\{[\s\S]*\}/);
          if (genMatch) {
            try {
              const gen = JSON.parse(genMatch[0]);
              if (gen.name) skillName = gen.name;
              if (gen.description) skillDescription = gen.description;
            } catch { /* use defaults */ }
          }

          const slug = skillName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);

          // Check if a pattern skill with this slug already exists — don't duplicate
          const existing = store.get(slug);
          if (existing) {
            store.recordSuccess(slug);
            console.log(`[Plan] Pattern skill "${slug}" already exists — recorded success (count: ${existing.successCount + 1})`);
          } else {
            store.save({
              name: skillName,
              slug,
              description: skillDescription,
              created: new Date().toISOString().split('T')[0],
              lastUsed: new Date().toISOString().split('T')[0],
              successCount: 1,
              steps: plan,
              notes: [...new Set(notes)],
            });
          }
        } catch (err) {
          console.warn(`[Plan] Failed to save skill: ${err instanceof Error ? err.message : err}`);
        }
      },
    },
  ],
};

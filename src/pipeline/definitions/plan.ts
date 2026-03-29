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

const PLAN_PROMPT = `You are a task decomposer. Break the user's goal into sub-tasks, each handled by a specialist. Each specialist has its own tools and pipeline — you just decide WHICH specialist handles each sub-task and WHAT to tell them.

Available specialists:
- web_search: Search the internet and summarize findings. Give it a search query.
- research: Deep research with charts and slide decks. Give it a topic.
- memory: Save or recall information. Give it what to remember or what to look up.
- task: Create, list, update, or complete tasks. Give it the task details.
- cron: Schedule recurring jobs. Give it the job name, schedule, and what to do. Valid categories for cron jobs: chat, web_search, memory, exec, task, research.
- exec: Run shell commands or code. Give it the command.
- multi: Interactive browser tasks — signing up, filling forms, navigating sites. ONLY when the task requires clicking/typing on a website.

CHOOSING THE RIGHT SPECIALIST:
- "Find info about X" → web_search
- "Research X in depth" → research
- "Remember that X" / "What do you know about X" → memory
- "Add X to my task list" → task
- "Schedule daily X at 4pm" → cron
- "Run this command" → exec
- "Go to X website and sign up" → multi (browser interaction)
- "Find X and schedule updates" → web_search THEN cron (chained)
- "Search for events and add to tasks" → web_search THEN task (chained)

RULES:
- Each step: { "specialist": string, "message": string, "purpose": string }
- "message" is what you tell the specialist — it should be a clear, self-contained instruction
- Include context from previous steps when needed: "Based on the results: [prior findings], now do X"
- Keep plans to 5 steps or fewer. Most tasks need 1-3 specialists.
- Only use "task" specialist when user EXPLICITLY asked to add to their task list.
- Only use "multi" specialist when the task genuinely requires browser interaction (clicking, typing, forms).
- DO NOT include message/notification steps. User receives your summary automatically.
- LINKS: Specialists should include URLs in their responses. The final summary MUST include links.

Return ONLY a JSON array of steps. No explanation.

Example 1 — information gathering:
[
  {"specialist": "web_search", "message": "Find the top AI news stories today", "purpose": "Get current AI headlines with links"}
]

Example 2 — compound task:
[
  {"specialist": "web_search", "message": "Find the best AI news sources and aggregators", "purpose": "Identify top AI news sources"},
  {"specialist": "cron", "message": "Schedule a daily job at 4pm called 'Daily AI News' that searches for top AI news stories and summarizes them. Category: web_search", "purpose": "Set up daily 4pm news digest"}
]

Example 3 — find and add to tasks:
[
  {"specialist": "web_search", "message": "Search for tech meetups near Huntington Station NY happening in the next month", "purpose": "Find upcoming tech meetups"},
  {"specialist": "task", "message": "Add a task: [event name from previous step] on [date]", "purpose": "Add the most relevant meetup to task list"}
]

Example 4 — browser interaction:
[
  {"specialist": "multi", "message": "Go to eventbrite.com, search for tech events near Huntington Station NY, and read the results", "purpose": "Browse Eventbrite for events"},
  {"specialist": "task", "message": "Add a task: [event from previous step]", "purpose": "Add event to task list"}
]

Example 5 — research and schedule:
[
  {"specialist": "research", "message": "Research the current state of AI regulation in the US", "purpose": "Deep research on AI regulation"},
  {"specialist": "cron", "message": "Schedule a weekly job on Mondays at 9am called 'AI Regulation Update' that researches new AI regulation developments. Category: research", "purpose": "Set up weekly monitoring"}
]`;

const REFLECT_PROMPT = `You are a plan reviewer. Critique the proposed plan below and suggest improvements.

Check for these common issues:
1. OVERKILL SPECIALIST: If the plan uses "multi" (browser) when "web_search" would work, flag it. Browser is expensive and slow — only use it when the task requires clicking, typing, or form interaction. "Find information" = web_search. "Read a page" = web_search.
2. WRONG ORDER: Steps that depend on previous results must come after those results.
3. UNREALISTIC: Steps that assume information not yet gathered by a previous step.
4. TOO VAGUE: Instructions to specialists should be specific and clear.
5. UNNECESSARY TASK: "task" specialist used when user didn't explicitly ask to add to their task list. "Find X" should just present results. NOTE: "cron" is fine when user says "schedule" — that IS an explicit request.
6. TOO MANY STEPS: Most tasks need 1-3 specialists. If the plan has more than 5, simplify.
7. MISSING CONTEXT THREADING: If step 2 depends on step 1's results, the message should reference it (e.g., "Based on the results above...").

Return a JSON object:
{
  "issues": ["list of problems found"],
  "revised_plan": [revised steps array if changes needed],
  "approved": true/false
}

If the plan is good, return: {"issues": [], "revised_plan": [], "approved": true}`;

const REPLAN_PROMPT = `You are monitoring plan execution. A step just completed. Based on the result, decide what to do next.

If the step succeeded, return the next step from the original plan (adjusted if needed).
If the step failed, return an adjusted step using a different specialist or approach.
If the goal is achieved, return: {"done": true, "summary": "what was accomplished"}

Return ONLY a JSON object — either a step {"specialist": "...", "message": "...", "purpose": "..."} or {"done": true, "summary": "..."}`;

interface PlanStep {
  specialist: string;
  message: string;
  purpose: string;
}

// Keep old format for backward compatibility with saved skills
interface LegacyPlanStep {
  tool: string;
  params: Record<string, unknown>;
  purpose: string;
}

/**
 * Parse a JSON plan from LLM output. Tolerates markdown fences and surrounding text.
 * Handles both new format (specialist/message) and legacy format (tool/params).
 */
function parsePlan(raw: string): PlanStep[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  try {
    const arr = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(arr)) return [];
    const VALID_SPECIALISTS = new Set([
      'web_search', 'research', 'memory', 'task', 'cron', 'exec', 'multi',
      'chat', 'message', 'website', 'config',
    ]);

    return arr
      .filter((s: any) => s && (typeof s.specialist === 'string' || typeof s.tool === 'string'))
      .map((s: any) => {
        // Convert legacy format to new format
        if (s.specialist) return s as PlanStep;
        // Legacy: tool/params → specialist/message
        return {
          specialist: mapToolToSpecialist(s.tool),
          message: `Use ${s.tool} with params: ${JSON.stringify(s.params)}`,
          purpose: s.purpose ?? '',
        };
      })
      .filter((s: PlanStep) => {
        // Validate specialist is real and message exists
        if (!s.message || s.message === 'undefined') {
          console.log(`[Plan] Dropping step with missing message: ${s.specialist}`);
          return false;
        }
        if (!VALID_SPECIALISTS.has(s.specialist)) {
          console.log(`[Plan] Dropping step with invalid specialist: "${s.specialist}"`);
          return false;
        }
        return true;
      });
  } catch {
    return [];
  }
}

/** Map a tool name to its specialist category for legacy plan compatibility */
function mapToolToSpecialist(tool: string): string {
  const map: Record<string, string> = {
    // Specialist names map to themselves (skills store these directly)
    web_search: 'web_search', research: 'research', memory: 'memory',
    task: 'task', cron: 'cron', exec: 'exec', multi: 'multi',
    chat: 'chat', message: 'message', website: 'website', config: 'config',
    // Legacy tool names map to their specialist
    web_fetch: 'web_search', browser: 'multi',
    memory_save: 'memory', memory_search: 'memory', memory_get: 'memory',
    task_add: 'task', task_list: 'task', task_update: 'task', task_done: 'task', task_remove: 'task',
    cron_add: 'cron', cron_list: 'cron', cron_remove: 'cron', cron_edit: 'cron',
    code_session: 'exec', read_file: 'exec', write_file: 'exec',
  };
  return map[tool] ?? 'chat';
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
    if (obj.specialist && obj.message) return { step: obj as PlanStep };
    // Legacy format
    if (obj.tool && obj.params) {
      return { step: { specialist: mapToolToSpecialist(obj.tool), message: `Use ${obj.tool}: ${JSON.stringify(obj.params)}`, purpose: obj.purpose ?? '' } };
    }
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

    // Stage 1: Generate the plan (uses skill template if matched)
    {
      name: 'generate_plan',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 2048,
      buildPrompt: (ctx) => {
        // If a skill matched, provide its specialist sequence as a template
        // but let the LLM generate fresh messages for the current request
        const skillSteps = ctx.params._skillSteps as PlanStep[] | undefined;
        const skillHint = skillSteps && skillSteps.length > 0
          ? `\n\nA similar task has succeeded before using this specialist sequence: ${skillSteps.map(s => s.specialist).join(' → ')}. You can follow this pattern but write messages specific to the current goal.`
          : '';

        return {
          system: PLAN_PROMPT,
          user: `Today's date: ${new Date().toISOString().split('T')[0]}\n\nGoal: ${ctx.userMessage}${skillHint}`,
        };
      },
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
            if (ctx.metricsCollector) {
              ctx.metricsCollector.reflectionIssueCount = reflection.issues.length;
            }
          }

          if (!reflection.approved && reflection.revised_plan?.length > 0) {
            // Run revised plan through the same validation as parsePlan
            const revisedRaw = JSON.stringify(reflection.revised_plan);
            const revised = parsePlan(revisedRaw);
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

            const step = plan[stepIndex];
            console.log(`[Plan] Step ${stepIndex + 1}/${plan.length}: ${step.specialist} — ${step.purpose}`);

            // Thread context from previous steps into the message
            let message = step.message;
            if (stepIndex > 0 && results.length > 0) {
              const priorContext = results.slice(-2).join('\n\n');
              message = `${step.message}\n\nContext from previous steps:\n${priorContext}`;
            }

            const stepStart = Date.now();

            // Dispatch to specialist via subDispatch (or fall back to direct executor)
            if (ctx.subDispatch) {
              try {
                const result = await ctx.subDispatch(message, step.specialist);
                const observation = result.answer;
                if (result.steps) {
                  ctx.steps.push(...result.steps);
                }
                results.push(`Step ${stepIndex + 1} (${step.specialist}): ${step.purpose}\nResult: ${observation}`);
                ctx.params._lastResult = observation;
                ctx.params._lastSuccess = true;

                ctx.metricsCollector?.trackStep({
                  index: stepIndex,
                  tool: step.specialist,
                  purpose: step.purpose,
                  resultClass: observation.length > 0 ? 'success' : 'empty',
                  durationMs: Date.now() - stepStart,
                  observation,
                });
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                results.push(`Step ${stepIndex + 1} (${step.specialist}): ${step.purpose}\nError: ${errMsg}`);
                ctx.params._lastResult = `Error: ${errMsg}`;
                ctx.params._lastSuccess = false;

                ctx.metricsCollector?.trackStep({
                  index: stepIndex,
                  tool: step.specialist,
                  purpose: step.purpose,
                  resultClass: 'error',
                  durationMs: Date.now() - stepStart,
                  observation: errMsg,
                });
              }
            } else {
              // Fallback: no subDispatch available (e.g., CLI mode) — skip
              results.push(`Step ${stepIndex + 1} (${step.specialist}): SKIPPED — sub-dispatch not available`);
              ctx.params._lastResult = 'Sub-dispatch not available';
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

            // If step succeeded, reset fail counter and continue
            if (lastSuccess && stepIndex < plan.length) {
              ctx.params._consecutiveFailures = 0;
              return;
            }

            // Track consecutive failures — give up after 2 to prevent infinite replan loops
            const consecutiveFailures = ((ctx.params._consecutiveFailures as number) ?? 0) + 1;
            ctx.params._consecutiveFailures = consecutiveFailures;
            if (consecutiveFailures >= 2) {
              console.log(`[Plan] ${consecutiveFailures} consecutive failures — skipping replan, moving on`);
              return;
            }

            // Step failed — ask LLM to replan
            const remainingSteps = plan.slice(stepIndex).map((s, i) =>
              `${stepIndex + i + 1}. ${s.specialist}: ${s.purpose}`,
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
          system: `Tell the user what you did and what they got. Be direct and concise.

RULES:
- Lead with the result, not the process. "Here are the top AI news sources: ..." not "I searched for AI news sources and found..."
- Include URLs/links for anything you found or visited.
- Do NOT list limitations, caveats, or workarounds unless there was an actual failure that prevented completing the goal.
- Do NOT suggest alternative tools, services, or manual steps. The user asked YOU to do something — report what you did.
- Do NOT explain how the system works internally (cron, scheduling, background tasks).
- Do NOT add emoji section headers like ✅ ⚠️ 🕒 🔧.
- If everything worked, just say what was done. No "limitations" section. No "next steps" section.
- Short is better than long. 3-5 sentences is usually enough.`,
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
        if (!plan || !results || plan.length < 2) return;

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
          const toolSequence = plan.map(s => s.specialist).join(' → ');
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
                content: `Request: "${ctx.userMessage}"\nSpecialists used: ${toolSequence}`,
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

          // Convert specialist-based steps to skill format
          const skillSteps = plan.map(s => ({
            tool: s.specialist,
            params: { message: s.message },
            purpose: s.purpose,
          }));

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
              steps: skillSteps,
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

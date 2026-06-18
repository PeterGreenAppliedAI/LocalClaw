/**
 * Briefing service — proactive check-ins with calendar, tasks, and memory context.
 * Extracted from orchestrator.ts for single-responsibility and testability.
 */
import type { LocalClawConfig } from '../config/types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { FactStore } from '../memory/fact-store.js';
import type { TaskStore } from '../tasks/store.js';
import { resolveWorkspacePath } from '../agents/scope.js';
import { enrichTasks, filterForModel, formatTaskBoard, enrichCalendarOutput } from '../temporal/urgency.js';

export interface BriefingDeps {
  config: LocalClawConfig;
  client: OllamaClient;
  toolRegistry: ToolRegistry;
  channelRegistry: ChannelRegistry;
  factStore?: FactStore;
  taskStore?: TaskStore;
}

export async function runBriefing(deps: BriefingDeps): Promise<void> {
  const { config, client, toolRegistry, channelRegistry, factStore, taskStore } = deps;
  const hb = config.heartbeat;
  if (!hb?.delivery.target) return;

  const now = new Date();
  const tz = config.timezone;
  const localHour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  const timeOfDay = localHour <= 10 ? 'morning' : localHour <= 16 ? 'afternoon' : 'evening';
  const dateStr = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

  console.log(`[Briefing] Running ${timeOfDay} briefing...`);

  try {
    const workspacePath = resolveWorkspacePath(config.agents.default, config);
    const executor = toolRegistry.createExecutor();
    const toolCtx = { agentId: config.agents.default, sessionKey: 'briefing', workspacePath, senderId: hb.delivery.target };

    // Gather calendar. Look 2 days ahead (3 in the evening, when you're planning further out) so
    // the near horizon is reliably covered — a 1-day window from a midday briefing clipped events
    // later the next day. calendar_list now extends through end-of-day, so this is full-day coverage.
    let calendar = '';
    try { calendar = await executor('calendar_list', { days: timeOfDay === 'evening' ? 3 : 2 }, toolCtx); } catch { calendar = '(calendar not available)'; }
    calendar = enrichCalendarOutput(calendar, now);

    // Code-level conflict detection
    const calEvents: Array<{ title: string; date: string; start: string; end: string }> = [];
    const eventLines = calendar.split('\n- **');
    for (const block of eventLines) {
      const titleMatch = block.match(/^([^*]+?)(?:\s*\[.*?\])?\**/);
      const timeMatch = block.match(/(\w{3}, \w{3} \d+) (\d+:\d+ [AP]M) – (\d+:\d+ [AP]M)/);
      if (titleMatch && timeMatch) {
        calEvents.push({ title: titleMatch[1].trim(), date: timeMatch[1], start: timeMatch[2], end: timeMatch[3] });
      }
    }
    const conflicts: string[] = [];
    for (let i = 0; i < calEvents.length; i++) {
      for (let j = i + 1; j < calEvents.length; j++) {
        if (calEvents[i].date === calEvents[j].date && calEvents[i].start === calEvents[j].start) {
          conflicts.push(`CONFLICT: "${calEvents[i].title}" and "${calEvents[j].title}" overlap at ${calEvents[i].start} on ${calEvents[i].date}`);
        }
      }
    }
    if (conflicts.length > 0) {
      calendar += `\n\n**Schedule Conflicts Detected:**\n${conflicts.join('\n')}`;
    }

    // Task board
    let taskBoardEnriched = '';
    if (taskStore) {
      const allTasks = taskStore.list();
      const activeTasks = allTasks.filter(t => t.status === 'todo' || t.status === 'in_progress');
      const enriched = enrichTasks(activeTasks, now);
      const forModel = filterForModel(enriched);
      taskBoardEnriched = forModel.length > 0 ? formatTaskBoard(forModel) : 'No tasks need attention.';
    }

    // Memory
    let memory = '';
    try { memory = await executor('memory_search', { query: 'recent activity decisions context' }, toolCtx); } catch { memory = '(memory not available)'; }

    // Stale facts
    let staleFacts = '';
    if (factStore && hb.delivery.target) {
      try {
        const allFacts = factStore.loadFactsJson(hb.delivery.target);
        const nowMs = Date.now();
        const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
        const staleList = allFacts.filter(f => f.category !== 'stable' && (nowMs - new Date(f.createdAt).getTime()) > TEN_DAYS);
        if (staleList.length > 0) {
          staleFacts = staleList.map(f => `- [${f.category}] "${f.text}" (from ${f.createdAt.slice(0, 10)})`).join('\n');
        }
      } catch { /* best-effort */ }
    }

    console.log(`[Briefing] Context: calendar=${calendar.length} chars, tasks=${taskBoardEnriched.length} chars, memory=${memory.length} chars`);

    const briefingModel = config.briefing.model;
    const timeFrames: Record<string, string> = {
      morning: "Focus on today's schedule. What should the user prepare for? Flag early meetings, deadlines, or things that need attention before the day gets busy.",
      afternoon: "Focus on what's left today. Anything urgent that hasn't been addressed? Any prep needed for tomorrow?",
      evening: "Focus on tomorrow. What's coming up? Anything to prep tonight? Flag early morning commitments.",
    };

    const response = await client.chat({
      model: briefingModel,
      messages: [{
        role: 'user',
        content: `You are a proactive personal assistant. It is ${dateStr}. This is the ${timeOfDay} check-in.

## Calendar (day labels are pre-computed and correct)
${calendar}

## Tasks (urgency tiers are pre-computed and correct)
${taskBoardEnriched}

## Recent Memory
${memory}
${staleFacts ? `\n## Stale Context (may be outdated — mention if relevant)\n${staleFacts}` : ''}

RULES:
- Write the ENTIRE update in English. Source data may contain non-English names or terms, but your output must be English regardless.
- The Calendar section above is the ONLY source of truth for events. NEVER invent, fabricate, or recall events from memory.
- Day labels like [TODAY], [TOMORROW], [in 3 days] are AUTHORITATIVE. Never contradict them.
- Urgency tiers (critical/high/medium/low) are AUTHORITATIVE. Never say something is urgent if labeled low or dormant.
- Your job is SYNTHESIS, not analysis. The temporal analysis is already done.
- Look for facts that are CONNECTED — if two things relate, reason about what that combination means.
- ${timeFrames[timeOfDay]}

Write a useful ${timeOfDay} update:
- If the calendar has events, list them in CHRONOLOGICAL order with their day labels.
- If the calendar says "No events found", state that the schedule is clear. Do NOT list any events.
- If conflicts are detected above, mention them prominently.
- After calendar, add 1-2 sentences about anything worth noting (task deadlines, connections between facts).
- Be specific: dates, times, names, locations.
- If nothing notable beyond the calendar, say so briefly.
- NEVER ask questions. This is a one-way notification.
- Do NOT repeat yourself or add a "Final update:" section.
- After your reasoning, write your final update OUTSIDE of any think tags. Write it in English. /no_think`,
      }],
      options: { temperature: 0.6, num_predict: 8192 },
    });

    const raw = response.message?.content ?? '';
    let insight: string;
    const thinkEnd = raw.indexOf('</think>');
    if (thinkEnd !== -1) {
      insight = raw.slice(thinkEnd + '</think>'.length).trim();
    } else {
      insight = raw.replace(/<think>[\s\S]*$/g, '').trim();
    }
    if (!insight && raw.includes('<think>')) {
      insight = raw.replace(/<\/?think>/g, '').trim();
      console.log(`[Briefing] Model put everything in <think> tags — extracting reasoning as output`);
    }
    console.log(`[Briefing] ${timeOfDay} complete (${insight.length} chars)`);

    if (insight) {
      await channelRegistry.send(
        { channel: hb.delivery.channel, channelId: hb.delivery.target },
        { text: insight },
      );
    }
  } catch (err) {
    console.warn('[Briefing] Failed:', err instanceof Error ? err.message : err);
  }
}

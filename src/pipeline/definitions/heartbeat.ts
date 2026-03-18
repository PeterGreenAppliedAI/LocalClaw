import type { PipelineDefinition } from '../types.js';

/**
 * Heartbeat pipeline: tool(task_list) → code(compare due dates) → tool(memory_search) → code(format report)
 *
 * Fully deterministic — NO LLM date reasoning.
 * Replaces the ReAct-based heartbeat which hallucinated date comparisons.
 */
export const heartbeatPipeline: PipelineDefinition = {
  name: 'heartbeat',
  stages: [
    {
      name: 'fetch_tasks',
      type: 'tool',
      tool: 'task_list',
      resolveParams: () => ({}),
    },
    {
      name: 'analyze_tasks',
      type: 'code',
      execute: (ctx) => {
        const raw = ctx.stageResults.fetch_tasks as string;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Parse tasks from the tool output
        const lines = raw.split('\n');
        const overdue: string[] = [];
        const upcoming: string[] = [];
        const inProgress: string[] = [];

        for (const line of lines) {
          // Extract due date if present (format: "Due: YYYY-MM-DD")
          const dueMatch = line.match(/Due:\s*(\d{4}-\d{2}-\d{2})/);
          const statusMatch = line.match(/Status:\s*(todo|in_progress|done|cancelled)/i);
          const status = statusMatch?.[1]?.toLowerCase() ?? '';

          if (status === 'done' || status === 'cancelled') continue;

          if (dueMatch) {
            const dueDate = new Date(dueMatch[1] + 'T00:00:00');
            if (dueDate < today) {
              overdue.push(line.trim());
            } else {
              const daysUntil = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              if (daysUntil <= 7) {
                upcoming.push(`${line.trim()} (${daysUntil} day${daysUntil === 1 ? '' : 's'} away)`);
              }
            }
          }

          if (status === 'in_progress') {
            inProgress.push(line.trim());
          }
        }

        ctx.params._overdue = overdue;
        ctx.params._upcoming = upcoming;
        ctx.params._inProgress = inProgress;
        ctx.params._taskSummary = raw;

        return { overdue: overdue.length, upcoming: upcoming.length, inProgress: inProgress.length };
      },
    },
    {
      name: 'fetch_recent_memory',
      type: 'tool',
      tool: 'memory_search',
      resolveParams: () => ({ query: 'recent activity decisions context', maxResults: '5' }),
    },
    {
      name: 'format_report',
      type: 'code',
      execute: (ctx) => {
        const overdue = ctx.params._overdue as string[];
        const upcoming = ctx.params._upcoming as string[];
        const inProgress = ctx.params._inProgress as string[];
        const memoryResults = ctx.stageResults.fetch_recent_memory as string;

        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        const sections: string[] = [`**Heartbeat Report — ${dateStr}**`];

        if (overdue.length > 0) {
          sections.push(`\n**Overdue (${overdue.length}):**\n${overdue.map(t => `- ${t}`).join('\n')}`);
        }

        if (upcoming.length > 0) {
          sections.push(`\n**Due This Week (${upcoming.length}):**\n${upcoming.map(t => `- ${t}`).join('\n')}`);
        }

        if (inProgress.length > 0) {
          sections.push(`\n**In Progress (${inProgress.length}):**\n${inProgress.map(t => `- ${t}`).join('\n')}`);
        }

        if (!overdue.length && !upcoming.length && !inProgress.length) {
          sections.push('\nNo active or overdue tasks.');
        }

        if (memoryResults && !memoryResults.includes('No memories found')) {
          sections.push(`\n**Recent Context:**\n${memoryResults}`);
        }

        ctx.answer = sections.join('\n');
        return ctx.answer;
      },
    },
  ],
};

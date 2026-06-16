import type { RouterConfig } from '../config/types.js';

/**
 * Build the ~300 token classifier prompt for the router model.
 */
export function buildRouterPrompt(message: string, config: RouterConfig): string {
  const categoryList = Object.keys(config.categories).length > 0
    ? Object.entries(config.categories)
        .map(([name, cat]) => `- ${name}: ${cat.description ?? name}`)
        .join('\n')
    : DEFAULT_CATEGORIES;

  return `You are a message classifier. Pick the ONE specialist whose capabilities best fit the request. Output ONLY the category name, nothing else.

Each line is a specialist and WHAT IT CAN DO:
${categoryList}

Rules:
- MATCH THE CAPABILITY. If the user wants something PRODUCED — a PDF/document → multi, a researched report → research, an image → image, code → code_gen, a data analysis → analytics. Pick the specialist that can actually make it.
- personal, memory, and web_search can only READ — they cannot create files, PDFs, or run anything. Never send a "make a document/PDF" request to personal.
- Choose web_search ONLY when the user is actively asking to look something up now. Statements that merely mention searching/news, or describe the user's own setup, are chat.
- Classify by the user's INSTRUCTION, not by stray words inside quoted or pasted content.

User message: ${message}
Category:`;
}

const DEFAULT_CATEGORIES = `- chat: Talk — conversation, opinions, explanations, questions about Peter. No tools; use when the user is discussing, not asking to produce/fetch/do something.
- web_search: Look something up on the live internet now (search + read pages). READ-only.
- memory: Recall past conversations or stored facts about the user. READ-only.
- exec: Run shell commands, scripts, and file operations in a sandbox.
- cron: Schedule, list, or manage recurring tasks and heartbeats.
- message: Send a message to another channel or user.
- website: Fetch and summarize a specific web page or teaching material.
- task: Create, list, update, or complete to-do tasks.
- document: Turn PROVIDED content into a formatted PDF/DOCX/spreadsheet file (the user gives you the text, you format and render it). Route "make this a PDF", "turn this into a doc", "format this".
- multi: Full-toolset worker for COMPLEX multi-step tasks needing several different tools chained (search + save + send, browse + extract + file). Not for a single artifact.
- config: Edit settings, cron jobs, workspace files, agent configuration.
- research: Deep multi-source research that PRODUCES a polished PDF report with citations and charts.
- personal: READ-ONLY access to Peter's Gmail + Google Calendar (search/read email, list/search events). CANNOT create files, PDFs, or run commands.
- image: Generate an image, picture, or illustration.
- code_gen: Build, scaffold, or write code for a project or feature.
- analytics: Analyze an uploaded data file (CSV/Excel/JSON) — stats, charts, insights.`;

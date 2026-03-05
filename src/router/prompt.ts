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

  return `You are a message classifier. Given a user message, respond with EXACTLY ONE category name. Output ONLY the category, nothing else.

Categories:
${categoryList}

User message: ${message}
Category:`;
}

const DEFAULT_CATEGORIES = `- chat: Simple conversation, greetings, opinions, questions about the owner/user, or anything answerable from context
- web_search: Questions needing current internet information about external topics (NOT about the owner)
- memory: Questions about past conversations or stored info
- exec: Run commands, edit files, system operations
- cron: Schedule, list, or manage recurring tasks
- message: Send messages to other channels/users
- website: Teaching materials, courses, assignments
- multi: Complex requests needing multiple different tools
- research: Research topics in depth, analyze data, generate charts/visualizations, compare trends`;

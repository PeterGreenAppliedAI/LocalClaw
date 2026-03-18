import type { PipelineDefinition } from '../types.js';

/**
 * Web search pipeline: extract(query, count) → tool(web_search) → code(pick top URLs)
 *   → loop(web_fetch each URL, max 3) → llm(synthesize with sources)
 *
 * Replaces the ReAct loop for the "web_search" category.
 */
export const webSearchPipeline: PipelineDefinition = {
  name: 'web_search',
  stages: [
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        query: { type: 'string', description: 'The search query', required: true },
        count: { type: 'string', description: 'Number of search results (default 5)' },
        freshness: { type: 'string', description: 'Time filter', enum: ['day', 'week', 'month'] },
      },
      examples: [
        { input: "what's the latest on NVIDIA stock", output: { query: 'NVIDIA stock price latest news', freshness: 'day' } },
        { input: 'best practices for TypeScript in 2026', output: { query: 'TypeScript best practices 2026' } },
      ],
    },
    {
      name: 'search',
      type: 'tool',
      tool: 'web_search',
      resolveParams: (ctx) => {
        const p: Record<string, unknown> = { query: ctx.params.query };
        if (ctx.params.count) p.count = ctx.params.count;
        if (ctx.params.freshness) p.freshness = ctx.params.freshness;
        return p;
      },
    },
    {
      name: 'pick_urls',
      type: 'code',
      execute: (ctx) => {
        const searchResult = ctx.stageResults.search as string;
        // Extract URLs from search results (format: "URL: https://...")
        const urlMatches = searchResult.match(/https?:\/\/[^\s)"\]]+/g) ?? [];
        // Deduplicate and take top 3
        const unique = [...new Set(urlMatches)].slice(0, 3);
        ctx.params._urls = unique;
        return unique;
      },
    },
    {
      name: 'fetch_pages',
      type: 'loop',
      maxIterations: 3,
      continueIf: (ctx, iteration) => {
        const urls = ctx.params._urls as string[];
        return iteration < urls.length;
      },
      stages: [
        {
          name: 'fetch',
          type: 'tool',
          tool: 'web_fetch',
          resolveParams: (ctx) => {
            const urls = ctx.params._urls as string[];
            return {
              url: urls[ctx.loopIndex!],
              extractMode: 'text',
              maxChars: '3000',
            };
          },
        },
        {
          name: 'collect',
          type: 'code',
          execute: (ctx) => {
            // Accumulate fetched page content
            const pages = (ctx.params._pages as string[] | undefined) ?? [];
            const urls = ctx.params._urls as string[];
            const url = urls[ctx.loopIndex!];
            const content = ctx.stageResults.fetch as string;
            pages.push(`[Source: ${url}]\n${content}`);
            ctx.params._pages = pages;
            return pages;
          },
        },
      ],
    },
    {
      name: 'synthesize',
      type: 'llm',
      temperature: 0.4,
      maxTokens: 2048,
      buildPrompt: (ctx) => {
        const searchResults = ctx.stageResults.search as string;
        const pages = (ctx.params._pages as string[] | undefined) ?? [];
        const pageContent = pages.length > 0
          ? pages.join('\n\n---\n\n')
          : 'No pages could be fetched.';

        return {
          system: [
            'You are a research assistant. Synthesize information from search results and fetched pages into a clear, comprehensive answer.',
            'Always cite sources with URLs. Be factual and concise.',
            'If the fetched pages add useful detail beyond the search snippets, incorporate it.',
          ].join('\n'),
          user: `User asked: "${ctx.userMessage}"\n\n## Search Results\n${searchResults}\n\n## Fetched Pages\n${pageContent}`,
        };
      },
    },
  ],
};

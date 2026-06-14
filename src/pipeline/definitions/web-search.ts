import { appendFileSync, mkdirSync } from 'node:fs';
import type { PipelineDefinition } from '../types.js';
import { detectBucket, buildSiteFilter, prioritizeUrls } from '../search-buckets.js';

const QUALITY_LOG = 'data/quality/web-search.jsonl';

function logQualityReview(entry: Record<string, unknown>): void {
  try {
    mkdirSync('data/quality', { recursive: true });
    appendFileSync(QUALITY_LOG, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* non-critical */ }
}

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
        const query = ctx.params.query as string;
        // Detect topic bucket and add site filter for curated sources
        const bucket = detectBucket(query);
        ctx.params._bucket = bucket;
        const siteFilter = bucket ? buildSiteFilter(bucket) : null;
        const enhancedQuery = siteFilter ? `${query} (${siteFilter})` : query;
        if (bucket) console.log(`[WebSearch] Bucket: ${bucket} — site filter applied`);

        const p: Record<string, unknown> = { query: enhancedQuery };
        if (ctx.params.count) p.count = ctx.params.count;
        // Freshness: trust the extractor if set, else force a recency window when the
        // query signals "recent" — prevents evergreen/historical pages answering a "latest" ask.
        if (ctx.params.freshness) {
          p.freshness = ctx.params.freshness;
        } else if (/\b(recent|latest|newest|just (released|announced|launched|dropped)|this (week|month|year)|right now|currently|up.?to.?date|2026)\b/i.test(query)) {
          p.freshness = 'month';
          ctx.params.freshness = 'month';
          console.log('[WebSearch] Recency query detected — forcing freshness=month');
        }
        return p;
      },
    },
    {
      name: 'pick_urls',
      type: 'code',
      execute: (ctx) => {
        const searchResult = ctx.stageResults.search as string;
        const urlMatches = searchResult.match(/https?:\/\/[^\s)"\]]+/g) ?? [];
        const unique = [...new Set(urlMatches)];
        // Prioritize curated sources from the detected bucket
        const bucket = ctx.params._bucket as string | null;
        const prioritized = prioritizeUrls(unique, bucket);
        ctx.params._urls = prioritized.slice(0, 5);
        return ctx.params._urls;
      },
    },
    {
      name: 'fetch_pages',
      type: 'parallel_tool',
      tool: 'web_fetch',
      resolveParamsList: (ctx) => {
        const urls = ctx.params._urls as string[];
        return urls.map(url => ({ url, extractMode: 'text', maxChars: '3000' }));
      },
    },
    {
      name: 'collect_pages',
      type: 'code',
      execute: (ctx) => {
        const results = ctx.stageResults.fetch_pages as string[];
        const urls = ctx.params._urls as string[];
        ctx.params._pages = results.map((content, i) =>
          `[Source: ${urls[i]}]\n${content}`
        );
      },
    },
    {
      name: 'synthesize',
      type: 'llm',
      stream: true,
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
            'Provide ANALYSIS and INSIGHT, not just a summary of what each source said.',
            'Structure your response with clear sections. Each point should add value beyond restating a headline.',
          ].join('\n'),
          user: `User asked: "${ctx.userMessage}"\n\n## Search Results\n${searchResults}\n\n## Fetched Pages\n${pageContent}`,
        };
      },
    },

    // Quality review — check synthesis quality before delivery
    {
      name: 'quality_review',
      type: 'code',
      execute: async (ctx) => {
        const synthesis = ctx.answer ?? '';
        if (!synthesis || synthesis.length < 100) {
          console.log('[WebSearch] Quality review: output too short, skipping');
          return;
        }

        // Add a recency check only when the query asked for current/recent info
        const isRecencyQuery = !!ctx.params.freshness;
        const today = new Date().toISOString().split('T')[0];
        const recencyCheck = isRecencyQuery
          ? `\n5. RECENCY: The user asked for recent/current info (today is ${today}). Does the content actually cover recent developments, or is it a stale/historical overview? FAIL if the bulk of the answer is more than ~1 year old when recency was requested.`
          : '';

        try {
          const response = await ctx.client.chat({
            model: ctx.routerModel ?? ctx.model,
            messages: [{
              role: 'user',
              content: `Review this search synthesis for quality. Be brief.

${synthesis.slice(0, 4000)}

Check:
1. Does it provide analysis or insight beyond restating search snippets/headlines?
2. Are sources cited with URLs?
3. Is it well-structured with clear sections (not a raw dump of results)?
4. Does it comprehensively answer the original question: "${ctx.userMessage}"?${recencyCheck}

Respond with JSON: {"pass": true} if adequate, or {"pass": false, "fix": "brief instruction to improve"}`,
            }],
            options: { temperature: 0.2, num_predict: 256 },
          });

          const raw = response.message?.content ?? '';
          const match = raw.match(/\{[\s\S]*\}/);
          if (!match) { console.log('[WebSearch] Quality review: no JSON, proceeding'); return; }

          const result = JSON.parse(match[0]);
          if (result.pass) {
            console.log('[WebSearch] Quality review: PASS');
            logQualityReview({
              query: ctx.userMessage,
              pass: true,
              synthesisLength: synthesis.length,
              model: ctx.model,
            });
          } else {
            console.log(`[WebSearch] Quality review: FAIL — ${result.fix}`);
            ctx.params._revisionNeeded = true;
            ctx.params._revisionInstructions = result.fix;
            ctx.params._originalSynthesis = synthesis;
            logQualityReview({
              query: ctx.userMessage,
              pass: false,
              fix: result.fix,
              synthesisLength: synthesis.length,
              model: ctx.model,
            });
          }
        } catch (err) {
          console.warn('[WebSearch] Quality review failed:', err instanceof Error ? err.message : err);
        }
      },
    },

    // Revision pass (conditional — only if quality review failed)
    {
      name: 'revision_pass',
      type: 'code',
      when: (ctx) => !!(ctx.params._revisionNeeded),
      execute: async (ctx) => {
        const synthesis = ctx.answer ?? '';
        const instructions = ctx.params._revisionInstructions as string;
        const searchResults = ctx.stageResults.search as string;
        const pages = (ctx.params._pages as string[] | undefined) ?? [];
        const pageContent = pages.length > 0
          ? pages.join('\n\n---\n\n')
          : '';

        try {
          console.log('[WebSearch] Running revision pass...');
          const response = await ctx.client.chat({
            model: ctx.model,
            messages: [{
              role: 'user',
              content: [
                `Revise this search synthesis. ${instructions}`,
                '',
                'Provide ANALYSIS and INSIGHT, not just summaries. Cite sources with URLs. Structure with clear sections.',
                '',
                `Original question: "${ctx.userMessage}"`,
                '',
                '## Current Synthesis',
                synthesis,
                '',
                '## Source Material',
                searchResults.slice(0, 2000),
                pageContent ? `\n## Fetched Pages\n${pageContent.slice(0, 4000)}` : '',
              ].join('\n'),
            }],
            options: { temperature: 0.4, num_predict: 2048 },
          });

          const revised = (response.message?.content ?? '').trim();
          if (revised.length > synthesis.length * 0.5) {
            ctx.answer = revised;
            console.log('[WebSearch] Revision applied');
            logQualityReview({
              query: ctx.userMessage,
              event: 'revision_applied',
              originalLength: (ctx.params._originalSynthesis as string)?.length ?? synthesis.length,
              revisedLength: revised.length,
              instructions,
            });
          } else {
            console.log('[WebSearch] Revision too short, keeping original');
            logQualityReview({
              query: ctx.userMessage,
              event: 'revision_rejected',
              reason: 'too_short',
              originalLength: synthesis.length,
              revisedLength: revised.length,
            });
          }
        } catch (err) {
          console.warn('[WebSearch] Revision failed:', err instanceof Error ? err.message : err);
        }
      },
    },
  ],
};

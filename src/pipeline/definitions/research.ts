import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineDefinition, PipelineContext } from '../types.js';
import { markdownToHtml } from '../../utils/markdown-to-html.js';
import type { VerificationConfig } from '../../config/types.js';
import {
  type Claim, type VerificationResult,
  extractClaimsPrompt, parseClaims, pickRelevantSources, entailmentPrompt, parseVerdict,
  buildPatchSet, correctionPrompt, verificationSection, needsCorrection,
} from '../verification.js';

/**
 * Research pipeline — REAL research, not a search.
 *
 * Flow: decompose topic into facets → investigate each facet in parallel
 * (search → deep fetch → per-facet synthesis) → gap-check + supplementary →
 * analytical final synthesis (markdown) → deterministic HTML render → PDF.
 *
 * The model writes MARKDOWN (its strength); code converts it to valid HTML and
 * assembles the report (no LLM-authored HTML). Output is always a PDF.
 * Gated to explicit "research/report/deep-dive" requests by the router.
 */

const CHART_RULES = `Chart rules:
- import matplotlib; matplotlib.use('Agg')
- Save each chart to: data/workspaces/main/research/<SLUG>/<chart_name>.png
- Create the dir first: os.makedirs('data/workspaces/main/research/<SLUG>', exist_ok=True)
- EVERY chart MUST have: a descriptive title, labeled axes, a legend if multiple series, and data labels.
- Call plt.tight_layout() then plt.close() after saving each figure.
- Use ONLY the data provided in the chart specs — never invent numbers.

Styling boilerplate (use a clean light theme suitable for a printed PDF report):
\`\`\`python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'figure.facecolor':'#ffffff','axes.facecolor':'#ffffff','font.size':11,'axes.titlesize':13,'axes.labelsize':11,'figure.figsize':(8,4.5),'savefig.dpi':130})
\`\`\``;

const REPORT_CSS = `
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; margin: 0; padding: 0; line-height: 1.7; }
.report { max-width: 780px; margin: 0 auto; padding: 40px 50px; }
h1 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 28px; font-weight: 700; color: #111; border-bottom: 3px solid #2563eb; padding-bottom: 12px; margin-bottom: 8px; }
.report-meta { font-size: 13px; color: #666; margin-bottom: 30px; }
h2 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 20px; font-weight: 600; color: #1e40af; margin-top: 32px; margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
h3 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 16px; font-weight: 600; color: #374151; margin-top: 20px; }
p { margin: 10px 0; font-size: 14px; }
ul, ol { margin: 10px 0 10px 20px; font-size: 14px; }
li { margin-bottom: 6px; }
blockquote { border-left: 4px solid #f59e0b; background: #fffbeb; margin: 16px 0; padding: 8px 16px; font-size: 14px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
th { background: #1e40af; color: #fff; padding: 10px 14px; text-align: left; font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 600; }
td { padding: 8px 14px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
tr:nth-child(even) td { background: #f9fafb; }
img { max-width: 100%; height: auto; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 4px; }
code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
a { color: #2563eb; }
@media print { .report { padding: 20px; } h2 { page-break-after: avoid; } }
`;

const REPORT_TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>${REPORT_CSS}</style></head>
<body><div class="report">${body}</div></body></html>`;

// --- helpers ---
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'research';
}
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\/no_?think/gi, '').trim();
}
function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)"\]]+/g) ?? [])];
}
function wantsFreshness(text: string): boolean {
  return /\b(recent|latest|newest|current|today|this year|2026|2025|now|upcoming)\b/i.test(text);
}

interface AngleResult { angle: string; findings: string; sources: string[]; }

/** Run async fn over items with bounded concurrency (avoid bursting external rate limits). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Investigate ONE facet: search → deep fetch → focused synthesis. */
async function researchAngle(ctx: PipelineContext, angle: string): Promise<AngleResult> {
  const label = angle.slice(0, 45);
  try {
    // Plain facet query (no source bucket — it over-constrained queries). Research is
    // recency-biased: default to a 1-year window, tighten to a month when the ask signals "latest".
    const recency = wantsFreshness(angle) || wantsFreshness(ctx.params.topic as string);
    const searchParams: Record<string, unknown> = {
      query: angle,
      count: '6',
      freshness: recency ? 'month' : 'year',
    };

    const searchResult = await ctx.executor('web_search', searchParams, ctx.toolContext);
    const urls = extractUrls(searchResult).slice(0, 3);
    if (urls.length === 0) {
      console.warn(`[Research] Facet "${label}": no search results (${searchResult.slice(0, 80)})`);
      return { angle, findings: '', sources: [] };
    }

    // Fetch sequentially (small N) to avoid a fetch burst across facets
    const fetched: Array<{ url: string; content: string }> = [];
    for (const url of urls) {
      try {
        const content = await ctx.executor('web_fetch', { url, extractMode: 'text', maxChars: '6000' }, ctx.toolContext);
        fetched.push({ url, content });
      } catch { fetched.push({ url, content: '' }); }
    }
    const valid = fetched.filter(f => f.content && !f.content.startsWith('Error') && f.content.length > 120);
    if (valid.length === 0) {
      console.warn(`[Research] Facet "${label}": ${urls.length} urls, 0 fetched usable content`);
      return { angle, findings: '', sources: [] };
    }

    // Cache the raw fetched text so the verification stage can check claims against the
    // exact pages they were built from — no re-fetch, no extra search.
    const sourceText = ctx.params._sourceText as Record<string, string> | undefined;
    if (sourceText) for (const f of valid) if (!sourceText[f.url]) sourceText[f.url] = f.content;

    const sourceBlocks = valid.map((f, i) => `[Source ${i + 1}: ${f.url}]\n${f.content}`).join('\n\n---\n\n');
    const resp = await ctx.client.chat({
      model: ctx.model,
      messages: [
        { role: 'system', content: [
          'You are a research analyst investigating ONE facet of a larger topic.',
          'From the sources below, extract the concrete findings, data points, specs, dates, and claims relevant to THIS facet only.',
          'Cite every claim inline with its source as [n] (matching the [Source n] blocks).',
          'Be factual. If sources disagree, say so explicitly. Do NOT fabricate — only use what the sources say.',
          'Output concise markdown — short paragraphs or bullets. No preamble, no conclusion. /no_think',
        ].join('\n') },
        { role: 'user', content: `Facet: ${angle}\n\nSources:\n${sourceBlocks}` },
      ],
      options: { temperature: 0.3, num_predict: 1600, ...(ctx.contextSize ? { num_ctx: ctx.contextSize } : {}) },
    });
    return { angle, findings: stripThinking(resp.message?.content ?? ''), sources: valid.map(f => f.url) };
  } catch (err) {
    console.warn(`[Research] Angle failed "${angle.slice(0, 50)}":`, err instanceof Error ? err.message : err);
    return { angle, findings: '', sources: [] };
  }
}

export const researchPipeline: PipelineDefinition = {
  name: 'research',
  stages: [
    // 0. Extract topic + slug
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        topic: { type: 'string', description: 'The research topic or question', required: true },
        slug: { type: 'string', description: 'URL-safe slug for the output filename' },
      },
      examples: [
        { input: 'research the EV battery market and make me a PDF', output: { topic: 'EV battery market', slug: 'ev-battery-market' } },
        { input: 'deep dive on local inference hardware in 2026', output: { topic: 'local inference hardware in 2026', slug: 'local-inference-hardware-2026' } },
      ],
    },

    // 1. Defaults + conversational downgrade guard
    {
      name: 'defaults',
      type: 'code',
      execute: (ctx) => {
        if (!ctx.params.topic) ctx.params.topic = ctx.userMessage;
        if (!ctx.params.slug) ctx.params.slug = slugify(ctx.params.topic as string);
        // If we're mid-conversation and the user didn't actually ask for a report/deep-dive,
        // abort and let dispatch re-route to the fast web_search pipeline.
        if (ctx.conversational) {
          const wantsArtifact = /\b(report|deep.?dive|research|analy[sz]e|analysis|pdf|brief|write.?up|memo|market|teardown)\b/i.test(ctx.userMessage);
          if (!wantsArtifact) {
            ctx.abort = true;
            ctx.answer = '__DOWNGRADE_TO_WEB_SEARCH__';
            console.log('[Research] Conversational, no artifact intent — downgrading to web_search');
          }
        }
      },
    },

    // 2. Decompose the topic into 4-6 distinct facets
    {
      name: 'decompose',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 700,
      buildPrompt: (ctx) => ({
        system: [
          'You are a senior research analyst scoping an investigation.',
          'Break the topic into 4-6 DISTINCT sub-questions/facets that together give comprehensive coverage.',
          'Each facet should be a different angle (not a paraphrase): e.g. current state, key players/options, performance/benchmarks, costs/tradeoffs, recent developments, outlook.',
          'If the topic names multiple entities to compare, ensure each gets dedicated coverage.',
          'Output ONLY a JSON array of facet strings. Each facet should read as a searchable research question.',
          'Example: ["What are the current AMD options for local inference?", "How does AMD ROCm performance compare to NVIDIA CUDA?", ...]',
          'Return ONLY the JSON array. /no_think',
        ].join('\n'),
        user: `Topic: ${ctx.params.topic}\nCurrent year: ${new Date().getFullYear()}`,
      }),
    },

    // 3. Parse facets
    {
      name: 'parse_angles',
      type: 'code',
      execute: (ctx) => {
        const raw = stripThinking(ctx.stageResults.decompose as string);
        let angles: string[] = [];
        try {
          const m = raw.match(/\[[\s\S]*\]/);
          if (m) { const arr = JSON.parse(m[0]); if (Array.isArray(arr)) angles = arr.filter(a => typeof a === 'string' && a.length > 5); }
        } catch { /* fall through */ }
        if (angles.length === 0) angles = [ctx.params.topic as string];
        ctx.params._angles = angles.slice(0, 6);
        console.log(`[Research] Facets (${(ctx.params._angles as string[]).length}): ${(ctx.params._angles as string[]).map(a => a.slice(0, 40)).join(' | ')}`);
      },
    },

    // 4. Investigate each facet in parallel (search → fetch → synthesize)
    {
      name: 'research_angles',
      type: 'code',
      execute: async (ctx) => {
        const angles = ctx.params._angles as string[];
        console.log(`[Research] Investigating ${angles.length} facets (max 3 concurrent)...`);
        // url → raw page text, shared across facets so verification can reuse fetched pages.
        ctx.params._sourceText = {};
        // Bounded concurrency: 3 facets at a time avoids bursting Brave / fetch rate limits.
        const results = await mapLimit(angles, 3, a => researchAngle(ctx, a));
        const withFindings = results.filter(r => r.findings.trim().length > 0);
        ctx.params._angleResults = withFindings;
        const allSources = [...new Set(withFindings.flatMap(r => r.sources))];
        ctx.params._allSources = allSources;
        console.log(`[Research] ${withFindings.length}/${angles.length} facets produced findings; ${allSources.length} unique sources`);
      },
    },

    // 5. Gap check → supplementary queries
    {
      name: 'gap_check',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 400,
      buildPrompt: (ctx) => ({
        system: [
          'You review research coverage. Given facet findings, identify what is MISSING, thin, or unverified for a thorough report on the topic.',
          'Output ONLY a JSON array of 0-2 additional search queries that would fill the biggest gaps. If coverage is already strong, output [].',
          'Return ONLY the JSON array. /no_think',
        ].join('\n'),
        user: `Topic: ${ctx.params.topic}\n\nFindings so far:\n${(ctx.params._angleResults as AngleResult[]).map(r => `### ${r.angle}\n${r.findings.slice(0, 600)}`).join('\n\n')}`,
      }),
    },
    {
      name: 'supplementary',
      type: 'code',
      execute: async (ctx) => {
        let queries: string[] = [];
        try {
          const m = stripThinking(ctx.stageResults.gap_check as string).match(/\[[\s\S]*\]/);
          if (m) { const arr = JSON.parse(m[0]); if (Array.isArray(arr)) queries = arr.filter(q => typeof q === 'string' && q.length > 5).slice(0, 2); }
        } catch { /* none */ }
        if (queries.length === 0) { console.log('[Research] No gaps flagged'); return; }
        console.log(`[Research] Supplementary: ${queries.join(' | ')}`);
        const extra = await Promise.all(queries.map(q => researchAngle(ctx, q)));
        const merged = [...(ctx.params._angleResults as AngleResult[]), ...extra.filter(r => r.findings.trim())];
        ctx.params._angleResults = merged;
        ctx.params._allSources = [...new Set(merged.flatMap(r => r.sources))];
      },
    },

    // 6. Final analytical synthesis → markdown report (+ optional charts spec)
    {
      name: 'final_synthesis',
      type: 'llm',
      temperature: 0.4,
      maxTokens: 8192,
      buildPrompt: (ctx) => {
        const findings = (ctx.params._angleResults as AngleResult[])
          .map((r, i) => `## Facet ${i + 1}: ${r.angle}\n${r.findings}\nSources: ${r.sources.join(', ')}`)
          .join('\n\n');
        const sources = (ctx.params._allSources as string[]);
        return {
          system: [
            'You are a senior analyst writing the FINAL research report from facet findings. Write in MARKDOWN (never HTML).',
            'This is ANALYSIS, not a summary. Form a clear thesis, weave findings across facets, and surface tensions.',
            '',
            'Structure:',
            '- `# {Report Title}` (one line)',
            '- A 2-4 sentence executive summary paragraph (no heading).',
            '- `## {Theme}` sections (4-7) with real analytical prose. Each major claim gets an inline citation like [3] referencing the numbered Sources list.',
            '- A `## Contradictions & Gaps` section naming where sources disagree or coverage is thin/uncertain. Do not paper over uncertainty.',
            '- A `## Sources` section: a numbered markdown list where item [n] is the URL (and title if known). Citation numbers in the body MUST match this list.',
            '',
            'If a chart would materially help, insert a placeholder line `{{chart:short_name}}` where it belongs, and at the VERY END append a fenced block:',
            '```charts',
            '[{"name":"short_name","title":"Chart Title","description":"what it shows","data":{"labels":["A","B"],"values":[1,2]}}]',
            '```',
            'Only propose charts you have real numeric data for. If none, omit the charts block entirely.',
            '',
            'Rules: never fabricate data or sources. Use only the findings provided. Be specific (numbers, dates, names). /no_think',
          ].join('\n'),
          user: `Topic: ${ctx.params.topic}\nToday: ${new Date().toISOString().split('T')[0]}\n\nNumbered sources:\n${sources.map((u, i) => `[${i + 1}] ${u}`).join('\n')}\n\nFacet findings:\n${findings}`,
        };
      },
    },

    // 7. Split markdown report from the charts spec; fail loud if empty
    {
      name: 'parse_final',
      type: 'code',
      execute: (ctx) => {
        const raw = stripThinking(ctx.stageResults.final_synthesis as string);
        let charts: any[] = [];
        const chartBlock = raw.match(/```charts\s*([\s\S]*?)```/);
        if (chartBlock) {
          try { const arr = JSON.parse(chartBlock[1].trim()); if (Array.isArray(arr)) charts = arr.filter(c => c?.name); } catch { /* no charts */ }
        }
        const reportMarkdown = raw.replace(/```charts[\s\S]*?```/g, '').trim();
        ctx.params._reportMarkdown = reportMarkdown;
        ctx.params._charts = charts;
        // Fail loud: never emit a blank PDF
        if (reportMarkdown.replace(/[#*\->\s]/g, '').length < 200) {
          ctx.abort = true;
          ctx.answer = `I researched "${ctx.params.topic}" but couldn't gather enough reliable source material to produce a report. Try narrowing the topic or rephrasing.`;
          console.warn('[Research] Final synthesis too thin — aborting before render');
        }
      },
    },

    // 7b. Extract atomic, checkable claims from the draft (fast model)
    {
      name: 'extract_claims',
      type: 'code',
      when: (ctx) => (ctx.params._verification as VerificationConfig | undefined)?.enabled !== false,
      execute: async (ctx) => {
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        const maxClaims = vcfg?.maxClaims ?? 12;
        const model = vcfg?.extractorModel || ctx.routerModel || ctx.model;
        try {
          const { system, user } = extractClaimsPrompt(ctx.params._reportMarkdown as string, maxClaims);
          const resp = await ctx.client.chat({
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            options: { temperature: 0.1, num_predict: 2000 },
          });
          const claims = parseClaims(resp.message?.content ?? '', maxClaims);
          ctx.params._claims = claims;
          console.log(`[Verify] extracted ${claims.length} checkable claim(s)`);
        } catch (err) {
          console.warn('[Verify] claim extraction failed (skipping verification):', err instanceof Error ? err.message : err);
          ctx.params._claims = [];
        }
      },
    },

    // 7c. Check each claim against the cached sources that actually mention it (broader corpus,
    //     not the single — often mis-numbered — cited URL). No independent search.
    {
      name: 'verify_claims',
      type: 'code',
      when: (ctx) => ((ctx.params._claims as Claim[] | undefined)?.length ?? 0) > 0,
      execute: async (ctx) => {
        const claims = ctx.params._claims as Claim[];
        const sources = (ctx.params._allSources as string[]) ?? [];
        const sourceText = (ctx.params._sourceText as Record<string, string>) ?? {};
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        const model = vcfg?.judgeModel || ctx.model;
        const results = await mapLimit(claims, 3, async (claim): Promise<VerificationResult> => {
          const citedUrl = claim.citation && sources[claim.citation - 1] ? sources[claim.citation - 1] : undefined;
          // Top cached pages that mention the claim's tokens, plus the cited page if any.
          const candidateUrls = pickRelevantSources(claim, sourceText, 3, citedUrl);
          let candidates = candidateUrls.map(u => ({ url: u, text: sourceText[u] })).filter(c => c.text);
          // Fallback: nothing cached matched — fetch the cited page on demand.
          if (candidates.length === 0 && citedUrl) {
            try {
              const c = await ctx.executor('web_fetch', { url: citedUrl, extractMode: 'text', maxChars: '6000' }, ctx.toolContext);
              if (c && !c.startsWith('Error') && c.length > 120) candidates = [{ url: citedUrl, text: c }];
            } catch { /* leave empty */ }
          }
          if (candidates.length === 0) {
            return { claim_id: claim.claim_id, claim: claim.claim, verdict: 'AMBIGUOUS', cited_source: citedUrl, supported_elements: [], unsupported_elements: [], reason: 'No cached source available to check against — left as drafted.', recommended_action: 'keep' };
          }
          try {
            const { system, user } = entailmentPrompt(claim, candidates);
            const resp = await ctx.client.chat({
              model,
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
              options: { temperature: 0.2, num_predict: 600 },
            });
            return parseVerdict(resp.message?.content ?? '', claim, citedUrl);
          } catch (err) {
            console.warn(`[Verify] judge failed for ${claim.claim_id}:`, err instanceof Error ? err.message : err);
            return { claim_id: claim.claim_id, claim: claim.claim, verdict: 'AMBIGUOUS', cited_source: citedUrl, supported_elements: [], unsupported_elements: [], reason: 'Judge error — left as drafted.', recommended_action: 'keep' };
          }
        });
        ctx.params._verifications = results;
        console.log(`[Verify] ${results.length} checked, ${results.filter(needsCorrection).length} need correction`);
        // Auditable artifact alongside the report/charts
        try {
          const dir = join('data', 'workspaces', 'main', 'research', ctx.params.slug as string);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'verification.json'), JSON.stringify({ topic: ctx.params.topic, generated: new Date().toISOString(), results }, null, 2));
        } catch (err) {
          console.warn('[Verify] could not write verification.json:', err instanceof Error ? err.message : err);
        }
      },
    },

    // 7d. Correction pass — only runs when claims need hedging/attribution
    {
      name: 'correction_pass',
      type: 'code',
      when: (ctx) => (ctx.params._verifications as VerificationResult[] | undefined)?.some(needsCorrection) ?? false,
      execute: async (ctx) => {
        const results = ctx.params._verifications as VerificationResult[];
        const claims = ctx.params._claims as Claim[];
        const vcfg = ctx.params._verification as VerificationConfig | undefined;
        const md = ctx.params._reportMarkdown as string;
        const patch = buildPatchSet(results);
        const claimText: Record<string, string> = {};
        for (const c of claims) claimText[c.claim_id] = c.claim;
        try {
          const { system, user } = correctionPrompt(md, patch, claimText);
          const resp = await ctx.client.chat({
            model: vcfg?.judgeModel || ctx.model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            options: { temperature: 0.3, num_predict: 8192, ...(ctx.contextSize ? { num_ctx: ctx.contextSize } : {}) },
          });
          const corrected = stripThinking(resp.message?.content ?? '').trim();
          // Guard: only accept a revision that preserves the bulk of the report (no mass deletion)
          if (corrected.length > md.length * 0.7) {
            ctx.params._reportMarkdown = corrected;
            console.log(`[Verify] applied ${Object.keys(patch).length} correction(s)`);
          } else {
            console.warn('[Verify] correction output too short — keeping original draft');
          }
        } catch (err) {
          console.warn('[Verify] correction pass failed (keeping original):', err instanceof Error ? err.message : err);
        }
      },
    },

    // 7e. Append the verification appendix to the published report
    {
      name: 'verification_append',
      type: 'code',
      when: (ctx) => ((ctx.params._verifications as VerificationResult[] | undefined)?.length ?? 0) > 0,
      execute: (ctx) => {
        const section = verificationSection(ctx.params._verifications as VerificationResult[]);
        if (section) ctx.params._reportMarkdown = `${ctx.params._reportMarkdown as string}\n${section}`;
      },
    },

    // 8. Generate charts (matplotlib via code_session) — optional, non-blocking
    {
      name: 'generate_visuals',
      type: 'code',
      execute: async (ctx) => {
        const charts = (ctx.params._charts as any[]) ?? [];
        const slug = ctx.params.slug as string;
        ctx.params._validCharts = [];
        if (charts.length === 0) return;
        try {
          await ctx.executor('code_session', { action: 'start', session: 'research', runtime: 'python' }, ctx.toolContext);
          const resp = await ctx.client.chat({
            model: ctx.model,
            messages: [
              { role: 'system', content: ['Write ONE Python script generating ALL the requested charts. Output ONLY Python, no fences, no prose.', '', CHART_RULES.replace(/<SLUG>/g, slug)].join('\n') },
              { role: 'user', content: `Charts:\n${JSON.stringify(charts, null, 2)}\nSlug: ${slug}` },
            ],
            options: { temperature: 0.2, num_predict: 3000 },
          });
          const code = stripThinking(resp.message?.content ?? '').replace(/^```(?:python)?\n?/m, '').replace(/\n?```$/m, '').trim();
          await ctx.executor('code_session', { action: 'run', session: 'research', code }, ctx.toolContext);
          ctx.params._validCharts = charts
            .map((c: any) => c.name as string)
            .filter((name: string) => existsSync(join('data', 'workspaces', 'main', 'research', slug, `${name}.png`)));
          console.log(`[Research] Charts: ${(ctx.params._validCharts as string[]).length}/${charts.length} rendered`);
        } catch (err) {
          console.warn('[Research] Chart generation failed (continuing without charts):', err instanceof Error ? err.message : err);
        }
      },
    },

    // 9. Deterministic render: markdown → HTML, embed charts, wrap in template
    {
      name: 'render_report',
      type: 'code',
      execute: (ctx) => {
        const slug = ctx.params.slug as string;
        const validCharts = new Set(ctx.params._validCharts as string[]);
        let md = ctx.params._reportMarkdown as string;
        // Swap chart placeholders for <img> (filesystem path for LibreOffice) only if the file exists
        md = md.replace(/\{\{chart:([a-z0-9_\-]+)\}\}/gi, (_m, name) => {
          return validCharts.has(name)
            ? `\n\n![${name}](data/workspaces/main/research/${slug}/${name}.png)\n\n`
            : '';
        });
        let body = markdownToHtml(md);
        // Style the first H1 as the report title + add a meta line
        body = body.replace(/<h1>/, '<h1 class="report-title">');
        const meta = `<div class="report-meta">${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })} · ${(ctx.params._allSources as string[]).length} sources</div>`;
        body = body.replace(/(<\/h1>)/, `$1${meta}`);
        ctx.params._reportHtml = REPORT_TEMPLATE(ctx.params.topic as string, body);
      },
    },

    // 10. HTML → PDF via LibreOffice (document tool)
    {
      name: 'convert_pdf',
      type: 'tool',
      tool: 'document',
      resolveParams: (ctx) => ({
        action: 'create',
        content: ctx.params._reportHtml,
        format: 'pdf',
        filename: ctx.params.slug,
      }),
    },

    // 11. User-facing summary (streamed)
    {
      name: 'summary',
      type: 'llm',
      stream: true,
      temperature: 0.4,
      maxTokens: 400,
      buildPrompt: (ctx) => ({
        system: 'Write a 3-5 sentence summary of the key findings for the user. Plain prose, no markdown headers. Do NOT mention files, PDFs, or technical details — just the substance. /no_think',
        user: `Topic: ${ctx.params.topic}\n\nReport:\n${(ctx.params._reportMarkdown as string).slice(0, 3000)}`,
      }),
    },

    // 12. Finalize: attach the PDF
    {
      name: 'finalize',
      type: 'code',
      execute: (ctx) => {
        const slug = ctx.params.slug as string;
        const pdfPath = join('data', 'media', 'documents', `${slug}.pdf`);
        const summary = stripThinking(ctx.stageResults.summary as string);
        if (existsSync(pdfPath)) {
          ctx.answer = `${summary} [FILE:${pdfPath}]`;
        } else {
          console.warn('[Research] PDF not found after convert:', pdfPath);
          ctx.answer = `${summary}\n\n(Note: the report was generated but the PDF conversion did not produce a file.)`;
        }
      },
    },
  ],
};

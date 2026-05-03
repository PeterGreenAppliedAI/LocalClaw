import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineDefinition } from '../types.js';

// --- Artifact type slide structure guides ---
const SECTION_GUIDES: Record<string, string> = {
  memo: 'Title → Key Findings → Context → Analysis → Evidence → Recommendations → Sources (6-8 slides)',
  brief: 'Title → BLUF → Situation → Problem → Recommendation → Options → Risks → Timeline → Action → Appendix (8-12 slides)',
  deck: 'Title → Exec Summary → Highlights → Challenges → KPIs → Financials → Market → Competition → Strategy → Recommendations → Appendix (10-15 slides)',
  market: 'Title → Exec Summary → Industry Overview → Trends → Segments → Landscape Map → Competitors → Share → SWOT → Recommendations → Projections → Appendix (12-15 slides)',
  teardown: 'Title → Exec Summary → Competitor Overview → Product Matrix → Pricing → Strengths/Weaknesses → Positioning → Opportunities → Recommendations → Appendix (10-12 slides)',
  deepdive: 'Title → Context → Architecture → Flow → Deep Dive → Performance → Trade-offs → Limitations → Roadmap → Appendix (10-15 slides)',
  report: 'Executive Summary → Background → Analysis Section 1 → Analysis Section 2 → Analysis Section 3 → Data & Evidence → Recommendations → Sources (6-10 sections)',
};

const CHART_RULES = `Chart rules:
- import matplotlib; matplotlib.use('Agg')
- Save to: data/workspaces/main/research/<SLUG>/chart_name.png
- Create dir first: os.makedirs('data/workspaces/main/research/<SLUG>', exist_ok=True)
- EVERY chart MUST have: descriptive title, labeled axes, legend if multiple series, data labels on bars/points
- plt.tight_layout() then plt.close() after saving
- For stocks use yfinance. For other data, use values from research.

CRITICAL — chart styling boilerplate (copy EXACTLY at the top of the script):
\`\`\`python
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns

plt.rcParams.update({
    'figure.facecolor': '#1a1a2e',
    'axes.facecolor': '#16213e',
    'axes.edgecolor': '#e0e0e0',
    'axes.labelcolor': '#ffffff',
    'text.color': '#ffffff',
    'xtick.color': '#e0e0e0',
    'ytick.color': '#e0e0e0',
    'legend.facecolor': '#16213e',
    'legend.edgecolor': '#444444',
    'legend.labelcolor': '#ffffff',
    'grid.color': '#2a2a4a',
    'font.size': 12,
    'axes.titlesize': 14,
    'axes.labelsize': 12,
})
sns.set_theme(style='darkgrid', rc=plt.rcParams)
\`\`\`
Every axis label, tick label, title, legend, and data annotation MUST be clearly readable on the dark background. Use #ffffff for all text.`;

const DECK_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TITLE</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/black.css">
<style>
.reveal{font-family:'Segoe UI',system-ui,sans-serif}
.reveal h1,.reveal h2,.reveal h3{font-weight:600;text-transform:none;letter-spacing:-0.02em}
.reveal h1{font-size:2.2em} .reveal h2{font-size:1.6em}
.reveal h3{font-size:1.2em;color:#8be9fd}
.reveal p,.reveal li{font-size:0.85em;line-height:1.6}
.reveal ul{text-align:left}
.reveal .subtitle{font-size:0.7em;color:#aaa;margin-top:0.5em}
.reveal .metric{font-size:2.5em;font-weight:700;color:#50fa7b}
.reveal .metric-label{font-size:0.6em;color:#aaa}
.reveal table{margin:0 auto;border-collapse:collapse;font-size:0.75em}
.reveal th,.reveal td{padding:0.4em 1em;border:1px solid #444}
.reveal th{background:#333}
.reveal .two-col{display:flex;gap:2em;text-align:left}
.reveal .two-col>div{flex:1}
.reveal .slides section{overflow:hidden;box-sizing:border-box;max-height:700px}
.reveal img{max-height:350px}
.reveal .source{font-size:0.5em;color:#666;margin-top:1em}
.reveal .callout{background:#1e1e3f;border-left:4px solid #8be9fd;padding:0.8em 1.2em;margin:0.5em 0;text-align:left;border-radius:4px}
</style>
</head>
<body>
<div class="reveal"><div class="slides">
<!-- SLIDES -->
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
<script>Reveal.initialize({hash:true,controls:true,progress:true,slideNumber:true,transition:'slide',width:1280,height:720});</script>
</body></html>`;

const SLIDE_COMPONENTS = `Slide components:
- Title: <section><h1>Title</h1><p class="subtitle">Subtitle</p></section>
- Bullets: <section><h2>Title</h2><ul><li>Point</li></ul></section>
- Metric: <section><h2>Label</h2><div class="metric">$4.2B</div><div class="metric-label">Description</div></section>
- Two-column: <section><h2>Title</h2><div class="two-col"><div><h3>Left</h3><p>...</p></div><div><h3>Right</h3><p>...</p></div></div></section>
- Chart: <section><h2>Title</h2><img src="/console/api/files/research/SLUG/chart.png" alt="desc"></section>
- Callout: <div class="callout">Key insight</div>
- Source: <p class="source">Source: URL</p>`;

// --- Report mode: professional document styling ---
const REPORT_CSS = `
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; margin: 0; padding: 0; line-height: 1.7; }
.report { max-width: 780px; margin: 0 auto; padding: 40px 50px; }
h1.report-title { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 28px; font-weight: 700; color: #111; border-bottom: 3px solid #2563eb; padding-bottom: 12px; margin-bottom: 8px; }
.report-meta { font-size: 13px; color: #666; margin-bottom: 30px; }
h2 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 20px; font-weight: 600; color: #1e40af; margin-top: 32px; margin-bottom: 12px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
h3 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 16px; font-weight: 600; color: #374151; margin-top: 20px; }
p { margin: 10px 0; font-size: 14px; }
ul, ol { margin: 10px 0 10px 20px; font-size: 14px; }
li { margin-bottom: 6px; }
.executive-summary { background: #f0f4ff; border-left: 4px solid #2563eb; padding: 16px 20px; margin: 20px 0; border-radius: 0 4px 4px 0; }
.executive-summary p { margin: 6px 0; }
.callout { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 16px 0; border-radius: 0 4px 4px 0; font-size: 14px; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
th { background: #1e40af; color: #fff; padding: 10px 14px; text-align: left; font-family: 'Segoe UI', system-ui, sans-serif; font-weight: 600; white-space: nowrap; }
td { padding: 8px 14px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
tr:nth-child(even) td { background: #f9fafb; }
img { max-width: 100%; height: auto; margin: 16px 0; border: 1px solid #e5e7eb; border-radius: 4px; }
.sources { margin-top: 40px; border-top: 2px solid #e5e7eb; padding-top: 16px; }
.sources h2 { color: #6b7280; font-size: 16px; }
.sources ol { font-size: 12px; color: #4b5563; }
.sources a { color: #2563eb; text-decoration: none; }
.sources a:hover { text-decoration: underline; }
a { color: #2563eb; }
@media print { .report { padding: 20px; } h2 { page-break-after: avoid; } section { page-break-inside: avoid; } }
`;

const REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>TITLE</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="report">
<!-- CONTENT -->
</div>
</body>
</html>`;

const REPORT_COMPONENTS = `Report HTML components:
- Title: <h1 class="report-title">Report Title</h1><div class="report-meta">Date | Source Count</div>
- Executive Summary: <div class="executive-summary"><p>Key finding 1.</p><p>Key finding 2.</p></div>
- Section: <section><h2>Section Title</h2><p>Full paragraph with detailed analysis...</p><p>Another paragraph...</p></section>
- Subsection: <h3>Subtopic</h3><p>Details...</p>
- Callout: <div class="callout"><strong>Key Insight:</strong> Important finding here.</div>
- Table: <table><thead><tr><th>Column</th></tr></thead><tbody><tr><td>Data</td></tr></tbody></table>
- Chart: <img src="ABSOLUTE_PATH/chart.png" alt="Description">
- Sources: <div class="sources"><h2>Sources</h2><ol><li><a href="URL">Title - Domain</a></li></ol></div>
- Inline citation: <sup>[1]</sup> (number matches source list)`;

export const researchPipeline: PipelineDefinition = {
  name: 'research',
  stages: [
    // --- STAGE 0: Extract topic, artifact type, slug ---
    {
      name: 'extract_params',
      type: 'extract',
      schema: {
        topic: { type: 'string', description: 'The research topic', required: true },
        artifactType: {
          type: 'string',
          description: 'Type of research artifact to produce',
          enum: ['memo', 'brief', 'deck', 'market', 'teardown', 'deepdive', 'report'],
        },
        slug: { type: 'string', description: 'URL-safe slug for output filename' },
      },
      examples: [
        { input: '[RESEARCH PIPELINE]\nArtifact type: market\nTopic: EV battery trends\nOutput slug: ev-battery-trends', output: { topic: 'EV battery trends', artifactType: 'market', slug: 'ev-battery-trends' } },
        { input: '[RESEARCH PIPELINE]\nArtifact type: memo\nTopic: NVIDIA stock analysis\nOutput slug: nvidia-stock', output: { topic: 'NVIDIA stock analysis', artifactType: 'memo', slug: 'nvidia-stock' } },
      ],
    },

    // --- Fill defaults ---
    {
      name: 'defaults',
      type: 'code',
      execute: (ctx) => {
        if (!ctx.params.artifactType) ctx.params.artifactType = 'memo';
        if (!ctx.params.slug) {
          ctx.params.slug = (ctx.params.topic as string)
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        }
        ctx.params._searchQueries = [];
        ctx.params._allSearchResults = '';
        ctx.params._fetchedPages = [];
        ctx.params._chartPaths = [];
      },
    },

    // --- Infer report type from natural language ---
    {
      name: 'infer_report_type',
      type: 'code',
      execute: (ctx) => {
        const msg = ctx.userMessage.toLowerCase();
        const currentType = ctx.params.artifactType as string;
        if (!currentType || currentType === 'memo') {
          if (/\b(pdf|docx)\b.*\breport\b/i.test(msg) || /\breport\b.*\b(pdf|docx)\b/i.test(msg) || /\bpdf report\b/i.test(msg)) {
            ctx.params.artifactType = 'report';
            console.log('[Research] Inferred artifact type: report (from message keywords)');
          }
        }
      },
    },

    // --- STAGE 1: PLAN — generate search queries ---
    {
      name: 'plan',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 1024,
      buildPrompt: (ctx) => ({
        system: [
          'You are a senior research analyst planning a briefing.',
          'Given a research topic, output ONLY a JSON array of 3-5 specific search queries.',
          'Target PRIMARY sources: earnings calls, industry reports, regulatory filings, not just news.',
          'Include the current year in at least 2 queries for freshness.',
          'Output format: ["query 1", "query 2", "query 3"]',
          'Return ONLY the JSON array, nothing else.',
        ].join('\n'),
        user: `Topic: ${ctx.params.topic}\nCurrent year: ${new Date().getFullYear()}`,
      }),
    },

    // --- Parse search queries ---
    {
      name: 'parse_queries',
      type: 'code',
      execute: (ctx) => {
        const raw = ctx.stageResults.plan as string;
        try {
          const match = raw.match(/\[[\s\S]*\]/);
          if (match) {
            const queries = JSON.parse(match[0]);
            if (Array.isArray(queries)) {
              ctx.params._searchQueries = queries.slice(0, 5);
              return queries;
            }
          }
        } catch { /* fall through */ }
        // Fallback: use the topic as a single query
        ctx.params._searchQueries = [ctx.params.topic as string];
        return ctx.params._searchQueries;
      },
    },

    // --- STAGE 2: RETRIEVE — parallel searches ---
    {
      name: 'search_all',
      type: 'parallel_tool',
      tool: 'web_search',
      resolveParamsList: (ctx) => {
        const queries = ctx.params._searchQueries as string[];
        return queries.map(q => ({ query: q, count: '5' }));
      },
    },

    // --- Collect search results + pick top URLs ---
    {
      name: 'pick_urls',
      type: 'code',
      execute: (ctx) => {
        const results = ctx.stageResults.search_all as string[];
        ctx.params._allSearchResults = results.join('\n\n---\n\n');
        const allText = ctx.params._allSearchResults as string;
        const urlMatches = allText.match(/https?:\/\/[^\s)"\]]+/g) ?? [];
        const unique = [...new Set(urlMatches)].slice(0, 8);
        ctx.params._urls = unique;
        return unique;
      },
    },

    // --- Parallel page fetches ---
    {
      name: 'fetch_all',
      type: 'parallel_tool',
      tool: 'web_fetch',
      resolveParamsList: (ctx) => {
        const urls = ctx.params._urls as string[];
        return urls.map(url => ({ url, extractMode: 'text', maxChars: '4000' }));
      },
    },

    // --- Collect fetched pages, filter failures ---
    {
      name: 'collect_pages',
      type: 'code',
      execute: (ctx) => {
        const results = ctx.stageResults.fetch_all as string[];
        const urls = ctx.params._urls as string[];
        const pages: string[] = [];
        const failedUrls: string[] = [];

        for (let i = 0; i < results.length; i++) {
          const content = results[i];
          if (content.startsWith('Error') || content.length < 100) {
            failedUrls.push(urls[i]);
          } else {
            // Extract publication date from page content if present
            const dateMatch = content.match(
              /(?:Published|Updated|Posted|Date|Written)[:\s]*(\w+ \d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})/i,
            ) ?? content.match(
              /(\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i,
            );
            const dateTag = dateMatch ? ` [Published: ${dateMatch[1]}]` : '';
            pages.push(`[Source: ${urls[i]}${dateTag}]\n${content}`);
          }
        }

        ctx.params._fetchedPages = pages;
        ctx.params._failedUrlCount = failedUrls.length;
        console.log(`[Research] Fetched ${pages.length} pages, ${failedUrls.length} failed`);
        return pages;
      },
    },

    // --- Supplementary search if too many fetches failed ---
    {
      name: 'supplementary_search',
      type: 'parallel_tool',
      tool: 'web_search',
      when: (ctx) => (ctx.params._failedUrlCount as number ?? 0) >= 3,
      resolveParamsList: (ctx) => {
        console.log('[Research] Too many fetch failures — running supplementary search');
        return [{ query: `${ctx.params.topic} ${new Date().getFullYear()} analysis`, count: '5' }];
      },
    },

    // --- Supplementary fetch ---
    {
      name: 'supplementary_fetch',
      type: 'parallel_tool',
      tool: 'web_fetch',
      when: (ctx) => !!(ctx.stageResults.supplementary_search),
      resolveParamsList: (ctx) => {
        const results = ctx.stageResults.supplementary_search as string[];
        const allText = (results ?? []).join('\n');
        const urlMatches = allText.match(/https?:\/\/[^\s)"\]]+/g) ?? [];
        const existingUrls = new Set(ctx.params._urls as string[]);
        const newUrls = [...new Set(urlMatches)].filter(u => !existingUrls.has(u)).slice(0, 4);
        ctx.params._supplementaryUrls = newUrls;
        return newUrls.map(url => ({ url, extractMode: 'text', maxChars: '4000' }));
      },
    },

    // --- Merge supplementary pages ---
    {
      name: 'merge_supplementary',
      type: 'code',
      when: (ctx) => !!(ctx.stageResults.supplementary_fetch),
      execute: (ctx) => {
        const results = ctx.stageResults.supplementary_fetch as string[];
        const urls = ctx.params._supplementaryUrls as string[];
        const pages = ctx.params._fetchedPages as string[];

        for (let i = 0; i < results.length; i++) {
          if (!results[i].startsWith('Error') && results[i].length >= 100) {
            pages.push(`[Source: ${urls[i]}]\n${results[i]}`);
          }
        }

        ctx.params._fetchedPages = pages;
        console.log(`[Research] After supplementary: ${pages.length} total pages`);
      },
    },

    // --- STAGE 3: SYNTHESIZE — analyze and outline slides ---
    {
      name: 'synthesize',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 4096,
      buildPrompt: (ctx) => {
        const type = ctx.params.artifactType as string;
        const guide = SECTION_GUIDES[type] ?? SECTION_GUIDES.memo;
        const pages = (ctx.params._fetchedPages as string[]).join('\n\n===\n\n');
        const searchResults = ctx.params._allSearchResults as string;

        return {
          system: [
            'You are a senior research analyst. Synthesize the research data into a structured slide outline.',
            '',
            'Output a JSON object with this structure:',
            '{',
            '  "thesis": "One sentence thesis statement",',
            '  "slides": [',
            '    {',
            '      "title": "Slide Title",',
            '      "bullets": ["point 1", "point 2", "point 3"],',
            '      "sources": ["https://..."],',
            '      "needsChart": false,',
            '      "chartDescription": ""',
            '    }',
            '  ],',
            '  "chartData": [',
            '    {',
            '      "name": "chart_name",',
            '      "description": "What to visualize",',
            '      "dataPoints": "key data values from research"',
            '    }',
            '  ]',
            '}',
            '',
            `Section guide for ${type}: ${guide}`,
            '',
            'Rules:',
            ...(type === 'report' ? [
              '- Each section "bullets" should contain 2-4 FULL PARAGRAPHS (3-5 sentences each), not short bullets',
              '- Include specific data points, statistics, and direct quotes from the source material',
              '- Every claim MUST cite a source URL from the fetched pages (not a homepage)',
              '- At least 1 chart for data visualization',
            ] : [
              '- Max 4 bullet points per slide, max 15 words per bullet',
              '- Every major claim needs a source URL from the research, not a homepage',
              '- At least 2 charts. Identify data-heavy slides that benefit from visualization',
            ]),
            '- NEVER fabricate data — only use what is in the search results and fetched pages',
            '- DATES: Use ONLY dates that appear in the source material. Each source has a [Published: date] tag — use those dates. Do NOT guess or infer release dates. If a source does not include a date, say "date not confirmed" rather than inventing one.',
            '- Return ONLY the JSON object, no markdown or explanation',
          ].join('\n'),
          user: `Topic: ${ctx.params.topic}\n\n## Search Results\n${searchResults.slice(0, 6000)}\n\n## Fetched Pages\n${pages.slice(0, 12000)}`,
        };
      },
    },

    // --- Parse synthesis output ---
    {
      name: 'parse_synthesis',
      type: 'code',
      execute: (ctx) => {
        const raw = ctx.stageResults.synthesize as string;
        try {
          const match = raw.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            ctx.params._synthesis = parsed;
            return parsed;
          }
        } catch { /* fall through */ }
        // Fallback: store raw text
        ctx.params._synthesis = { thesis: '', slides: [], chartData: [] };
        ctx.params._synthesisRaw = raw;
        return raw;
      },
    },

    // --- STAGE 4: VISUALIZE — start code session ---
    {
      name: 'start_session',
      type: 'tool',
      tool: 'code_session',
      when: (ctx) => {
        const synthesis = ctx.params._synthesis as any;
        return Array.isArray(synthesis?.chartData) && synthesis.chartData.length > 0;
      },
      resolveParams: () => ({
        action: 'start',
        session: 'research',
        runtime: 'python',
      }),
    },

    // --- Generate and run chart code ---
    {
      name: 'generate_charts',
      type: 'llm',
      temperature: 0.2,
      maxTokens: 4096,
      when: (ctx) => {
        const synthesis = ctx.params._synthesis as any;
        return Array.isArray(synthesis?.chartData) && synthesis.chartData.length > 0;
      },
      buildPrompt: (ctx) => {
        const synthesis = ctx.params._synthesis as any;
        const slug = ctx.params.slug as string;
        const chartData = synthesis.chartData ?? [];

        return {
          system: [
            'You are a data visualization expert. Write Python code to generate ALL the requested charts.',
            'Output ONLY the Python code, no markdown fences, no explanation.',
            '',
            CHART_RULES.replace(/<SLUG>/g, slug),
            '',
            'Write ONE complete Python script that generates all charts.',
            'Import all libraries at the top. Handle each chart in sequence.',
          ].join('\n'),
          user: `Charts to generate:\n${JSON.stringify(chartData, null, 2)}\n\nSlug: ${slug}`,
        };
      },
    },

    // --- Execute chart code ---
    {
      name: 'run_charts',
      type: 'tool',
      tool: 'code_session',
      when: (ctx) => {
        const synthesis = ctx.params._synthesis as any;
        return Array.isArray(synthesis?.chartData) && synthesis.chartData.length > 0 && !!ctx.stageResults.generate_charts;
      },
      resolveParams: (ctx) => {
        let code = ctx.stageResults.generate_charts as string;
        // Strip markdown fences if present
        code = code.replace(/^```(?:python)?\n?/m, '').replace(/\n?```$/m, '').trim();
        return {
          action: 'run',
          session: 'research',
          code,
        };
      },
    },

    // --- Collect chart paths ---
    {
      name: 'collect_charts',
      type: 'code',
      execute: (ctx) => {
        const slug = ctx.params.slug as string;
        const synthesis = ctx.params._synthesis as any;
        const chartData = synthesis?.chartData ?? [];
        const paths = chartData.map((c: any) =>
          `/console/api/files/research/${slug}/${c.name}.png`
        );
        ctx.params._chartPaths = paths;
        return paths;
      },
    },

    // --- STAGE 5: BRANCH — deck vs report rendering ---
    {
      name: 'render_branch',
      type: 'branch',
      decide: (ctx) => (ctx.params.artifactType === 'report') ? 'report' : 'deck',
      branches: {
        // ======== DECK BRANCH (existing) ========
        deck: [
          {
            name: 'render_deck',
            type: 'llm',
            temperature: 0.2,
            maxTokens: 8192,
            buildPrompt: (ctx) => {
              const synthesis = ctx.params._synthesis as any;
              const slug = ctx.params.slug as string;
              const type = ctx.params.artifactType as string;
              const chartPaths = ctx.params._chartPaths as string[];
              return {
                system: [
                  'You are a presentation designer. Generate a complete reveal.js HTML deck from the slide outline.',
                  'Output ONLY the complete HTML document, no markdown fences, no explanation.',
                  '', `Use this template structure:\n${DECK_TEMPLATE}`, '',
                  SLIDE_COMPONENTS.replace(/SLUG/g, slug), '',
                  'Replace <!-- SLIDES --> with the actual <section> elements.',
                  'Replace TITLE in <title> with the actual title.',
                  `Chart images use absolute paths: /console/api/files/research/${slug}/chart_name.png`,
                  'Max 4 bullets per slide, max 15 words per bullet.',
                  'Include source URLs on relevant slides using <p class="source">.',
                  'Each chart MUST be its own standalone <section> — NEVER nest a <section> inside another <section>.',
                  'Place chart slides AFTER the related content slide, not inside it.',
                  'Never duplicate a heading — each <section> has exactly one <h2>.',
                ].join('\n'),
                user: [
                  `Artifact type: ${type}`,
                  `Thesis: ${synthesis?.thesis ?? 'N/A'}`,
                  `Slides: ${JSON.stringify(synthesis?.slides ?? [], null, 2)}`,
                  `Available charts: ${JSON.stringify(chartPaths)}`,
                ].join('\n'),
              };
            },
          },
          {
            name: 'write_deck',
            type: 'tool',
            tool: 'write_file',
            resolveParams: (ctx) => {
              let html = ctx.stageResults.render_deck as string;
              html = html.replace(/^```(?:html)?\n?/m, '').replace(/\n?```$/m, '').trim();
              const slug = ctx.params.slug as string;
              return { path: `research/${slug}.html`, content: html };
            },
          },
          {
            name: 'summary',
            type: 'llm',
            stream: true,
            temperature: 0.3,
            maxTokens: 512,
            buildPrompt: (ctx) => {
              const synthesis = ctx.params._synthesis as any;
              return {
                system: 'Write a brief 3-5 sentence summary of the research findings. Be factual and concise. Do not mention the deck or file — just summarize what was found.',
                user: `Thesis: ${synthesis?.thesis ?? ''}\nSlides: ${JSON.stringify((synthesis?.slides ?? []).map((s: any) => s.title))}`,
              };
            },
          },
          {
            name: 'finalize',
            type: 'code',
            execute: (ctx) => {
              const summary = ctx.stageResults.summary as string;
              const slug = ctx.params.slug as string;
              ctx.answer = `${summary}\n\n📊 **View your deck:** /console/api/files/research/${slug}.html`;
            },
          },
        ],

        // ======== REPORT BRANCH (new) ========
        report: [
          // Render styled HTML report from synthesis data
          {
            name: 'render_report',
            type: 'llm',
            temperature: 0.3,
            maxTokens: 8192,
            buildPrompt: (ctx) => {
              const synthesis = ctx.params._synthesis as any;
              const slug = ctx.params.slug as string;
              const chartPaths = ctx.params._chartPaths as string[];
              // Convert web chart paths to filesystem paths for PDF rendering
              const fsChartPaths = chartPaths.map((p: string) =>
                p.replace('/console/api/files/', 'data/workspaces/main/'),
              );

              return {
                system: [
                  'You are a professional report writer. Generate a complete, styled HTML document from the research synthesis.',
                  'Output ONLY the complete HTML document, no markdown fences, no explanation.',
                  '',
                  `Use this template:\n${REPORT_TEMPLATE}`,
                  '',
                  REPORT_COMPONENTS.replace(/ABSOLUTE_PATH/g, `data/workspaces/main/research/${slug}`),
                  '',
                  'Replace <!-- CONTENT --> with the full report content.',
                  'Replace TITLE with the actual report title.',
                  '',
                  'CRITICAL RULES:',
                  '- Write FULL PARAGRAPHS (3-5 sentences each), not bullet summaries',
                  '- Every section must have substantive analysis, not just headlines',
                  '- Include specific data points, statistics, and quotes from the source material',
                  '- DATES: Only use dates that appear in the source material (look for [Published: date] tags). NEVER guess release dates or event dates. If a date is not in the sources, write "date not confirmed".',
                  '- Use inline citations <sup>[1]</sup> linking to the numbered sources list',
                  '- Include a Sources section at the end with ALL URLs from the research',
                  '- Use tables for comparative data, callout boxes for key insights',
                  '- Place charts inline with relevant content using absolute filesystem paths',
                  `- Chart paths: ${JSON.stringify(fsChartPaths)}`,
                ].join('\n'),
                user: [
                  `Topic: ${ctx.params.topic}`,
                  `Today's date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
                  `Thesis: ${synthesis?.thesis ?? 'N/A'}`,
                  `Sections: ${JSON.stringify(synthesis?.slides ?? [], null, 2)}`,
                  `Available charts: ${JSON.stringify(fsChartPaths)}`,
                ].join('\n'),
              };
            },
          },

          // Write HTML to file (for preview and revision)
          {
            name: 'write_report_html',
            type: 'code',
            execute: (ctx) => {
              let html = ctx.stageResults.render_report as string;
              html = html.replace(/^```(?:html)?\n?/m, '').replace(/\n?```$/m, '').trim();
              ctx.params._reportHtml = html;
              const slug = ctx.params.slug as string;
              const dir = join('data', 'workspaces', 'main', 'research');
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, `${slug}-report.html`), html);
              console.log(`[Research] Report HTML written: research/${slug}-report.html`);
            },
          },

          // Quality review — check content completeness and source citations
          {
            name: 'quality_review',
            type: 'code',
            execute: async (ctx) => {
              const html = ctx.params._reportHtml as string;
              if (!html || html.length < 200) {
                console.log('[Research] Quality review: HTML too short, skipping');
                return;
              }

              try {
                const response = await ctx.client.chat({
                  model: ctx.routerModel ?? ctx.model,
                  messages: [{
                    role: 'user',
                    content: `Review this HTML report for quality. Be brief.

${html.slice(0, 4000)}

Check:
1. Are there at least 3 substantive sections with full paragraphs (not just bullets)?
2. Are source URLs cited (either inline or in a Sources section)?
3. Is the content detailed enough to be useful (not just headlines)?
4. Are dates accurate? If the report claims something was "released in April 2026" or similar, verify it matches the source dates. Dates should come from the source material, not be assumed.

Respond with JSON: {"pass": true} if adequate, or {"pass": false, "fix": "brief instruction to improve"} if not.`,
                  }],
                  options: { temperature: 0.2, num_predict: 256 },
                });

                const raw = response.message?.content ?? '';
                const match = raw.match(/\{[\s\S]*\}/);
                if (!match) { console.log('[Research] Quality review: no JSON, proceeding'); return; }

                const result = JSON.parse(match[0]);
                if (result.pass) {
                  console.log('[Research] Quality review: PASS');
                } else {
                  console.log(`[Research] Quality review: FAIL — ${result.fix}`);
                  ctx.params._revisionNeeded = true;
                  ctx.params._revisionInstructions = result.fix;
                }
              } catch (err) {
                console.warn('[Research] Quality review failed:', err instanceof Error ? err.message : err);
              }
            },
          },

          // Revision pass (conditional — only if quality review failed)
          {
            name: 'revision_pass',
            type: 'code',
            when: (ctx) => !!(ctx.params._revisionNeeded),
            execute: async (ctx) => {
              const html = ctx.params._reportHtml as string;
              const instructions = ctx.params._revisionInstructions as string;

              try {
                console.log('[Research] Running revision pass...');
                const response = await ctx.client.chat({
                  model: ctx.model,
                  messages: [{
                    role: 'user',
                    content: `Revise this HTML report. ${instructions}\n\nOutput ONLY the complete revised HTML, no markdown fences.\n\n${html}`,
                  }],
                  options: { temperature: 0.3, num_predict: 8192 },
                });

                let revised = (response.message?.content ?? '').trim();
                revised = revised.replace(/^```(?:html)?\n?/m, '').replace(/\n?```$/m, '').trim();

                if (revised.length > html.length * 0.5) {
                  ctx.params._reportHtml = revised;
                  const slug = ctx.params.slug as string;
                  writeFileSync(join('data', 'workspaces', 'main', 'research', `${slug}-report.html`), revised);
                  console.log('[Research] Revision applied');
                } else {
                  console.log('[Research] Revision too short, keeping original');
                }
              } catch (err) {
                console.warn('[Research] Revision failed:', err instanceof Error ? err.message : err);
              }
            },
          },

          // Convert HTML to PDF via document tool
          {
            name: 'convert_pdf',
            type: 'tool',
            tool: 'document',
            resolveParams: (ctx) => {
              const html = ctx.params._reportHtml as string;
              const slug = ctx.params.slug as string;
              return { action: 'create', content: html, format: 'pdf', filename: slug };
            },
          },

          // Summary for the user
          {
            name: 'report_summary',
            type: 'llm',
            stream: true,
            temperature: 0.3,
            maxTokens: 512,
            buildPrompt: (ctx) => {
              const synthesis = ctx.params._synthesis as any;
              return {
                system: 'Write a brief 3-5 sentence summary of the research findings. Be factual and concise. Do not mention files, PDFs, or technical details — just summarize what was found.',
                user: `Thesis: ${synthesis?.thesis ?? ''}\nSections: ${JSON.stringify((synthesis?.slides ?? []).map((s: any) => s.title))}`,
              };
            },
          },

          // Append [FILE:] token for delivery
          {
            name: 'report_finalize',
            type: 'code',
            execute: (ctx) => {
              const summary = ctx.stageResults.report_summary as string;
              const slug = ctx.params.slug as string;
              const pdfPath = `data/media/documents/${slug}.pdf`;
              ctx.answer = `${summary} [FILE:${pdfPath}]`;
            },
          },
        ],
      },
    },
  ],
};

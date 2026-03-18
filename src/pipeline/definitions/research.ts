import type { PipelineDefinition } from '../types.js';

// --- Artifact type slide structure guides ---
const SECTION_GUIDES: Record<string, string> = {
  memo: 'Title → Key Findings → Context → Analysis → Evidence → Recommendations → Sources (6-8 slides)',
  brief: 'Title → BLUF → Situation → Problem → Recommendation → Options → Risks → Timeline → Action → Appendix (8-12 slides)',
  deck: 'Title → Exec Summary → Highlights → Challenges → KPIs → Financials → Market → Competition → Strategy → Recommendations → Appendix (10-15 slides)',
  market: 'Title → Exec Summary → Industry Overview → Trends → Segments → Landscape Map → Competitors → Share → SWOT → Recommendations → Projections → Appendix (12-15 slides)',
  teardown: 'Title → Exec Summary → Competitor Overview → Product Matrix → Pricing → Strengths/Weaknesses → Positioning → Opportunities → Recommendations → Appendix (10-12 slides)',
  deepdive: 'Title → Context → Architecture → Flow → Deep Dive → Performance → Trade-offs → Limitations → Roadmap → Appendix (10-15 slides)',
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
          enum: ['memo', 'brief', 'deck', 'market', 'teardown', 'deepdive'],
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
        const unique = [...new Set(urlMatches)].slice(0, 5);
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

    // --- Collect fetched pages ---
    {
      name: 'collect_pages',
      type: 'code',
      execute: (ctx) => {
        const results = ctx.stageResults.fetch_all as string[];
        const urls = ctx.params._urls as string[];
        ctx.params._fetchedPages = results.map((content, i) =>
          `[Source: ${urls[i]}]\n${content}`
        );
        return ctx.params._fetchedPages;
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
            '- Max 4 bullet points per slide, max 15 words per bullet',
            '- Every major claim needs a source URL from the research, not a homepage',
            '- At least 2 charts. Identify data-heavy slides that benefit from visualization',
            '- NEVER fabricate data — only use what is in the search results and fetched pages',
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

    // --- STAGE 5: RENDER — generate HTML deck ---
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
            '',
            `Use this template structure:\n${DECK_TEMPLATE}`,
            '',
            SLIDE_COMPONENTS.replace(/SLUG/g, slug),
            '',
            'Replace <!-- SLIDES --> with the actual <section> elements.',
            'Replace TITLE in <title> with the actual title.',
            `Chart images use absolute paths: /console/api/files/research/${slug}/chart_name.png`,
            'Max 4 bullets per slide, max 15 words per bullet.',
            'Include source URLs on relevant slides using <p class="source">.',
            'Place charts inline with relevant content, not grouped at end.',
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

    // --- Write deck to file ---
    {
      name: 'write_deck',
      type: 'tool',
      tool: 'write_file',
      resolveParams: (ctx) => {
        let html = ctx.stageResults.render_deck as string;
        // Strip markdown fences if present
        html = html.replace(/^```(?:html)?\n?/m, '').replace(/\n?```$/m, '').trim();
        const slug = ctx.params.slug as string;
        return {
          path: `research/${slug}.html`,
          content: html,
        };
      },
    },

    // --- Final summary ---
    {
      name: 'summary',
      type: 'llm',
      stream: true,
      temperature: 0.3,
      maxTokens: 512,
      buildPrompt: (ctx) => {
        const synthesis = ctx.params._synthesis as any;
        const slug = ctx.params.slug as string;
        const writeResult = ctx.stageResults.write_deck as string;

        return {
          system: 'Write a brief 3-5 sentence summary of the research findings. Be factual and concise. Do not mention the deck or file — just summarize what was found.',
          user: `Thesis: ${synthesis?.thesis ?? ''}\nSlides: ${JSON.stringify((synthesis?.slides ?? []).map((s: any) => s.title))}`,
        };
      },
    },

    // --- Append deck link to answer ---
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
};

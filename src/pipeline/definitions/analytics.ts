import type { PipelineDefinition } from '../types.js';

/**
 * Chart styling rules shared with the research pipeline.
 * Dark theme, clean labels, seaborn defaults.
 */
const CHART_SETUP = `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns
import pandas as pd
import numpy as np
import json
import os

sns.set_theme(style='darkgrid')
plt.rcParams.update({'figure.facecolor': '#1a1a2e', 'axes.facecolor': '#16213e',
  'text.color': 'white', 'axes.labelcolor': 'white', 'xtick.color': 'white', 'ytick.color': 'white'})

CHART_DIR = 'data/media/charts'
os.makedirs(CHART_DIR, exist_ok=True)
`;

/**
 * Analytics pipeline: load_data → describe → analyze → visualize → synthesize
 *
 * Triggered when a user uploads a data file (.csv, .xlsx, .json).
 * Code stages handle file loading and chart execution.
 * LLM stages decide what analysis to run and synthesize findings.
 */
export const analyticsPipeline: PipelineDefinition = {
  name: 'analytics',
  stages: [
    // Stage 0: Extract file path from message (injected by orchestrator as [DATA_FILE:path])
    {
      name: 'extract_file',
      type: 'code',
      execute: (ctx) => {
        const match = ctx.userMessage.match(/\[DATA_FILE:([^\]]+)\]/);
        if (match) {
          ctx.params.filePath = match[1].trim();
        }
        // Clean the token from the message so the LLM doesn't see it
        ctx.userMessage = ctx.userMessage.replace(/\[DATA_FILE:[^\]]+\]/g, '').trim();
        return ctx.params.filePath ?? 'unknown';
      },
    },

    // Stage 1: Load data into pandas and produce a summary
    {
      name: 'load_data',
      type: 'tool',
      tool: 'code_session',
      resolveParams: (ctx) => {
        const filePath = ctx.params.filePath as string ?? '';
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

        let loadCode: string;
        if (ext === 'xlsx' || ext === 'xls') {
          loadCode = `df = pd.read_excel("${filePath}")`;
        } else if (ext === 'json') {
          loadCode = `df = pd.read_json("${filePath}")`;
        } else {
          loadCode = `df = pd.read_csv("${filePath}")`;
        }

        return {
          runtime: 'python',
          code: `${CHART_SETUP}
${loadCode}
print(f"Shape: {df.shape[0]} rows x {df.shape[1]} columns")
print(f"\\nColumns: {list(df.columns)}")
print(f"\\nData types:\\n{df.dtypes.to_string()}")
print(f"\\nFirst 5 rows:\\n{df.head().to_string()}")
print(f"\\nBasic statistics:\\n{df.describe(include='all').to_string()}")
print(f"\\nNull counts:\\n{df.isnull().sum().to_string()}")
numeric_cols = df.select_dtypes(include='number').columns.tolist()
categorical_cols = df.select_dtypes(include=['object', 'category']).columns.tolist()
datetime_cols = df.select_dtypes(include='datetime').columns.tolist()
print(f"\\nColumn types: numeric={numeric_cols}, categorical={categorical_cols}, datetime={datetime_cols}")
`,
        };
      },
    },

    // Stage 2: LLM decides what analysis to run based on the data summary + user question
    {
      name: 'analyze',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 2048,
      buildPrompt: (ctx) => {
        const dataSummary = ctx.stageResults.load_data as string;
        const userMessage = ctx.userMessage;

        return {
          system: `You are a data analyst. Based on the data summary below, decide what analyses and charts to produce.

Return ONLY a JSON object with this structure:
{
  "insights": ["key observation 1", "key observation 2"],
  "charts": [
    {"type": "bar|line|scatter|hist|heatmap|pie|box", "title": "Chart Title", "code": "matplotlib/seaborn code to generate this chart"}
  ]
}

Rules for chart code:
- Data is already loaded as \`df\` in the Python session
- Use seaborn or matplotlib — dark theme is already set
- Save each chart: plt.savefig(f'{CHART_DIR}/chart_N.png', dpi=150, bbox_inches='tight'); plt.close()
- Number charts starting from 1
- Max 4 charts — pick the most informative visualizations
- If the user asked a specific question, focus charts on answering it
- If no specific question, show: distribution of key numeric columns, correlations, category breakdowns`,
          user: `Data Summary:\n${dataSummary}\n\nUser's request: "${userMessage}"`,
        };
      },
    },

    // Stage 3: Parse analysis plan and execute chart code
    {
      name: 'visualize',
      type: 'code',
      execute: async (ctx) => {
        const raw = ctx.stageResults.analyze as string;

        // Parse the LLM's JSON response
        let analysis: { insights: string[]; charts: Array<{ type: string; title: string; code: string }> };
        try {
          const jsonMatch = raw.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('No JSON found');
          analysis = JSON.parse(jsonMatch[0]);
        } catch {
          // LLM didn't return valid JSON — skip charts, just use insights
          ctx.stageResults.visualize = { insights: [raw], chartPaths: [] };
          return;
        }

        const chartPaths: string[] = [];

        // Execute each chart's code in the existing Python session
        if (analysis.charts?.length) {
          for (let i = 0; i < analysis.charts.length; i++) {
            const chart = analysis.charts[i];
            try {
              const result = await ctx.executor('code_session', {
                runtime: 'python',
                code: chart.code,
              }, ctx.toolContext);

              const expectedPath = `data/media/charts/chart_${i + 1}.png`;
              const { existsSync } = await import('node:fs');
              if (existsSync(expectedPath)) {
                chartPaths.push(expectedPath);
              }
              ctx.steps.push({ tool: 'code_session', params: { chart: chart.title }, observation: result });
            } catch (err) {
              console.warn(`[Analytics] Chart "${chart.title}" failed:`, err instanceof Error ? err.message : err);
            }
          }
        }

        ctx.stageResults.visualize = {
          insights: analysis.insights ?? [],
          chartPaths,
        };
      },
    },

    // Stage 4: Synthesize findings into a natural language response
    {
      name: 'synthesize',
      type: 'llm',
      stream: true,
      temperature: 0.5,
      maxTokens: 4096,
      buildPrompt: (ctx) => {
        const dataSummary = ctx.stageResults.load_data as string;
        const vizResult = ctx.stageResults.visualize as { insights: string[]; chartPaths: string[] };
        const insights = vizResult?.insights ?? [];
        const chartPaths = vizResult?.chartPaths ?? [];

        const chartSection = chartPaths.length > 0
          ? `\n\nCharts generated (${chartPaths.length}):\n${chartPaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
          : '\n\nNo charts were generated.';

        // Append [FILE:] tokens so they get extracted for delivery
        const fileTokens = chartPaths.map(p => `[FILE:${p}]`).join(' ');
        if (fileTokens) {
          ctx.stageResults._fileTokens = fileTokens;
        }

        return {
          system: `You are a data analyst presenting findings to a non-technical user. Summarize the key insights from the data analysis. Be concise and actionable. Use markdown formatting (headers, bullet points, bold for key numbers). Do NOT reference file paths or chart filenames — the charts will be attached automatically.`,
          user: `Data overview:\n${(dataSummary as string).slice(0, 2000)}\n\nKey insights:\n${insights.join('\n')}\n${chartSection}\n\nUser's original question: "${ctx.userMessage}"`,
        };
      },
    },

    // Stage 5: Append file tokens for media delivery
    {
      name: 'attach_charts',
      type: 'code',
      execute: (ctx) => {
        const fileTokens = ctx.stageResults._fileTokens as string | undefined;
        if (fileTokens && ctx.answer) {
          ctx.answer = ctx.answer + '\n' + fileTokens;
        }
      },
    },
  ],
};

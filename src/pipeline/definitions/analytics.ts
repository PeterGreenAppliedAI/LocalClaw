import type { PipelineDefinition } from '../types.js';

/**
 * Analytics pipeline: extract_file → load_and_report → generate_charts → interpret → attach_charts
 *
 * Code computes ALL numbers (totals, breakdowns, top items, distributions).
 * LLM ONLY interprets what the data means — never computes or formats numbers.
 *
 * Pattern: code handles the "what", model handles the "so what".
 */
export const analyticsPipeline: PipelineDefinition = {
  name: 'analytics',
  stages: [
    // Stage 0: Extract file path from message and resolve to absolute path
    {
      name: 'extract_file',
      type: 'code',
      execute: async (ctx) => {
        const match = ctx.userMessage.match(/\[DATA_FILE:([^\]]+)\]/);
        if (match) {
          const rawPath = match[1].trim();
          const { resolve } = await import('node:path');
          ctx.params.filePath = resolve(rawPath);
        }
        ctx.userMessage = ctx.userMessage.replace(/\[DATA_FILE:[^\]]+\]/g, '').trim();
        return ctx.params.filePath ?? 'unknown';
      },
    },

    // Stage 1: Load data + compute complete report in Python (deterministic)
    {
      name: 'report',
      type: 'code',
      execute: async (ctx) => {
        const filePath = ctx.params.filePath as string ?? '';
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const safePath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        let loadCode: string;
        if (ext === 'xlsx' || ext === 'xls') {
          loadCode = `df = pd.read_excel(r'${safePath}')`;
        } else if (ext === 'json') {
          loadCode = `df = pd.read_json(r'${safePath}')`;
        } else {
          loadCode = `df = pd.read_csv(r'${safePath}')`;
        }

        const pyCode = [
          'import pandas as pd',
          'import json',
          '',
          loadCode,
          '',
          'numeric_cols = df.select_dtypes(include="number").columns.tolist()',
          'categorical_cols = df.select_dtypes(include=["object", "category", "str"]).columns.tolist()',
          '',
          '# === BUILD STRUCTURED REPORT ===',
          'report = []',
          '',
          '# Overview',
          'report.append("## Overview")',
          'report.append("- **Rows:** " + str(len(df)))',
          'report.append("- **Columns:** " + str(len(df.columns)) + " (" + ", ".join(df.columns[:10].tolist()) + ("..." if len(df.columns) > 10 else "") + ")")',
          'report.append("")',
          '',
          '# Numeric totals',
          'if numeric_cols:',
          '    report.append("## Numeric Totals")',
          '    report.append("| Column | Sum | Mean | Min | Max |")',
          '    report.append("|--------|-----|------|-----|-----|")',
          '    for col in numeric_cols:',
          '        s = round(float(df[col].sum()), 2)',
          '        m = round(float(df[col].mean()), 2)',
          '        mn = round(float(df[col].min()), 2)',
          '        mx = round(float(df[col].max()), 2)',
          '        report.append("| " + col + " | " + str(s) + " | " + str(m) + " | " + str(mn) + " | " + str(mx) + " |")',
          '    report.append("")',
          '',
          '# Smart column selection for analysis',
          '# Prefer "Total"/"Amount"/"Value"/"Price" over raw numeric cols',
          'amount_keywords = ["total", "amount", "value", "price", "cost", "revenue", "spend", "budget"]',
          'main_num = None',
          'for keyword in amount_keywords:',
          '    for col in numeric_cols:',
          '        if keyword in col.lower():',
          '            main_num = col',
          '            break',
          '    if main_num:',
          '        break',
          'if not main_num:',
          '    main_num = numeric_cols[-1] if numeric_cols else None',
          '',
          '# Prefer grouping cols with low cardinality (Category/Type/Status) over high (Description/Name)',
          'group_cols = []',
          'for col in categorical_cols:',
          '    nuniq = df[col].nunique()',
          '    if 2 <= nuniq <= 15:',
          '        group_cols.append(col)',
          'if not group_cols:',
          '    group_cols = [c for c in categorical_cols if df[c].nunique() <= 30][:3]',
          '',
          '# Category breakdowns — group meaningful categorical cols by the amount column',
          'if main_num and group_cols:',
          '    for cat_col in group_cols[:3]:',
          '        try:',
          '            gb = df.groupby(cat_col)[main_num].agg(["sum", "count"]).sort_values("sum", ascending=False)',
          '            report.append("## " + cat_col + " by " + main_num)',
          '            report.append("| " + cat_col + " | Sum | Count |")',
          '            report.append("|------|-----|-------|")',
          '            for idx, row in gb.iterrows():',
          '                report.append("| " + str(idx) + " | " + str(round(float(row["sum"]), 2)) + " | " + str(int(row["count"])) + " |")',
          '            report.append("")',
          '        except Exception:',
          '            pass',
          '',
          '# Top items by amount column',
          'if main_num:',
          '    top = df.nlargest(10, main_num)',
          '    # Pick the best label column — prefer Description/Name/Item cols',
          '    label_keywords = ["description", "item", "name", "product", "title"]',
          '    label_col = None',
          '    for col in categorical_cols:',
          '        if any(k in col.lower() for k in label_keywords):',
          '            label_col = col',
          '            break',
          '    if not label_col and categorical_cols:',
          '        label_col = categorical_cols[0]',
          '    if label_col:',
          '        report.append("## Top 10 by " + main_num)',
          '        report.append("| " + label_col + " | " + main_num + " |")',
          '        report.append("|------|------|")',
          '        for _, row in top.iterrows():',
          '            report.append("| " + str(row[label_col]) + " | " + str(round(float(row[main_num]), 2)) + " |")',
          '        report.append("")',
          '',
          '# Raw data for LLM interpretation',
          'raw_data = {}',
          'for col in numeric_cols:',
          '    raw_data[col + "_sum"] = round(float(df[col].sum()), 2)',
          'raw_data["row_count"] = len(df)',
          'report.append("## Raw Aggregations (for interpretation)")',
          'report.append("```json")',
          'report.append(json.dumps(raw_data, indent=2, default=str))',
          'report.append("```")',
          '',
          'print("\\n".join(report))',
        ].join('\n');

        const { execFileSync } = await import('node:child_process');
        const { writeFileSync: writeFs, unlinkSync: unlinkFs } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const tmpScript = joinPath('/tmp', `analytics_${Date.now()}.py`);
        writeFs(tmpScript, pyCode);
        try {
          const output = execFileSync('python3', [tmpScript], {
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
          });
          return output;
        } catch (err: any) {
          return `Error: ${err.stderr || err.message}`;
        } finally {
          try { unlinkFs(tmpScript); } catch { /* ignore */ }
        }
      },
    },

    // Stage 2: Generate charts from the data (deterministic Python)
    {
      name: 'generate_charts',
      type: 'code',
      execute: async (ctx) => {
        const filePath = ctx.params.filePath as string ?? '';
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const safePath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        let loadCode: string;
        if (ext === 'xlsx' || ext === 'xls') {
          loadCode = `df = pd.read_excel(r'${safePath}')`;
        } else if (ext === 'json') {
          loadCode = `df = pd.read_json(r'${safePath}')`;
        } else {
          loadCode = `df = pd.read_csv(r'${safePath}')`;
        }

        // Deterministic chart generation — no LLM decides what to chart
        const pyCode = [
          'import matplotlib',
          'matplotlib.use("Agg")',
          'import matplotlib.pyplot as plt',
          'import seaborn as sns',
          'import pandas as pd',
          'import os',
          '',
          'sns.set_theme(style="darkgrid")',
          'plt.rcParams.update({"figure.facecolor": "#1a1a2e", "axes.facecolor": "#16213e",',
          '  "text.color": "white", "axes.labelcolor": "white", "xtick.color": "white", "ytick.color": "white"})',
          '',
          'CHART_DIR = "data/media/charts"',
          'os.makedirs(CHART_DIR, exist_ok=True)',
          '',
          loadCode,
          '',
          'numeric_cols = df.select_dtypes(include="number").columns.tolist()',
          'categorical_cols = df.select_dtypes(include=["object", "category", "str"]).columns.tolist()',
          'charts_created = []',
          '',
          '# Smart column selection — same as report stage',
          'amount_keywords = ["total", "amount", "value", "price", "cost", "revenue", "spend", "budget"]',
          'main_num = None',
          'for keyword in amount_keywords:',
          '    for col in numeric_cols:',
          '        if keyword in col.lower():',
          '            main_num = col',
          '            break',
          '    if main_num:',
          '        break',
          'if not main_num:',
          '    main_num = numeric_cols[-1] if numeric_cols else None',
          '',
          'group_keywords = ["category", "type", "status", "subcategory", "department", "group", "class"]',
          'group_cols = []',
          'for keyword in group_keywords:',
          '    for col in categorical_cols:',
          '        if keyword in col.lower() and 2 <= df[col].nunique() <= 15 and col not in group_cols:',
          '            group_cols.append(col)',
          'for col in categorical_cols:',
          '    if col not in group_cols and 2 <= df[col].nunique() <= 15:',
          '        group_cols.append(col)',
          'if not group_cols:',
          '    group_cols = [c for c in categorical_cols if df[c].nunique() <= 30][:2]',
          '',
          '# Clean NaN only from columns used in charts — full dropna removes valid data rows',
          'df_clean = df.copy()',
          '',
          '# Chart 1: Category breakdown bar chart',
          'if main_num and group_cols:',
          '    cat_col = group_cols[0]',
          '    gb = df_clean.dropna(subset=[cat_col, main_num]).groupby(cat_col)[main_num].sum().sort_values(ascending=True)',
          '    gb.index = gb.index.astype(str)',
          '    if len(gb) > 1:',
          '        fig, ax = plt.subplots(figsize=(10, 6))',
          '        ax.barh(gb.index.tolist(), gb.values.tolist())',
          '        ax.set_title(cat_col + " by " + main_num, fontsize=14)',
          '        ax.set_xlabel(main_num)',
          '        plt.tight_layout()',
          '        path = os.path.join(CHART_DIR, "chart_1.png")',
          '        plt.savefig(path, dpi=150, bbox_inches="tight")',
          '        plt.close()',
          '        charts_created.append(path)',
          '',
          '# Chart 2: Top items bar chart',
          'if main_num:',
          '    label_keywords = ["description", "item", "name", "product", "title"]',
          '    label_col = None',
          '    for col in categorical_cols:',
          '        if any(k in col.lower() for k in label_keywords):',
          '            label_col = col',
          '            break',
          '    if not label_col and categorical_cols:',
          '        label_col = categorical_cols[0]',
          '    if label_col:',
          '        top = df_clean.dropna(subset=[main_num, label_col]).nlargest(10, main_num)',
          '        labels = [str(x) for x in top[label_col].tolist()]',
          '        values = [float(x) for x in top[main_num].tolist()]',
          '        fig, ax = plt.subplots(figsize=(10, 6))',
          '        ax.barh(labels, values)',
          '        ax.set_title("Top Items by " + main_num, fontsize=14)',
          '        ax.set_xlabel(main_num)',
          '        plt.tight_layout()',
          '        path = os.path.join(CHART_DIR, "chart_2.png")',
          '        plt.savefig(path, dpi=150, bbox_inches="tight")',
          '        plt.close()',
          '        charts_created.append(path)',
          '',
          'print("Charts created: " + str(len(charts_created)))',
          'for p in charts_created:',
          '    print(p)',
        ].join('\n');

        const { execFileSync } = await import('node:child_process');
        const { writeFileSync: writeFs, unlinkSync: unlinkFs } = await import('node:fs');
        const { join: joinPath } = await import('node:path');
        const tmpScript = joinPath('/tmp', `analytics_charts_${Date.now()}.py`);
        writeFs(tmpScript, pyCode);
        try {
          const output = execFileSync('python3', [tmpScript], {
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf-8',
          });
          // Extract chart paths from output
          const lines = output.trim().split('\n');
          const chartPaths = lines.filter(l => l.startsWith('data/media/charts/'));
          ctx.stageResults.chartPaths = chartPaths;
          return output;
        } catch (err: any) {
          console.warn('[Analytics] Chart generation failed:', err.stderr?.slice(0, 200) || err.message);
          ctx.stageResults.chartPaths = [];
          return 'Chart generation failed';
        } finally {
          try { unlinkFs(tmpScript); } catch { /* ignore */ }
        }
      },
    },

    // Stage 3: LLM interprets — ONLY adds "so what", never formats or computes
    {
      name: 'interpret',
      type: 'llm',
      stream: true,
      temperature: 0.5,
      maxTokens: 8192,
      buildPrompt: (ctx) => {
        const report = ctx.stageResults.report as string;
        const chartPaths = (ctx.stageResults.chartPaths as string[]) ?? [];

        // Append [FILE:] tokens for chart delivery
        if (chartPaths.length > 0) {
          ctx.stageResults._fileTokens = chartPaths.map(p => `[FILE:${p}]`).join(' ');
        }

        return {
          system: `You are a senior data analyst. A code pipeline has already computed exact numbers from the dataset. The structured report below is your source of truth.

YOUR JOB: Write an EXECUTIVE ANALYSIS that answers "so what?" — not a reformatted spreadsheet.

Structure your response as:
1. **Bottom line** (1-2 sentences — the single most important takeaway, with the total figure)
2. **Key findings** (3-5 bullet points — each must include a specific number from the report AND explain why it matters)
3. **Concentration & risk** (where is spending/activity clustered? what happens if that changes?)
4. **Recommendations** (2-3 actionable next steps based on the patterns)

RULES:
- Every number must come from the report below — never invent
- DO NOT reproduce the tables — the user already has the spreadsheet
- Focus on PATTERNS, ANOMALIES, and IMPLICATIONS — not raw data
- If the user asked a specific question, answer it directly first`,
          user: `${report}\n\nUser's question: "${ctx.userMessage || 'Analyze this data'}"`,
        };
      },
    },

    // Stage 4: Append file tokens for media delivery
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

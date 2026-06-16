import type { PipelineDefinition } from '../types.js';
import { markdownToHtml } from '../../utils/markdown-to-html.js';

/**
 * Document pipeline — CODE-DRIVEN document generation from PROVIDED content.
 *
 * Inversion of control: the model is NOT in charge here. Code orchestrates; it calls the model
 * exactly once for the one thing it's good at (cleaning the user's content into markdown), then
 * CODE renders the markdown to HTML and CODE invokes the document tool to produce the PDF. The
 * model never decides whether to use a tool, so it can't flake on it — which is the failure mode
 * that plagued the model-driven plan/exec tool-loop for "turn this into a PDF".
 */

const DOC_CSS = `
@page { margin: 2.2cm 2cm; }
body { font-family: Georgia, 'Times New Roman', serif; color: #1a202c; line-height: 1.5; font-size: 12pt; }
.doc { max-width: 100%; }
h1 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 26px; color: #1a365d; margin: 0 0 4px; }
h2 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 18px; color: #1a365d; border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; margin-top: 26px; }
h3 { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; color: #2c5282; margin-top: 18px; }
p { margin: 8px 0; }
ul, ol { margin: 8px 0 8px 22px; }
li { margin-bottom: 4px; }
blockquote { border-left: 4px solid #2c5282; background: #f7fafc; margin: 14px 0; padding: 8px 14px; }
table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 11pt; }
th { background: #1a365d; color: #fff; padding: 8px 12px; text-align: left; font-family: 'Segoe UI', system-ui, sans-serif; }
td { padding: 6px 12px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
tr:nth-child(even) td { background: #f7fafc; }
code { background: #edf2f7; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
a { color: #2c5282; }
`;

const TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>${DOC_CSS}</style></head>
<body><div class="doc">${body}</div></body></html>`;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
}
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\/no_?think/gi, '').trim();
}

export const documentPipeline: PipelineDefinition = {
  name: 'document',
  stages: [
    // 1. ONE model call: clean the user's PROVIDED content into well-structured markdown.
    //    This is the only thing the model touches — it does not choose tools or render anything.
    {
      name: 'structure',
      type: 'llm',
      temperature: 0.3,
      maxTokens: 8192,
      buildPrompt: (ctx) => ({
        system: [
          'You format USER-PROVIDED content into a clean document. The user pasted content and wants it turned into a polished PDF.',
          'Convert the content into well-structured GitHub-flavored MARKDOWN:',
          '- Start with a single `# Title` line that names the document.',
          '- Use `##`/`###` headings, bullet/numbered lists, and tables where the content warrants them.',
          '- Tighten formatting and fix obvious structure, but PRESERVE ALL the substance — do not summarize, drop, or invent content.',
          'Ignore any instruction like "make a PDF" / "clean this up" — that is the request, not content. Just format what was provided.',
          'Output ONLY the markdown. No preamble, no code fences. /no_think',
        ].join('\n'),
        user: ctx.userMessage,
      }),
    },

    // 2. CODE renders the markdown → styled HTML (deterministic; no model, no tool choice).
    {
      name: 'render',
      type: 'code',
      execute: (ctx) => {
        const md = stripThinking(ctx.stageResults.structure as string)
          .replace(/^```(?:markdown)?\n?/m, '').replace(/\n?```$/m, '').trim();
        // Fail loud rather than emit a blank/near-empty PDF.
        if (md.replace(/[#*\->\s]/g, '').length < 40) {
          ctx.abort = true;
          ctx.answer = 'I couldn\'t turn that into a document — there wasn\'t enough usable content. Try pasting the text again.';
          return;
        }
        const titleMatch = md.match(/^#\s+(.+)$/m);
        const title = (titleMatch?.[1] ?? 'Document').trim();
        ctx.params._title = title;
        ctx.params._slug = slugify(title);
        let body = markdownToHtml(md);
        body = body.replace(/<h1>/, '<h1 class="doc-title">');
        ctx.params._html = TEMPLATE(title, body);
      },
    },

    // 3. CODE invokes the document tool to make the PDF. The model is not in this loop.
    {
      name: 'convert_pdf',
      type: 'tool',
      tool: 'document',
      when: (ctx) => !ctx.abort,
      resolveParams: (ctx) => ({
        action: 'create',
        content: ctx.params._html,
        format: 'pdf',
        filename: ctx.params._slug,
      }),
    },

    // 4. CODE builds the reply with the [FILE:] token for channel delivery.
    {
      name: 'finalize',
      type: 'code',
      when: (ctx) => !ctx.abort,
      execute: (ctx) => {
        const toolResult = (ctx.stageResults.convert_pdf as string) ?? '';
        const fileMatch = toolResult.match(/\[FILE:([^\]]+)\]/);
        const title = (ctx.params._title as string) ?? 'document';
        if (fileMatch) {
          ctx.answer = `Here's your PDF — **${title}**. [FILE:${fileMatch[1]}]`;
        } else {
          ctx.answer = `I formatted the content but the PDF conversion didn't return a file. Tool said: ${toolResult.slice(0, 200)}`;
        }
      },
    },
  ],
};

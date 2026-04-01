import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { execSync } from 'node:child_process';
import type { LocalClawTool, ToolContext } from './types.js';

const SOFFICE = '/opt/homebrew/bin/soffice';
const OUTPUT_DIR = 'data/media/documents';
const SUPPORTED_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'html', 'csv', 'txt', 'odt', 'ods', 'odp'];

/**
 * Resolve input path relative to workspace or absolute.
 */
function resolvePath(inputPath: string, ctx: ToolContext): string {
  if (inputPath.startsWith('/')) return inputPath;
  if (!ctx.workspacePath) return inputPath;
  return join(ctx.workspacePath, inputPath);
}

/**
 * Run LibreOffice headless conversion.
 */
function convertFile(inputPath: string, format: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true });

  try {
    execSync(
      `${SOFFICE} --headless --convert-to ${format} --outdir "${outDir}" "${inputPath}"`,
      { timeout: 30_000, stdio: 'pipe' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`LibreOffice conversion failed: ${msg}`);
  }

  // LibreOffice outputs with the same base name but new extension
  const base = basename(inputPath, extname(inputPath));
  const outputPath = join(outDir, `${base}.${format}`);

  if (!existsSync(outputPath)) {
    throw new Error(`Conversion produced no output file. Expected: ${outputPath}`);
  }

  return outputPath;
}

export function createDocumentTool(): LocalClawTool {
  return {
    name: 'document',
    description: `Create and convert documents using LibreOffice. Supports PDF, DOCX, XLSX, PPTX, HTML, CSV, and more.

Actions:
- "create": Write content to a temp file, then convert to the target format. Good for generating reports, spreadsheets, formatted docs.
- "convert": Convert an existing file to a different format.

Supported formats: ${SUPPORTED_FORMATS.join(', ')}.

Tips:
- For PDFs/DOCX: write content as HTML for best formatting (headings, tables, lists).
- For spreadsheets: write content as CSV, then convert to XLSX.
- For presentations: write content as HTML with <h1> for slide titles.`,
    parameterDescription: `action (required): "create" or "convert".
content (for create): The document content. Use HTML for rich formatting, CSV for spreadsheets, plain text for simple docs.
inputPath (for convert): Path to the file to convert (relative to workspace or absolute).
format (required): Target format — pdf, docx, xlsx, pptx, html, csv, txt, odt, ods, odp.
filename (optional): Output filename without extension (default: "document").`,
    example: 'document[{"action": "create", "content": "<h1>Report</h1><p>Summary here</p>", "format": "pdf", "filename": "report"}]',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to perform', enum: ['create', 'convert'] },
        content: { type: 'string', description: 'Document content for "create" action. Use HTML for rich formatting.' },
        inputPath: { type: 'string', description: 'Input file path for "convert" action' },
        format: { type: 'string', description: 'Target output format', enum: SUPPORTED_FORMATS },
        filename: { type: 'string', description: 'Output filename without extension (default: "document")' },
      },
      required: ['action', 'format'],
    },
    category: 'exec',
    execute: async (params: Record<string, unknown>, ctx: ToolContext): Promise<string> => {
      const action = params.action as string;
      const format = params.format as string;
      const filename = (params.filename as string) || 'document';

      if (!SUPPORTED_FORMATS.includes(format)) {
        return `Unsupported format "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}`;
      }

      mkdirSync(OUTPUT_DIR, { recursive: true });

      if (action === 'create') {
        const content = params.content as string;
        if (!content) return 'Missing "content" parameter for create action.';

        // Determine source format from content
        const isHtml = content.trimStart().startsWith('<');
        const isCsv = !isHtml && content.includes(',') && content.includes('\n');
        const sourceExt = isHtml ? 'html' : isCsv ? 'csv' : 'txt';

        // Write temp source file
        const tempPath = join(OUTPUT_DIR, `${filename}_src.${sourceExt}`);
        writeFileSync(tempPath, content);

        // If target format matches source, just return the file
        if (sourceExt === format) {
          const finalPath = join(OUTPUT_DIR, `${filename}.${format}`);
          writeFileSync(finalPath, content);
          return `Document created: ${finalPath} [FILE:${finalPath}]`;
        }

        // Convert
        const outputPath = convertFile(tempPath, format, OUTPUT_DIR);

        // Rename to desired filename if different
        const desiredPath = join(OUTPUT_DIR, `${filename}.${format}`);
        if (outputPath !== desiredPath) {
          const { renameSync } = await import('node:fs');
          renameSync(outputPath, desiredPath);
        }

        return `Document created: ${desiredPath} [FILE:${desiredPath}]`;

      } else if (action === 'convert') {
        const inputPath = params.inputPath as string;
        if (!inputPath) return 'Missing "inputPath" parameter for convert action.';

        const resolved = resolvePath(inputPath, ctx);
        if (!existsSync(resolved)) {
          return `File not found: ${resolved}`;
        }

        const outputPath = convertFile(resolved, format, OUTPUT_DIR);
        return `Converted: ${resolved} → ${outputPath} [FILE:${outputPath}]`;

      } else {
        return `Unknown action "${action}". Use "create" or "convert".`;
      }
    },
  };
}

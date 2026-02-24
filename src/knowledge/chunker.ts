import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export interface ChunkOptions {
  maxChunkSize: number;
  overlapSize: number;
}

export interface Chunk {
  text: string;
  index: number;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxChunkSize: 800,
  overlapSize: 100,
};

/**
 * Read a document file and return its text content.
 * Supports: .md, .txt, .csv, .html, .htm, .pdf
 */
export async function readDocument(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    return readPdf(filePath);
  }

  if (ext === '.html' || ext === '.htm') {
    const html = readFileSync(filePath, 'utf-8');
    const { extractReadableContent } = await import('../tools/web-fetch-utils.js');
    const result = await extractReadableContent(html, `file://${filePath}`);
    return result.textContent || result.content;
  }

  // Text-based formats: md, txt, csv
  return readFileSync(filePath, 'utf-8');
}

/**
 * Read a PDF file using pdf-parse.
 */
async function readPdf(filePath: string): Promise<string> {
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buffer = readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } catch (err) {
    throw new Error(`Failed to parse PDF: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Chunk plain text by splitting on paragraph breaks.
 * Merges small paragraphs until maxChunkSize, prepends overlap from previous chunk.
 */
export function chunkText(text: string, options: ChunkOptions = DEFAULT_OPTIONS): Chunk[] {
  const { maxChunkSize, overlapSize } = options;
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let current = '';
  let prevOverlap = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length > maxChunkSize && current) {
      // Flush current chunk with overlap prefix
      const chunkText = prevOverlap ? `${prevOverlap}\n\n${current}` : current;
      chunks.push({ text: chunkText.trim(), index: chunks.length });
      prevOverlap = current.slice(-overlapSize);
      current = para;
    } else {
      current = candidate;
    }
  }

  // Flush remaining
  if (current.trim()) {
    const chunkText = prevOverlap ? `${prevOverlap}\n\n${current}` : current;
    chunks.push({ text: chunkText.trim(), index: chunks.length });
  }

  return chunks;
}

/**
 * Chunk markdown text, respecting ## headers.
 * Each chunk gets the current heading prepended.
 */
export function chunkMarkdown(text: string, options: ChunkOptions = DEFAULT_OPTIONS): Chunk[] {
  const { maxChunkSize, overlapSize } = options;
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let currentHeading = '';
  let currentContent = '';
  let prevOverlap = '';

  function flush() {
    if (!currentContent.trim()) return;
    const prefix = currentHeading ? `${currentHeading}\n\n` : '';
    const overlapPrefix = prevOverlap ? `${prevOverlap}\n\n` : '';
    const chunkText = `${prefix}${overlapPrefix}${currentContent}`.trim();
    chunks.push({ text: chunkText, index: chunks.length });
    prevOverlap = currentContent.trim().slice(-overlapSize);
    currentContent = '';
  }

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line)) {
      flush();
      currentHeading = line;
      continue;
    }

    const candidate = currentContent ? `${currentContent}\n${line}` : line;
    if (candidate.length > maxChunkSize && currentContent) {
      flush();
      currentContent = line;
    } else {
      currentContent = candidate;
    }
  }

  flush();
  return chunks;
}

/**
 * Chunk CSV content, prepending the header row to each chunk.
 */
export function chunkCSV(text: string, options: ChunkOptions = DEFAULT_OPTIONS): Chunk[] {
  const { maxChunkSize } = options;
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];

  const header = lines[0];
  const dataRows = lines.slice(1);

  if (dataRows.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentRows: string[] = [];

  for (const row of dataRows) {
    const candidate = [header, ...currentRows, row].join('\n');
    if (candidate.length > maxChunkSize && currentRows.length > 0) {
      chunks.push({
        text: [header, ...currentRows].join('\n'),
        index: chunks.length,
      });
      currentRows = [row];
    } else {
      currentRows.push(row);
    }
  }

  if (currentRows.length > 0) {
    chunks.push({
      text: [header, ...currentRows].join('\n'),
      index: chunks.length,
    });
  }

  return chunks;
}

/**
 * Auto-detect format and chunk a document.
 */
export function chunkDocument(text: string, filePath: string, options: ChunkOptions = DEFAULT_OPTIONS): Chunk[] {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.csv') {
    return chunkCSV(text, options);
  }

  if (ext === '.md') {
    return chunkMarkdown(text, options);
  }

  // Default: plain text chunking (txt, pdf text, html text)
  return chunkText(text, options);
}

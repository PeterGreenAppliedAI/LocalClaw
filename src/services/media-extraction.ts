/**
 * Extract [IMAGE:path] and [FILE:path] tokens from text, read files, return attachments + cleaned text.
 * Extracted from orchestrator for testability and reuse.
 */
import { readFileSync } from 'node:fs';

const IMAGE_TOKEN_RE = /\[IMAGE:([^\]]+)\]/g;
const FILE_TOKEN_RE = /\[FILE:([^\]]+)\]/g;

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', html: 'text/html',
};

export function extractMediaAttachments(text: string): {
  cleanText: string;
  attachments: Array<{ data: Buffer; mimeType: string; filename: string }>;
} {
  const attachments: Array<{ data: Buffer; mimeType: string; filename: string }> = [];

  let cleanText = text.replace(IMAGE_TOKEN_RE, (match, filePath: string) => {
    try {
      const data = readFileSync(filePath.trim());
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
      attachments.push({ data, mimeType: MIME_MAP[ext] ?? 'image/png', filename: filePath.split('/').pop() ?? 'image.png' });
      return '';
    } catch { return match; }
  });

  cleanText = cleanText.replace(FILE_TOKEN_RE, (match, filePath: string) => {
    try {
      const data = readFileSync(filePath.trim());
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
      attachments.push({ data, mimeType: MIME_MAP[ext] ?? 'application/octet-stream', filename: filePath.split('/').pop() ?? 'file' });
      return '';
    } catch { return match; }
  });

  // Catch document file paths the model may have reformatted (markdown links, plain mentions)
  const docPathRe = /(?:\[([^\]]*)\]\([^)]*\)|(?:^|\s))((?:\/[^\s]*|data)\/media\/documents\/[^\s)]+\.(?:pdf|docx|xlsx|pptx|csv))/gim;
  const seenPaths = new Set(attachments.map(a => a.filename));
  for (const m of cleanText.matchAll(docPathRe)) {
    const filePath = (m[2] || '').trim();
    const filename = filePath.split('/').pop() ?? 'file';
    if (seenPaths.has(filename)) continue;
    try {
      const data = readFileSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'bin';
      attachments.push({ data, mimeType: MIME_MAP[ext] ?? 'application/octet-stream', filename });
      seenPaths.add(filename);
      cleanText = cleanText.replace(m[0], '').trim();
    } catch { /* file doesn't exist */ }
  }

  return { cleanText: cleanText.trim(), attachments };
}

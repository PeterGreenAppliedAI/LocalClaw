import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Attachment } from '../channels/types.js';

const UPLOADS_DIR = 'data/uploads';
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_FILENAME_LENGTH = 200;

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
]);

export interface SavedAttachment {
  localPath: string;
  isImage: boolean;
  filename: string;
  mimeType: string;
}

export function isImageMime(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime.split(';')[0].trim().toLowerCase());
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/\0/g, '')
    .slice(0, MAX_FILENAME_LENGTH);
}

export function saveAttachment(
  att: Attachment,
  channel: string,
  msgId: string,
): SavedAttachment | null {
  if (att.size > MAX_ATTACHMENT_SIZE) {
    console.warn(`[Attachments] Skipping ${att.filename}: ${(att.size / 1024 / 1024).toFixed(1)}MB exceeds 25MB limit`);
    return null;
  }

  const sanitized = sanitizeFilename(att.filename);
  const diskName = `${channel}_${msgId}_${sanitized}`;
  const uploadsDir = join(process.cwd(), UPLOADS_DIR);
  mkdirSync(uploadsDir, { recursive: true });

  const localPath = join(uploadsDir, diskName);
  writeFileSync(localPath, att.data);

  console.log(`[Attachments] Saved ${att.filename} (${(att.size / 1024).toFixed(1)}KB) → ${localPath}`);

  return {
    localPath,
    isImage: isImageMime(att.mimeType),
    filename: att.filename,
    mimeType: att.mimeType,
  };
}

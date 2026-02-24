import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveAttachment, isImageMime } from '../../src/services/attachments.js';
import type { Attachment } from '../../src/channels/types.js';

const UPLOADS_DIR = join(process.cwd(), 'data/uploads');

afterEach(() => {
  // Clean up any test uploads
  try { rmSync(UPLOADS_DIR, { recursive: true }); } catch { /* ignore */ }
});

describe('isImageMime', () => {
  it('returns true for common image MIME types', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('image/jpeg')).toBe(true);
    expect(isImageMime('image/gif')).toBe(true);
    expect(isImageMime('image/webp')).toBe(true);
    expect(isImageMime('image/bmp')).toBe(true);
    expect(isImageMime('image/tiff')).toBe(true);
  });

  it('returns false for non-image MIME types', () => {
    expect(isImageMime('application/pdf')).toBe(false);
    expect(isImageMime('text/csv')).toBe(false);
    expect(isImageMime('audio/ogg')).toBe(false);
  });

  it('handles MIME types with parameters', () => {
    expect(isImageMime('image/jpeg; charset=utf-8')).toBe(true);
  });
});

describe('saveAttachment', () => {
  it('saves a file to data/uploads/', () => {
    const att: Attachment = {
      filename: 'test.pdf',
      mimeType: 'application/pdf',
      size: 100,
      data: Buffer.from('fake pdf content'),
    };

    const result = saveAttachment(att, 'discord', 'msg123');
    expect(result).not.toBeNull();
    expect(result!.localPath).toContain('discord_msg123_test.pdf');
    expect(result!.isImage).toBe(false);
    expect(result!.filename).toBe('test.pdf');
    expect(result!.mimeType).toBe('application/pdf');

    // Verify file was written
    expect(existsSync(result!.localPath)).toBe(true);
    expect(readFileSync(result!.localPath, 'utf-8')).toBe('fake pdf content');
  });

  it('correctly identifies image attachments', () => {
    const att: Attachment = {
      filename: 'photo.png',
      mimeType: 'image/png',
      size: 50,
      data: Buffer.from('fake png'),
    };

    const result = saveAttachment(att, 'whatsapp', 'msg456');
    expect(result).not.toBeNull();
    expect(result!.isImage).toBe(true);
  });

  it('rejects files exceeding 25MB', () => {
    const att: Attachment = {
      filename: 'huge.bin',
      mimeType: 'application/octet-stream',
      size: 26 * 1024 * 1024,
      data: Buffer.alloc(10), // small buffer but size field exceeds limit
    };

    const result = saveAttachment(att, 'discord', 'msg789');
    expect(result).toBeNull();
  });

  it('sanitizes filenames with path traversal', () => {
    const att: Attachment = {
      filename: '../../../etc/passwd',
      mimeType: 'text/plain',
      size: 10,
      data: Buffer.from('test'),
    };

    const result = saveAttachment(att, 'discord', 'msg000');
    expect(result).not.toBeNull();
    expect(result!.localPath).not.toContain('..');
    expect(result!.localPath).toContain('______etc_passwd');
  });

  it('sanitizes filenames with backslashes and null bytes', () => {
    const att: Attachment = {
      filename: 'test\\path\0bad.txt',
      mimeType: 'text/plain',
      size: 5,
      data: Buffer.from('hello'),
    };

    const result = saveAttachment(att, 'slack', 'msg111');
    expect(result).not.toBeNull();
    expect(result!.localPath).not.toContain('\\');
    expect(result!.localPath).not.toContain('\0');
  });

  it('truncates long filenames to 200 chars', () => {
    const att: Attachment = {
      filename: 'a'.repeat(300) + '.txt',
      mimeType: 'text/plain',
      size: 5,
      data: Buffer.from('hello'),
    };

    const result = saveAttachment(att, 'discord', 'msg222');
    expect(result).not.toBeNull();
    // The sanitized filename part should be at most 200 chars
    const diskName = result!.localPath.split('/').pop()!;
    const prefix = 'discord_msg222_';
    const sanitizedPart = diskName.slice(prefix.length);
    expect(sanitizedPart.length).toBeLessThanOrEqual(200);
  });
});

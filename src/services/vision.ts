import type { VisionConfig } from '../config/types.js';

const MIN_DIMENSION = 64;

/** Extract width/height from PNG or JPEG buffer. Returns null if unrecognized. */
function getImageDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG: bytes 16-23 of IHDR chunk contain width (4 bytes BE) and height (4 bytes BE)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0-SOF2 markers (0xFF 0xC0-0xC2)
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset + 8 < buf.length) {
      if (buf[offset] !== 0xFF) break;
      const marker = buf[offset + 1];
      if (marker >= 0xC0 && marker <= 0xC2) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // WebP: RIFF header, 'WEBP' at offset 8, VP8 chunk width/height at offset 26-29
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    // VP8 lossy
    if (buf.toString('ascii', 12, 16) === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
    }
    // VP8L lossless
    if (buf.toString('ascii', 12, 16) === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
    }
  }
  return null;
}

export class VisionService {
  private config: VisionConfig;
  private baseUrl: string;

  constructor(config: VisionConfig, ollamaBaseUrl: string) {
    this.config = config;
    this.baseUrl = ollamaBaseUrl;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async describe(imageBuffer: Buffer, _mimeType: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    try {
      // qwen3-vl crashes on images smaller than 32x32 (known Ollama bug)
      // Resize undersized images instead of rejecting them
      let processedBuffer = imageBuffer;
      const dims = getImageDimensions(imageBuffer);
      if (dims && (dims.width < MIN_DIMENSION || dims.height < MIN_DIMENSION)) {
        const { default: sharp } = await import('sharp');
        const newWidth = Math.max(dims.width, MIN_DIMENSION);
        const newHeight = Math.max(dims.height, MIN_DIMENSION);
        console.log(`[Vision] Image too small (${dims.width}x${dims.height}), resizing to ${newWidth}x${newHeight}`);
        processedBuffer = await sharp(imageBuffer).resize(newWidth, newHeight, { fit: 'fill' }).png().toBuffer();
      }

      const base64 = processedBuffer.toString('base64');

      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            {
              role: 'user',
              content: this.config.prompt,
              images: [base64],
            },
          ],
          stream: false,
          options: {
            num_predict: this.config.maxTokens,
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        console.error(`[Vision] Ollama returned ${res.status}: ${res.statusText}`);
        return null;
      }

      const raw = await res.text();
      let data: { message?: { content?: string; thinking?: string }; error?: { message?: string } };
      try {
        data = JSON.parse(raw);
      } catch {
        console.error(`[Vision] Invalid JSON response: ${raw.slice(0, 200)}`);
        return null;
      }

      if (data.error) {
        console.error(`[Vision] Ollama error: ${data.error.message ?? JSON.stringify(data.error)}`);
        return null;
      }

      // qwen3 models may put output in thinking field instead of content
      const description = (data.message?.content || data.message?.thinking || '').trim();

      if (!description) {
        console.warn(`[Vision] Empty response. Keys: ${JSON.stringify(Object.keys(data.message ?? {}))}, eval_count: ${(data as any).eval_count}`);
      }

      if (description) {
        console.log(`[Vision] Described image: "${description.slice(0, 80)}${description.length > 80 ? '...' : ''}"`);
      }

      return description ?? null;
    } catch (err) {
      console.error('[Vision] Failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

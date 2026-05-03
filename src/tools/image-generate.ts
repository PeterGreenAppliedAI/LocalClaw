import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { LocalClawTool, ToolContext } from './types.js';
import type { z } from 'zod';
import type { ImageGenConfigSchema } from '../config/schema.js';

type ImageGenConfig = z.infer<typeof ImageGenConfigSchema>;

export function createImageGenerateTool(config: ImageGenConfig): LocalClawTool {
  return {
    name: 'image_generate',
    description: `Generate an image from a text prompt using a local Flux model.
WHEN TO USE: User asks you to create, generate, draw, or make an image/picture/illustration.
DO NOT use for editing existing images unless a reference image is provided.
Returns a [FILE:path] token for the generated image.`,
    parameterDescription: 'prompt (required): Text description of the image to generate. filename (optional): Output filename without extension (default: generated timestamp). reference_image_path (optional): Path to a reference image for img2img style transfer.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        filename: { type: 'string', description: 'Output filename without extension' },
        reference_image_path: { type: 'string', description: 'Path to reference image for img2img (optional)' },
      },
      required: ['prompt'],
    },
    category: 'media',

    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      const prompt = params.prompt as string;
      if (!prompt?.trim()) return 'Error: prompt is required';

      const filename = (params.filename as string) || `image_${Date.now()}`;
      const refPath = params.reference_image_path as string | undefined;
      const workspace = ctx.workspacePath ?? 'data/workspaces/main';

      const outDir = join(workspace, 'images');
      mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `${filename}.png`);

      // Build request body
      const body: Record<string, unknown> = {
        model: config.model,
        prompt,
      };

      // img2img: load reference image as base64
      if (refPath) {
        try {
          const { readFileSync } = await import('node:fs');
          const fullPath = refPath.startsWith('/') ? refPath : join(workspace, refPath);
          const imgBuffer = readFileSync(fullPath);
          body.images = [imgBuffer.toString('base64')];
        } catch (err) {
          return `Error reading reference image: ${err instanceof Error ? err.message : err}`;
        }
      }

      try {
        const res = await fetch(`${config.url}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000), // 5 min timeout
        });

        if (!res.ok) {
          return `Image generation failed: ${res.status} ${res.statusText}`;
        }

        // Stream response — collect lines until we get the final one with the image
        const text = await res.text();
        const lines = text.trim().split('\n');

        let imageBase64: string | null = null;
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.image) {
              imageBase64 = data.image;
            }
          } catch { /* skip non-JSON lines */ }
        }

        if (!imageBase64) {
          return 'Image generation completed but no image data was returned.';
        }

        // Save to file
        const buffer = Buffer.from(imageBase64, 'base64');
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, buffer);

        return `Generated image saved to ${outPath} (${Math.round(buffer.length / 1024)}KB)\n[FILE:${outPath}]`;
      } catch (err) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          return 'Image generation timed out (5 minute limit).';
        }
        return `Image generation failed: ${err instanceof Error ? err.message : err}`;
      }
    },
  };
}

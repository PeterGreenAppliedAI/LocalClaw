import type { VisionConfig } from '../config/types.js';

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
      const base64 = imageBuffer.toString('base64');

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

      const data = await res.json() as { message?: { content?: string } };
      const description = data.message?.content?.trim();

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

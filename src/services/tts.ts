import type { TTSConfig } from '../config/types.js';

export class TTSService {
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Synthesize text to audio via Orpheus TTS (OpenAI-compatible endpoint).
   * Returns audio buffer on success, null on failure or disabled.
   */
  async synthesize(text: string): Promise<Buffer | null> {
    if (!this.config.enabled) return null;
    if (!text.trim()) return null;

    try {
      const res = await fetch(`${this.config.url}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'orpheus',
          input: text,
          voice: this.config.voice,
          response_format: this.config.format,
        }),
      });

      if (!res.ok) {
        console.error(`[TTS] Orpheus returned ${res.status}: ${res.statusText}`);
        return null;
      }

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error('[TTS] Failed to reach Orpheus:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

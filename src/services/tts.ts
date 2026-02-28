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
   * Synthesize text to audio via QwenTTS (OpenAI-compatible endpoint).
   * Returns audio buffer on success, null on failure or disabled.
   */
  async synthesize(text: string): Promise<Buffer | null> {
    if (!this.config.enabled) return null;
    if (!text.trim()) return null;

    try {
      const payload = {
        model: 'tts-1',
        input: text,
        voice: this.config.voice,
        response_format: this.config.format,
      };
      console.log(`[TTS] Request: voice=${payload.voice}, format=${payload.response_format}, input=${text.length} chars`);
      const res = await fetch(`${this.config.url}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[TTS] OLLAMA_INFERENCE_ERROR: QwenTTS returned ${res.status}: ${res.statusText} — ${body}`);
        return null;
      }

      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.warn('[TTS] OLLAMA_UNREACHABLE: Failed to reach QwenTTS —', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

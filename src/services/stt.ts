import type { STTConfig } from '../config/types.js';

export class STTService {
  private config: STTConfig;

  constructor(config: STTConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Transcribe audio to text via faster-whisper server (OpenAI-compatible endpoint).
   * Returns transcribed text on success, null on failure or disabled.
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    try {
      // Determine file extension from MIME type
      const ext = mimeTypeToExt(mimeType);

      // Build multipart form data
      const formData = new FormData();
      const blob = new Blob([audio], { type: mimeType });
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', this.config.model);
      formData.append('language', this.config.language);

      const res = await fetch(`${this.config.url}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        console.warn(`[STT] OLLAMA_INFERENCE_ERROR: Whisper returned ${res.status}: ${res.statusText}`);
        return null;
      }

      const data = await res.json() as { text?: string };
      return data.text?.trim() ?? null;
    } catch (err) {
      console.warn('[STT] OLLAMA_UNREACHABLE: Failed to reach Whisper —', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/x-wav': 'wav',
  };
  return map[mimeType] ?? 'ogg';
}

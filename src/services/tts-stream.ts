import type { TTSService } from './tts.js';

/** Matches sentence-ending punctuation followed by whitespace */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

/** Minimum chars before we flush a sentence to TTS (avoids fragments like "Dr.") */
const MIN_SENTENCE_LENGTH = 20;

/** Maximum chars before force-flushing even without a sentence boundary */
const MAX_BUFFER_LENGTH = 300;

export interface AudioChunkEvent {
  data: string;       // base64-encoded audio
  mimeType: string;
  index: number;      // sentence index (0-based)
  final: boolean;     // true for the last sentence
}

export interface TTSPipelineCallbacks {
  onAudioChunk: (chunk: AudioChunkEvent) => void;
  onComplete: () => void;
}

/**
 * Split text into sentences at punctuation boundaries.
 * Merges short fragments (< MIN_SENTENCE_LENGTH) into the previous sentence.
 */
export function splitIntoSentences(text: string): string[] {
  const raw = text.split(SENTENCE_BOUNDARY).filter(s => s.trim().length > 0);
  const result: string[] = [];
  for (const s of raw) {
    if (result.length > 0 && s.trim().length < MIN_SENTENCE_LENGTH) {
      result[result.length - 1] += ' ' + s.trim();
    } else {
      result.push(s.trim());
    }
  }
  return result.length > 0 ? result : (text.trim() ? [text.trim()] : []);
}

/**
 * Creates a streaming TTS pipeline that buffers LLM text deltas,
 * detects sentence boundaries, and fires concurrent TTS requests.
 *
 * - `push(delta)` — synchronous, called from onStream callback
 * - `flush()` — async, call after dispatch completes to send remaining text
 */
export function createTTSPipeline(
  tts: TTSService,
  mimeType: string,
  callbacks: TTSPipelineCallbacks,
): { push: (delta: string) => void; flush: () => Promise<void> } {
  let buffer = '';
  let sentenceIndex = 0;
  const pending: Promise<void>[] = [];

  function trySplit(): string[] {
    const sentences: string[] = [];
    while (true) {
      const match = SENTENCE_BOUNDARY.exec(buffer);
      if (!match || match.index === undefined) break;
      const end = match.index + match[0].length;
      const sentence = buffer.slice(0, end).trim();
      buffer = buffer.slice(end);
      if (sentence.length >= MIN_SENTENCE_LENGTH) {
        sentences.push(sentence);
      } else {
        // Too short — prepend back to buffer
        buffer = sentence + ' ' + buffer;
        break;
      }
    }
    // Force-flush if buffer is too long without a boundary
    if (buffer.length > MAX_BUFFER_LENGTH) {
      const flushed = buffer.trim();
      buffer = '';
      if (flushed) sentences.push(flushed);
    }
    return sentences;
  }

  function enqueueSentence(sentence: string, isFinal: boolean): void {
    const idx = sentenceIndex++;
    const p = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of tts.synthesizeStream(sentence)) {
          chunks.push(chunk);
        }
        if (chunks.length > 0) {
          const combined = Buffer.concat(chunks);
          callbacks.onAudioChunk({
            data: combined.toString('base64'),
            mimeType,
            index: idx,
            final: isFinal,
          });
        }
      } catch (err) {
        console.warn(`[TTS Pipeline] Sentence ${idx} failed:`, err instanceof Error ? err.message : err);
      }
    })();
    pending.push(p);
  }

  return {
    push(delta: string): void {
      buffer += delta;
      const sentences = trySplit();
      for (const s of sentences) {
        enqueueSentence(s, false);
      }
    },

    async flush(): Promise<void> {
      const remaining = buffer.trim();
      buffer = '';
      if (remaining.length > 0) {
        enqueueSentence(remaining, true);
      }
      await Promise.all(pending);
      callbacks.onComplete();
    },
  };
}

import { describe, it, expect, vi } from 'vitest';
import { splitIntoSentences, createTTSPipeline } from '../../src/services/tts-stream.js';
import type { AudioChunkEvent, TTSPipelineCallbacks } from '../../src/services/tts-stream.js';

// ─── splitIntoSentences ───────────────────────────────────────

describe('splitIntoSentences', () => {
  it('splits on period + space', () => {
    const result = splitIntoSentences('Hello world, this is nice. And here is more text to read.');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('Hello world, this is nice.');
    expect(result[1]).toBe('And here is more text to read.');
  });

  it('splits on question mark', () => {
    const result = splitIntoSentences('How are you doing today? I am doing well thank you.');
    expect(result).toHaveLength(2);
  });

  it('splits on exclamation mark', () => {
    const result = splitIntoSentences('Wow that is amazing and cool! Let me tell you about this thing.');
    expect(result).toHaveLength(2);
  });

  it('merges short fragments into previous sentence', () => {
    // "Ok." is too short (< 20 chars), should be merged
    const result = splitIntoSentences('This is a long enough sentence here. Ok. And another long sentence follows.');
    // "Ok." gets merged with previous since it's < 20 chars
    expect(result.length).toBeLessThanOrEqual(2);
    // The merged result should contain "Ok."
    expect(result.join(' ')).toContain('Ok.');
  });

  it('returns full text when no boundaries', () => {
    const result = splitIntoSentences('Just some text without any sentence ending punctuation');
    expect(result).toEqual(['Just some text without any sentence ending punctuation']);
  });

  it('handles empty string', () => {
    const result = splitIntoSentences('');
    expect(result).toEqual([]);
  });

  it('handles single sentence', () => {
    const result = splitIntoSentences('Just one sentence with enough chars.');
    expect(result).toEqual(['Just one sentence with enough chars.']);
  });

  it('handles multiple spaces after punctuation', () => {
    const result = splitIntoSentences('First sentence is here.  Second sentence is here too.');
    expect(result).toHaveLength(2);
  });
});

// ─── createTTSPipeline ───────────────────────────────────────

describe('createTTSPipeline', () => {
  function createMockTTS() {
    return {
      enabled: true,
      async *synthesizeStream(text: string): AsyncGenerator<Buffer, void, undefined> {
        // Simulate two chunks of audio data per sentence
        yield Buffer.from(`audio-chunk-1:${text.slice(0, 10)}`);
        yield Buffer.from(`audio-chunk-2:${text.slice(0, 10)}`);
      },
      synthesize: vi.fn(),
    } as any;
  }

  it('detects sentence boundaries and emits audio chunks', async () => {
    const tts = createMockTTS();
    const chunks: AudioChunkEvent[] = [];
    let completed = false;

    const pipeline = createTTSPipeline(tts, 'audio/ogg', {
      onAudioChunk: (chunk) => chunks.push(chunk),
      onComplete: () => { completed = true; },
    });

    // Simulate LLM streaming token by token
    pipeline.push('Hello world, this is sentence one. ');
    pipeline.push('And this is sentence number two.');

    await pipeline.flush();

    expect(completed).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Each chunk should have base64 data
    for (const chunk of chunks) {
      expect(chunk.data).toBeTruthy();
      expect(chunk.mimeType).toBe('audio/ogg');
      expect(typeof chunk.index).toBe('number');
    }
    // Last chunk should be marked final
    expect(chunks[chunks.length - 1].final).toBe(true);
  });

  it('handles text with no sentence boundaries via flush', async () => {
    const tts = createMockTTS();
    const chunks: AudioChunkEvent[] = [];
    let completed = false;

    const pipeline = createTTSPipeline(tts, 'audio/ogg', {
      onAudioChunk: (chunk) => chunks.push(chunk),
      onComplete: () => { completed = true; },
    });

    pipeline.push('Short text no boundary');
    await pipeline.flush();

    expect(completed).toBe(true);
    // Should have flushed the remaining buffer as final
    expect(chunks.length).toBe(1);
    expect(chunks[0].final).toBe(true);
    expect(chunks[0].index).toBe(0);
  });

  it('preserves sentence ordering via index', async () => {
    const tts = createMockTTS();
    const chunks: AudioChunkEvent[] = [];

    const pipeline = createTTSPipeline(tts, 'audio/ogg', {
      onAudioChunk: (chunk) => chunks.push(chunk),
      onComplete: () => {},
    });

    pipeline.push('First sentence is long enough to send. Second sentence is also long enough. ');
    pipeline.push('Third sentence arrives after flush.');

    await pipeline.flush();

    const indices = chunks.map(c => c.index);
    // Indices should be monotonically increasing
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it('handles TTS failure gracefully', async () => {
    const tts = {
      enabled: true,
      async *synthesizeStream(): AsyncGenerator<Buffer, void, undefined> {
        throw new Error('TTS server down');
      },
      synthesize: vi.fn(),
    } as any;

    const chunks: AudioChunkEvent[] = [];
    let completed = false;

    const pipeline = createTTSPipeline(tts, 'audio/ogg', {
      onAudioChunk: (chunk) => chunks.push(chunk),
      onComplete: () => { completed = true; },
    });

    pipeline.push('This sentence should fail in TTS. ');
    await pipeline.flush();

    // Should complete without throwing
    expect(completed).toBe(true);
    // No audio chunks since TTS failed
    expect(chunks).toHaveLength(0);
  });

  it('force-flushes buffer exceeding max length', async () => {
    const tts = createMockTTS();
    const chunks: AudioChunkEvent[] = [];

    const pipeline = createTTSPipeline(tts, 'audio/ogg', {
      onAudioChunk: (chunk) => chunks.push(chunk),
      onComplete: () => {},
    });

    // Push a very long string without sentence boundaries
    const longText = 'word '.repeat(80); // ~400 chars, exceeds MAX_BUFFER_LENGTH
    pipeline.push(longText);

    // Should have force-flushed at least one chunk
    await pipeline.flush();
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty flush', async () => {
    const tts = createMockTTS();
    let completed = false;

    const pipeline = createTTSPipeline(tts, 'audio/ogg', {
      onAudioChunk: () => {},
      onComplete: () => { completed = true; },
    });

    // Flush without pushing anything
    await pipeline.flush();
    expect(completed).toBe(true);
  });
});

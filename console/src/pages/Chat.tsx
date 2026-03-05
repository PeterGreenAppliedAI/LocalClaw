import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Send, Volume2, Loader2, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { getToken } from '../api/client';
import { useStatus } from '../api/hooks';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  attachments?: { name: string; type: string; preview?: string }[];
}

interface PendingFile {
  file: File;
  preview?: string; // data URL for images
}

type ChatStatus = 'idle' | 'sending' | 'recording' | 'processing' | 'playing';

const VAD_SILENCE_MS = 1500;
const VAD_THRESHOLD = 0.01;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

function isImageType(mime: string): boolean {
  return mime.startsWith('image/');
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip data URL prefix to get raw base64
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [voiceMode, setVoiceMode] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  // Get the default senderId from system status (primary user identity)
  const { data: sysStatus } = useStatus();
  const senderId = sysStatus?.defaultSenderId ?? 'console-user';
  const senderIdRef = useRef(senderId);
  useEffect(() => { senderIdRef.current = senderId; }, [senderId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Voice refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number>(0);
  const voiceModeRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when not in voice mode
  useEffect(() => {
    if (!voiceMode && status === 'idle') {
      inputRef.current?.focus();
    }
  }, [voiceMode, status]);

  const addMessage = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    setMessages(prev => [...prev, {
      ...msg,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  // --- File handling ---
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newFiles: PendingFile[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`${file.name} exceeds 25MB limit`);
        continue;
      }

      const pending: PendingFile = { file };

      // Generate preview for images
      if (isImageType(file.type)) {
        const url = URL.createObjectURL(file);
        pending.preview = url;
      }

      newFiles.push(pending);
    }

    setPendingFiles(prev => [...prev, ...newFiles]);
    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, []);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles(prev => {
      const removed = prev[index];
      if (removed.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  // --- Text Chat ---
  const sendTextMessage = useCallback(async (text: string) => {
    const hasContent = text.trim() || pendingFiles.length > 0;
    if (!hasContent || status !== 'idle') return;

    // Build user message display
    const fileInfos = pendingFiles.map(pf => ({
      name: pf.file.name,
      type: pf.file.type,
      preview: pf.preview,
    }));

    const displayText = text.trim() || (pendingFiles.length > 0
      ? `[${pendingFiles.map(f => f.file.name).join(', ')}]`
      : '');

    addMessage({ role: 'user', content: displayText, attachments: fileInfos });
    setInput('');
    setStatus('sending');
    setStatusText(pendingFiles.length > 0 ? 'Processing attachments...' : 'Thinking...');

    // Convert files to base64
    const attachments: { name: string; data: string; mimeType: string }[] = [];
    for (const pf of pendingFiles) {
      try {
        const base64 = await fileToBase64(pf.file);
        attachments.push({ name: pf.file.name, data: base64, mimeType: pf.file.type });
      } catch (err) {
        console.error('Failed to read file:', pf.file.name, err);
      }
    }

    // Clear pending files
    pendingFiles.forEach(pf => { if (pf.preview) URL.revokeObjectURL(pf.preview); });
    setPendingFiles([]);

    const token = getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const body: Record<string, unknown> = {
        message: text.trim(),
        senderId: senderIdRef.current,
      };
      if (attachments.length > 0) {
        body.attachments = attachments;
      }

      const res = await fetch('/console/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Request failed');
        addMessage({ role: 'assistant', content: `Error: ${errText}` });
        setStatus('idle');
        setStatusText('');
        return;
      }

      // SSE consumption
      const reader = res.body?.getReader();
      if (!reader) {
        addMessage({ role: 'assistant', content: 'Error: No response body' });
        setStatus('idle');
        setStatusText('');
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'done' && event.answer) {
              addMessage({ role: 'assistant', content: event.answer });
            } else if (event.type === 'error') {
              addMessage({ role: 'assistant', content: `Error: ${event.error}` });
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      addMessage({ role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Network error'}` });
    }

    setStatus('idle');
    setStatusText('');
  }, [status, addMessage, pendingFiles]);

  // --- Voice ---
  const startRecording = useCallback(async () => {
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const source = audioContextRef.current.createMediaStreamSource(streamRef.current);
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      audioChunksRef.current = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(streamRef.current, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.start(250);
      mediaRecorderRef.current = recorder;

      setStatus('recording');
      setStatusText('Listening...');
      startVAD();
    } catch (err) {
      console.error('Mic error:', err);
      setStatusText('Microphone access denied');
      setVoiceMode(false);
    }
  }, []);

  const startVAD = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Float32Array(analyser.fftSize);
    let silenceStart = 0;
    let hasSpoken = false;

    const check = () => {
      if (!voiceModeRef.current) return;

      analyser.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);

      if (rms > VAD_THRESHOLD) {
        hasSpoken = true;
        silenceStart = 0;
      } else if (hasSpoken) {
        if (!silenceStart) {
          silenceStart = Date.now();
        } else if (Date.now() - silenceStart > VAD_SILENCE_MS) {
          stopAndSend();
          return;
        }
      }

      rafRef.current = requestAnimationFrame(check);
    };

    rafRef.current = requestAnimationFrame(check);
  }, []);

  const stopAndSend = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;

    cancelAnimationFrame(rafRef.current);

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });

    if (blob.size < 1000) {
      if (voiceModeRef.current) startRecording();
      return;
    }

    setStatus('processing');
    setStatusText('Processing...');

    const token = getToken();
    const headers: Record<string, string> = { 'Content-Type': recorder.mimeType };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      abortRef.current = new AbortController();
      const voiceUrl = `/api/voice?senderId=${encodeURIComponent(senderIdRef.current)}`;
      const res = await fetch(voiceUrl, {
        method: 'POST',
        headers,
        body: blob,
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        setStatusText('Error sending voice');
        if (voiceModeRef.current) setTimeout(() => startRecording(), 1000);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let playbackCtx: AudioContext | null = null;
      let nextPlayTime = 0;
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: any;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.stage === 'stt' && event.transcript) {
            addMessage({ role: 'user', content: event.transcript });
            setStatusText('Transcribed');
          } else if (event.stage === 'thinking') {
            setStatusText('Thinking...');
          } else if (event.stage === 'tts') {
            setStatusText('Generating speech...');
          } else if (event.stage === 'audio-chunk' && event.data) {
            if (!playbackCtx) {
              playbackCtx = new AudioContext();
              nextPlayTime = playbackCtx.currentTime;
              setStatus('playing');
              setStatusText('Speaking...');
            }
            chunkCount++;
            const bytes = atob(event.data);
            const arr = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
            try {
              const audioBuffer = await playbackCtx.decodeAudioData(arr.buffer.slice(0));
              const source = playbackCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(playbackCtx.destination);
              const startTime = Math.max(playbackCtx.currentTime, nextPlayTime);
              source.start(startTime);
              nextPlayTime = startTime + audioBuffer.duration;
            } catch (err) {
              console.warn('Audio chunk decode error:', err);
            }
          } else if (event.stage === 'audio-done') {
            const remaining = Math.max(0, nextPlayTime - (playbackCtx?.currentTime ?? 0));
            setTimeout(() => {
              setStatus('idle');
              if (voiceModeRef.current) startRecording();
            }, remaining * 1000 + 300);
          } else if (event.stage === 'done') {
            if (event.response) addMessage({ role: 'assistant', content: event.response });
            if (event.audio?.data && chunkCount === 0) {
              setStatus('playing');
              setStatusText('Speaking...');
              await playBase64Audio(event.audio.data, event.audio.mimeType, () => {
                setStatus('idle');
                if (voiceModeRef.current) startRecording();
              });
            } else if (chunkCount === 0) {
              setStatus('idle');
              if (voiceModeRef.current) startRecording();
            }
          }
        }
      }

      if (chunkCount > 0 && playbackCtx) {
        const remaining = Math.max(0, nextPlayTime - playbackCtx.currentTime);
        setTimeout(() => {
          setStatus('idle');
          if (voiceModeRef.current) startRecording();
        }, remaining * 1000 + 300);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Voice error:', err);
        setStatusText('Voice request failed');
      }
      setStatus('idle');
      if (voiceModeRef.current) setTimeout(() => startRecording(), 1000);
    }
  }, [addMessage, startRecording]);

  const toggleVoiceMode = useCallback(() => {
    if (voiceMode) {
      setVoiceMode(false);
      voiceModeRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
      abortRef.current?.abort();
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === 'recording') recorder.stop();
      setStatus('idle');
      setStatusText('');
    } else {
      setVoiceMode(true);
      startRecording();
    }
  }, [voiceMode, startRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      if (vadTimerRef.current) clearTimeout(vadTimerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === 'recording') recorder.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  // Paste handler — intercept pasted images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        e.preventDefault();
        const file = item.getAsFile();
        if (file && file.size <= MAX_FILE_SIZE) {
          const preview = isImageType(file.type) ? URL.createObjectURL(file) : undefined;
          setPendingFiles(prev => [...prev, { file, preview }]);
        }
      }
    }
  }, []);

  // Drag and drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;

    const newFiles: PendingFile[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) continue;
      const preview = isImageType(file.type) ? URL.createObjectURL(file) : undefined;
      newFiles.push({ file, preview });
    }
    setPendingFiles(prev => [...prev, ...newFiles]);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTextMessage(input);
    }
  };

  const isProcessing = status === 'sending' || status === 'processing';

  return (
    <div
      className="flex flex-col h-[calc(100vh-4rem)]"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-zinc-500">
              <p className="text-lg mb-1">Start a conversation</p>
              <p className="text-sm">Type a message, drop files, or tap the mic to talk</p>
            </div>
          </div>
        )}

        {messages.map(msg => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 border border-zinc-700 text-zinc-100'
              }`}
            >
              {/* Attachment previews */}
              {msg.attachments && msg.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {msg.attachments.map((att, i) => (
                    <div key={i}>
                      {att.preview ? (
                        <img
                          src={att.preview}
                          alt={att.name}
                          className="max-w-48 max-h-32 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5 bg-black/20 rounded-lg px-2.5 py-1.5 text-xs">
                          <FileText size={14} />
                          {att.name}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}

        {isProcessing && (
          <div className="flex justify-start">
            <div className="bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-400 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              {statusText || 'Thinking...'}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Voice mode banner */}
      {voiceMode && (
        <div className={`mx-4 mb-2 rounded-lg px-4 py-2 text-sm flex items-center gap-2 ${
          status === 'recording'
            ? 'bg-red-500/10 border border-red-500/30 text-red-400'
            : status === 'playing'
            ? 'bg-blue-500/10 border border-blue-500/30 text-blue-400'
            : 'bg-zinc-800 border border-zinc-700 text-zinc-400'
        }`}>
          {status === 'recording' && (
            <>
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
              </span>
              Listening... speak naturally, I'll detect when you're done
            </>
          )}
          {status === 'processing' && (
            <>
              <Loader2 size={14} className="animate-spin" />
              {statusText}
            </>
          )}
          {status === 'playing' && (
            <>
              <Volume2 size={14} />
              Speaking...
            </>
          )}
          {status === 'idle' && voiceMode && 'Voice mode active'}
        </div>
      )}

      {/* Pending files strip */}
      {pendingFiles.length > 0 && (
        <div className="mx-4 mb-1 flex flex-wrap gap-2">
          {pendingFiles.map((pf, i) => (
            <div
              key={i}
              className="relative group bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden"
            >
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="h-16 w-auto rounded-lg object-cover" />
              ) : (
                <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-zinc-300">
                  <FileText size={14} />
                  <span className="max-w-32 truncate">{pf.file.name}</span>
                </div>
              )}
              <button
                onClick={() => removePendingFile(i)}
                className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 rounded-full flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div className="border-t border-zinc-800 px-4 py-3 flex items-center gap-2">
        <button
          onClick={toggleVoiceMode}
          disabled={isProcessing && !voiceMode}
          className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            voiceMode
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400'
          }`}
          title={voiceMode ? 'Exit voice mode' : 'Enter voice mode'}
        >
          {voiceMode ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={voiceMode || isProcessing}
          className="flex-shrink-0 w-10 h-10 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-400 flex items-center justify-center transition-colors disabled:opacity-30"
          title="Attach files"
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.csv,.doc,.docx,.xls,.xlsx"
          onChange={handleFileSelect}
          className="hidden"
        />

        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={voiceMode ? 'Voice mode active — tap mic to stop' : 'Type a message...'}
          disabled={voiceMode || isProcessing}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />

        <button
          onClick={() => sendTextMessage(input)}
          disabled={(!input.trim() && pendingFiles.length === 0) || voiceMode || isProcessing}
          className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Send message"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}

/** Play base64-encoded audio and call onDone when finished */
function playBase64Audio(base64: string, mimeType: string, onDone: () => void): Promise<void> {
  return new Promise((resolve) => {
    const bytes = atob(base64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      onDone();
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      onDone();
      resolve();
    };
    audio.play().catch(() => {
      onDone();
      resolve();
    });
  });
}

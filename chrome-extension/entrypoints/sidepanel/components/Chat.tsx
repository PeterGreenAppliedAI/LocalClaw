import React, { useRef, useEffect, useState } from 'react';
import type { ChatMessage, Settings as SettingsType } from '../../../lib/types.js';
import { Message } from './Message.js';

interface ChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  streaming: boolean;
  connected: boolean;
  settings: SettingsType;
}

export function Chat({ messages, onSend, streaming, connected, settings }: ChatProps) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!input.trim() || streaming || !connected) return;
    onSend(input.trim());
    setInput('');
    // Reset textarea height
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  return (
    <>
      {/* Messages */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '12px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {messages.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-dim)', textAlign: 'center', padding: 24,
          }}>
            <div>
              <div style={{ fontSize: 24, marginBottom: 8 }}>LocalClaw</div>
              <div style={{ fontSize: 12 }}>
                {connected
                  ? 'Ask me anything. I can see your current page.'
                  : 'Not connected. Check settings.'}
              </div>
            </div>
          </div>
        )}

        {messages.map(msg => (
          <Message key={msg.id} message={msg} settings={settings} />
        ))}

        {streaming && (
          <div style={{
            padding: '8px 12px', background: 'var(--assistant-bg)',
            borderRadius: 'var(--radius)', color: 'var(--text-dim)', fontSize: 13,
          }}>
            Thinking...
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '8px 12px', borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}>
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-end',
          background: 'var(--bg-input)', borderRadius: 'var(--radius)',
          padding: '8px 12px',
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={connected ? 'Message LocalClaw...' : 'Not connected'}
            disabled={!connected || streaming}
            rows={1}
            style={{
              flex: 1, background: 'none', border: 'none', color: 'var(--text)',
              fontSize: 14, lineHeight: 1.5, resize: 'none', outline: 'none',
              fontFamily: 'inherit', maxHeight: 120,
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim() || streaming || !connected}
            style={{
              background: input.trim() && connected ? 'var(--accent)' : 'var(--border)',
              border: 'none', borderRadius: 6, padding: '6px 12px',
              color: 'white', cursor: input.trim() && connected ? 'pointer' : 'default',
              fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
            }}
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}

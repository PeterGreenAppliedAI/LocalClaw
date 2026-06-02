import React, { useState, useEffect, useCallback } from 'react';
import { Chat } from './components/Chat.js';
import { Settings } from './components/Settings.js';
import type { Settings as SettingsType, ChatMessage, PageContext } from '../../lib/types.js';
import { DEFAULT_SETTINGS } from '../../lib/types.js';
import { getSettings, saveSettings, getMessages, saveMessages, clearMessages, getSenderId } from '../../lib/storage.js';
import { streamChat, healthCheck } from '../../lib/api.js';

type View = 'chat' | 'settings' | 'loading';

export default function App() {
  const [view, setView] = useState<View>('loading');
  const [settings, setSettings] = useState<SettingsType>(DEFAULT_SETTINGS);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [senderId, setSenderId] = useState('');

  // Load persisted state
  useEffect(() => {
    Promise.all([getSettings(), getMessages(), getSenderId()]).then(([s, m, id]) => {
      setSettings(s);
      setMessages(m);
      setSenderId(id);
      // Show settings first if no host configured
      setView(s.host ? 'chat' : 'settings');
    });
  }, []);

  // Check connection on settings change
  useEffect(() => {
    if (!settings.host) return;
    healthCheck(settings).then(setConnected);
  }, [settings]);

  // Listen for context menu actions from background
  useEffect(() => {
    const handler = (message: any) => {
      if (message.type !== 'CONTEXT_MENU_ACTION') return;
      if (message.action === 'ask' && message.text) {
        sendMessage(`[PAGE: ${message.pageUrl} | ${message.pageTitle}]\n[SELECTED: ${message.text}]\n\nExplain this: ${message.text}`);
      } else if (message.action === 'summarize') {
        sendMessage(`[PAGE: ${message.pageUrl} | ${message.pageTitle}]\n\nSummarize this page`);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [settings, senderId, streaming]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    // Get page context
    let context: PageContext | null = null;
    try {
      context = await chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT' });
    } catch { /* may fail on restricted pages */ }

    // Build message with page context injected
    let fullMessage = text;
    if (context) {
      const parts: string[] = [];
      if (context.url) parts.push(`[PAGE: ${context.url} | ${context.title}]`);
      if (context.selectedText) parts.push(`[SELECTED: ${context.selectedText}]`);
      if (context.pageContent) parts.push(`[PAGE_CONTENT]\n${context.pageContent}\n[/PAGE_CONTENT]`);
      // Strip any existing [PAGE:] prefix from context menu actions
      const cleanText = text.replace(/^\[PAGE:[^\]]*\]\n*/g, '').trim();
      if (parts.length > 0) fullMessage = parts.join('\n') + '\n\n' + cleanText;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(36),
      role: 'user',
      content: text, // Show clean text in UI
      timestamp: Date.now(),
    };

    const updated = [...messages, userMsg];
    setMessages(updated);
    setStreaming(true);

    const assistantMsg: ChatMessage = {
      id: (Date.now() + 1).toString(36),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    try {
      for await (const event of streamChat(settings, fullMessage, senderId)) {
        if (event.type === 'done') {
          assistantMsg.content = event.answer ?? assistantMsg.content;
          assistantMsg.images = event.images;
        }
      }
    } catch (err) {
      assistantMsg.content = `Error: ${err instanceof Error ? err.message : 'Connection failed'}`;
    }

    const final = [...updated, assistantMsg];
    setMessages(final);
    saveMessages(final);
    setStreaming(false);
  }, [messages, settings, senderId, streaming]);

  const handleClear = useCallback(async () => {
    setMessages([]);
    await clearMessages();
    // Also reset server session
    try {
      await fetch(`${settings.host}/console/api/chat/reset`, {
        method: 'POST',
        headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {},
      });
    } catch { /* ignore */ }
  }, [settings]);

  const handleSettingsSave = useCallback(async (newSettings: SettingsType) => {
    setSettings(newSettings);
    await saveSettings(newSettings);
    setView('chat');
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>LocalClaw</span>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: connected === true ? 'var(--success)' : connected === false ? 'var(--error)' : 'var(--text-dim)',
          }} />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {view === 'chat' && (
            <HeaderButton onClick={handleClear} title="Clear chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M5 6l1 14h12l1-14M10 11v6M14 11v6"/></svg>
            </HeaderButton>
          )}
          <HeaderButton
            onClick={() => setView(view === 'settings' ? 'chat' : 'settings')}
            title={view === 'settings' ? 'Back to chat' : 'Settings'}
          >
            {view === 'settings' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
            )}
          </HeaderButton>
        </div>
      </div>

      {/* Body */}
      {view === 'settings' ? (
        <Settings settings={settings} onSave={handleSettingsSave} connected={connected} />
      ) : (
        <Chat
          messages={messages}
          onSend={sendMessage}
          streaming={streaming}
          connected={connected === true}
          settings={settings}
        />
      )}
    </div>
  );
}

function HeaderButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
        padding: 4, borderRadius: 4, display: 'flex', alignItems: 'center',
      }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
    >
      {children}
    </button>
  );
}

import React from 'react';
import type { ChatMessage, Settings } from '../../../lib/types.js';
import { fileUrl } from '../../../lib/api.js';

interface MessageProps {
  message: ChatMessage;
  settings: Settings;
}

export function Message({ message, settings }: MessageProps) {
  const isUser = message.role === 'user';

  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        maxWidth: '85%',
        padding: '8px 12px',
        borderRadius: 'var(--radius)',
        background: isUser ? 'var(--user-bg)' : 'var(--assistant-bg)',
        fontSize: 13,
        lineHeight: 1.6,
        wordBreak: 'break-word',
      }}>
        {renderContent(message.content)}

        {/* Render images if present */}
        {message.images && message.images.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {message.images.map((path, i) => (
              <img
                key={i}
                src={fileUrl(settings, path)}
                alt="Chart"
                style={{ maxWidth: '100%', borderRadius: 4 }}
                loading="lazy"
              />
            ))}
          </div>
        )}

        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

/** Simple markdown-like rendering — bold, code, newlines */
function renderContent(text: string): React.ReactNode {
  if (!text) return null;

  // Split into code blocks and regular text
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return parts.map((part, i) => {
    // Fenced code block
    if (part.startsWith('```') && part.endsWith('```')) {
      const code = part.slice(3, -3).replace(/^\w+\n/, ''); // strip language hint
      return (
        <pre key={i} style={{
          background: 'var(--bg)', padding: 8, borderRadius: 4,
          overflow: 'auto', fontSize: 12, margin: '4px 0',
          fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
        }}>
          {code}
        </pre>
      );
    }

    // Inline code
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} style={{
          background: 'var(--bg)', padding: '1px 4px', borderRadius: 3,
          fontSize: 12, fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
        }}>
          {part.slice(1, -1)}
        </code>
      );
    }

    // Regular text — handle bold and newlines
    return <span key={i}>{renderInline(part)}</span>;
  });
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\n)/g);
  return parts.map((part, i) => {
    if (part === '\n') return <br key={i} />;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

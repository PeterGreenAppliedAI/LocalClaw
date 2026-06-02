import React, { useState } from 'react';
import type { Settings as SettingsType } from '../../../lib/types.js';
import { healthCheck } from '../../../lib/api.js';

interface SettingsProps {
  settings: SettingsType;
  onSave: (settings: SettingsType) => void;
  connected: boolean | null;
}

export function Settings({ settings, onSave, connected }: SettingsProps) {
  const [host, setHost] = useState(settings.host);
  const [token, setToken] = useState(settings.token);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const ok = await healthCheck({ host, token });
    setTestResult(ok);
    setTesting(false);
  };

  const handleSave = () => {
    onSave({ host: host.replace(/\/+$/, ''), token: token.trim() });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', background: 'var(--bg-input)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    color: 'var(--text)', fontSize: 13, outline: 'none',
    fontFamily: 'inherit',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', marginBottom: 4, fontSize: 12,
    color: 'var(--text-dim)', fontWeight: 500,
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={labelStyle}>LocalClaw Host</label>
        <input
          type="text"
          value={host}
          onChange={e => setHost(e.target.value)}
          placeholder="http://192.168.x.x:3100"
          style={inputStyle}
        />
      </div>

      <div>
        <label style={labelStyle}>API Token (optional)</label>
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="Leave empty if not configured"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleTest} disabled={testing} style={{
          flex: 1, padding: '8px 12px', background: 'var(--bg-input)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          color: 'var(--text)', cursor: 'pointer', fontSize: 13,
        }}>
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button onClick={handleSave} style={{
          flex: 1, padding: '8px 12px', background: 'var(--accent)',
          border: 'none', borderRadius: 'var(--radius)',
          color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}>
          Save
        </button>
      </div>

      {/* Connection status */}
      {testResult !== null && (
        <div style={{
          padding: '8px 12px', borderRadius: 'var(--radius)',
          background: testResult ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          border: `1px solid ${testResult ? 'var(--success)' : 'var(--error)'}`,
          fontSize: 13,
          color: testResult ? 'var(--success)' : 'var(--error)',
        }}>
          {testResult ? 'Connected to LocalClaw' : 'Connection failed. Check host and token.'}
        </div>
      )}

      {connected !== null && testResult === null && (
        <div style={{
          padding: '8px 12px', borderRadius: 'var(--radius)',
          background: 'var(--bg-input)', fontSize: 12, color: 'var(--text-dim)',
        }}>
          Status: {connected ? 'Connected' : 'Disconnected'}
        </div>
      )}

      {/* Info */}
      <div style={{
        marginTop: 'auto', padding: '12px', borderRadius: 'var(--radius)',
        background: 'var(--bg-input)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>About</div>
        <div>LocalClaw browser companion. Connects to your local LocalClaw instance.</div>
        <div style={{ marginTop: 4 }}>Right-click selected text or a page to send to LocalClaw via context menu.</div>
      </div>
    </div>
  );
}

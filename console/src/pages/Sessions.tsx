import { useState } from 'react';
import { useSessions, useTranscript, useDeleteSession } from '../api/hooks';
import type { SessionMeta } from '../types';

export default function Sessions() {
  const [selected, setSelected] = useState<SessionMeta | null>(null);
  const [agentFilter, setAgentFilter] = useState('');
  const { data: sessions = [], isLoading } = useSessions();
  const { data: turns = [], isLoading: loadingTranscript } = useTranscript(
    selected?.agentId ?? '',
    selected?.sessionKey ?? '',
  );
  const deleteSession = useDeleteSession();

  const agents = [...new Set(sessions.map(s => s.agentId))];
  const filtered = agentFilter
    ? sessions.filter(s => s.agentId === agentFilter)
    : sessions;

  const sorted = [...filtered].sort(
    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
  );

  return (
    <div className="flex gap-6 h-[calc(100vh-8rem)]">
      {/* Session list */}
      <div className="w-80 shrink-0 flex flex-col gap-3">
        <h2 className="text-2xl font-bold">Sessions</h2>

        <select
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
        >
          <option value="">All agents</option>
          {agents.map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {isLoading && <p className="text-zinc-500 text-sm">Loading...</p>}
          {sorted.map(s => {
            const isSelected = selected?.agentId === s.agentId && selected?.sessionKey === s.sessionKey;
            return (
              <div
                key={`${s.agentId}/${s.sessionKey}`}
                className={`p-3 rounded cursor-pointer border transition-colors ${
                  isSelected
                    ? 'bg-zinc-700 border-blue-500'
                    : 'bg-zinc-800 border-zinc-700 hover:border-zinc-500'
                }`}
                onClick={() => setSelected(s)}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium bg-zinc-700 px-2 py-0.5 rounded">
                    {s.agentId}
                  </span>
                  <span className="text-xs text-zinc-500">{s.turnCount} turns</span>
                </div>
                <p className="text-sm text-zinc-300 truncate" title={s.sessionKey}>
                  {s.sessionKey}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  {new Date(s.lastActiveAt).toLocaleString()}
                </p>
                <button
                  className="text-xs text-red-400 hover:text-red-300 mt-1"
                  onClick={e => {
                    e.stopPropagation();
                    if (confirm('Delete this session?')) {
                      deleteSession.mutate({ agentId: s.agentId, sessionKey: s.sessionKey });
                      if (isSelected) setSelected(null);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            );
          })}
          {!isLoading && sorted.length === 0 && (
            <p className="text-zinc-500 text-sm">No sessions found</p>
          )}
        </div>
      </div>

      {/* Transcript viewer */}
      <div className="flex-1 flex flex-col bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-zinc-500">
            Select a session to view transcript
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-zinc-700 bg-zinc-900 flex items-center justify-between">
              <div>
                <span className="font-medium">{selected.agentId}</span>
                <span className="text-zinc-500 mx-2">/</span>
                <span className="text-zinc-400 text-sm">{selected.sessionKey}</span>
              </div>
              <span className="text-xs text-zinc-500">
                Created {new Date(selected.createdAt).toLocaleString()}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingTranscript && <p className="text-zinc-500">Loading transcript...</p>}
              {turns.map((turn, i) => (
                <div
                  key={i}
                  className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-lg px-4 py-2 ${
                      turn.role === 'user'
                        ? 'bg-blue-600 text-white'
                        : 'bg-zinc-700 text-zinc-200'
                    }`}
                  >
                    <p className="whitespace-pre-wrap text-sm">{turn.content}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs opacity-60">
                      <span>{new Date(turn.timestamp).toLocaleTimeString()}</span>
                      {turn.category && (
                        <span className="bg-zinc-600 px-1.5 py-0.5 rounded">{turn.category}</span>
                      )}
                      {turn.model && <span>{turn.model}</span>}
                    </div>
                    {turn.toolCalls && turn.toolCalls.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {turn.toolCalls.map((tc, j) => (
                          <details key={j} className="text-xs">
                            <summary className="cursor-pointer text-zinc-400 hover:text-zinc-300">
                              Tool: {tc.tool}
                            </summary>
                            <pre className="bg-zinc-900 p-2 rounded mt-1 overflow-x-auto text-xs">
                              {JSON.stringify(tc.params, null, 2)}
                            </pre>
                            <pre className="bg-zinc-900 p-2 rounded mt-1 overflow-x-auto text-xs text-green-400">
                              {tc.observation}
                            </pre>
                          </details>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

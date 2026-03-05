import { useState, useRef } from 'react';
import { useFacts, useMemorySenders, useConsolidateFacts } from '../api/hooks';

const CATEGORY_COLORS: Record<string, string> = {
  stable: 'bg-green-900 text-green-300',
  context: 'bg-blue-900 text-blue-300',
  decision: 'bg-purple-900 text-purple-300',
  question: 'bg-yellow-900 text-yellow-300',
};

export default function Memory() {
  const [senderId, setSenderId] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { data: senders = [] } = useMemorySenders();
  const { data: facts = [], isLoading } = useFacts(senderId || undefined, debouncedQuery || undefined);
  const consolidate = useConsolidateFacts();

  const handleSearch = (val: string) => {
    setQuery(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(val), 400);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Memory</h2>
        <button
          className="bg-purple-600 hover:bg-purple-500 px-4 py-2 rounded text-sm font-medium disabled:opacity-50"
          disabled={consolidate.isPending}
          onClick={() => consolidate.mutate(senderId || undefined)}
        >
          {consolidate.isPending ? 'Consolidating...' : 'Consolidate Facts'}
        </button>
      </div>

      <div className="flex gap-3 mb-6">
        <select
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
          value={senderId}
          onChange={e => setSenderId(e.target.value)}
        >
          <option value="">All senders</option>
          {senders.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm"
          placeholder="Search facts..."
          value={query}
          onChange={e => handleSearch(e.target.value)}
        />
      </div>

      {isLoading && <p className="text-zinc-500">Loading...</p>}

      <div className="text-xs text-zinc-500 mb-3">{facts.length} facts</div>

      <div className="space-y-2">
        {facts.map(fact => (
          <div
            key={fact.id}
            className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 hover:border-zinc-500 transition-colors"
          >
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm flex-1">{fact.text}</p>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-xs px-2 py-0.5 rounded ${CATEGORY_COLORS[fact.category] || 'bg-zinc-700'}`}>
                  {fact.category}
                </span>
                <span className="text-xs text-zinc-500">{Math.round(fact.confidence * 100)}%</span>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-1">
              {fact.tags.map(tag => (
                <span key={tag} className="text-xs bg-zinc-700 text-zinc-300 px-1.5 py-0.5 rounded">
                  {tag}
                </span>
              ))}
              {fact.entities.map(ent => (
                <span key={ent} className="text-xs bg-zinc-600 text-zinc-200 px-1.5 py-0.5 rounded italic">
                  {ent}
                </span>
              ))}
            </div>

            <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
              <span>{fact.source}</span>
              {fact.senderId && <span>sender: {fact.senderId}</span>}
              <span>{new Date(fact.createdAt).toLocaleDateString()}</span>
              {fact.expiresAt && (
                <span className="text-yellow-500">expires {new Date(fact.expiresAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {!isLoading && facts.length === 0 && (
        <p className="text-zinc-500">No facts found</p>
      )}
    </div>
  );
}

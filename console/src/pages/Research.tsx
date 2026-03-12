import { useState } from 'react';
import { useResearchDecks, useDeleteResearchDeck } from '../api/hooks';
import type { ResearchDeck } from '../types';
import { Trash2 } from 'lucide-react';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Research() {
  const { data: decks = [], isLoading } = useResearchDecks();
  const deleteDeck = useDeleteResearchDeck();
  const [selected, setSelected] = useState<ResearchDeck | null>(null);

  const handleDelete = (e: React.MouseEvent, slug: string) => {
    e.stopPropagation();
    if (confirm('Delete this research deck?')) {
      deleteDeck.mutate(slug);
      if (selected?.slug === slug) setSelected(null);
    }
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-4 mb-4">
          <button
            onClick={() => setSelected(null)}
            className="text-zinc-400 hover:text-white text-sm flex items-center gap-1"
          >
            &larr; Back to decks
          </button>
          <h2 className="text-xl font-bold flex-1">{selected.title}</h2>
          <button
            onClick={(e) => handleDelete(e, selected.slug)}
            className="text-zinc-500 hover:text-red-400 px-3 py-2 rounded text-sm"
            title="Delete deck"
          >
            <Trash2 size={16} />
          </button>
          <a
            href={selected.url}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-medium"
          >
            Open in new tab
          </a>
        </div>
        <div className="flex-1 bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <iframe
            src={selected.url}
            title={selected.title}
            className="w-full h-full border-0"
            style={{ minHeight: 'calc(100vh - 160px)' }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Research</h2>
          <p className="text-sm text-zinc-500 mt-1">
            Generated research decks — trigger with <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">!research</code> in chat
          </p>
        </div>
      </div>

      {isLoading && (
        <p className="text-zinc-500 text-sm">Loading...</p>
      )}

      {!isLoading && decks.length === 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-400 mb-2">No research decks yet</p>
          <p className="text-zinc-600 text-sm">
            Use <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">!research --market EV battery trends</code> in Discord or chat to generate one
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {decks.map(deck => (
          <div
            key={deck.slug}
            onClick={() => setSelected(deck)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 text-left hover:border-zinc-600 transition-colors group cursor-pointer relative"
          >
            <button
              onClick={(e) => handleDelete(e, deck.slug)}
              className="absolute top-3 right-3 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Delete deck"
            >
              <Trash2 size={14} />
            </button>
            <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors mb-2 pr-6">
              {deck.title}
            </h3>
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              <span>{formatDate(deck.createdAt)}</span>
              <span>&middot;</span>
              <span>{formatSize(deck.fileSize)}</span>
              {deck.chartCount > 0 && (
                <>
                  <span>&middot;</span>
                  <span>{deck.chartCount} chart{deck.chartCount !== 1 ? 's' : ''}</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

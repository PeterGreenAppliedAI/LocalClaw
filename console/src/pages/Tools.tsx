import { useState } from 'react';
import { useTools } from '../api/hooks';

export default function Tools() {
  const { data: tools = [], isLoading } = useTools();
  const [search, setSearch] = useState('');

  const filtered = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.description.toLowerCase().includes(search.toLowerCase()) ||
        t.category.toLowerCase().includes(search.toLowerCase())
      )
    : tools;

  // Group by category
  const grouped = filtered.reduce<Record<string, typeof tools>>((acc, tool) => {
    const cat = tool.category || 'uncategorized';
    (acc[cat] ??= []).push(tool);
    return acc;
  }, {});

  const categories = Object.keys(grouped).sort();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Tools</h2>

      <input
        className="w-full max-w-md bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm mb-6"
        placeholder="Search tools..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {isLoading && <p className="text-zinc-500">Loading...</p>}

      {categories.map(cat => (
        <div key={cat} className="mb-8">
          <h3 className="text-lg font-semibold mb-3 text-zinc-300 capitalize">{cat}</h3>
          <div className="space-y-2">
            {grouped[cat].map(tool => (
              <details
                key={tool.name}
                className="bg-zinc-800 border border-zinc-700 rounded-lg hover:border-zinc-500 transition-colors group"
              >
                <summary className="px-4 py-3 cursor-pointer flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-blue-400">{tool.name}</span>
                    <span className="text-sm text-zinc-400">{tool.description}</span>
                  </div>
                  <span className="text-xs text-zinc-600 group-open:rotate-90 transition-transform">&#9654;</span>
                </summary>
                <div className="px-4 pb-3 border-t border-zinc-700 pt-3">
                  <div className="text-sm text-zinc-400 mb-2">
                    <span className="font-medium text-zinc-300">Parameters:</span>{' '}
                    {tool.parameterDescription || 'None'}
                  </div>
                  {tool.parameters && (
                    <pre className="bg-zinc-900 p-3 rounded text-xs overflow-x-auto text-zinc-400">
                      {JSON.stringify(tool.parameters, null, 2)}
                    </pre>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      ))}

      {!isLoading && filtered.length === 0 && (
        <p className="text-zinc-500">No tools found</p>
      )}
    </div>
  );
}

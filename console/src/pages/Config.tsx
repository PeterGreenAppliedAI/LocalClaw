import { useState } from 'react';
import { useConfig } from '../api/hooks';

function ConfigNode({ name, value, depth = 0 }: { name: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null || value === undefined) {
    return (
      <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 16 }}>
        <span className="text-zinc-400">{name}:</span>
        <span className="text-zinc-500 italic">null</span>
      </div>
    );
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div style={{ paddingLeft: depth * 16 }}>
        <button
          className="flex items-center gap-1 py-0.5 hover:text-zinc-200 text-zinc-300 w-full text-left"
          onClick={() => setOpen(!open)}
        >
          <span className={`text-xs transition-transform ${open ? 'rotate-90' : ''}`}>&#9654;</span>
          <span className="font-medium">{name}</span>
          <span className="text-xs text-zinc-600 ml-1">({entries.length})</span>
        </button>
        {open && (
          <div>
            {entries.map(([k, v]) => (
              <ConfigNode key={k} name={k} value={v} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div style={{ paddingLeft: depth * 16 }}>
        <button
          className="flex items-center gap-1 py-0.5 hover:text-zinc-200 text-zinc-300 w-full text-left"
          onClick={() => setOpen(!open)}
        >
          <span className={`text-xs transition-transform ${open ? 'rotate-90' : ''}`}>&#9654;</span>
          <span className="font-medium">{name}</span>
          <span className="text-xs text-zinc-600 ml-1">[{value.length}]</span>
        </button>
        {open && (
          <div>
            {value.map((item, i) => (
              <ConfigNode key={i} name={`[${i}]`} value={item} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // Primitive value
  const isRedacted = typeof value === 'string' && value === '[REDACTED]';
  let valueClass = 'text-green-400';
  if (typeof value === 'number') valueClass = 'text-yellow-400';
  if (typeof value === 'boolean') valueClass = 'text-blue-400';
  if (isRedacted) valueClass = 'text-red-400 italic';

  return (
    <div className="flex items-center gap-2 py-0.5" style={{ paddingLeft: depth * 16 }}>
      <span className="text-zinc-400">{name}:</span>
      <span className={`text-sm ${valueClass}`}>
        {typeof value === 'string' ? (isRedacted ? value : `"${value}"`) : String(value)}
      </span>
    </div>
  );
}

export default function Config() {
  const { data: config, isLoading } = useConfig();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Configuration</h2>

      {isLoading && <p className="text-zinc-500">Loading...</p>}

      {config && (
        <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 font-mono text-sm">
          {Object.entries(config).map(([k, v]) => (
            <ConfigNode key={k} name={k} value={v} />
          ))}
        </div>
      )}
    </div>
  );
}

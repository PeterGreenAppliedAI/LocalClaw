import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBuilds, useBuild, useDeleteBuild } from '../api/hooks';
import { getToken } from '../api/client';
import type { BuildMeta, BuildStatus } from '../types';
import { Trash2, CheckCircle2, XCircle, CircleDashed, FileCode, Loader2, Play } from 'lucide-react';

function formatDate(iso?: string): string {
  if (!iso) return 'uncommitted';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function StatusBadge({ status }: { status: BuildStatus }) {
  const map = {
    passing: { icon: CheckCircle2, cls: 'text-green-400 bg-green-400/10', label: 'tests passing' },
    failing: { icon: XCircle, cls: 'text-red-400 bg-red-400/10', label: 'tests failing' },
    unknown: { icon: CircleDashed, cls: 'text-zinc-400 bg-zinc-400/10', label: 'no test status' },
  }[status];
  const Icon = map.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${map.cls}`}>
      <Icon size={12} /> {map.label}
    </span>
  );
}

function BuildDetailView({ slug, onBack }: { slug: string; onBack: () => void }) {
  const { data: build, isLoading } = useBuild(slug);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const files = build?.files ?? [];
  const current = files.find(f => f.path === activeFile) ?? files[0];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 mb-4">
        <button onClick={onBack} className="text-zinc-400 hover:text-white text-sm flex items-center gap-1">&larr; Back to builds</button>
        <h2 className="text-xl font-bold flex-1">{slug}</h2>
        {build && <StatusBadge status={build.status} />}
      </div>
      {build?.lastCommit && (
        <p className="text-xs text-zinc-500 mb-4">{build.lastCommit} &middot; {formatDate(build.lastCommitAt)}</p>
      )}
      {isLoading && <p className="text-zinc-500 text-sm">Loading...</p>}
      {!isLoading && files.length === 0 && <p className="text-zinc-500 text-sm">No source files.</p>}
      {files.length > 0 && (
        <div className="flex-1 flex gap-4 min-h-0">
          <div className="w-56 shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg p-2 overflow-y-auto">
            {files.map(f => (
              <button
                key={f.path}
                onClick={() => setActiveFile(f.path)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs flex items-center gap-1.5 truncate ${current?.path === f.path ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`}
              >
                <FileCode size={12} className="shrink-0" /> {f.path}
              </button>
            ))}
          </div>
          <div className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg overflow-auto">
            <pre className="text-xs text-zinc-300 p-4 font-mono whitespace-pre">{current?.content}{current?.truncated ? '\n\n…(truncated)' : ''}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Code() {
  const qc = useQueryClient();
  const { data: builds = [], isLoading } = useBuilds();
  const deleteBuild = useDeleteBuild();
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);

  const handleDelete = (e: React.MouseEvent, slug: string) => {
    e.stopPropagation();
    if (confirm(`Delete build "${slug}"? This removes the project directory.`)) {
      deleteBuild.mutate(slug);
      if (selected === slug) setSelected(null);
    }
  };

  const runBuild = async () => {
    const message = prompt.trim();
    if (!message || running) return;
    setRunning(true);
    setResult(null);
    setLog([`› Sending build request…`]);
    try {
      const token = getToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/console/api/code/build', { method: 'POST', headers, body: JSON.stringify({ message }) });
      const reader = res.body?.getReader();
      if (!reader) { setLog(l => [...l, 'Error: no response stream']); setRunning(false); return; }
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
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'status') setLog(l => [...l, ev.message]);
            else if (ev.type === 'done') { setResult(ev.answer); setLog(l => [...l, '✓ done']); }
            else if (ev.type === 'error') setLog(l => [...l, `✗ ${ev.error}`]);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setLog(l => [...l, `✗ ${err instanceof Error ? err.message : 'network error'}`]);
    } finally {
      setRunning(false);
      setPrompt('');
      qc.invalidateQueries({ queryKey: ['builds'] });
    }
  };

  if (selected) {
    return <div className="h-full" style={{ minHeight: 'calc(100vh - 120px)' }}><BuildDetailView slug={selected} onBack={() => setSelected(null)} /></div>;
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Code Builds</h2>
        <p className="text-sm text-zinc-500 mt-1">Projects built by the Pi coding agent.</p>
      </div>

      {/* Drive: kick off a build and watch it stream */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6">
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runBuild(); }}
          placeholder="Describe what to build — e.g. a Python CLI that converts CSV to JSON, with pytest tests"
          rows={2}
          disabled={running}
          className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 text-sm text-zinc-200 resize-none focus:outline-none focus:border-zinc-600 disabled:opacity-60"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-zinc-600">⌘/Ctrl+Enter to run · runs the full pipeline (build → test → fix → commit)</span>
          <button
            onClick={runBuild}
            disabled={running || !prompt.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed px-4 py-1.5 rounded text-sm font-medium flex items-center gap-2"
          >
            {running ? <><Loader2 size={14} className="animate-spin" /> Building…</> : <><Play size={14} /> Build</>}
          </button>
        </div>
        {(log.length > 0 || result) && (
          <div className="mt-3 bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-xs max-h-72 overflow-y-auto">
            {log.map((line, i) => <div key={i} className="text-zinc-400">{line}</div>)}
            {result && <div className="mt-2 pt-2 border-t border-zinc-800 text-zinc-300 whitespace-pre-wrap font-sans">{result}</div>}
          </div>
        )}
      </div>

      {isLoading && <p className="text-zinc-500 text-sm">Loading...</p>}

      {!isLoading && builds.length === 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-400 mb-2">No builds yet</p>
          <p className="text-zinc-600 text-sm">Ask the bot to "build a Python CLI that…" to generate one.</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {builds.map((b: BuildMeta) => (
          <div
            key={b.slug}
            onClick={() => setSelected(b.slug)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 text-left hover:border-zinc-600 transition-colors group cursor-pointer relative"
          >
            <button
              onClick={(e) => handleDelete(e, b.slug)}
              className="absolute top-3 right-3 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Delete build"
            >
              <Trash2 size={14} />
            </button>
            <h3 className="font-semibold text-white group-hover:text-blue-400 transition-colors mb-2 pr-6">{b.slug}</h3>
            <div className="mb-3"><StatusBadge status={b.status} /></div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <span>{b.fileCount} file{b.fileCount !== 1 ? 's' : ''}</span>
              <span>&middot;</span>
              <span>{formatDate(b.lastCommitAt)}</span>
              {!b.committed && <><span>&middot;</span><span className="text-amber-500">uncommitted</span></>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

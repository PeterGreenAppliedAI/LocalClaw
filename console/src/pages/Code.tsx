import { useState } from 'react';
import { useBuilds, useBuild, useDeleteBuild } from '../api/hooks';
import type { BuildMeta, BuildStatus } from '../types';
import { Trash2, CheckCircle2, XCircle, CircleDashed, FileCode } from 'lucide-react';

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
  const { data: builds = [], isLoading } = useBuilds();
  const deleteBuild = useDeleteBuild();
  const [selected, setSelected] = useState<string | null>(null);

  const handleDelete = (e: React.MouseEvent, slug: string) => {
    e.stopPropagation();
    if (confirm(`Delete build "${slug}"? This removes the project directory.`)) {
      deleteBuild.mutate(slug);
      if (selected === slug) setSelected(null);
    }
  };

  if (selected) {
    return <div className="h-full" style={{ minHeight: 'calc(100vh - 120px)' }}><BuildDetailView slug={selected} onBack={() => setSelected(null)} /></div>;
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Code Builds</h2>
        <p className="text-sm text-zinc-500 mt-1">
          Projects built by the Pi coding agent — trigger by asking the bot to <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">build …</code>
        </p>
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

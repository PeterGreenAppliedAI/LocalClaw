const colors: Record<string, string> = {
  connected: 'bg-emerald-500/20 text-emerald-400',
  connecting: 'bg-yellow-500/20 text-yellow-400',
  disconnected: 'bg-zinc-500/20 text-zinc-400',
  error: 'bg-red-500/20 text-red-400',
  high: 'bg-red-500/20 text-red-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  low: 'bg-zinc-500/20 text-zinc-400',
  stable: 'bg-blue-500/20 text-blue-400',
  context: 'bg-purple-500/20 text-purple-400',
  decision: 'bg-amber-500/20 text-amber-400',
  question: 'bg-cyan-500/20 text-cyan-400',
};

export default function Badge({ label, variant }: { label: string; variant?: string }) {
  const cls = colors[variant ?? label.toLowerCase()] ?? 'bg-zinc-500/20 text-zinc-400';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

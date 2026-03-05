import { useStatus, useChannels } from '../api/hooks';
import Card from '../components/shared/Card';
import Badge from '../components/shared/Badge';

export default function Dashboard() {
  const { data: status, isLoading } = useStatus();
  const { data: channels } = useChannels();

  if (isLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!status) return <p className="text-zinc-400">Failed to load status</p>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card
          title="Ollama"
          value={status.ollama.available ? 'Online' : 'Offline'}
          subtitle={`${status.ollama.models} models loaded`}
        />
        <Card title="Tools" value={status.tools} subtitle="registered" />
        <Card
          title="Cron"
          value={status.cron.jobs + status.cron.heartbeats}
          subtitle={`${status.cron.jobs} cron + ${status.cron.heartbeats} heartbeat`}
        />
        <Card title="Memory" value={status.memory.totalFacts} subtitle="facts stored" />
      </div>

      <h3 className="text-lg font-semibold mb-3">Channels</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {channels?.map(ch => (
          <div key={ch.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center justify-between">
            <span className="text-sm font-medium capitalize">{ch.id}</span>
            <Badge label={ch.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

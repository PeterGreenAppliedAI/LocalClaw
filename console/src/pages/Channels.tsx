import { useChannels, useReconnectChannel } from '../api/hooks';

const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  connected: { bg: 'bg-green-900/30', text: 'text-green-400', dot: 'bg-green-400' },
  connecting: { bg: 'bg-yellow-900/30', text: 'text-yellow-400', dot: 'bg-yellow-400' },
  disconnected: { bg: 'bg-zinc-800', text: 'text-zinc-400', dot: 'bg-zinc-500' },
  error: { bg: 'bg-red-900/30', text: 'text-red-400', dot: 'bg-red-400' },
};

export default function Channels() {
  const { data: channels = [], isLoading } = useChannels();
  const reconnect = useReconnectChannel();

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Channels</h2>

      {isLoading && <p className="text-zinc-500">Loading...</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {channels.map(ch => {
          const style = STATUS_STYLES[ch.status] || STATUS_STYLES.disconnected;
          return (
            <div
              key={ch.id}
              className={`${style.bg} border border-zinc-700 rounded-lg p-5 hover:border-zinc-500 transition-colors`}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-lg capitalize">{ch.id}</h3>
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
                  <span className={`text-sm font-medium ${style.text}`}>{ch.status}</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className={`text-xs px-2 py-0.5 rounded ${ch.enabled ? 'bg-green-900 text-green-300' : 'bg-zinc-700 text-zinc-400'}`}>
                  {ch.enabled ? 'Enabled' : 'Disabled'}
                </span>

                {(ch.status === 'disconnected' || ch.status === 'error') && (
                  <button
                    className="text-sm bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded disabled:opacity-50"
                    disabled={reconnect.isPending}
                    onClick={() => reconnect.mutate(ch.id)}
                  >
                    Reconnect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!isLoading && channels.length === 0 && (
        <p className="text-zinc-500">No channels configured</p>
      )}
    </div>
  );
}

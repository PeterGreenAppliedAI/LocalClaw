import { useState } from 'react';
import { useCronJobs, useRunCronJob, useToggleCronJob, useEditCronJob, useDeleteCronJob } from '../api/hooks';
import type { CronJob } from '../types';

function EditModal({ job, onClose }: { job: CronJob; onClose: () => void }) {
  const editJob = useEditCronJob();
  const [name, setName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule);
  const [category, setCategory] = useState(job.category);
  const [message, setMessage] = useState(job.message);
  const [channel, setChannel] = useState(job.delivery.channel);
  const [target, setTarget] = useState(job.delivery.target ?? '');

  const handleSave = () => {
    editJob.mutate(
      {
        id: job.id,
        name,
        schedule,
        category,
        message,
        delivery: { channel, target },
      } as any,
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-800 border border-zinc-600 rounded-lg p-6 w-full max-w-lg space-y-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold">Edit: {job.name}</h3>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Name</label>
          <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Schedule (cron expression)</label>
          <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm font-mono" value={schedule} onChange={e => setSchedule(e.target.value)} placeholder="0 9 * * *" />
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Category</label>
          <select className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={category} onChange={e => setCategory(e.target.value)}>
            {['chat', 'web_search', 'memory', 'exec', 'cron', 'message', 'website', 'multi', 'research', 'task'].map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs text-zinc-400 block mb-1">Message / Prompt</label>
          <textarea className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm resize-none" rows={3} value={message} onChange={e => setMessage(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Delivery Channel</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={channel} onChange={e => setChannel(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Delivery Target</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm" value={target} onChange={e => setTarget(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button className="text-sm text-zinc-400 hover:text-zinc-300 px-4 py-2" onClick={onClose}>Cancel</button>
          <button className="text-sm bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-medium" onClick={handleSave} disabled={editJob.isPending}>
            {editJob.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function JobCard({ job }: { job: CronJob }) {
  const runJob = useRunCronJob();
  const toggleJob = useToggleCronJob();
  const deleteJob = useDeleteCronJob();
  const [editing, setEditing] = useState(false);

  return (
    <>
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 hover:border-zinc-500 transition-colors">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium">{job.name}</h3>
          <div className="flex items-center gap-2">
            <button
              className={`relative w-10 h-5 rounded-full transition-colors ${
                job.enabled ? 'bg-green-600' : 'bg-zinc-600'
              }`}
              title={job.enabled ? 'Disable' : 'Enable'}
              onClick={() => toggleJob.mutate({ id: job.id, enabled: !job.enabled })}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                  job.enabled ? 'left-5' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        <div className="space-y-1 text-sm text-zinc-400">
          <div className="flex items-center gap-2">
            <span className="text-xs bg-zinc-700 px-2 py-0.5 rounded">{job.schedule}</span>
            <span className="text-xs bg-zinc-700 px-2 py-0.5 rounded">{job.category}</span>
          </div>
          <p className="text-xs line-clamp-2 text-zinc-500">{job.message}</p>
          <div className="text-xs text-zinc-500">
            Deliver to: <span className="text-zinc-400">{job.delivery.channel}</span>
            {' / '}
            <span className="text-zinc-400">{job.delivery.target}</span>
          </div>
          {job.lastRunAt && (
            <p className="text-xs text-zinc-500">
              Last run: {new Date(job.lastRunAt).toLocaleString()}
            </p>
          )}
        </div>

        <div className="flex gap-2 mt-3">
          <button
            className="text-xs bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded"
            disabled={runJob.isPending}
            onClick={() => runJob.mutate(job.id)}
          >
            {runJob.isPending ? 'Running...' : 'Run Now'}
          </button>
          <button
            className="text-xs text-blue-400 hover:text-blue-300 px-3 py-1"
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            className="text-xs text-red-400 hover:text-red-300 px-3 py-1"
            onClick={() => {
              if (confirm(`Delete "${job.name}"?`)) deleteJob.mutate(job.id);
            }}
          >
            Delete
          </button>
        </div>
      </div>
      {editing && <EditModal job={job} onClose={() => setEditing(false)} />}
    </>
  );
}

export default function Cron() {
  const { data: jobs = [], isLoading } = useCronJobs();

  const cronJobs = jobs.filter(j => j.type === 'cron');
  const heartbeats = jobs.filter(j => j.type === 'heartbeat');

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Cron & Heartbeats</h2>

      {isLoading && <p className="text-zinc-500">Loading...</p>}

      {cronJobs.length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-semibold mb-3 text-zinc-300">Cron Jobs</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {cronJobs.map(j => <JobCard key={j.id} job={j} />)}
          </div>
        </div>
      )}

      {heartbeats.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold mb-3 text-zinc-300">Heartbeats</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {heartbeats.map(j => <JobCard key={j.id} job={j} />)}
          </div>
        </div>
      )}

      {!isLoading && jobs.length === 0 && (
        <p className="text-zinc-500">No cron jobs or heartbeats configured</p>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { fetchApi } from '../api/client';

interface MetricsStats {
  totalRuns: number;
  successRate: number;
  avgStepCount: number;
  avgDurationMs: number;
  skillReuseCount: number;
  skillReuseSuccessRate: number;
  domSuccessRate: number;
  visualEscalationRate: number;
  reflectionImprovementRate: number;
  topFailedTools: Array<{ tool: string; failCount: number }>;
  outcomeDistribution: Array<{ outcome: string; count: number }>;
  pipelineDistribution: Array<{ pipeline: string; count: number }>;
  dailyRuns: Array<{ date: string; runs: number; successes: number }>;
}

interface PipelineRun {
  id: number;
  timestamp: string;
  pipeline: string;
  category: string;
  plan_source: string;
  skill_slug: string | null;
  step_count: number;
  step_success_count: number;
  step_fail_count: number;
  failed_steps: string | null;
  reflection_issue_count: number;
  reflection_revised_plan: number;
  dom_click_count: number;
  dom_click_success_count: number;
  visual_escalation_count: number;
  visual_escalation_success_count: number;
  smart_selection_used: number;
  smart_selection_target: string | null;
  duration_ms: number;
  outcome: string;
  user_message: string;
}

interface StepRecord {
  step_index: number;
  tool: string;
  purpose: string;
  result_class: string;
  retry_count: number;
  escalated: number;
  duration_ms: number;
  observation_preview: string | null;
}

function Stat({ label, value, subtitle, color }: { label: string; value: string | number; subtitle?: string; color?: string }) {
  return (
    <div className="bg-zinc-800 rounded-lg p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      {subtitle && <p className="text-xs text-zinc-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const colors: Record<string, string> = {
    success: 'bg-green-900 text-green-300',
    partial: 'bg-yellow-900 text-yellow-300',
    failed: 'bg-red-900 text-red-300',
    aborted: 'bg-zinc-700 text-zinc-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[outcome] ?? 'bg-zinc-700 text-zinc-400'}`}>
      {outcome}
    </span>
  );
}

function PlanSourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    fresh_plan: 'bg-blue-900 text-blue-300',
    saved_skill: 'bg-purple-900 text-purple-300',
    react_fallback: 'bg-zinc-700 text-zinc-400',
  };
  const labels: Record<string, string> = {
    fresh_plan: 'Fresh Plan',
    saved_skill: 'Saved Skill',
    react_fallback: 'ReAct',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[source] ?? 'bg-zinc-700 text-zinc-400'}`}>
      {labels[source] ?? source}
    </span>
  );
}

export default function Metrics() {
  const [stats, setStats] = useState<MetricsStats | null>(null);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [steps, setSteps] = useState<StepRecord[]>([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchApi<MetricsStats>(`/metrics/stats?days=${days}`),
      fetchApi<PipelineRun[]>(`/metrics/runs?limit=50`),
    ]).then(([s, r]) => {
      setStats(s);
      setRuns(r);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [days]);

  useEffect(() => {
    if (selectedRun === null) { setSteps([]); return; }
    fetchApi<StepRecord[]>(`/metrics/runs/${selectedRun}/steps`).then(setSteps).catch(() => setSteps([]));
  }, [selectedRun]);

  if (loading) return <p className="text-zinc-400">Loading metrics...</p>;
  if (!stats) return <p className="text-zinc-400">No execution metrics available. Metrics are recorded when pipeline runs complete.</p>;

  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const fmt = (ms: number) => ms > 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Execution Metrics</h2>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          className="bg-zinc-800 text-white border border-zinc-700 rounded px-3 py-1 text-sm"
        >
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
        <Stat label="Total Runs" value={stats.totalRuns} />
        <Stat label="Success Rate" value={pct(stats.successRate)} color={stats.successRate > 0.7 ? 'text-green-400' : stats.successRate > 0.4 ? 'text-yellow-400' : 'text-red-400'} />
        <Stat label="Avg Steps" value={stats.avgStepCount} />
        <Stat label="Avg Duration" value={fmt(stats.avgDurationMs)} />
        <Stat label="Skill Reuse" value={stats.skillReuseCount} subtitle={stats.skillReuseCount > 0 ? `${pct(stats.skillReuseSuccessRate)} success` : 'none yet'} />
        <Stat label="Reflection Hit" value={pct(stats.reflectionImprovementRate)} subtitle="plans revised" />
      </div>

      {/* Browser Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="DOM Click Success" value={pct(stats.domSuccessRate)} color={stats.domSuccessRate > 0.7 ? 'text-green-400' : 'text-yellow-400'} />
        <Stat label="Visual Escalation" value={pct(stats.visualEscalationRate)} subtitle="of DOM clicks" />
      </div>

      {/* Outcome Distribution */}
      {stats.outcomeDistribution.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Outcomes</h3>
          <div className="flex gap-4">
            {stats.outcomeDistribution.map(o => (
              <div key={o.outcome} className="flex items-center gap-2">
                <OutcomeBadge outcome={o.outcome} />
                <span className="text-zinc-300">{o.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline Distribution */}
      {stats.pipelineDistribution.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Pipelines</h3>
          <div className="flex flex-wrap gap-3">
            {stats.pipelineDistribution.map(p => (
              <div key={p.pipeline} className="bg-zinc-800 rounded px-3 py-2 text-sm">
                <span className="text-cyan-400">{p.pipeline}</span>
                <span className="text-zinc-500 ml-2">{p.count} runs</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Failed Tools */}
      {stats.topFailedTools.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3">Top Failed Tools</h3>
          <div className="space-y-1">
            {stats.topFailedTools.map(t => (
              <div key={t.tool} className="flex items-center gap-3">
                <span className="text-red-400 font-mono text-sm">{t.tool}</span>
                <div className="flex-1 bg-zinc-800 rounded-full h-2">
                  <div className="bg-red-500 rounded-full h-2" style={{ width: `${Math.min(100, (t.failCount / Math.max(1, stats.totalRuns)) * 100)}%` }} />
                </div>
                <span className="text-zinc-500 text-sm">{t.failCount}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Runs */}
      <h3 className="text-lg font-semibold mb-3">Recent Runs</h3>
      <div className="space-y-2 mb-6">
        {runs.map(run => (
          <div
            key={run.id}
            onClick={() => setSelectedRun(selectedRun === run.id ? null : run.id)}
            className={`bg-zinc-800 rounded-lg p-3 cursor-pointer hover:bg-zinc-750 transition-colors ${selectedRun === run.id ? 'ring-1 ring-cyan-500' : ''}`}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <OutcomeBadge outcome={run.outcome} />
              <PlanSourceBadge source={run.plan_source} />
              <span className="text-cyan-400 text-sm">{run.pipeline}</span>
              <span className="text-zinc-500 text-sm">{run.step_count} steps</span>
              <span className="text-zinc-500 text-sm">{fmt(run.duration_ms)}</span>
              {run.skill_slug && <span className="text-purple-400 text-xs">skill: {run.skill_slug.slice(0, 30)}</span>}
              <span className="text-zinc-600 text-xs ml-auto">{new Date(run.timestamp).toLocaleString()}</span>
            </div>
            <p className="text-zinc-400 text-sm mt-1 truncate">{run.user_message}</p>

            {/* Expanded step detail */}
            {selectedRun === run.id && steps.length > 0 && (
              <div className="mt-3 border-t border-zinc-700 pt-3 space-y-1">
                {steps.map(step => (
                  <div key={step.step_index} className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-600 w-6 text-right">{step.step_index + 1}.</span>
                    <span className={`font-mono ${step.result_class === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                      {step.tool}
                    </span>
                    {step.escalated ? <span className="text-yellow-500 text-xs">↑ visual</span> : null}
                    {step.retry_count > 0 ? <span className="text-orange-400 text-xs">×{step.retry_count + 1}</span> : null}
                    <span className="text-zinc-500 text-xs truncate flex-1">{step.purpose}</span>
                    <span className="text-zinc-600 text-xs">{fmt(step.duration_ms)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {runs.length === 0 && (
        <p className="text-zinc-500 text-center py-8">No pipeline runs recorded yet. Execute a plan pipeline task to see metrics here.</p>
      )}
    </div>
  );
}

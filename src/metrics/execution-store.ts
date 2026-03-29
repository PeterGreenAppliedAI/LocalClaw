/**
 * Execution metrics store — records pipeline and tool-loop execution data
 * for runtime introspection. Stored in SQLite for efficient querying.
 *
 * This is agent-level observability: why did this execution behave the way
 * it did? Not "what happened" (gateway handles that) but "why it made the
 * decisions it made and where execution quality degrades."
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PipelineRun {
  id?: number;
  timestamp: string;
  pipeline: string;
  category: string;
  /** 'fresh_plan' | 'saved_skill' | 'react_fallback' */
  planSource: string;
  skillSlug?: string;
  skillMatchScore?: number;
  stepCount: number;
  stepSuccessCount: number;
  stepFailCount: number;
  /** Comma-separated list of failed step names/tools */
  failedSteps?: string;
  reflectionIssueCount: number;
  reflectionRevisedPlan: boolean;
  domClickCount: number;
  domClickSuccessCount: number;
  visualEscalationCount: number;
  visualEscalationSuccessCount: number;
  smartSelectionUsed: boolean;
  smartSelectionTarget?: string;
  paramResolutionCount: number;
  durationMs: number;
  /** 'success' | 'partial' | 'failed' | 'aborted' */
  outcome: string;
  userMessage: string;
  answer?: string;
}

export interface StepRecord {
  id?: number;
  runId: number;
  stepIndex: number;
  tool: string;
  purpose: string;
  /** 'success' | 'error' | 'empty' | 'timeout' | 'escalated' */
  resultClass: string;
  retryCount: number;
  escalated: boolean;
  durationMs: number;
  /** First 500 chars of observation */
  observationPreview?: string;
}

export class ExecutionMetricsStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        pipeline TEXT NOT NULL,
        category TEXT NOT NULL,
        plan_source TEXT NOT NULL,
        skill_slug TEXT,
        skill_match_score INTEGER,
        step_count INTEGER NOT NULL DEFAULT 0,
        step_success_count INTEGER NOT NULL DEFAULT 0,
        step_fail_count INTEGER NOT NULL DEFAULT 0,
        failed_steps TEXT,
        reflection_issue_count INTEGER NOT NULL DEFAULT 0,
        reflection_revised_plan INTEGER NOT NULL DEFAULT 0,
        dom_click_count INTEGER NOT NULL DEFAULT 0,
        dom_click_success_count INTEGER NOT NULL DEFAULT 0,
        visual_escalation_count INTEGER NOT NULL DEFAULT 0,
        visual_escalation_success_count INTEGER NOT NULL DEFAULT 0,
        smart_selection_used INTEGER NOT NULL DEFAULT 0,
        smart_selection_target TEXT,
        param_resolution_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL,
        user_message TEXT NOT NULL,
        answer TEXT
      );

      CREATE TABLE IF NOT EXISTS step_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
        step_index INTEGER NOT NULL,
        tool TEXT NOT NULL,
        purpose TEXT,
        result_class TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        observation_preview TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON pipeline_runs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_runs_pipeline ON pipeline_runs(pipeline);
      CREATE INDEX IF NOT EXISTS idx_runs_outcome ON pipeline_runs(outcome);
      CREATE INDEX IF NOT EXISTS idx_steps_run_id ON step_records(run_id);
    `);
  }

  /** Record a completed pipeline run. Returns the run ID. */
  recordRun(run: PipelineRun): number {
    const stmt = this.db.prepare(`
      INSERT INTO pipeline_runs (
        timestamp, pipeline, category, plan_source, skill_slug, skill_match_score,
        step_count, step_success_count, step_fail_count, failed_steps,
        reflection_issue_count, reflection_revised_plan,
        dom_click_count, dom_click_success_count,
        visual_escalation_count, visual_escalation_success_count,
        smart_selection_used, smart_selection_target,
        param_resolution_count, duration_ms, outcome,
        user_message, answer
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?
      )
    `);

    const result = stmt.run(
      run.timestamp, run.pipeline, run.category, run.planSource, run.skillSlug ?? null, run.skillMatchScore ?? null,
      run.stepCount, run.stepSuccessCount, run.stepFailCount, run.failedSteps ?? null,
      run.reflectionIssueCount, run.reflectionRevisedPlan ? 1 : 0,
      run.domClickCount, run.domClickSuccessCount,
      run.visualEscalationCount, run.visualEscalationSuccessCount,
      run.smartSelectionUsed ? 1 : 0, run.smartSelectionTarget ?? null,
      run.paramResolutionCount, run.durationMs, run.outcome,
      run.userMessage, run.answer ?? null,
    );

    return result.lastInsertRowid as number;
  }

  /** Record a step within a run. */
  recordStep(step: StepRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO step_records (
        run_id, step_index, tool, purpose, result_class,
        retry_count, escalated, duration_ms, observation_preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      step.runId, step.stepIndex, step.tool, step.purpose ?? null, step.resultClass,
      step.retryCount, step.escalated ? 1 : 0, step.durationMs, step.observationPreview ?? null,
    );
  }

  /** Get recent pipeline runs. */
  getRecentRuns(limit = 50): PipelineRun[] {
    return this.db.prepare(`
      SELECT * FROM pipeline_runs ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as any[];
  }

  /** Get steps for a specific run. */
  getSteps(runId: number): StepRecord[] {
    return this.db.prepare(`
      SELECT * FROM step_records WHERE run_id = ? ORDER BY step_index
    `).all(runId) as any[];
  }

  /** Aggregate stats for dashboard. */
  getStats(days = 7): {
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
  } {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString();

    const runs = this.db.prepare(`SELECT * FROM pipeline_runs WHERE timestamp >= ?`).all(sinceStr) as any[];
    const totalRuns = runs.length;
    if (totalRuns === 0) {
      return {
        totalRuns: 0, successRate: 0, avgStepCount: 0, avgDurationMs: 0,
        skillReuseCount: 0, skillReuseSuccessRate: 0,
        domSuccessRate: 0, visualEscalationRate: 0, reflectionImprovementRate: 0,
        topFailedTools: [], outcomeDistribution: [], pipelineDistribution: [], dailyRuns: [],
      };
    }

    const successCount = runs.filter((r: any) => r.outcome === 'success').length;
    const avgSteps = runs.reduce((s: number, r: any) => s + r.step_count, 0) / totalRuns;
    const avgDuration = runs.reduce((s: number, r: any) => s + r.duration_ms, 0) / totalRuns;

    // Skill reuse
    const skillRuns = runs.filter((r: any) => r.plan_source === 'saved_skill');
    const skillSuccesses = skillRuns.filter((r: any) => r.outcome === 'success').length;

    // Browser
    const totalDomClicks = runs.reduce((s: number, r: any) => s + r.dom_click_count, 0);
    const totalDomSuccesses = runs.reduce((s: number, r: any) => s + r.dom_click_success_count, 0);
    const totalVisualEscalations = runs.reduce((s: number, r: any) => s + r.visual_escalation_count, 0);

    // Reflection
    const reflectedRuns = runs.filter((r: any) => r.reflection_issue_count > 0);
    const revisedRuns = reflectedRuns.filter((r: any) => r.reflection_revised_plan);

    // Top failed tools
    const toolFailCounts = new Map<string, number>();
    const steps = this.db.prepare(`
      SELECT tool, COUNT(*) as cnt FROM step_records
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE timestamp >= ?)
      AND result_class != 'success'
      GROUP BY tool ORDER BY cnt DESC LIMIT 10
    `).all(sinceStr) as any[];
    for (const s of steps) {
      toolFailCounts.set(s.tool, s.cnt);
    }

    // Outcome distribution
    const outcomes = this.db.prepare(`
      SELECT outcome, COUNT(*) as count FROM pipeline_runs
      WHERE timestamp >= ? GROUP BY outcome
    `).all(sinceStr) as any[];

    // Pipeline distribution
    const pipelines = this.db.prepare(`
      SELECT pipeline, COUNT(*) as count FROM pipeline_runs
      WHERE timestamp >= ? GROUP BY pipeline ORDER BY count DESC
    `).all(sinceStr) as any[];

    // Daily runs
    const daily = this.db.prepare(`
      SELECT DATE(timestamp) as date,
        COUNT(*) as runs,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
      FROM pipeline_runs WHERE timestamp >= ?
      GROUP BY DATE(timestamp) ORDER BY date
    `).all(sinceStr) as any[];

    return {
      totalRuns,
      successRate: totalRuns > 0 ? successCount / totalRuns : 0,
      avgStepCount: Math.round(avgSteps * 10) / 10,
      avgDurationMs: Math.round(avgDuration),
      skillReuseCount: skillRuns.length,
      skillReuseSuccessRate: skillRuns.length > 0 ? skillSuccesses / skillRuns.length : 0,
      domSuccessRate: totalDomClicks > 0 ? totalDomSuccesses / totalDomClicks : 0,
      visualEscalationRate: totalDomClicks > 0 ? totalVisualEscalations / totalDomClicks : 0,
      reflectionImprovementRate: reflectedRuns.length > 0 ? revisedRuns.length / reflectedRuns.length : 0,
      topFailedTools: [...toolFailCounts.entries()].map(([tool, failCount]) => ({ tool, failCount })),
      outcomeDistribution: outcomes,
      pipelineDistribution: pipelines,
      dailyRuns: daily,
    };
  }

  close(): void {
    this.db.close();
  }
}

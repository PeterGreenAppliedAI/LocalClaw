/**
 * Execution metrics collector — accumulates metrics during a pipeline run
 * and flushes to the ExecutionMetricsStore at the end.
 *
 * Usage: create at pipeline start, call track methods during execution,
 * call flush() when done.
 */

import type { ExecutionMetricsStore, PipelineRun, StepRecord } from './execution-store.js';

export class MetricsCollector {
  private startTime = Date.now();
  private steps: Omit<StepRecord, 'id' | 'runId'>[] = [];

  // Run-level metrics
  pipeline = '';
  category = '';
  planSource: 'fresh_plan' | 'saved_skill' | 'react_fallback' = 'fresh_plan';
  skillSlug?: string;
  skillMatchScore?: number;
  reflectionIssueCount = 0;
  reflectionRevisedPlan = false;
  domClickCount = 0;
  domClickSuccessCount = 0;
  visualEscalationCount = 0;
  visualEscalationSuccessCount = 0;
  smartSelectionUsed = false;
  smartSelectionTarget?: string;
  paramResolutionCount = 0;
  outcome: 'success' | 'partial' | 'failed' | 'aborted' = 'success';
  userMessage = '';
  answer?: string;

  /** Track a DOM click attempt. */
  trackDomClick(success: boolean): void {
    this.domClickCount++;
    if (success) this.domClickSuccessCount++;
  }

  /** Track a visual mode escalation. */
  trackVisualEscalation(success: boolean): void {
    this.visualEscalationCount++;
    if (success) this.visualEscalationSuccessCount++;
  }

  /** Track a step execution. */
  trackStep(step: {
    index: number;
    tool: string;
    purpose: string;
    resultClass: 'success' | 'error' | 'empty' | 'timeout' | 'escalated';
    retryCount?: number;
    escalated?: boolean;
    durationMs: number;
    observation?: string;
  }): void {
    this.steps.push({
      stepIndex: step.index,
      tool: step.tool,
      purpose: step.purpose,
      resultClass: step.resultClass,
      retryCount: step.retryCount ?? 0,
      escalated: step.escalated ?? false,
      durationMs: step.durationMs,
      observationPreview: step.observation?.slice(0, 500),
    });
  }

  /** Flush collected metrics to the store. */
  flush(store: ExecutionMetricsStore): number {
    const successSteps = this.steps.filter(s => s.resultClass === 'success').length;
    const failSteps = this.steps.filter(s => s.resultClass !== 'success').length;
    const failedTools = this.steps
      .filter(s => s.resultClass !== 'success')
      .map(s => s.tool);

    // Determine outcome from step results
    if (this.steps.length === 0) {
      this.outcome = 'aborted';
    } else if (failSteps === 0) {
      this.outcome = 'success';
    } else if (successSteps > failSteps) {
      this.outcome = 'partial';
    } else {
      this.outcome = 'failed';
    }

    const run: PipelineRun = {
      timestamp: new Date().toISOString(),
      pipeline: this.pipeline,
      category: this.category,
      planSource: this.planSource,
      skillSlug: this.skillSlug,
      skillMatchScore: this.skillMatchScore,
      stepCount: this.steps.length,
      stepSuccessCount: successSteps,
      stepFailCount: failSteps,
      failedSteps: failedTools.length > 0 ? failedTools.join(', ') : undefined,
      reflectionIssueCount: this.reflectionIssueCount,
      reflectionRevisedPlan: this.reflectionRevisedPlan,
      domClickCount: this.domClickCount,
      domClickSuccessCount: this.domClickSuccessCount,
      visualEscalationCount: this.visualEscalationCount,
      visualEscalationSuccessCount: this.visualEscalationSuccessCount,
      smartSelectionUsed: this.smartSelectionUsed,
      smartSelectionTarget: this.smartSelectionTarget,
      paramResolutionCount: this.paramResolutionCount,
      durationMs: Date.now() - this.startTime,
      outcome: this.outcome,
      userMessage: this.userMessage.slice(0, 500),
      answer: this.answer?.slice(0, 500),
    };

    const runId = store.recordRun(run);

    // Record individual steps
    for (const step of this.steps) {
      store.recordStep({ ...step, runId } as StepRecord);
    }

    console.log(`[Metrics] Recorded run #${runId}: ${this.pipeline} → ${this.outcome} (${this.steps.length} steps, ${Date.now() - this.startTime}ms)`);

    return runId;
  }
}

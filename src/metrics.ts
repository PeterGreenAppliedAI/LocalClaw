import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const METRICS_PATH = 'data/metrics.jsonl';

export interface MetricEvent {
  timestamp: string;
  type: string;
  category?: string;
  [key: string]: unknown;
}

let initialized = false;

function ensureDir(): void {
  if (!initialized) {
    mkdirSync(dirname(METRICS_PATH), { recursive: true });
    initialized = true;
  }
}

export function logMetric(event: MetricEvent): void {
  ensureDir();
  try {
    appendFileSync(METRICS_PATH, JSON.stringify(event) + '\n');
  } catch {
    // Non-critical — don't crash on metrics failure
  }
}

/** Log a dispatch cycle with timing and outcome */
export function logDispatch(data: {
  category: string;
  confidence: string;
  iterations: number;
  hitMaxIterations: boolean;
  durationMs: number;
  toolCalls?: string[];
  repairUsed?: boolean;
  abortReason?: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'dispatch',
    ...data,
  });
}

/** Log a tool execution */
export function logToolCall(data: {
  tool: string;
  category: string;
  durationMs: number;
  success: boolean;
  error?: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'tool_call',
    ...data,
  });
}

/** Log a narration repair (model narrated instead of using tool_calls) */
export function logRepair(data: {
  category: string;
  format: 'xml' | 'action' | 'repair_prompt';
  toolName: string;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'narration_repair',
    ...data,
  });
}

/** Log a router classification */
export function logRouterClassification(data: {
  category: string;
  confidence: string;
  durationMs: number;
}): void {
  logMetric({
    timestamp: new Date().toISOString(),
    type: 'router',
    ...data,
  });
}

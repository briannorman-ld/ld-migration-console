/**
 * Progress and time remaining for a run in flight. Steps are weighted by the LD requests they
 * make (planner `requestsFor`), and the pace comes from the steps this run has already finished,
 * so a run of 700 small segments and a run of 20 big flags both estimate from their own history.
 * Until enough has finished to measure, the plan's assumption of half a second per request is
 * used. Pure, so it can be tested with hand-written runs.
 */
import type { RunRecord, StepRecord } from '@sslm/executor';
import { requestsFor } from '@sslm/planner';

/** The plan modal's assumption before any step has run. */
export const DEFAULT_MS_PER_REQUEST = 500;
/** Finished steps needed before the measured pace is trusted over the default. */
const MIN_MEASURED_STEPS = 3;

export interface RunProgressInfo {
  total: number;
  /** Steps that are no longer pending or running (done, failed, skipped, pending approval, undone). */
  finished: number;
  /** 0–1, by request weight. */
  fraction: number;
  elapsedMs: number;
  /** Undefined until the run has started doing work; 0 when nothing is left. */
  remainingMs?: number;
  /** Whether the estimate comes from this run's own measured pace, or the default. */
  measured: boolean;
}

const weight = (s: StepRecord): number => Math.max(1, requestsFor(s.step));
const isFinished = (s: StepRecord): boolean => s.status !== 'pending' && s.status !== 'running';

export function runProgress(run: RunRecord, nowMs: number = Date.now()): RunProgressInfo {
  const total = run.steps.length;
  const finishedSteps = run.steps.filter(isFinished);
  const totalWeight = run.steps.reduce((n, s) => n + weight(s), 0);
  const doneWeight = finishedSteps.reduce((n, s) => n + weight(s), 0);
  const endMs = run.finishedAt ? Date.parse(run.finishedAt) : nowMs;
  const elapsedMs = Math.max(0, endMs - Date.parse(run.startedAt));

  // Pace from steps that actually did work (skipped ones finish instantly and would flatter it).
  const worked = finishedSteps.filter((s) => s.status !== 'skipped' && s.startedAt && s.finishedAt);
  const workedMs = worked.reduce((n, s) => n + Math.max(0, Date.parse(s.finishedAt!) - Date.parse(s.startedAt!)), 0);
  const workedWeight = worked.reduce((n, s) => n + weight(s), 0);
  const measured = worked.length >= MIN_MEASURED_STEPS && workedMs > 0;
  const msPerRequest = measured ? workedMs / workedWeight : DEFAULT_MS_PER_REQUEST;

  const remainingWeight = totalWeight - doneWeight;
  const running = run.steps.find((s) => s.status === 'running');
  const runningElapsed = running?.startedAt ? Math.max(0, nowMs - Date.parse(running.startedAt)) : 0;
  const inProgress = run.status === 'running' || run.status === 'undoing';
  const remainingMs = !inProgress ? (remainingWeight === 0 ? 0 : undefined) : Math.max(0, remainingWeight * msPerRequest - runningElapsed);

  return {
    total,
    finished: finishedSteps.length,
    fraction: totalWeight === 0 ? 1 : Math.min(1, doneWeight / totalWeight),
    elapsedMs,
    ...(remainingMs !== undefined ? { remainingMs } : {}),
    measured,
  };
}

/** "12 s", "4 min", "1 h 05 min": coarse on purpose, an estimate is not a stopwatch. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "about 4 min left", "under a minute left", or nothing before there is anything to go on. */
export function describeRemaining(p: RunProgressInfo): string | undefined {
  if (p.remainingMs === undefined) return undefined;
  if (p.remainingMs === 0) return p.finished < p.total ? undefined : 'done';
  if (p.remainingMs < 45_000) return 'under a minute left';
  return `about ${formatDuration(p.remainingMs)} left`;
}

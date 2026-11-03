import { describe, expect, it } from 'vitest';
import type { RunRecord, StepRecord } from '@sslm/executor';
import type { PlanStep } from '@sslm/planner';
import { describeRemaining, formatDuration, runProgress } from './runProgress.ts';

const T0 = Date.parse('2026-11-02T10:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** An existing segment step weighs 3 requests (read, create or patch, targets), a context kind 1 (planner `requestsFor`). */
const segment = (key: string): PlanStep =>
  ({ id: `segment:test:${key}`, deps: [], op: 'upsert_segment', ldEnv: 'test', key, exists: true, adopt: false, desired: { key, name: key, rules: [], included: [], includedContexts: [] }, provenance: {} }) as unknown as PlanStep;
const kind = (key: string): PlanStep => ({ id: `context_kind:${key}`, deps: [], op: 'ensure_context_kind', key, name: key, unitType: key });

function step(plan: PlanStep, status: StepRecord['status'], startMs?: number, endMs?: number): StepRecord {
  return { id: plan.id, label: plan.id, status, step: plan, ...(startMs !== undefined ? { startedAt: at(startMs) } : {}), ...(endMs !== undefined ? { finishedAt: at(endMs) } : {}) };
}

function run(steps: StepRecord[], status: RunRecord['status'] = 'running'): RunRecord {
  return { id: 'r', workspaceId: 'w', projectKey: 'p', label: 'l', dryRun: false, startedAt: at(0), status, steps };
}

describe('run progress', () => {
  it('weights the bar by requests and estimates the rest from the measured pace once three steps have run', () => {
    // 4 segments done in 2 s each (3 requests → 667 ms/request), one running for 1 s, 5 pending.
    const steps = [
      ...[0, 1, 2, 3].map((i) => step(segment(`s${i}`), 'done', i * 2000, i * 2000 + 2000)),
      step(segment('s4'), 'running', 8000),
      ...[5, 6, 7, 8, 9].map((i) => step(segment(`s${i}`), 'pending')),
    ];
    const p = runProgress(run(steps), T0 + 9000);
    expect(p).toMatchObject({ total: 10, finished: 4, measured: true, elapsedMs: 9000 });
    expect(p.fraction).toBeCloseTo(0.4, 5);
    // 6 steps × 3 requests × 666.7 ms = 12 s, minus the 1 s the running step has already taken.
    expect(p.remainingMs).toBeCloseTo(11_000, -2);
    expect(describeRemaining(p)).toBe('under a minute left');
  });

  it('uses the default pace before enough steps have finished, and ignores skipped steps when measuring', () => {
    const steps = [step(segment('a'), 'done', 0, 100), step(kind('k'), 'skipped'), step(segment('b'), 'running', 100), step(segment('c'), 'pending'), step(segment('d'), 'pending')];
    const p = runProgress(run(steps), T0 + 200);
    expect(p.measured).toBe(false);
    // 9 requests left × 500 ms − 100 ms already spent on the running step.
    expect(p.remainingMs).toBe(4400);
    expect(p.fraction).toBeCloseTo(4 / 13, 5);
  });

  it('spreads the remaining work over the steps that run at once, measuring the pace against the wall clock', () => {
    // Two waves of 4 segments, each wave 2 s: 16 s of step time in 4 s of wall clock. 8 more pending.
    const steps = [
      ...[0, 1, 2, 3].map((i) => step(segment(`s${i}`), 'done', 0, 2000)),
      ...[4, 5, 6, 7].map((i) => step(segment(`s${i}`), 'done', 2000, 4000)),
      ...[8, 9, 10, 11, 12, 13, 14, 15].map((i) => step(segment(`s${i}`), 'pending')),
    ];
    const p = runProgress({ ...run(steps), concurrency: 4 }, T0 + 4000);
    expect(p).toMatchObject({ measured: true, concurrency: 4 });
    expect(p.fraction).toBeCloseTo(0.5, 5);
    // 24 requests × 667 ms per slot ÷ 4 slots = 4 s: the second half takes as long as the first did,
    // not the 16 s that summing the overlapping step durations would claim.
    expect(p.remainingMs).toBeCloseTo(4000, -2);
    // A run record from before the concurrency was recorded: the overlap of the finished steps shows it.
    expect(runProgress(run(steps), T0 + 4000)).toMatchObject({ concurrency: 4, remainingMs: 4000 });
  });

  it('a rate-limit pause halves the steps at a time for the rest of the run and adds the wait', () => {
    const steps = [
      ...[0, 1, 2, 3].map((i) => step(segment(`s${i}`), 'done', 0, 2000)),
      ...[4, 5, 6, 7].map((i) => step(segment(`s${i}`), 'done', 2000, 4000)),
      ...[8, 9, 10, 11, 12, 13, 14, 15].map((i) => step(segment(`s${i}`), 'pending')),
    ];
    const paused = { ...run(steps), concurrency: 2, pause: { until: at(4000 + 60_000), reason: 'rate limit' } };
    const p = runProgress(paused, T0 + 4000);
    // The history ran 4 at a time, but the executor now runs 2: 24 requests × 667 ms ÷ 2 = 8 s, plus the 60 s wait.
    expect(p.concurrency).toBe(2);
    expect(p.remainingMs).toBeCloseTo(68_000, -2);
    expect(describeRemaining(p)).toBe('about 1 min left');
    // Half way through the wait, half of it is left.
    expect(runProgress(paused, T0 + 34_000).remainingMs).toBeCloseTo(38_000, -2);
  });

  it('does not credit more steps at a time than actually ran together', () => {
    // Four allowed, but dependencies kept it to one at a time: the estimate follows the history, not the setting.
    const steps = [...[0, 1, 2, 3].map((i) => step(segment(`s${i}`), 'done', i * 2000, i * 2000 + 2000)), ...[4, 5, 6, 7].map((i) => step(segment(`s${i}`), 'pending'))];
    const p = runProgress({ ...run(steps), concurrency: 4 }, T0 + 8000);
    expect(p.concurrency).toBe(1);
    expect(p.remainingMs).toBeCloseTo(8000, -2);
  });

  it('reports a finished run as complete with nothing remaining', () => {
    const steps = [step(segment('a'), 'done', 0, 500), step(segment('b'), 'failed', 500, 900)];
    const p = runProgress({ ...run(steps, 'done'), finishedAt: at(900) }, T0 + 60_000);
    expect(p).toMatchObject({ finished: 2, fraction: 1, remainingMs: 0, elapsedMs: 900 });
    expect(describeRemaining(p)).toBe('done');
  });

  it('formats durations coarsely', () => {
    expect(formatDuration(12_400)).toBe('12 s');
    expect(formatDuration(4 * 60_000 + 20_000)).toBe('4 min');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
    expect(describeRemaining({ total: 10, finished: 2, fraction: 0.2, elapsedMs: 0, remainingMs: 4 * 60_000, measured: true, concurrency: 1 })).toBe('about 4 min left');
    expect(describeRemaining({ total: 10, finished: 0, fraction: 0, elapsedMs: 0, measured: false, concurrency: 1 })).toBeUndefined();
  });
});

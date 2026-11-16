/**
 * Superseded steps (PLAN §9 step 7, "Resume"). A stopped or interrupted run keeps its pending
 * steps as planned, from the snapshot of that day. When a later run has since migrated the same
 * resource into the same environment, replaying the old step would at best re-write what the
 * newer run wrote and at worst put an older configuration back and claim ownership of a flag
 * the newer run created (its create answers 409 after this run started, so the executor would
 * count it as this run's). So before a resume, every still-pending step whose resource a later
 * run finished is marked `skipped` as superseded, and the Runs screen says how much of a run is
 * left rather than offering to replay all of it.
 */
import type { PlanStep } from '@sslm/planner';
import type { RunRecord, StepRecord } from './executor.ts';

/**
 * What a step writes, as the key two runs' steps share when they migrate the same thing to the
 * same place. Finer than `resourceLane` (which serialises writes to a flag across environments):
 * a run that set a flag's targeting in `production` does not supersede the same flag's step for
 * `staging`.
 */
export function stepIdentity(s: PlanStep): string {
  switch (s.op) {
    case 'upsert_flag_shell':
      return `upsert_flag_shell:${s.key}`;
    case 'update_flag_env':
      return `update_flag_env:${s.key}:${s.ldEnv}`;
    case 'create_bandit':
      return `create_bandit:${s.flagKey}:${s.ldEnv}`;
    case 'upsert_segment':
      return `upsert_segment:${s.ldEnv}:${s.key}`;
    case 'upsert_metric':
      return `upsert_metric:${s.key}`;
    case 'upsert_ai_config':
      return `upsert_ai_config:${s.key}`;
    case 'ensure_context_kind':
      return `ensure_context_kind:${s.key}`;
    case 'ensure_randomization_unit':
      return `ensure_randomization_unit:${s.key}`;
  }
}

/** A step a resume would run again. Mirrors the executor's own `resumable`. */
export function isResumableStep(s: StepRecord): boolean {
  return s.status === 'pending' || s.status === 'running' || s.status === 'failed';
}

export interface Supersession {
  /** The later run that did this step's work. */
  runId: string;
  runLabel: string;
  /** When that run started (the order the Runs screen shows). */
  startedAt: string;
  /** When that run finished the step, if it recorded it. */
  finishedAt?: string;
}

/**
 * For each resumable step of `run`, the latest later run of the same LaunchDarkly project that
 * finished a step with the same identity, if any. A dry run writes nothing, so it supersedes
 * nothing; a step that was undone no longer counts; `run` itself and runs started before it are
 * ignored, since an older run's result is what this run was planned over.
 */
export function supersededSteps(run: RunRecord, runs: readonly RunRecord[]): Map<string, Supersession> {
  const later = runs.filter((r) => r.id !== run.id && r.projectKey === run.projectKey && !r.dryRun && r.startedAt > run.startedAt).sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  if (later.length === 0) return new Map();
  const wanted = new Map<string, StepRecord[]>();
  for (const s of run.steps) {
    if (!isResumableStep(s)) continue;
    const id = stepIdentity(s.step);
    const list = wanted.get(id);
    if (list) list.push(s);
    else wanted.set(id, [s]);
  }
  const out = new Map<string, Supersession>();
  if (wanted.size === 0) return out;
  for (const r of later) {
    for (const s of r.steps) {
      if (s.status !== 'done') continue;
      const id = stepIdentity(s.step);
      const ours = wanted.get(id);
      if (!ours) continue;
      for (const o of ours) if (!out.has(o.id)) out.set(o.id, { runId: r.id, runLabel: r.label, startedAt: r.startedAt, ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}) });
      wanted.delete(id);
    }
    if (wanted.size === 0) break;
  }
  return out;
}

export interface ResumeOutlook {
  /** Resumable steps a later run has not done: what a resume would actually run. */
  outstanding: number;
  /** Resumable steps a later run has done: skipped as superseded on resume. */
  superseded: number;
  /** The runs that did the superseded work, newest first. */
  by: { runId: string; runLabel: string; steps: number }[];
}

/** What a resume of `run` would do, given every run of the workspace. */
export function resumeOutlook(run: RunRecord, runs: readonly RunRecord[]): ResumeOutlook {
  const map = supersededSteps(run, runs);
  const resumable = run.steps.filter(isResumableStep).length;
  const byRun = new Map<string, { runId: string; runLabel: string; startedAt: string; steps: number }>();
  for (const s of map.values()) {
    const cur = byRun.get(s.runId);
    if (cur) cur.steps++;
    else byRun.set(s.runId, { runId: s.runId, runLabel: s.runLabel, startedAt: s.startedAt, steps: 1 });
  }
  return {
    outstanding: resumable - map.size,
    superseded: map.size,
    by: [...byRun.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map(({ runId, runLabel, steps }) => ({ runId, runLabel, steps })),
  };
}

/**
 * Mark the superseded steps of `run` as skipped, in place, so the executor leaves them alone when
 * it resumes (a skipped step counts as settled for its dependents, which then read the flag the
 * later run left). Returns how many steps were marked. A skipped step never claims the resource,
 * so undoing this run later cannot touch what the newer run made.
 */
export function applySupersession(run: RunRecord, map: ReadonlyMap<string, Supersession>, now: Date): number {
  let n = 0;
  for (const s of run.steps) {
    const by = map.get(s.id);
    if (!by || !isResumableStep(s)) continue;
    s.status = 'skipped';
    s.finishedAt = now.toISOString();
    delete s.startedAt;
    delete s.error;
    s.message = `Superseded: run “${by.runLabel}” (#${by.runId.slice(0, 8)}) migrated this${by.finishedAt ? ` on ${by.finishedAt.slice(0, 10)}` : ''}; not replayed.`;
    n++;
  }
  return n;
}

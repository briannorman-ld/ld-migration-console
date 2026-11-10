/**
 * In-tab executor (PLAN §9 steps 4–7, §15). Runs a plan's steps against LD in order:
 * - every step is journaled before and after it runs, so a closed tab resumes where it stopped;
 * - every write is idempotent (a create that already happened is recognized by its provenance);
 * - the state of anything updated is captured first (pre-image), so the run can be undone;
 * - each flag environment is one atomic semantic PATCH that also records provenance.
 *
 * M4 fallbacks (PLAN §5.1): a 405 means the environment requires approvals, so the same
 * instructions go into an approval request and the step waits as `pending_approval` until
 * `checkApprovals` sees it applied; `time` conditions the user chose to schedule become LD
 * scheduled changes carrying the full targeting of that moment; ID lists above 15,000 become big
 * segments filled by a CSV import. The first write a plan refuses updates the capability matrix.
 */
import { footer as provenanceFooter, parseFooter as parseProvenanceFooter, PROP, readSync, SOURCE_KIND_LABEL, stableStringify, withFooter as withProvenanceFooter, type FooterInput, CONSOLE_CREATED_MARKER } from '@sslm/canonical';
import { LdAuthError, LdWriteError, type JsonPatchOp, type LdAiConfig, type LdClient, type LdExperiment, type LdExperimentationSettings, type LdFlag, type LdFlagConfig, type LdMetric, type LdSegment, type SemanticPatch } from '@sslm/ld-client';
import { flagOwner, ownsSegment, syncPropertyKey, type PlanStep, ldChange } from '@sslm/planner';
import { FLAG_SIZE_BUDGET, FLAG_SIZE_LIMIT, SOURCE_KIND, type DesiredBandit, type DesiredFlagEnv, type DesiredRule, type DesiredSegment, type VariationOrRollout } from '@sslm/mapper';
import type { MigrationSourceKind } from '@sslm/canonical';

export type LdWriter = Pick<
  LdClient,
  | 'getFlag'
  | 'createFlag'
  | 'patchFlagSemantic'
  | 'patchFlagJson'
  | 'deleteFlag'
  | 'getSegment'
  | 'createSegment'
  | 'patchSegmentJson'
  | 'patchSegmentSemantic'
  | 'deleteSegment'
  | 'putContextKind'
  | 'listContextKinds'
  | 'getMetric'
  | 'createMetric'
  | 'patchMetricJson'
  | 'deleteMetric'
  | 'getExperiment'
  | 'createExperiment'
  | 'createIteration'
  | 'patchExperimentSemantic'
  | 'getExperimentationSettings'
  | 'putExperimentationSettings'
  | 'createSegmentImport'
  | 'getSegmentMembership'
  | 'createFlagApprovalRequest'
  | 'getFlagApprovalRequest'
  | 'deleteFlagApprovalRequest'
  | 'createApprovalRequest'
  | 'getApprovalRequest'
  | 'deleteApprovalRequest'
  | 'listScheduledChanges'
  | 'createScheduledChange'
  | 'deleteScheduledChange'
  | 'getAiConfig'
  | 'createAiConfig'
  | 'patchAiConfig'
  | 'deleteAiConfig'
>;

/** `pending_approval`: the write went into an LD approval request; `checkApprovals` moves it on. */
export type StepStatus = 'pending' | 'running' | 'done' | 'pending_approval' | 'failed' | 'skipped' | 'undone';
export type RunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'undoing' | 'undone' | 'undo_failed';

export interface StepRecord {
  id: string;
  label: string;
  status: StepStatus;
  step: PlanStep;
  startedAt?: string;
  finishedAt?: string;
  /** Plain-language outcome, e.g. "Created flag", "Would update 3 rules". */
  message?: string;
  error?: string;
  /** The environment refused a direct write (HTTP 405), so the step went through approval requests. */
  approvalRequired?: boolean;
  /** Approval requests this step filed (targeting, one per scheduled change, or an undo). */
  approvals?: ApprovalRecord[];
  /** LD scheduled changes this step created (also recorded in the flag's sync provenance for re-syncs). */
  scheduledChangeIds?: string[];
  /** Big-segment CSV import: IDs sent, and how many sampled keys were confirmed as members afterwards. */
  import?: { ids: number; sampled: number; confirmed: number };
  /** A capability this step proved or disproved (PLAN §5.2 "the first failed write updates the matrix"). */
  capability?: CapabilityUpdate;
  /** Created by this run: undo deletes (or archives) it. */
  created?: boolean;
  /** A context kind that already existed, archived, and this run unarchived: undo archives it again. */
  unarchived?: boolean;
  /** State before this run touched it: undo restores it. Contains customer config; stays local. */
  preImage?: LdFlag | LdSegment | LdMetric | LdExperiment | LdExperimentationSettings;
  /**
   * Set by the journal (@sslm/store) on a record it lists without its pre-image, which it keeps
   * apart; reading the run back by id puts the pre-image in place.
   */
  hasPreImage?: boolean;
  ldVersion?: number;
}

export interface ApprovalRecord {
  id: string;
  /** Flag-scoped request (flag environment routes) or a generic one (segments). */
  kind: 'flag' | 'segment';
  purpose: 'targeting' | 'scheduled_change' | 'undo';
  status: 'pending' | 'applied' | 'declined' | 'failed';
  createdAt: string;
  /** For a scheduled change filed through an approval: when LD applies it once approved. */
  executionDate?: string;
  checkedAt?: string;
  reviewStatus?: string;
}

export interface CapabilityUpdate {
  key: 'prerequisites' | 'big_segments' | 'scheduled_changes' | 'approvals' | 'context_kinds' | 'invite_members' | 'approval_settings' | 'ai_configs' | 'teams';
  status: 'available' | 'unavailable' | 'not_permitted';
  evidence: string;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  projectKey: string;
  label: string;
  dryRun: boolean;
  actor?: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  steps: StepRecord[];
  undoneAt?: string;
  /** Why a `stopped` (or cancelled `undo_failed`) run ended early: a cancel, or the systemic error. */
  stopReason?: string;
  /** Set while the run waits out a LaunchDarkly rate limit (PLAN §9 step 6); cleared when it goes on. */
  pause?: { until: string; reason: string };
  /** Steps run at once right now: the executor's setting, halved by each rate-limit pause. Drives the time-left estimate. */
  concurrency?: number;
}

export interface Journal {
  save(run: RunRecord): Promise<void>;
}

/**
 * A flag or segment as LaunchDarkly returned it from a write this run made, or `null` once the run
 * deleted it (undo). The app merges these into its listings when the run ends, instead of
 * re-listing the whole project.
 */
export type ResourceChange = { kind: 'flag'; key: string; flag: LdFlag | null } | { kind: 'segment'; ldEnv: string; key: string; segment: LdSegment | null };

export interface ExecutorOptions {
  client: LdWriter;
  projectKey: string;
  journal: Journal;
  /** Every flag and segment a write returned (never a dry run's), in order; the last report per key is the current state. */
  onResource?: (change: ResourceChange) => void;
  /** Shown in LD audit-log comments, e.g. the member email from caller identity. */
  actor?: string;
  onProgress?: (run: RunRecord) => void;
  /** A write proved or disproved an LD capability (plan-gated features). The app updates its matrix. */
  onCapability?: (c: CapabilityUpdate) => void;
  now?: () => Date;
  /** Wait between membership checks after a big-segment import (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Membership checks after an import before giving up on confirmation (default 6, 5 s apart). */
  importChecks?: number;
  /**
   * Steps in flight at once (default 4). Only independent steps overlap: a step waits for its
   * dependencies, and steps on the same LaunchDarkly resource run one at a time in plan order
   * (`resourceLane`). The transport's limiter caps the requests this produces.
   */
  concurrency?: number;
}

export const DEFAULT_CONCURRENCY = 4;

/**
 * Steps that write the same resource share a lane and never overlap: the run's flag cache assumes
 * one writer per flag, concurrent PUTs of the experimentation settings would race, and
 * LaunchDarkly's per-resource limits punish rapid writes to one item.
 */
export function resourceLane(s: PlanStep): string {
  switch (s.op) {
    case 'upsert_flag_shell':
    case 'update_flag_env':
      return `flag:${s.key}`;
    case 'create_bandit':
      return `flag:${s.flagKey}`;
    case 'upsert_segment':
      return `segment:${s.ldEnv}:${s.key}`;
    case 'upsert_metric':
      return `metric:${s.key}`;
    case 'upsert_ai_config':
      return `ai_config:${s.key}`;
    case 'ensure_context_kind':
      return `context_kind:${s.key}`;
    case 'ensure_randomization_unit':
      return 'experimentation_settings';
  }
}

/**
 * Systemic failures stop the whole run instead of failing every remaining step (PLAN §9 step 6).
 * A 429 that survived the transport's retries means LD is still throttling us: pressing on would
 * burn a minute of backoff per step against the same limit, so stop and let the user resume. An
 * unreachable LD (a timed-out write, a dropped connection) is the same wall for every step.
 */
function isSystemic(e: unknown): boolean {
  return e instanceof LdAuthError || (e instanceof LdWriteError && (e.status === 403 || e.status === 429 || e.status === 'unreachable'));
}

const isRateLimit = (e: unknown): boolean => e instanceof LdWriteError && e.status === 429;
const isUnreachable = (e: unknown): boolean => e instanceof LdWriteError && e.status === 'unreachable';
/** A failure that usually clears by itself: the run pauses and retries before it gives up. */
const isTransient = (e: unknown): boolean => isRateLimit(e) || isUnreachable(e);

/**
 * A 429 that outlived the transport's retries, or a write that timed out, pauses the whole run
 * rather than stopping it: every step in flight settles, the run waits (a minute, then two, then
 * four) with half the concurrency, and the step is retried. A long run then rides out
 * LaunchDarkly's limit or a slow minute by itself; only a failure that holds through every pause
 * stops the run for the user to resume later.
 */
export const RATE_LIMIT_PAUSE_MS = 60_000;
export const MAX_RATE_LIMIT_PAUSES = 3;

export function stepLabel(s: PlanStep): string {
  switch (s.op) {
    case 'ensure_context_kind':
      return `Context kind “${s.key}”`;
    case 'upsert_segment':
      return `Segment “${s.key}” in ${s.ldEnv}`;
    case 'upsert_flag_shell':
      return `Flag “${s.key}” (project settings)`;
    case 'update_flag_env':
      return `Flag “${s.key}” targeting in ${s.ldEnv}`;
    case 'ensure_randomization_unit':
      return `Randomization unit “${s.key}” (experimentation settings)`;
    case 'upsert_metric':
      return `Metric “${s.key}” (project)`;
    case 'create_bandit':
      return `Bandit “${s.key}” in ${s.ldEnv} (draft)`;
    case 'upsert_ai_config':
      return `AI Config “${s.key}” (project)`;
  }
}

export function newRun(input: { id: string; workspaceId: string; projectKey: string; label: string; dryRun: boolean; actor?: string; steps: PlanStep[]; now: Date }): RunRecord {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    projectKey: input.projectKey,
    label: input.label,
    dryRun: input.dryRun,
    ...(input.actor ? { actor: input.actor } : {}),
    startedAt: input.now.toISOString(),
    status: 'running',
    steps: input.steps.map((step) => ({ id: step.id, label: stepLabel(step), status: 'pending', step })),
  };
}

export class Executor {
  private readonly c: LdWriter;
  private readonly p: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Flags read during this run, by key (variation IDs for prerequisites). */
  private readonly flags = new Map<string, LdFlag>();
  /** The current run's cancel signal; every LD call gets it, so a cancel also aborts the write in flight. */
  private signal?: AbortSignal;

  constructor(private readonly opts: ExecutorOptions) {
    this.c = opts.client;
    this.p = opts.projectKey;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Waits `ms`, or until the run is cancelled. */
  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal?.removeEventListener('abort', done);
        resolve();
      };
      signal?.addEventListener('abort', done, { once: true });
      void this.sleep(ms).then(done);
    });
  }

  /**
   * Runs (or resumes) every pending step. A dry run writes nothing (LD `dryRun=true`).
   *
   * Up to `concurrency` independent steps run at once, each started in plan order as soon as its
   * dependencies have finished and no other step is writing the same resource (`resourceLane`).
   * A run of a thousand segments is then paced by LaunchDarkly's latency divided by the
   * concurrency rather than by it alone.
   *
   * Aborting `signal` stops the run: nothing more starts, the steps in flight finish (one that
   * throws goes back to `pending`; the write may or may not have reached LD, and resuming
   * re-checks it idempotently), the next step not started is marked cancelled, later steps stay
   * `pending`, and the run is `stopped` with `stopReason`, never `failed`. A systemic error
   * (auth, 403, a 429 or an unreachable LD that survived the retries and the pauses) stops it the same way.
   */
  async run(run: RunRecord, signal?: AbortSignal): Promise<RunRecord> {
    this.signal = signal;
    run.status = 'running';
    delete run.stopReason;
    await this.save(run);
    let concurrency = Math.max(1, Math.floor(this.opts.concurrency ?? DEFAULT_CONCURRENCY));
    run.concurrency = concurrency;
    const byId = new Map(run.steps.map((s) => [s.id, s]));
    /** Failed or skipped in this run: their dependents are skipped. */
    const failed = new Set<string>();
    /** Started (or skipped) in this run, so a resumed `failed` step is retried once. */
    const started = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    const lanes = new Set<string>();
    let halt = false;
    /** A 429 outlived the retries, or a write timed out: nothing new starts, and once the steps in flight settle the run waits. */
    let pausing = false;
    let pauses = 0;
    let pauseCause: 'rate_limit' | 'unreachable' = 'rate_limit';
    const resumable = (s: StepRecord) => s.status === 'pending' || s.status === 'running' || s.status === 'failed';
    const settled = (id: string) => {
      const s = byId.get(id);
      return !s || s.status === 'done' || s.status === 'pending_approval' || s.status === 'skipped';
    };
    const start = (rec: StepRecord) => {
      const lane = resourceLane(rec.step);
      lanes.add(lane);
      started.add(rec.id);
      const work = (async () => {
        rec.status = 'running';
        rec.startedAt = this.now().toISOString();
        delete rec.error;
        await this.save(run);
        try {
          rec.message = await this.execute(run, rec);
          rec.status = rec.approvals?.some((a) => a.status === 'pending') ? 'pending_approval' : 'done';
        } catch (e) {
          if (signal?.aborted) {
            this.cancel(run, rec, true);
            halt = true;
            await this.save(run);
            return;
          }
          if (isTransient(e) && !halt && (pausing || pauses < MAX_RATE_LIMIT_PAUSES)) {
            // LaunchDarkly is still throttling after the client's own retries, or a write timed out.
            // The step goes back to pending and is retried once the run has waited; the loop below
            // pauses when nothing is in flight.
            if (!pausing) {
              pausing = true;
              pauses++;
              pauseCause = isRateLimit(e) ? 'rate_limit' : 'unreachable';
            }
            rec.status = 'pending';
            delete rec.startedAt;
            delete rec.error;
            started.delete(rec.id);
            rec.message = isRateLimit(e)
              ? `LaunchDarkly rate limit (429) after the client's retries; the run pauses, then retries this step.`
              : `LaunchDarkly unreachable (${(e as LdWriteError).path} timed out or the connection dropped); the run pauses, then retries this step.`;
            await this.save(run);
            return;
          }
          if (isSystemic(e) && halt) {
            // The run is already stopping on a systemic error; this step met the same wall. It goes
            // back to pending (not failed), so the resume retries it rather than skipping its dependents.
            rec.status = 'pending';
            delete rec.startedAt;
            delete rec.error;
            rec.message = `Stopped with the run (${(e as Error).message}); resuming retries it.`;
            await this.save(run);
            return;
          }
          rec.status = 'failed';
          rec.error = (e as Error).message;
          if (e instanceof LdWriteError && e.status === 405) rec.approvalRequired = true;
          failed.add(rec.id);
          if (isSystemic(e)) {
            rec.finishedAt = this.now().toISOString();
            run.status = 'stopped';
            const pauseCount = `${pauses} pause${pauses === 1 ? '' : 's'}`;
            run.stopReason = isRateLimit(e)
              ? `Stopped on LaunchDarkly's rate limit after ${pauseCount}: ${rec.error} Resume from Runs in a few minutes; failed steps are retried.`
              : isUnreachable(e)
                ? `Stopped because LaunchDarkly stayed unreachable through ${pauseCount}: ${rec.error} Check your connection and LaunchDarkly's status, then resume from Runs; failed steps are retried.`
                : `Stopped on a systemic error: ${rec.error} Fix it, then resume from Runs.`;
            halt = true;
            await this.save(run);
            return;
          }
        }
        rec.finishedAt = this.now().toISOString();
        await this.save(run);
      })().finally(() => {
        inFlight.delete(rec.id);
        lanes.delete(lane);
      });
      inFlight.set(rec.id, work);
    };
    for (;;) {
      if (signal?.aborted) halt = true;
      if (pausing && !halt && inFlight.size === 0) {
        const ms = RATE_LIMIT_PAUSE_MS * 2 ** (pauses - 1);
        concurrency = Math.max(1, Math.floor(concurrency / 2));
        run.concurrency = concurrency;
        run.pause = {
          until: new Date(this.now().getTime() + ms).toISOString(),
          reason: `${pauseCause === 'rate_limit' ? "LaunchDarkly's API rate limit held through the client's retries" : 'A write to LaunchDarkly timed out or the connection dropped'}. Pause ${pauses} of ${MAX_RATE_LIMIT_PAUSES}: waiting ${Math.round(ms / 1000)} s, then going on with ${concurrency} step${concurrency === 1 ? '' : 's'} at a time.`,
        };
        await this.save(run);
        await this.pause(ms, signal);
        delete run.pause;
        pausing = false;
        if (signal?.aborted) halt = true;
        await this.save(run);
      }
      if (!halt && !pausing) {
        for (const rec of run.steps) {
          if (inFlight.size >= concurrency) break;
          if (!resumable(rec) || started.has(rec.id)) continue;
          const blockedBy = rec.step.deps.find((d) => failed.has(d));
          if (blockedBy) {
            rec.status = 'skipped';
            rec.message = `Skipped: depends on ${byId.get(blockedBy)?.label ?? blockedBy}, which failed.`;
            failed.add(rec.id);
            started.add(rec.id);
            await this.save(run);
            continue;
          }
          if (!rec.step.deps.every(settled)) continue;
          if (lanes.has(resourceLane(rec.step))) continue;
          start(rec);
        }
      }
      if (inFlight.size === 0 && (!pausing || halt)) break;
      if (inFlight.size) await Promise.race(inFlight.values());
    }
    if (run.status === 'running' && signal?.aborted) {
      const next = run.steps.find((s) => resumable(s) && !started.has(s.id));
      if (next) this.cancel(run, next);
    }
    if (run.status === 'running') run.status = run.steps.some((s) => s.status === 'failed') ? 'failed' : 'done';
    run.finishedAt = this.now().toISOString();
    await this.save(run);
    return run;
  }

  /**
   * Undo a run: restore pre-images and delete what it created, newest first (PLAN §15).
   * Aborting `signal` leaves the remaining steps as they were; the run ends `undo_failed` with a
   * `stopReason` saying it was cancelled, so "Undo…" can be tried again.
   */
  async undo(run: RunRecord, signal?: AbortSignal): Promise<RunRecord> {
    if (run.dryRun) throw new Error('A dry run wrote nothing; there is nothing to undo.');
    this.signal = signal;
    run.status = 'undoing';
    delete run.stopReason;
    await this.save(run);
    const createdFlags = new Set(run.steps.filter((s) => s.step.op === 'upsert_flag_shell' && s.created).map((s) => s.step.key));
    let ok = true;
    for (const rec of [...run.steps].reverse()) {
      if (rec.status !== 'done' && rec.status !== 'pending_approval' && !(rec.status === 'failed' && rec.created)) continue;
      if (signal?.aborted) {
        ok = false;
        run.stopReason = `Undo cancelled before “${rec.label}”. Steps not yet undone keep their LaunchDarkly changes; use Undo… again to finish.`;
        break;
      }
      try {
        await this.revert(run, rec, createdFlags);
        rec.status = rec.approvals?.some((a) => a.status === 'pending' && a.purpose === 'undo') ? 'pending_approval' : 'undone';
        rec.message = `${rec.status === 'undone' ? 'Undone' : 'Undo requested (approval pending)'}: ${rec.message ?? ''}`.trim();
      } catch (e) {
        ok = false;
        if (signal?.aborted) {
          run.stopReason = `Undo cancelled while “${rec.label}” was being reverted. Use Undo… again to finish; every revert is safe to repeat.`;
          break;
        }
        rec.error = `Undo failed: ${(e as Error).message}`;
        if (isSystemic(e)) break;
      }
      await this.save(run);
    }
    run.status = ok ? 'undone' : 'undo_failed';
    run.undoneAt = this.now().toISOString();
    await this.save(run);
    return run;
  }

  /**
   * Re-read every pending approval request (PLAN §5.1 "poll its status and reviewStatus"). A
   * flag environment's provenance is written only once LD has applied the targeting, so the
   * status strip never claims a sync that is still waiting on a reviewer.
   */
  async checkApprovals(run: RunRecord): Promise<RunRecord> {
    let changed = false;
    for (const rec of run.steps) {
      const pending = (rec.approvals ?? []).filter((a) => a.status === 'pending');
      if (!pending.length) continue;
      for (const a of pending) {
        const s = rec.step;
        const ar = a.kind === 'flag' && (s.op === 'update_flag_env' || s.op === 'upsert_flag_shell') ? await this.c.getFlagApprovalRequest(this.p, s.key, s.op === 'update_flag_env' ? s.ldEnv : '', a.id) : await this.c.getApprovalRequest(a.id);
        a.checkedAt = this.now().toISOString();
        if (!ar) {
          a.status = 'failed';
          a.reviewStatus = 'deleted';
        } else {
          a.reviewStatus = ar.reviewStatus ?? undefined;
          // `scheduled` = approved, LD applies it at executionDate: nothing left for us to do.
          if (ar.status === 'completed' || ar.status === 'scheduled') a.status = 'applied';
          else if (ar.reviewStatus === 'declined') a.status = 'declined';
          else if (ar.status === 'failed') a.status = 'failed';
        }
        changed = true;
      }
      if (rec.approvals!.some((a) => a.status === 'pending')) continue;
      const bad = rec.approvals!.filter((a) => a.status === 'declined' || a.status === 'failed');
      rec.finishedAt = this.now().toISOString();
      if (bad.length) {
        rec.status = 'failed';
        rec.error = `Approval request${bad.length === 1 ? '' : 's'} ${bad.map((a) => `${a.id.slice(0, 8)} ${a.status}${a.reviewStatus && a.reviewStatus !== a.status ? ` (${a.reviewStatus})` : ''}`).join(', ')}.`;
        continue;
      }
      if (rec.status === 'pending_approval') {
        if (rec.step.op === 'update_flag_env' && rec.approvals!.some((a) => a.purpose === 'targeting')) await this.writeProvenance(run, rec.step, []);
        rec.status = rec.approvals!.some((a) => a.purpose === 'undo') ? 'undone' : 'done';
        rec.message = `${(rec.message ?? '').replace(/\s*Provenance is recorded once it is applied\.$/, '')} Approved and applied.`.trim();
      }
    }
    if (changed) {
      if (run.status === 'done' || run.status === 'failed') run.status = run.steps.some((x) => x.status === 'failed') ? 'failed' : 'done';
      if (run.status === 'undoing' || run.status === 'undone' || run.status === 'undo_failed') run.status = run.steps.some((x) => x.status === 'failed' || x.error?.startsWith('Undo failed')) ? 'undo_failed' : run.steps.some((x) => x.status === 'pending_approval') ? 'undoing' : 'undone';
      await this.save(run);
    }
    return run;
  }

  /** Something this run has learned about the LD plan. Recorded on the step and reported once. */
  private learned(rec: StepRecord, c: CapabilityUpdate) {
    rec.capability = c;
    this.opts.onCapability?.(c);
  }

  /** Records a cancel: the step goes (back) to pending and the run is `stopped`, resumable from Runs. */
  private cancel(run: RunRecord, rec: StepRecord, inFlight = false): void {
    rec.status = 'pending';
    delete rec.startedAt;
    delete rec.error;
    rec.message = inFlight ? 'Cancelled while in flight; resuming re-checks what LaunchDarkly received.' : 'Cancelled before it started.';
    const pending = run.steps.filter((s) => s.status === 'pending').length;
    run.status = 'stopped';
    run.stopReason = `Cancelled${inFlight ? ` during “${rec.label}”` : ` before “${rec.label}”`}; ${pending} step${pending === 1 ? '' : 's'} still pending. Resume from Runs to continue where it stopped.`;
  }

  /**
   * Whether a step must read its LaunchDarkly resource before writing. The plan read the project's
   * listings before planning, so an item it marked new is created straight away and a 409 (it
   * appeared since) falls through to the read-and-check in the create's catch. The read stays for
   * items that exist (their pre-image is what undo restores) and for a step resumed after a
   * crash, where the create may already have gone out.
   */
  private report(change: ResourceChange): void {
    this.opts.onResource?.(change);
  }

  private mustRead(rec: StepRecord, s: { exists: boolean }): boolean {
    return s.exists || !!rec.created || rec.preImage !== undefined;
  }

  /**
   * A create answered 409: the item exists after all (the listing the plan used was older than the
   * item, or an interrupted attempt created it before the journal recorded it). Ours counts as this
   * step's create; a foreign one is taken over only when the plan said to adopt it, and otherwise
   * the user re-plans, exactly as if a read had found it first.
   */
  private foundAfterConflict(run: RunRecord, rec: StepRecord, s: { adopt: boolean }, ours: boolean, current: NonNullable<StepRecord['preImage']>, appeared: string): void {
    if (ours) {
      // Ours, but created before this run started: an earlier run (or another tab) made it, possibly
      // for other environments too. Undoing this run must not delete it, so it is adopted, not owned.
      const createdAt = createdAtMs(current);
      if (createdAt !== undefined && createdAt < Date.parse(run.startedAt)) {
        if (rec.preImage === undefined) rec.preImage = current;
        return;
      }
      rec.created = true;
      return;
    }
    if (!s.adopt) throw new Error(appeared);
    if (rec.preImage === undefined) rec.preImage = current;
  }

  private async save(run: RunRecord) {
    await this.opts.journal.save(run);
    // A new run object with new step records, so the UI (which compares identities) re-renders;
    // the pre-images and plan steps inside are shared, never mutated once set. Deep-cloning a
    // 3,000-step run with its pre-images twice per step was most of the main thread's work.
    this.opts.onProgress?.({ ...run, steps: run.steps.map((s) => ({ ...s })) });
  }

  private comment(run: RunRecord, s: PlanStep): string {
    const by = this.opts.actor ? ` by ${this.opts.actor}` : '';
    const ref = `run #${run.id.slice(0, 8)}`;
    if (s.op === 'update_flag_env' || s.op === 'upsert_segment' || s.op === 'upsert_metric' || s.op === 'create_bandit' || s.op === 'upsert_ai_config') {
      const p = s.provenance;
      return `Synced from ${SOURCE_KIND_LABEL[p.sourceKind ?? SOURCE_KIND]} ${p.statsigType} ${p.statsigId}${p.statsigVersion !== undefined ? ` v${p.statsigVersion}` : ''} (source ${p.sourceAlias})${by}, ${ref}`;
    }
    return `${s.op === 'ensure_context_kind' && s.sourceKind ? SOURCE_KIND_LABEL[s.sourceKind] : 'StatSig'} migration${by}, ${ref}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------------------------

  private execute(run: RunRecord, rec: StepRecord): Promise<string> {
    const s = rec.step;
    switch (s.op) {
      case 'ensure_context_kind':
        return this.contextKind(run, rec, s);
      case 'upsert_segment':
        return this.segment(run, rec, s);
      case 'upsert_flag_shell':
        return this.shell(run, rec, s);
      case 'update_flag_env':
        return this.flagEnv(run, rec, s);
      case 'ensure_randomization_unit':
        return this.randomizationUnit(run, rec, s);
      case 'upsert_metric':
        return this.metric(run, rec, s);
      case 'create_bandit':
        return this.bandit(run, rec, s);
      case 'upsert_ai_config':
        return this.aiConfig(run, rec, s);
    }
  }

  /**
   * StatSig prompt → LD AI Config shell (PLAN §6). AI Configs have no custom properties, so the
   * provenance footer goes in the description and ownership is the pair of tags, like segments.
   * Variations are never touched: they are the user's (the Console API cannot read StatSig's).
   */
  private async aiConfig(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'upsert_ai_config' }>): Promise<string> {
    const d = s.desired;
    let current = this.mustRead(rec, s) ? await this.c.getAiConfig(this.p, s.key, this.signal) : null;
    if (current && !rec.created && rec.preImage === undefined) {
      if (!s.adopt && !ownsSegment({ key: current.key, tags: current.tags ?? [] }, s.provenance.sourceAlias)) throw new Error(`AI Config “${s.key}” appeared since planning and wasn't created by this app. Re-plan to decide.`);
      rec.preImage = current;
    }
    const description = withFooter(d.description, footer(s.provenance, this.now()));
    const maintainer = d.maintainerId ? { maintainerId: d.maintainerId } : d.maintainerTeamKey ? { maintainerTeamKey: d.maintainerTeamKey } : {};
    if (!current) {
      if (run.dryRun) return `Would create AI Config “${s.key}” (${d.tags.join(', ')}); its variations are added in LaunchDarkly by hand.`;
      try {
        current = await this.c.createAiConfig(this.p, { key: d.key, name: d.name, description, tags: d.tags, mode: d.mode, ...maintainer }, this.signal);
        rec.created = true;
      } catch (e) {
        if (!(e instanceof LdWriteError && e.status === 409)) throw e;
        current = await this.c.getAiConfig(this.p, s.key, this.signal);
        if (!current) throw e;
        this.foundAfterConflict(run, rec, s, ownsSegment({ key: current.key, tags: current.tags ?? [] }, s.provenance.sourceAlias), current, `AI Config “${s.key}” appeared since planning and wasn't created by this app. Re-plan to decide.`);
      }
      if (rec.created) return `Created AI Config “${s.key}”. Add its variations in LaunchDarkly: StatSig's API does not expose prompt versions.`;
    }
    const body: Parameters<LdWriter['patchAiConfig']>[2] = {};
    if (current.name !== d.name) body.name = d.name;
    if ((current.description ?? '') !== description) body.description = description;
    const tags = union(current.tags ?? [], d.tags);
    if (tags.length !== (current.tags ?? []).length) body.tags = tags;
    const m = current._maintainer;
    if (d.maintainerId && m?.member?._id !== d.maintainerId) body.maintainerId = d.maintainerId;
    else if (d.maintainerTeamKey && m?.team?.key !== d.maintainerTeamKey) body.maintainerTeamKey = d.maintainerTeamKey;
    const fields = Object.keys(body);
    if (fields.length === 0) return `AI Config “${s.key}” already up to date.`;
    if (run.dryRun) return `Would update AI Config “${s.key}” (${fields.join(', ')}).`;
    await this.c.patchAiConfig(this.p, s.key, body, this.signal);
    return `Updated AI Config “${s.key}” (${fields.join(', ')}).`;
  }

  private async randomizationUnit(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'ensure_randomization_unit' }>): Promise<string> {
    const settings = await this.c.getExperimentationSettings(this.p, this.signal);
    const units = settings.randomizationUnits ?? [];
    if (units.some((u) => u.randomizationUnit === s.key)) return `Randomization unit “${s.key}” already enabled.`;
    if (run.dryRun) return `Would enable “${s.key}” as a randomization unit.`;
    if (rec.preImage === undefined) rec.preImage = settings;
    await this.c.putExperimentationSettings(this.p, { randomizationUnits: [...units.map((u) => ({ randomizationUnit: u.randomizationUnit, ...(u.default ? { default: true } : {}) })), { randomizationUnit: s.key }] }, this.signal);
    rec.created = true;
    return `Enabled “${s.key}” as a randomization unit.`;
  }

  private async metric(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'upsert_metric' }>): Promise<string> {
    const d = s.desired;
    let current = this.mustRead(rec, s) ? await this.c.getMetric(this.p, s.key, this.signal) : null;
    if (current && !rec.created && rec.preImage === undefined) {
      const same = current.kind === 'custom' && current.eventKey === d.eventKey;
      if (!s.adopt && !same && !ownsSegment({ tags: current.tags ?? [] }, s.provenance.sourceAlias)) throw new Error(`Metric “${s.key}” appeared since planning and wasn't created by this app. Re-plan to decide.`);
      rec.preImage = current;
    }
    if (!current) {
      if (run.dryRun) return `Would create custom metric “${s.key}” on event “${d.eventKey}”.`;
      const body = { key: d.key, name: d.name, description: d.description, kind: d.kind, eventKey: d.eventKey, isNumeric: d.isNumeric, successCriteria: d.successCriteria, tags: d.tags, analysisUnits: d.analysisUnits };
      try {
        current = await this.c.createMetric(this.p, body, this.signal);
        rec.created = true;
      } catch (e) {
        if (!(e instanceof LdWriteError && e.status === 409)) throw e;
        current = await this.c.getMetric(this.p, s.key, this.signal);
        if (!current) throw e;
        // A metric on the same event is reused, as the read above would have done.
        const same = current.kind === 'custom' && current.eventKey === d.eventKey;
        this.foundAfterConflict(run, rec, { adopt: s.adopt || same }, ownsSegment({ tags: current.tags ?? [] }, s.provenance.sourceAlias), current, `Metric “${s.key}” appeared since planning and wasn't created by this app. Re-plan to decide.`);
      }
      if (rec.created) return `Created metric “${s.key}” on event “${d.eventKey}”.`;
    }
    // Same event under the same key: the metric already is what the bandit needs. Only tag it.
    const ops: JsonPatchOp[] = [];
    const tags = union(current.tags ?? [], d.tags);
    if (tags.length !== (current.tags ?? []).length) ops.push({ op: 'replace', path: '/tags', value: tags });
    if (current.eventKey !== d.eventKey) ops.push({ op: 'replace', path: '/eventKey', value: d.eventKey });
    if (ops.length === 0) return `Metric “${s.key}” already up to date.`;
    if (run.dryRun) return `Would update metric “${s.key}” (${ops.map((o) => o.path.slice(1)).join(', ')}).`;
    await this.c.patchMetricJson(this.p, s.key, ops, { comment: this.comment(run, s), signal: this.signal });
    return `Updated metric “${s.key}” (${ops.map((o) => o.path.slice(1)).join(', ')}).`;
  }

  private async bandit(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'create_bandit' }>): Promise<string> {
    const d = s.desired;
    const flag = this.flags.get(s.flagKey) ?? (await this.c.getFlag(this.p, s.flagKey, this.signal));
    if (!flag) {
      if (run.dryRun) return `Would create bandit “${s.key}” in ${s.ldEnv}: ${banditSummary(d)}.`;
      throw new Error(`Flag “${s.flagKey}” doesn't exist (its settings step didn't run).`);
    }
    const env = flag.environments?.[s.ldEnv];
    const iteration = banditIteration(d, flag, env?.version ?? 0);
    let current = this.mustRead(rec, s) ? await this.c.getExperiment(this.p, s.ldEnv, s.key, this.signal) : null;
    if (current && !rec.created && rec.preImage === undefined) {
      if (!s.adopt && !ownsSegment({ tags: current.tags ?? [] }, s.provenance.sourceAlias)) throw new Error(`Experiment “${s.key}” appeared in ${s.ldEnv} since planning and wasn't created by this app. Re-plan to decide.`);
      rec.preImage = current;
    }
    if (!current) {
      if (run.dryRun) return `Would create bandit “${s.key}” in ${s.ldEnv}: ${banditSummary(d)}.`;
      const body = { key: d.key, name: d.name, description: withFooter(d.description, footer(s.provenance, this.now())), type: 'mab', tags: d.tags, iteration };
      try {
        current = await this.c.createExperiment(this.p, s.ldEnv, body, this.signal);
        rec.created = true;
      } catch (e) {
        if (!(e instanceof LdWriteError && e.status === 409)) throw e;
        current = await this.c.getExperiment(this.p, s.ldEnv, s.key, this.signal);
        if (!current) throw e;
        this.foundAfterConflict(run, rec, s, ownsSegment({ tags: current.tags ?? [] }, s.provenance.sourceAlias), current, `Experiment “${s.key}” appeared in ${s.ldEnv} since planning and wasn't created by this app. Re-plan to decide.`);
      }
      if (rec.created) return `Created bandit “${s.key}” in ${s.ldEnv} as a draft: ${banditSummary(d)}.`;
    }
    // An iteration that ran (or runs) is the customer's experiment history: never replaced.
    const status = current.draftIteration?.status ?? current.currentIteration?.status;
    if (status && status !== 'not_started') return `Bandit “${s.key}” in ${s.ldEnv} has ${status === 'running' ? 'a running' : 'a finished'} iteration; left as is.`;
    if (run.dryRun) return `Would replace the draft of bandit “${s.key}” in ${s.ldEnv}: ${banditSummary(d)}.`;
    await this.c.createIteration(this.p, s.ldEnv, s.key, iteration, this.signal);
    return `Replaced the draft of bandit “${s.key}” in ${s.ldEnv}: ${banditSummary(d)}.`;
  }

  private async contextKind(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'ensure_context_kind' }>): Promise<string> {
    if (run.dryRun) return `Would create context kind “${s.key}”.`;
    // The planner adds this step from its cached listing, which may be older than the project: read
    // before writing, so a kind the customer already has is never renamed, and never archived by undo.
    const existing = await this.existingContextKind(s.key);
    if (existing && !existing.archived) return `Context kind “${s.key}” already exists in LaunchDarkly; left as is.`;
    const from = s.sourceKind === 'launchdarkly' ? `Context kind “${s.unitType}” of the source LaunchDarkly project` : `StatSig unit type ${s.unitType}`;
    try {
      if (existing) {
        await this.c.putContextKind(this.p, s.key, { name: existing.name ?? s.name, ...(existing.description ? { description: existing.description } : {}), archived: false }, this.signal);
        rec.unarchived = true;
        this.contextKinds?.then((m) => m.set(s.key, { ...existing, archived: false }));
        return `Context kind “${s.key}” existed archived in LaunchDarkly; unarchived (undo archives it again).`;
      }
      await this.c.putContextKind(this.p, s.key, { name: s.name, description: `${from} (${CONSOLE_CREATED_MARKER}).` }, this.signal);
      this.contextKinds?.then((m) => m.set(s.key, { key: s.key, name: s.name, archived: false }));
    } catch (e) {
      // A 403 here is a missing createContextKind role, not a dead token: only the items that use this
      // kind are skipped, the rest of the run goes on, and the capability matrix learns it.
      if (e instanceof LdWriteError && e.status === 403) {
        this.learned(rec, { key: 'context_kinds', status: 'not_permitted', evidence: `PUT context kind “${s.key}” → 403` });
        throw new Error(`This token can't create context kind “${s.key}” (403: the role lacks createContextKind). Ask a LaunchDarkly admin to create it, or connect with a Developer, Maintainer or Project Admin token, then resume. Items keyed by it are skipped in this run.`);
      }
      throw e;
    }
    this.learned(rec, { key: 'context_kinds', status: 'available', evidence: `created context kind “${s.key}”` });
    rec.created = true;
    return `Created context kind “${s.key}”.`;
  }

  private contextKinds?: Promise<Map<string, { key: string; name?: string | null; description?: string | null; archived?: boolean | null }>>;

  /** The project's context kinds, read once per executor; a read the token is not allowed falls back to writing blind, as before. */
  private async existingContextKind(key: string): Promise<{ key: string; name?: string | null; description?: string | null; archived?: boolean | null } | undefined> {
    this.contextKinds ??= this.c
      .listContextKinds(this.p, this.signal)
      .then((r) => new Map(r.items.map((k) => [k.key, k])))
      .catch((e: unknown) => {
        if (this.signal?.aborted) throw e;
        return new Map();
      });
    return (await this.contextKinds).get(key);
  }

  private async segment(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'upsert_segment' }>): Promise<string> {
    const d = s.desired;
    let current = this.mustRead(rec, s) ? await this.c.getSegment(this.p, s.ldEnv, s.key, this.signal) : null;
    if (current && !rec.created && rec.preImage === undefined) {
      // Re-check ownership: the LD project may have changed since planning.
      if (!s.adopt && !ownsSegment({ key: current.key, tags: current.tags ?? [] }, s.provenance.sourceAlias)) throw new Error(`Segment “${s.key}” appeared in ${s.ldEnv} since planning and wasn't created by this app. Re-plan to decide.`);
      if (!rec.created) rec.preImage = current;
    }
    const description = withFooter(d.description, footer(s.provenance, this.now()));
    if (!current) {
      if (run.dryRun) return `Would create ${d.unbounded ? 'big ' : ''}segment “${s.key}” in ${s.ldEnv} with ${segmentSummary(d)}.`;
      try {
        current = await this.c.createSegment(this.p, s.ldEnv, { key: s.key, name: d.name, description, tags: d.tags, ...(d.unbounded ? { unbounded: true, unboundedContextKind: d.unbounded.contextKind } : {}) }, this.signal);
        rec.created = true;
        if (d.unbounded) this.learned(rec, { key: 'big_segments', status: 'available', evidence: `created big segment ${s.key}` });
      } catch (e) {
        if (e instanceof LdWriteError && d.unbounded && (e.status === 400 || e.status === 403 || e.status === 404 || e.status === 405)) {
          this.learned(rec, { key: 'big_segments', status: e.status === 403 ? 'not_permitted' : 'unavailable', evidence: `POST big segment → ${e.status}` });
          throw new Error(`LaunchDarkly refused to create a big segment (${e.status}): the plan or token doesn't allow them. The big_segment decision now offers only the other options.`);
        }
        if (!(e instanceof LdWriteError && e.status === 409)) throw e;
        current = await this.c.getSegment(this.p, s.ldEnv, s.key, this.signal);
        if (!current) throw e;
        this.foundAfterConflict(run, rec, s, ownsSegment({ key: current.key, tags: current.tags ?? [] }, s.provenance.sourceAlias), current, `Segment “${s.key}” appeared in ${s.ldEnv} since planning and wasn't created by this app. Re-plan to decide.`);
      }
    }
    // Checked after the create too: a segment found through a 409 may be of the other kind.
    if (!!current.unbounded !== !!d.unbounded)
      throw new Error(
        d.unbounded
          ? `Segment “${s.key}” exists in ${s.ldEnv} as a standard segment; LaunchDarkly can't turn it into a big segment in place. Delete or rename it in LaunchDarkly, then sync again.`
          : `Segment “${s.key}” exists in ${s.ldEnv} as a big segment; this list now fits a standard segment. Delete or rename it in LaunchDarkly, then sync again.`,
      );
    if (d.unbounded) return this.bigSegment(run, rec, s, current, description);

    // LD caps target operations at 1,500 per request, however the request is written. Small member
    // lists go in the one JSON patch with the rules; bigger ones are written afterwards in semantic
    // patches of at most 1,500 targets each.
    const targets = targetInstructions(current, d);
    const targetOps = targets.reduce((n, i) => n + (i.values as string[]).length, 0);
    const batched = targetOps > TARGET_BATCH;
    const patch: JsonPatchOp[] = [
      { op: 'add', path: '/rules', value: d.rules.map((r) => ({ description: r.description, clauses: r.clauses, ...(r.weight !== undefined ? { weight: r.weight, rolloutContextKind: r.rolloutContextKind, ...(r.bucketBy ? { bucketBy: r.bucketBy } : {}) } : {}) })) },
      ...(batched
        ? []
        : [
            { op: 'add' as const, path: '/included', value: d.included },
            { op: 'add' as const, path: '/includedContexts', value: d.includedContexts },
            // Excluded keys exist only for LD-source segments (PLAN §20.3); a StatSig segment leaves them alone.
            ...(d.excluded || d.excludedContexts ? [{ op: 'add' as const, path: '/excluded', value: d.excluded ?? [] }, { op: 'add' as const, path: '/excludedContexts', value: d.excludedContexts ?? [] }] : []),
          ]),
      { op: 'add', path: '/description', value: description },
      { op: 'add', path: '/tags', value: union(current.tags ?? [], d.tags) },
    ];
    try {
      const res = await this.c.patchSegmentJson(this.p, s.ldEnv, s.key, patch, { comment: this.comment(run, s), dryRun: run.dryRun, signal: this.signal });
      rec.ldVersion = res.version ?? undefined;
      if (!run.dryRun) this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: res });
    } catch (e) {
      if (!(e instanceof LdWriteError && e.status === 405)) throw e;
      rec.approvalRequired = true;
      if (run.dryRun) return `Would file an approval request for segment “${s.key}” in ${s.ldEnv} (the environment requires approvals): ${segmentSummary(d)}.`;
      // The segment stands as read (or as just created); the targeting waits for the approval.
      this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: current });
      return this.segmentApproval(run, rec, s, current);
    }
    const requests = batched ? ` in ${1 + targets.length} requests (LaunchDarkly takes at most ${TARGET_BATCH.toLocaleString('en-US')} targets per request)` : '';
    if (run.dryRun) return `Would update segment “${s.key}” in ${s.ldEnv}: ${segmentSummary(d)}${requests}.`;
    if (batched) {
      for (const instruction of targets) {
        const res = await this.c.patchSegmentSemantic(this.p, s.ldEnv, s.key, { comment: this.comment(run, s), instructions: [instruction] });
        rec.ldVersion = res.version ?? rec.ldVersion;
        this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: res });
      }
    }
    return `${rec.created ? 'Created' : 'Updated'} segment “${s.key}” in ${s.ldEnv}: ${segmentSummary(d)}${requests}.`;
  }

  /**
   * Big segment (PLAN §8.3 `big_segment`): description and tags by JSON patch, membership by a CSV
   * import in `replace` mode. LD answers the import with 204 and a `Location` the browser can't
   * read, so completion is confirmed by sampling membership instead of polling the import.
   */
  private async bigSegment(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'upsert_segment' }>, current: LdSegment, description: string): Promise<string> {
    const d = s.desired;
    const ids = d.unbounded!.ids;
    const patch: JsonPatchOp[] = [
      { op: 'add', path: '/description', value: description },
      { op: 'add', path: '/tags', value: union(current.tags ?? [], d.tags) },
    ];
    const res = await this.c.patchSegmentJson(this.p, s.ldEnv, s.key, patch, { comment: this.comment(run, s), dryRun: run.dryRun });
    rec.ldVersion = res.version ?? undefined;
    if (!run.dryRun) this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: res });
    // An LD-source big segment (PLAN §20.3): the console cannot read its members, so nothing is imported.
    if (d.unbounded!.manual) return `${run.dryRun ? 'Would create' : rec.created ? 'Created' : 'Updated'} big segment “${s.key}” in ${s.ldEnv} without members: import the member list yourself.`;
    if (run.dryRun) return `Would import ${ids.length.toLocaleString('en-US')} ${d.unbounded!.contextKind} IDs into big segment “${s.key}” in ${s.ldEnv} (replace mode).`;
    try {
      await this.c.createSegmentImport(this.p, s.ldEnv, s.key, ids, { mode: 'replace' });
    } catch (e) {
      if (e instanceof LdWriteError && (e.status === 403 || e.status === 404 || e.status === 405)) {
        this.learned(rec, { key: 'big_segments', status: e.status === 403 ? 'not_permitted' : 'unavailable', evidence: `POST segment import → ${e.status}` });
        throw new Error(`The big segment “${s.key}” exists but LaunchDarkly refused the CSV import (${e.status}): ${e.message}`);
      }
      throw e;
    }
    // Confirm asynchronously processed membership on a sample: first, middle and last key.
    const sample = unique([ids[0]!, ids[Math.floor(ids.length / 2)]!, ids[ids.length - 1]!]);
    let confirmed = 0;
    const checks = this.opts.importChecks ?? 6;
    for (let attempt = 0; attempt < checks; attempt++) {
      if (attempt > 0) await this.sleep(5000);
      const results = await Promise.all(sample.map((k) => this.c.getSegmentMembership(this.p, s.ldEnv, s.key, k).catch(() => null)));
      confirmed = results.filter((r) => r?.included).length;
      if (confirmed === sample.length) break;
    }
    rec.import = { ids: ids.length, sampled: sample.length, confirmed };
    const verdict = confirmed === sample.length ? `${sample.length} sampled keys confirmed as members` : `${confirmed}/${sample.length} sampled keys visible so far; LaunchDarkly processes imports asynchronously`;
    return `${rec.created ? 'Created' : 'Updated'} big segment “${s.key}” in ${s.ldEnv}: imported ${ids.length.toLocaleString('en-US')} ${d.unbounded!.contextKind} IDs (replace mode); ${verdict}.`;
  }

  /**
   * Segment write in an environment that requires approvals: the same change as semantic-patch
   * instructions (reference/launchdarkly/openapi.json "Patch segment"), filed with the generic
   * approval-request route and `resourceId: proj/…:env/…:segment/…`.
   */
  private async segmentApproval(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'upsert_segment' }>, current: LdSegment): Promise<string> {
    const d = s.desired;
    if (rec.approvals?.some((a) => a.purpose === 'targeting' && a.status === 'pending')) return rec.message ?? `Approval requested for segment “${s.key}” in ${s.ldEnv}.`;
    const instructions = segmentInstructions(current, d);
    const ar = await this.c.createApprovalRequest({
      resourceId: `proj/${this.p}:env/${s.ldEnv}:segment/${s.key}`,
      description: `StatSig migration: segment “${s.key}” in ${s.ldEnv} (${segmentSummary(d)})`,
      instructions,
      comment: this.comment(run, s),
    });
    (rec.approvals ??= []).push({ id: ar._id, kind: 'segment', purpose: 'targeting', status: 'pending', createdAt: this.now().toISOString() });
    this.learned(rec, { key: 'approvals', status: 'available', evidence: `405 on segment ${s.key} in ${s.ldEnv}; approval request ${ar._id} filed` });
    return `Approval requested for segment “${s.key}” in ${s.ldEnv} (${instructions.length} instructions): ${segmentSummary(d)}. Provenance is recorded once it is applied.`;
  }

  private async shell(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'upsert_flag_shell' }>): Promise<string> {
    const d = s.desired;
    let flag = this.mustRead(rec, s) ? await this.c.getFlag(this.p, s.key, this.signal) : null;
    if (flag && !rec.created && rec.preImage === undefined) {
      const owner = flagOwner({ key: flag.key, tags: flag.tags ?? [], customProperties: flag.customProperties ?? {} });
      if (!s.adopt && !owner) throw new Error(`Flag “${s.key}” appeared since planning and wasn't created by this app. Re-plan to decide.`);
      rec.preImage = flag;
    }
    if (!flag) {
      if (run.dryRun) return d.variations.every((v) => typeof v.value === 'boolean') ? `Would create boolean flag “${s.key}” (${d.tags.join(', ')}).` : `Would create JSON flag “${s.key}” with ${d.variations.length} variations (${d.tags.join(', ')}).`;
      const body = {
        key: d.key,
        name: d.name,
        description: d.description,
        variations: d.variations,
        defaults: d.defaults,
        temporary: d.temporary,
        tags: d.tags,
        customProperties: d.customProperties,
        clientSideAvailability: d.clientSideAvailability,
        ...(d.maintainerId ? { maintainerId: d.maintainerId } : d.maintainerTeamKey ? { maintainerTeamKey: d.maintainerTeamKey } : {}),
      };
      try {
        flag = await this.c.createFlag(this.p, body, this.signal);
        rec.created = true;
      } catch (e) {
        const size = flagSizeError(e);
        if (size) throw new Error(flagSizeMessage(s.key, 'settings', size, false));
        if (!(e instanceof LdWriteError && e.status === 409)) throw e;
        flag = await this.c.getFlag(this.p, s.key, this.signal);
        if (!flag) throw e;
        const owner = flagOwner({ key: flag.key, tags: flag.tags ?? [], customProperties: flag.customProperties ?? {} });
        this.foundAfterConflict(run, rec, s, owner?.id === d.customProperties[PROP.id]?.value[0], flag, `Flag “${s.key}” appeared since planning and wasn't created by this app. Re-plan to decide.`);
      }
      if (rec.created) {
        this.flags.set(s.key, flag);
        this.report({ kind: 'flag', key: s.key, flag });
        return `Created flag “${s.key}”.`;
      }
    }
    const ops = shellPatch(flag, d);
    this.flags.set(s.key, flag);
    if (ops.length === 0) {
      if (!run.dryRun) this.report({ kind: 'flag', key: s.key, flag });
      return `Flag “${s.key}” settings already up to date.`;
    }
    let res: LdFlag;
    try {
      res = await this.c.patchFlagJson(this.p, s.key, ops, { comment: this.comment(run, s), dryRun: run.dryRun, signal: this.signal });
    } catch (e) {
      const size = flagSizeError(e);
      if (size) throw new Error(flagSizeMessage(s.key, 'settings', size, false));
      throw e;
    }
    if (!run.dryRun) {
      this.flags.set(s.key, res);
      this.report({ kind: 'flag', key: s.key, flag: res });
    }
    return `${run.dryRun ? 'Would update' : 'Updated'} flag “${s.key}” settings (${ops.map((o) => o.path.split('/')[1]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}).`;
  }

  private async flagEnv(run: RunRecord, rec: StepRecord, s: Extract<PlanStep, { op: 'update_flag_env' }>): Promise<string> {
    // The settings step (or an earlier environment step of this run) left the flag in the cache,
    // current as of its last write, so this step reads nothing. A step resumed in a later run
    // starts with an empty cache and reads.
    const flag = this.flags.get(s.key) ?? (await this.c.getFlag(this.p, s.key, this.signal));
    if (!flag) {
      if (run.dryRun) return `Would set targeting in ${s.ldEnv}: ${envSummary(s.desired, s.variations)}.`;
      throw new Error(`Flag “${s.key}” doesn't exist (its settings step didn't run).`);
    }
    this.flags.set(s.key, flag);
    if (rec.preImage === undefined) rec.preImage = flag;
    const ids = variationIds(flag, s.variations);
    const d = s.desired;
    const scheduled = d.scheduledChanges ?? [];
    const instructions = await this.stateInstructions(d, flag, s.ldEnv, ids);
    const comment = this.comment(run, s);
    // Scheduled changes an earlier sync created (recorded in the sync provenance) and any this
    // step created before an interrupted attempt: both are replaced below.
    const sync = readSync(flag.customProperties ?? {}, s.ldEnv);
    const previous = unique([...scheduledIdsFrom(sync), ...(rec.scheduledChangeIds ?? [])]);

    // A flag whose targeting already matches (a re-plan that included in-sync items) is not
    // written again: a plan of hundreds of migrated flags would otherwise spend two writes per
    // flag and environment on LaunchDarkly's rate limit for nothing. The provenance is still
    // recorded when it lags (the decisions changed to the same result, or it was never written).
    const current = flag.environments?.[s.ldEnv];
    if (current && !scheduled.length && !previous.length && this.targetingMatches(flag, current, instructions)) {
      const recorded = !!sync && sync[0] === s.provenance.statsigFingerprint && sync[3] === s.provenance.decisionSetHash;
      if (recorded) return `Targeting in ${s.ldEnv} already in sync; nothing written.`;
      if (run.dryRun) return `Targeting in ${s.ldEnv} already matches; would record the sync.`;
      await this.writeProvenance(run, s, []);
      return `Targeting in ${s.ldEnv} already matches; recorded the sync.`;
    }

    // Someone edited the targeting in LaunchDarkly after the last sync: the planner raises
    // ld_drift_on_sync for that, and a plan older than the edit must not write over it either.
    const drift = ldChange(current, sync?.[2] ?? undefined);
    if (drift.changed && !s.overwriteLdChanges) {
      throw new Error(`Not written: the targeting of “${s.key}” in ${s.ldEnv} was changed in LaunchDarkly after the last sync (${drift.evidence}). Plan again and answer whether to keep LaunchDarkly’s targeting or overwrite it.`);
    }

    let approval = false;
    try {
      const res = await this.c.patchFlagSemantic(this.p, s.key, { environmentKey: s.ldEnv, comment, instructions }, { dryRun: run.dryRun, signal: this.signal });
      rec.ldVersion = res.environments?.[s.ldEnv]?.version ?? undefined;
      if (!run.dryRun) {
        this.flags.set(s.key, res);
        this.report({ kind: 'flag', key: s.key, flag: res });
      }
    } catch (e) {
      const size = flagSizeError(e);
      if (size) throw new Error(flagSizeMessage(s.key, `targeting in ${s.ldEnv}`, size, s.deps.some((d) => d.startsWith(`segment:${s.ldEnv}:${s.key}.`))));
      if (!(e instanceof LdWriteError && e.status === 405)) throw e;
      approval = true;
      rec.approvalRequired = true;
    }

    const summary = envSummary(d, s.variations);
    const schedNote = scheduled.length ? ` and ${scheduled.length} scheduled change${scheduled.length === 1 ? '' : 's'} (${scheduled.map((c) => c.executionDate).join(', ')})` : '';
    if (approval) {
      if (run.dryRun) return `Would file an approval request for targeting in ${s.ldEnv}${schedNote} (the environment requires approvals): ${summary}.`;
      rec.approvals ??= [];
      if (!rec.approvals.some((a) => a.purpose === 'targeting' && a.status === 'pending')) {
        const ar = await this.c.createFlagApprovalRequest(this.p, s.key, s.ldEnv, { description: `StatSig migration: targeting for “${s.key}” in ${s.ldEnv} (${summary})`, instructions, comment });
        rec.approvals.push({ id: ar._id, kind: 'flag', purpose: 'targeting', status: 'pending', createdAt: this.now().toISOString() });
        this.learned(rec, { key: 'approvals', status: 'available', evidence: `405 on ${s.key} in ${s.ldEnv}; approval request ${ar._id} filed` });
      }
      // PLAN §5.1: when approvals are required, executionDate goes on the approval request.
      for (const sc of scheduled) {
        if (rec.approvals.some((a) => a.purpose === 'scheduled_change' && a.executionDate === sc.executionDate && a.status === 'pending')) continue;
        const ar = await this.c.createFlagApprovalRequest(this.p, s.key, s.ldEnv, { description: `StatSig migration: ${sc.description} for “${s.key}”`, instructions: await this.stateInstructions(sc.state, flag, s.ldEnv, ids), comment, executionDate: Date.parse(sc.executionDate) });
        rec.approvals.push({ id: ar._id, kind: 'flag', purpose: 'scheduled_change', status: 'pending', createdAt: this.now().toISOString(), executionDate: sc.executionDate });
      }
      return `Approval requested for targeting in ${s.ldEnv}${schedNote}: ${summary}. Provenance is recorded once it is applied.`;
    }

    if (run.dryRun) return `Would set targeting in ${s.ldEnv}${schedNote ? `${schedNote.replace(' and ', ' and create ')}` : ''}${previous.length ? `, replacing ${previous.length} earlier scheduled change${previous.length === 1 ? '' : 's'}` : ''}: ${summary}.`;

    // Scheduled changes: ours are full-state snapshots, so the earlier ones go and the new set is created.
    const created: string[] = [];
    if (scheduled.length || previous.length) {
      for (const id of previous) await this.c.deleteScheduledChange(this.p, s.key, s.ldEnv, id).catch(ignore404);
      rec.scheduledChangeIds = [];
      try {
        for (const sc of scheduled) {
          const r = await this.c.createScheduledChange(this.p, s.key, s.ldEnv, { executionDate: Date.parse(sc.executionDate), instructions: await this.stateInstructions(sc.state, flag, s.ldEnv, ids), comment: `${comment}: ${sc.description}` }, { ignoreConflicts: true });
          created.push(r._id);
          rec.scheduledChangeIds = [...created];
        }
        if (scheduled.length) this.learned(rec, { key: 'scheduled_changes', status: 'available', evidence: `created ${scheduled.length} scheduled change(s) on ${s.key}` });
      } catch (e) {
        if (e instanceof LdWriteError && (e.status === 403 || e.status === 404 || e.status === 405)) this.learned(rec, { key: 'scheduled_changes', status: e.status === 403 ? 'not_permitted' : 'unavailable', evidence: `POST scheduled change → ${e.status}` });
        for (const id of created) await this.c.deleteScheduledChange(this.p, s.key, s.ldEnv, id).catch(() => undefined);
        rec.scheduledChangeIds = [];
        throw new Error(`Targeting in ${s.ldEnv} was written (as StatSig evaluates today), but LaunchDarkly refused the scheduled change: ${(e as Error).message} The time_condition decision now offers only the other options; re-sync after choosing one.`);
      }
    }
    await this.writeProvenance(run, s, created, rec);
    return `Set targeting in ${s.ldEnv}${schedNote ? schedNote.replace(' and ', ' and created ') : ''}: ${summary}.`;
  }

  /**
   * Provenance, `migration.sync.<env>` (PLAN §3.3): `[fingerprint, version, syncedAt, decisionSetHash, sc:<id>…]`.
   * LD refuses custom-property instructions in a patch with environment instructions, so it's a
   * second write; it runs only after targeting succeeded (or was approved and applied), so LD
   * never claims a sync that didn't happen.
   */
  private async writeProvenance(run: RunRecord, s: Extract<PlanStep, { op: 'update_flag_env' }>, scheduledChangeIds: string[], rec?: StepRecord): Promise<void> {
    const prop = syncPropertyKey(s.ldEnv);
    const value = [s.provenance.statsigFingerprint, String(s.provenance.statsigVersion ?? ''), this.now().toISOString(), s.provenance.decisionSetHash, ...scheduledChangeIds.map((id) => `sc:${id}`)];
    const res = await this.c.patchFlagJson(this.p, s.key, [{ op: 'add', path: `/customProperties/${pointer(prop)}`, value: { name: `${SOURCE_KIND_LABEL[s.provenance.sourceKind ?? SOURCE_KIND]} sync (${s.ldEnv})`, value } }], { comment: this.comment(run, s), dryRun: run.dryRun, signal: this.signal });
    if (!run.dryRun) {
      // The version the run left the environment at, provenance write included: undo compares against it.
      if (rec) rec.ldVersion = res.environments?.[s.ldEnv]?.version ?? rec.ldVersion;
      this.flags.set(s.key, res);
      this.report({ kind: 'flag', key: s.key, flag: res });
    }
  }

  /**
   * Whether `env` (as LaunchDarkly returned it) already is what `desired` would write: the
   * instructions that would restore the current state, normalized, equal the desired ones. Any
   * doubt (a prerequisite flag not read yet) counts as a difference, so the write goes out.
   */
  private targetingMatches(flag: LdFlag, env: LdFlagConfig, desired: SemanticPatch['instructions']): boolean {
    const prerequisites: { key: string; variationId: string }[] = [];
    for (const p of env.prerequisites ?? []) {
      const pf = this.flags.get(p.key);
      const id = pf?.variations[p.variation]?._id;
      if (!id) return false;
      prerequisites.push({ key: p.key, variationId: id });
    }
    try {
      return stableStringify(normalizeInstructions(restoreInstructions(flag, env, flag, env, prerequisites))) === stableStringify(normalizeInstructions(desired));
    } catch {
      return false;
    }
  }

  /** The semantic-patch instructions that make an environment match `state` (also used for scheduled changes and approvals). */
  private async stateInstructions(state: Pick<DesiredFlagEnv, 'on' | 'offVariation' | 'fallthrough' | 'rules' | 'targets' | 'prerequisites'>, flag: LdFlag, ldEnv: string, ids: Ids): Promise<SemanticPatch['instructions']> {
    const instructions: SemanticPatch['instructions'] = [
      { kind: state.on ? 'turnFlagOn' : 'turnFlagOff' },
      { kind: 'updateOffVariation', variationId: ids(state.offVariation) },
      { kind: 'updateFallthroughVariationOrRollout', ...serve(state.fallthrough, ids) },
      { kind: 'replaceRules', rules: state.rules.map((r) => rule(r, ids)) },
      { kind: 'replaceTargets', targets: state.targets.map((t) => ({ contextKind: t.contextKind, variationId: ids(t.variation), values: t.values })) },
    ];
    const prev = flag.environments?.[ldEnv]?.prerequisites ?? [];
    if (state.prerequisites.length || prev.length) {
      const prerequisites = [];
      for (const p of state.prerequisites) {
        const pf = this.flags.get(p.key) ?? (await this.c.getFlag(this.p, p.key, this.signal));
        if (!pf) throw new Error(`Prerequisite flag “${p.key}” doesn't exist.`);
        this.flags.set(p.key, pf);
        prerequisites.push({ key: p.key, variationId: variationIds(pf, [true, false])(p.variation) });
      }
      instructions.push({ kind: 'replacePrerequisites', prerequisites });
    }
    return instructions;
  }

  // ---------------------------------------------------------------------------------------------
  // Undo
  // ---------------------------------------------------------------------------------------------

  private async revert(run: RunRecord, rec: StepRecord, createdFlags: Set<string>): Promise<void> {
    const s = rec.step;
    const comment = `Undo of StatSig migration run #${run.id.slice(0, 8)}${this.opts.actor ? ` by ${this.opts.actor}` : ''}`;
    switch (s.op) {
      case 'ensure_context_kind':
        // Context kinds can't be deleted; archiving hides them from targeting.
        if (rec.created || rec.unarchived) await this.c.putContextKind(this.p, s.key, { name: s.name, archived: true }, this.signal);
        return;
      case 'upsert_segment': {
        for (const a of rec.approvals ?? []) if (a.status === 'pending') await this.c.deleteApprovalRequest(a.id).catch(ignore404);
        if (rec.created) {
          await this.c.deleteSegment(this.p, s.ldEnv, s.key, this.signal);
          this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: null });
          return;
        }
        const pre = rec.preImage as LdSegment | undefined;
        if (!pre) return;
        if (pre.unbounded) {
          // Big-segment membership can't be read back in bulk, so only the metadata is restored.
          const restored = await this.c.patchSegmentJson(this.p, s.ldEnv, s.key, [{ op: 'add', path: '/description', value: pre.description ?? '' }, { op: 'add', path: '/tags', value: pre.tags ?? [] }], { comment });
          this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: restored });
          rec.error = 'Undo restored the description and tags; the members imported into the big segment stay (LaunchDarkly has no bulk read to restore the previous list).';
          return;
        }
        const restored = await this.c.patchSegmentJson(
          this.p,
          s.ldEnv,
          s.key,
          [
            { op: 'add', path: '/rules', value: (pre.rules ?? []).map(({ _id, ...r }) => ({ ...r, clauses: r.clauses.map(({ _id: _c, ...c }) => c) })) },
            { op: 'add', path: '/included', value: pre.included ?? [] },
            { op: 'add', path: '/includedContexts', value: pre.includedContexts ?? [] },
            ...(s.desired.excluded || s.desired.excludedContexts ? [{ op: 'add' as const, path: '/excluded', value: pre.excluded ?? [] }, { op: 'add' as const, path: '/excludedContexts', value: pre.excludedContexts ?? [] }] : []),
            { op: 'add', path: '/description', value: pre.description ?? '' },
            { op: 'add', path: '/tags', value: pre.tags ?? [] },
          ],
          { comment, signal: this.signal },
        );
        this.report({ kind: 'segment', ldEnv: s.ldEnv, key: s.key, segment: restored });
        return;
      }
      case 'upsert_flag_shell': {
        if (rec.created) return this.deleteCreatedFlag(s.key, createdFlags);
        const pre = rec.preImage as LdFlag | undefined;
        if (!pre) return;
        const restored = await this.c.patchFlagJson(
          this.p,
          s.key,
          [
            { op: 'replace', path: '/name', value: pre.name },
            { op: 'replace', path: '/description', value: pre.description ?? '' },
            { op: 'replace', path: '/tags', value: pre.tags ?? [] },
            { op: 'replace', path: '/temporary', value: pre.temporary ?? true },
            { op: 'replace', path: '/customProperties', value: pre.customProperties ?? {} },
            ...(pre.clientSideAvailability ? [{ op: 'replace' as const, path: '/clientSideAvailability', value: pre.clientSideAvailability }] : []),
          ],
          { comment, signal: this.signal },
        );
        this.report({ kind: 'flag', key: s.key, flag: restored });
        return;
      }
      case 'ensure_randomization_unit': {
        const pre = rec.preImage as LdExperimentationSettings | undefined;
        if (!rec.created || !pre) return;
        await this.c.putExperimentationSettings(this.p, { randomizationUnits: (pre.randomizationUnits ?? []).map((u) => ({ randomizationUnit: u.randomizationUnit, ...(u.default ? { default: true } : {}) })) }, this.signal);
        return;
      }
      case 'upsert_metric': {
        if (rec.created) {
          await this.c.deleteMetric(this.p, s.key, this.signal).catch((e) => {
            if (!(e instanceof LdWriteError && e.status === 404)) throw e;
          });
          return;
        }
        const pre = rec.preImage as LdMetric | undefined;
        if (!pre) return;
        await this.c.patchMetricJson(this.p, s.key, [{ op: 'replace', path: '/tags', value: pre.tags ?? [] }, ...(pre.eventKey ? [{ op: 'replace' as const, path: '/eventKey', value: pre.eventKey }] : [])], { comment, signal: this.signal });
        return;
      }
      case 'create_bandit': {
        // Experiments can't be deleted: archiving hides a draft this run created. An adopted
        // experiment keeps the replaced draft (LD has no way to restore an iteration).
        if (rec.created) await this.c.patchExperimentSemantic(this.p, s.ldEnv, s.key, { comment, instructions: [{ kind: 'archiveExperiment' }] }, this.signal);
        return;
      }
      case 'upsert_ai_config': {
        if (rec.created) {
          await this.c.deleteAiConfig(this.p, s.key, this.signal).catch((e) => {
            if (!(e instanceof LdWriteError && e.status === 404)) throw e;
          });
          return;
        }
        const pre = rec.preImage as LdAiConfig | undefined;
        if (!pre) return;
        await this.c.patchAiConfig(this.p, s.key, { name: pre.name, description: pre.description ?? '', tags: pre.tags ?? [] }, this.signal);
        return;
      }
      case 'update_flag_env': {
        // Approval requests still waiting are withdrawn; scheduled changes this run created are deleted.
        for (const a of rec.approvals ?? []) if (a.status === 'pending' && a.purpose !== 'undo') await this.c.deleteFlagApprovalRequest(this.p, s.key, s.ldEnv, a.id).catch(ignore404);
        for (const id of rec.scheduledChangeIds ?? []) await this.c.deleteScheduledChange(this.p, s.key, s.ldEnv, id).catch(ignore404);
        // A flag this run created is deleted at its (last) environment step: environment steps are
        // in dependency order, so reversing them deletes dependents before their prerequisites,
        // and flags before the segments they use (LD refuses both the other way round).
        if (createdFlags.has(s.key)) return this.deleteCreatedFlag(s.key, createdFlags);
        const pre = rec.preImage as LdFlag | undefined;
        const env = pre?.environments?.[s.ldEnv];
        if (!pre || !env) return;
        // Targeting that never got applied (approval still pending) has nothing to restore.
        if (rec.status === 'pending_approval') return;
        const current = await this.c.getFlag(this.p, s.key, this.signal);
        if (!current) return;
        // The pre-image is older than any edit made in LaunchDarkly after this run; restoring it
        // would revert that edit too, so the environment is left as it is.
        const since = ldChange(current.environments?.[s.ldEnv], rec.finishedAt, rec.ldVersion);
        if (since.changed) throw new Error(`Not restored: the targeting of “${s.key}” in ${s.ldEnv} was changed in LaunchDarkly after this run (${since.evidence}). Restore it by hand if needed; LaunchDarkly’s audit log has both states.`);
        const prop = syncPropertyKey(s.ldEnv);
        const prereqs = [];
        for (const p of env.prerequisites ?? []) {
          const pf = await this.c.getFlag(this.p, p.key, this.signal);
          const id = pf?.variations[p.variation]?._id;
          if (id) prereqs.push({ key: p.key, variationId: id });
        }
        const instructions = restoreInstructions(pre, env, current, current.environments?.[s.ldEnv], prereqs);
        try {
          const restored = await this.c.patchFlagSemantic(this.p, s.key, { environmentKey: s.ldEnv, comment, instructions }, { signal: this.signal });
          this.report({ kind: 'flag', key: s.key, flag: restored });
        } catch (e) {
          if (!(e instanceof LdWriteError && e.status === 405)) throw e;
          // The environment requires approvals: the restore is filed as one too.
          const ar = await this.c.createFlagApprovalRequest(this.p, s.key, s.ldEnv, { description: `Undo StatSig migration: restore targeting for “${s.key}” in ${s.ldEnv}`, instructions, comment });
          (rec.approvals ??= []).push({ id: ar._id, kind: 'flag', purpose: 'undo', status: 'pending', createdAt: this.now().toISOString() });
        }
        const before = pre.customProperties?.[prop];
        if (before) this.report({ kind: 'flag', key: s.key, flag: await this.c.patchFlagJson(this.p, s.key, [{ op: 'add', path: `/customProperties/${pointer(prop)}`, value: before }], { comment, signal: this.signal }) });
        else if (current.customProperties?.[prop]) this.report({ kind: 'flag', key: s.key, flag: await this.c.patchFlagJson(this.p, s.key, [{ op: 'remove', path: `/customProperties/${pointer(prop)}` }], { comment, signal: this.signal }) });
        return;
      }
    }
  }

  private readonly deleted = new Set<string>();

  private async deleteCreatedFlag(key: string, createdFlags: Set<string>): Promise<void> {
    if (!createdFlags.has(key) || this.deleted.has(key)) return;
    await this.c.deleteFlag(this.p, key, this.signal).catch((e) => {
      if (!(e instanceof LdWriteError && e.status === 404)) throw e;
    });
    this.deleted.add(key);
    this.report({ kind: 'flag', key, flag: null });
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Ids = (index: number) => string;

/**
 * Maps desired variation indexes (by value) to the flag's variation IDs. Values are compared
 * with sorted keys: LaunchDarkly stores JSON variations with its own key order, so a plain
 * JSON.stringify would miss every object variation it returns.
 */
export function sameVariationValue(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function variationIds(flag: LdFlag, values: unknown[]): Ids {
  return (index: number) => {
    const want = JSON.stringify(values[index]);
    const v = flag.variations.find((x) => sameVariationValue(x.value, values[index]));
    if (!v) throw new Error(`Flag “${flag.key}” has no variation with value ${want}.`);
    return v._id;
  };
}

function serve(v: VariationOrRollout, ids: Ids): Record<string, unknown> {
  if (v.rollout) return { rolloutContextKind: v.rollout.contextKind, ...(v.rollout.bucketBy ? { rolloutBucketBy: v.rollout.bucketBy } : {}), rolloutWeights: Object.fromEntries(v.rollout.variations.map((w) => [ids(w.variation), w.weight])) };
  return { variationId: ids(v.variation ?? 0) };
}

function rule(r: DesiredRule, ids: Ids): Record<string, unknown> {
  return { description: r.description, clauses: r.clauses, ...serve(r, ids) };
}

/** Semantic-patch instructions that put an environment back the way a pre-image had it. */
export function restoreInstructions(pre: LdFlag, env: LdFlagConfig, current: LdFlag, currentEnv: LdFlagConfig | undefined, prerequisites: { key: string; variationId: string }[]): SemanticPatch['instructions'] {
  const byIndex = (i: number | null | undefined) => {
    const value = pre.variations[i ?? 0]?.value;
    const v = current.variations.find((x) => sameVariationValue(x.value, value));
    if (!v) throw new Error(`Variation ${i} of “${pre.key}” no longer exists.`);
    return v._id;
  };
  const restoreServe = (v: { variation?: number | null; rollout?: { variations: { variation: number; weight: number }[]; contextKind?: string | null; bucketBy?: string | null } | null } | null | undefined) =>
    v?.rollout
      ? { rolloutWeights: Object.fromEntries(v.rollout.variations.map((w) => [byIndex(w.variation), w.weight])), ...(v.rollout.contextKind ? { rolloutContextKind: v.rollout.contextKind } : {}), ...(v.rollout.bucketBy ? { rolloutBucketBy: v.rollout.bucketBy } : {}) }
      : { variationId: byIndex(v?.variation) };
  const targets = [...(env.targets ?? []).map((t) => ({ ...t, contextKind: t.contextKind ?? 'user' })), ...(env.contextTargets ?? [])].filter((t) => t.values.length);
  const out: SemanticPatch['instructions'] = [
    { kind: env.on ? 'turnFlagOn' : 'turnFlagOff' },
    { kind: 'updateOffVariation', variationId: byIndex(env.offVariation) },
    { kind: 'updateFallthroughVariationOrRollout', ...restoreServe(env.fallthrough) },
    {
      kind: 'replaceRules',
      rules: (env.rules ?? []).map((r) => ({
        ...(r.description ? { description: r.description } : {}),
        clauses: r.clauses.map(({ _id, ...c }) => c),
        ...(r.trackEvents ? { trackEvents: r.trackEvents } : {}),
        ...restoreServe(r),
      })),
    },
    { kind: 'replaceTargets', targets: targets.map((t) => ({ contextKind: t.contextKind ?? 'user', variationId: byIndex(t.variation), values: t.values })) },
  ];
  if (prerequisites.length || currentEnv?.prerequisites?.length) out.push({ kind: 'replacePrerequisites', prerequisites });
  return out;
}

/**
 * Semantic-patch instructions in a shape that compares: clauses without their `_id`, `user` where
 * a context kind is implied, `negate` and `trackEvents` always present, targets and prerequisites
 * in a fixed order. Two instruction lists that normalize alike describe the same targeting.
 */
export function normalizeInstructions(ins: SemanticPatch['instructions']): unknown[] {
  type R = Record<string, unknown>;
  const serve = (x: R) =>
    x.rolloutWeights ? { rolloutContextKind: (x.rolloutContextKind as string | undefined) ?? 'user', rolloutBucketBy: (x.rolloutBucketBy as string | undefined) ?? null, rolloutWeights: x.rolloutWeights } : { variationId: x.variationId };
  return ins.map((i) => {
    switch (i.kind) {
      case 'updateFallthroughVariationOrRollout':
        return { kind: i.kind, ...serve(i) };
      case 'replaceRules':
        return {
          kind: i.kind,
          rules: ((i.rules as R[] | undefined) ?? []).map((r) => ({
            description: (r.description as string | undefined) || '',
            trackEvents: !!r.trackEvents,
            clauses: ((r.clauses as R[] | undefined) ?? []).map((c) => ({ contextKind: (c.contextKind as string | undefined) ?? 'user', attribute: c.attribute, op: c.op, values: c.values, negate: !!c.negate })),
            ...serve(r),
          })),
        };
      case 'replaceTargets':
        return {
          kind: i.kind,
          targets: ((i.targets as { contextKind?: string; variationId: string; values: string[] }[] | undefined) ?? [])
            .filter((t) => t.values.length)
            .map((t) => ({ contextKind: t.contextKind ?? 'user', variationId: t.variationId, values: [...t.values].sort() }))
            .sort((a, b) => `${a.contextKind}|${a.variationId}`.localeCompare(`${b.contextKind}|${b.variationId}`)),
        };
      case 'replacePrerequisites':
        return { kind: i.kind, prerequisites: [...((i.prerequisites as { key: string; variationId: string }[] | undefined) ?? [])].sort((a, b) => a.key.localeCompare(b.key)) };
      default:
        return i;
    }
  });
}

function shellPatch(flag: LdFlag, d: Extract<PlanStep, { op: 'upsert_flag_shell' }>['desired']): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  if (flag.name !== d.name) ops.push({ op: 'replace', path: '/name', value: d.name });
  if ((flag.description ?? '') !== d.description) ops.push({ op: 'replace', path: '/description', value: d.description });
  const tags = union(flag.tags ?? [], d.tags);
  if (tags.length !== (flag.tags ?? []).length) ops.push({ op: 'replace', path: '/tags', value: tags });
  if ((flag.temporary ?? true) !== d.temporary) ops.push({ op: 'replace', path: '/temporary', value: d.temporary });
  const csa = flag.clientSideAvailability;
  if (!csa || !!csa.usingEnvironmentId !== d.clientSideAvailability.usingEnvironmentId || !!csa.usingMobileKey !== d.clientSideAvailability.usingMobileKey) ops.push({ op: 'replace', path: '/clientSideAvailability', value: d.clientSideAvailability });
  // Maintainer (PLAN §8.3): set when the mapper resolved one and LD holds a different one. A flag
  // created by a service token has none; one somebody set by hand is only replaced, never cleared.
  if (d.maintainerId && flag.maintainerId !== d.maintainerId) ops.push({ op: 'add', path: '/maintainerId', value: d.maintainerId });
  else if (d.maintainerTeamKey && !d.maintainerId && flag.maintainerTeamKey !== d.maintainerTeamKey) ops.push({ op: 'add', path: '/maintainerTeamKey', value: d.maintainerTeamKey });
  for (const [k, v] of Object.entries(d.customProperties)) {
    const cur = flag.customProperties?.[k];
    if (!cur || JSON.stringify(cur.value ?? []) !== JSON.stringify(v.value)) ops.push({ op: 'add', path: `/customProperties/${pointer(k)}`, value: v });
  }
  // PLAN §7: variations are append-only. New values are added at the end; nothing is removed or reordered.
  const missing = d.variations.filter((v) => !flag.variations.some((x) => sameVariationValue(x.value, v.value)));
  if (missing.length) {
    if (flag.kind === 'boolean' || d.variations.every((v) => typeof v.value === 'boolean')) throw new Error(`Flag “${flag.key}” lacks variation${missing.length === 1 ? '' : 's'} ${missing.map((m) => JSON.stringify(m.value)).join(', ')}.`);
    for (const v of missing) ops.push({ op: 'add', path: '/variations/-', value: { value: v.value, name: v.name } });
  }
  return ops;
}

/** `sc:<id>` entries of a `migration.sync.<env>` value: the scheduled changes an earlier sync created. */
export function scheduledIdsFrom(value: (string | null | undefined)[] | null | undefined): string[] {
  return (value ?? []).filter((v): v is string => typeof v === 'string' && v.startsWith('sc:')).map((v) => v.slice(3));
}

function ignore404(e: unknown): void {
  if (!(e instanceof LdWriteError && e.status === 404)) throw e;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * LaunchDarkly's 400 for a flag past its size limit (KNOWN-EDGE-CASES 15.22): `flag size validation
 * failed: This flag could not be saved because it is 904447 bytes, which exceeds the 400000 byte
 * limit. Remove some targets, rules, or variations to reduce its size, then try again.`
 */
export function flagSizeError(e: unknown): { bytes: number | null; limit: number } | null {
  if (!(e instanceof LdWriteError) || e.status !== 400) return null;
  const msg = e.body && typeof e.body === 'object' && 'message' in e.body ? String((e.body as { message: unknown }).message) : e.message;
  if (!/flag size validation failed|exceeds the \d+ byte limit/i.test(msg)) return null;
  const m = /is (\d+) bytes, which exceeds the (\d+) byte limit/i.exec(msg);
  return { bytes: m ? Number(m[1]) : null, limit: m ? Number(m[2]) : FLAG_SIZE_LIMIT };
}

/**
 * Names the cause (a list too long to live in the flag) and the remedy (re-plan, so the mapper
 * splits the list into a segment, then resume: the failed step retries) instead of echoing
 * LaunchDarkly's text alone. `split` says whether this plan already carries split-off segments.
 */
export function flagSizeMessage(key: string, what: string, size: { bytes: number | null; limit: number }, split: boolean): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const measured = size.bytes !== null ? `the flag would be ${n(size.bytes)} bytes, ` : '';
  const limit = `${measured}over LaunchDarkly's ${n(size.limit)}-byte limit on a flag's total size (the rules, individual targets and variations of every environment)`;
  const cause = split
    ? `Cause: the flag's lists are already kept in segments, so the console's size estimate (budget ${n(FLAG_SIZE_BUDGET)} bytes for the whole flag) fell short of LaunchDarkly's count.`
    : `Cause: a rule or override list too long to live in the flag itself; this plan was made before the console checked flag sizes.`;
  const remedy = split
    ? `Remedy: shorten the lists or split the gate in StatSig, then re-plan and resume; the failed step retries.`
    : `Remedy: re-plan this flag, which moves such lists into segments written before the flag (budget ${n(FLAG_SIZE_BUDGET)} bytes for the whole flag), then resume the run; the failed step retries.`;
  return `LaunchDarkly refused the ${what} of flag “${key}”: ${limit}. ${cause} ${remedy}`;
}

/** LD caps target operations at 1,500 per request ("Patch segment": "Total number of operations on targets must not exceed batch limit of 1500"). */
export const TARGET_BATCH = 1500;

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Semantic-patch instructions that make `current` match `d` (for approval requests, which only
 * take instructions): rules are removed and re-added, included targets diffed per context kind,
 * tags added. Weighted segment rules can't be added with a weight in one instruction, so they
 * are refused here rather than filed wrong.
 */
export function segmentInstructions(current: LdSegment, d: DesiredSegment): SemanticPatch['instructions'] {
  const weighted = d.rules.find((r) => r.weight !== undefined);
  if (weighted) throw new Error(`Segment rule “${weighted.description}” has a percentage; LaunchDarkly approval requests can't add a weighted segment rule in one step. Have an approver create the rule, or turn off segment approvals for this environment.`);
  const out: SemanticPatch['instructions'] = [];
  for (const r of current.rules ?? []) if (r._id) out.push({ kind: 'removeRule', ruleId: r._id });
  for (const r of d.rules) out.push({ kind: 'addRule', description: r.description, clauses: r.clauses });
  out.push(...targetInstructions(current, d));
  const tags = d.tags.filter((t) => !(current.tags ?? []).includes(t));
  if (tags.length) out.push({ kind: 'addTags', values: tags });
  return out;
}

/**
 * The target (member) changes that make `current` match `d`, as semantic-patch instructions of at
 * most TARGET_BATCH values each: included keys, included contexts per kind, and (LD-source
 * segments only) the exclusions. Each instruction fits in a request of its own.
 */
export function targetInstructions(current: LdSegment, d: DesiredSegment): SemanticPatch['instructions'] {
  const out: SemanticPatch['instructions'] = [];
  const diff = (have: string[], want: string[]) => ({ add: want.filter((v) => !have.includes(v)), remove: have.filter((v) => !want.includes(v)) });
  const users = diff(current.included ?? [], d.included);
  for (const c of chunks(users.remove, TARGET_BATCH)) out.push({ kind: 'removeIncludedUsers', values: c });
  for (const c of chunks(users.add, TARGET_BATCH)) out.push({ kind: 'addIncludedUsers', values: c });
  const kinds = unique([...(current.includedContexts ?? []).map((c) => c.contextKind), ...d.includedContexts.map((c) => c.contextKind)]);
  for (const kind of kinds) {
    const t = diff(current.includedContexts?.find((c) => c.contextKind === kind)?.values ?? [], d.includedContexts.find((c) => c.contextKind === kind)?.values ?? []);
    for (const c of chunks(t.remove, TARGET_BATCH)) out.push({ kind: 'removeIncludedTargets', contextKind: kind, values: c });
    for (const c of chunks(t.add, TARGET_BATCH)) out.push({ kind: 'addIncludedTargets', contextKind: kind, values: c });
  }
  // Exclusions exist only for LD-source segments (PLAN §20.3).
  if (d.excluded || d.excludedContexts) {
    const ex = diff(current.excluded ?? [], d.excluded ?? []);
    for (const c of chunks(ex.remove, TARGET_BATCH)) out.push({ kind: 'removeExcludedUsers', values: c });
    for (const c of chunks(ex.add, TARGET_BATCH)) out.push({ kind: 'addExcludedUsers', values: c });
    const exKinds = unique([...(current.excludedContexts ?? []).map((c) => c.contextKind), ...(d.excludedContexts ?? []).map((c) => c.contextKind)]);
    for (const kind of exKinds) {
      const t = diff(current.excludedContexts?.find((c) => c.contextKind === kind)?.values ?? [], d.excludedContexts?.find((c) => c.contextKind === kind)?.values ?? []);
      for (const c of chunks(t.remove, TARGET_BATCH)) out.push({ kind: 'removeExcludedTargets', contextKind: kind, values: c });
      for (const c of chunks(t.add, TARGET_BATCH)) out.push({ kind: 'addExcludedTargets', contextKind: kind, values: c });
    }
  }
  return out;
}

function pointer(k: string): string {
  return k.replace(/~/g, '~0').replace(/\//g, '~1');
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Segments have no custom properties, so provenance goes in a description footer (PLAN §3.3). */
export function footer(p: { sourceKind?: MigrationSourceKind; sourceAlias: string; statsigId: string; statsigFingerprint: string; decisionSetHash: string }, at: Date): string {
  const input: FooterInput = { kind: p.sourceKind ?? SOURCE_KIND, sourceAlias: p.sourceAlias, sourceId: p.statsigId, sourceFingerprint: p.statsigFingerprint, decisionSetHash: p.decisionSetHash };
  return provenanceFooter(input, at);
}

export const withFooter = withProvenanceFooter;
export const parseFooter = parseProvenanceFooter;

/** `IterationInput` for a drafted bandit (reference/launchdarkly/openapi.json): treatments by variation ID, the flag's default rule. */
export function banditIteration(d: DesiredBandit, flag: LdFlag, flagConfigVersion: number): Record<string, unknown> {
  const ids = (i: number) => {
    const v = flag.variations[i];
    if (!v) throw new Error(`Flag “${flag.key}” has no variation ${i}.`);
    return v._id;
  };
  return {
    hypothesis: d.hypothesis,
    canReshuffleTraffic: true,
    metrics: [{ key: d.metricKey, isGroup: false }],
    primarySingleMetricKey: d.metricKey,
    treatments: d.treatments.map((t) => ({ name: t.name, baseline: t.baseline, allocationPercent: t.allocationPercent, parameters: [{ flagKey: d.flagKey, variationId: ids(t.variation) }] })),
    flags: { [d.flagKey]: { ruleId: d.ruleId, flagConfigVersion, notInExperimentVariationId: ids(d.treatments.find((t) => t.baseline)?.variation ?? 0) } },
    randomizationUnit: d.randomizationUnit,
    reallocationFrequencyMillis: d.reallocationFrequencyMillis,
  };
}

export function banditSummary(d: DesiredBandit): string {
  return `${d.treatments.length} arms (${d.treatments.map((t) => `${t.name} ${t.allocationPercent}%`).join(', ')}), optimizing “${d.metricKey}” by ${d.randomizationUnit}`;
}

function segmentSummary(d: { rules: unknown[]; included: string[]; includedContexts: { values: string[] }[]; unbounded?: { contextKind: string; ids: string[] } }): string {
  if (d.unbounded) return `${d.unbounded.ids.length.toLocaleString('en-US')} ${d.unbounded.contextKind} IDs (big segment)`;
  const ids = d.included.length + d.includedContexts.reduce((n, c) => n + c.values.length, 0);
  return [d.rules.length ? `${d.rules.length} rule${d.rules.length === 1 ? '' : 's'}` : '', ids ? `${ids} IDs` : ''].filter(Boolean).join(', ') || 'no members';
}

/** One line for a run log; `variations` (the flag's values) names the default when given. */
export function envSummary(d: Extract<PlanStep, { op: 'update_flag_env' }>['desired'], variations?: unknown[]): string {
  const name = (i: number | undefined) => {
    if (!variations) return i === 0 ? 'true' : 'false';
    const v = JSON.stringify(variations[i ?? 0]);
    return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  };
  const ft = d.fallthrough.rollout
    ? d.fallthrough.rollout.variations.length > 2
      ? `${d.fallthrough.rollout.variations.length}-way split`
      : `${(d.fallthrough.rollout.variations[0]!.weight / 1000).toString()}% rollout`
    : name(d.fallthrough.variation);
  const targets = d.targets.reduce((n, t) => n + t.values.length, 0);
  return [
    d.on ? 'on' : 'off',
    `${d.rules.length} rule${d.rules.length === 1 ? '' : 's'}`,
    ...(targets ? [`${targets} individual target${targets === 1 ? '' : 's'}`] : []),
    ...(d.prerequisites.length ? [`prerequisite ${d.prerequisites.map((p) => p.key).join(', ')}`] : []),
    `default ${ft}`,
    ...(d.scheduledChanges?.length ? [`${d.scheduledChanges.length} scheduled change${d.scheduledChanges.length === 1 ? '' : 's'}`] : []),
  ].join(', ');
}

/**
 * When LaunchDarkly says a resource was created, in epoch ms: flags and segments carry
 * `creationDate`, metrics and experiments `_creationDate`, AI Configs `createdAt`. Undefined when
 * the body has none the client recognises.
 */
export function createdAtMs(resource: object): number | undefined {
  const r = resource as Record<string, unknown>;
  for (const k of ['creationDate', '_creationDate', 'createdAt', '_createdAt']) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

/**
 * "Make the LD project look like day 0." A deliberately destructive, user-triggered operation,
 * reachable only behind a preview and three typed confirmations (screens/ProjectResetModal.tsx).
 *
 * It runs in two halves so the user sees exactly what will happen before anything happens:
 *   1. `planReset` reads the project and lists everything in it: flags (all environments),
 *      segments, metrics, experiments (archived: LD can't delete them), custom context kinds
 *      (archived: same) and the environments this app created (tagged `migrated-from-statsig`,
 *      or `statsig-migrated` from earlier builds; LD's own environments stay, a project needs
 *      at least one). Nothing is written.
 *   2. `resetProject` executes that plan and only that plan: it deletes the keys the preview
 *      listed, under the project key the preview was built for. Anything created in between
 *      is left alone, and a plan for another project is refused before the first request.
 * Nothing in StatSig is touched, ever.
 */
import { hasMigratedTag } from '@sslm/canonical';
import { LdWriteError, type LdClient } from '@sslm/ld-client';
import { ldClient, refreshLdState, reprobe, type LdSession } from './ld.ts';
import { store } from './store.ts';

/** Thrown out of the step in flight when the user cancels; `resetProject` turns it into `report.cancelled`. */
class ResetCancelled extends Error {
  constructor() {
    super('Reset cancelled.');
    this.name = 'ResetCancelled';
  }
}

export interface ResetProgress {
  phase: string;
  done: number;
  total: number;
  message?: string;
}

/** Everything the reset is going to do to one project, as read before any confirmation. */
export interface ResetPlan {
  /** The key the plan was built for; `resetProject` refuses to run it against any other. */
  projectKey: string;
  /** The project's display name, as LD returned it for that key. */
  projectName: string;
  plannedAt: string;
  /** Every environment, with what happens to it. Only those this console created are deleted, and never the last one. */
  environments: { key: string; name: string; action: 'delete' | 'keep'; reason: string }[];
  flags: { key: string; name?: string }[];
  segments: { env: string; key: string; name: string }[];
  metrics: { key: string; name?: string }[];
  experiments: { env: string; key: string; name: string; running: boolean; winningTreatmentId?: string }[];
  contextKinds: { key: string; name?: string }[];
  /** Listings LD refused (Experimentation without the add-on reads 403). Whatever is there is left alone. */
  unreadable: string[];
}

export interface ResetReport {
  deleted: Record<'flags' | 'segments' | 'metrics' | 'environments', number>;
  archived: Record<'experiments' | 'contextKinds', number>;
  /** What LD refused, with the reason. The project may still hold these. */
  failures: { what: string; reason: string }[];
  /** The user cancelled: the counts above are what was removed before the stop; the rest is still there. */
  cancelled?: boolean;
}

type Client = Pick<
  LdClient,
  | 'getProject'
  | 'listFlags'
  | 'deleteFlag'
  | 'listEnvironments'
  | 'listSegments'
  | 'deleteSegment'
  | 'listMetrics'
  | 'deleteMetric'
  | 'listExperiments'
  | 'patchExperimentSemantic'
  | 'listContextKinds'
  | 'putContextKind'
  | 'deleteEnvironment'
>;

/** How many operations the plan amounts to; 0 means the project is already at day 0. */
export function planSize(plan: ResetPlan): number {
  return plan.flags.length + plan.segments.length + plan.metrics.length + plan.experiments.length + plan.contextKinds.length + plan.environments.filter((e) => e.action === 'delete').length;
}

/** Read the workspace's LD project and list what a reset would do. Writes nothing. */
export async function planLdReset(workspaceId: string, ld: LdSession, signal?: AbortSignal): Promise<ResetPlan> {
  if (!ld.projectKey) throw new Error('Choose an LD project first.');
  return planReset(ldClient(workspaceId), ld.projectKey, signal);
}

/**
 * Execute a plan against the workspace's LD project. Refused unless the plan, the session and
 * the saved workspace all name the same project. Aborting `signal` stops after the request in
 * flight; the report then says what was removed before the stop (`cancelled: true`) and the LD
 * state is re-read either way, so the UI shows what is actually left.
 */
export async function resetLdProject(workspaceId: string, ld: LdSession, plan: ResetPlan, onProgress?: (p: ResetProgress) => void, signal?: AbortSignal): Promise<ResetReport> {
  if (!ld.projectKey) throw new Error('Choose an LD project first.');
  const saved = (await store.getWorkspace(workspaceId))?.ld?.projectKey;
  if (plan.projectKey !== ld.projectKey || saved !== ld.projectKey) {
    throw new Error(`Refusing to reset: the preview was for “${plan.projectKey}”, the connection is on “${ld.projectKey}” and the workspace is saved with “${saved ?? 'none'}”. Close this dialog and start again.`);
  }
  const report = await resetProject(ldClient(workspaceId), plan, onProgress, signal);
  // The flags the samples and switches were about are gone; monitoring starts over.
  await store.clearMonitoring(workspaceId);
  // The environment list may have changed: re-probe, then re-read flags and segments.
  await reprobe(workspaceId);
  await refreshLdState(workspaceId);
  return report;
}

/** The inventory, against any client (tests pass a fake). Read-only. */
export async function planReset(c: Client, projectKey: string, signal?: AbortSignal): Promise<ResetPlan> {
  const project = await c.getProject(projectKey, signal);
  if (project.key !== projectKey) throw new Error(`LaunchDarkly returned project “${project.key}” for key “${projectKey}”; not resetting anything.`);
  const unreadable: string[] = [];
  const optional = async <T>(what: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted) throw e;
      unreadable.push(`${what}: ${(e as Error).message}`);
      return [];
    }
  };

  const envs = await c.listEnvironments(projectKey, signal);
  const plan: ResetPlan = {
    projectKey,
    projectName: project.name,
    plannedAt: new Date().toISOString(),
    environments: [],
    flags: (await c.listFlags(projectKey, { signal })).map((f) => ({ key: f.key, ...(f.name ? { name: f.name } : {}) })),
    segments: [],
    metrics: (await optional('metrics', () => c.listMetrics(projectKey, signal))).map((m) => ({ key: m.key, ...(m.name ? { name: m.name } : {}) })),
    experiments: [],
    contextKinds: (await c.listContextKinds(projectKey, signal)).items.filter((k) => k.key !== 'user' && !k.archived).map((k) => ({ key: k.key, ...(k.name ? { name: k.name } : {}) })),
    unreadable,
  };

  for (const env of envs) {
    for (const s of await c.listSegments(projectKey, env.key, signal)) plan.segments.push({ env: env.key, key: s.key, name: s.name });
    for (const x of await optional(`experiments in ${env.key}`, () => c.listExperiments(projectKey, env.key, signal))) {
      if (x.archivedDate != null) continue;
      const winningTreatmentId = x.currentIteration?.treatments?.[0]?._id;
      plan.experiments.push({ env: env.key, key: x.key, name: x.name, running: x.currentIteration?.status === 'running', ...(winningTreatmentId ? { winningTreatmentId } : {}) });
    }
  }

  // Environments: only the ones this console created, and never the last one left.
  let remaining = envs.length;
  for (const e of envs) {
    const ours = hasMigratedTag(e.tags ?? []);
    if (ours && remaining > 1) {
      remaining--;
      plan.environments.push({ key: e.key, name: e.name, action: 'delete', reason: 'created by this console' });
    } else {
      plan.environments.push({ key: e.key, name: e.name, action: 'keep', reason: ours ? 'a project needs at least one environment' : 'not created by this console' });
    }
  }
  return plan;
}

/** Execute the plan, against any client (tests pass a fake). Touches only what the plan lists. */
export async function resetProject(c: Client, plan: ResetPlan, onProgress?: (p: ResetProgress) => void, signal?: AbortSignal): Promise<ResetReport> {
  const report: ResetReport = { deleted: { flags: 0, segments: 0, metrics: 0, environments: 0 }, archived: { experiments: 0, contextKinds: 0 }, failures: [] };
  try {
    await resetSteps(c, plan, report, onProgress, signal);
  } catch (e) {
    if (!(e instanceof ResetCancelled)) throw e;
    report.cancelled = true;
    onProgress?.({ phase: 'Cancelled', done: 1, total: 1 });
  }
  return report;
}

async function resetSteps(c: Client, plan: ResetPlan, report: ResetReport, onProgress: ((p: ResetProgress) => void) | undefined, signal: AbortSignal | undefined): Promise<void> {
  const { projectKey } = plan;
  // Checked before every request: a cancel never starts another delete.
  const progress = (phase: string, done: number, total: number, message?: string) => {
    if (signal?.aborted) throw new ResetCancelled();
    onProgress?.({ phase, done, total, ...(message ? { message } : {}) });
  };
  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (signal?.aborted) throw new ResetCancelled();
      if (e instanceof LdWriteError && e.status === 404) return true;
      report.failures.push({ what, reason: (e as Error).message });
      return false;
    }
  };

  // 1. Experiments first: a flag with a running experiment can't be deleted.
  for (const [i, x] of plan.experiments.entries()) {
    progress('Archiving experiments', i, plan.experiments.length, `${x.env}/${x.key}`);
    if (x.running) await attempt(`stop experiment ${x.env}/${x.key}`, () => c.patchExperimentSemantic(projectKey, x.env, x.key, { instructions: [{ kind: 'stopIteration', winningTreatmentId: x.winningTreatmentId, winningReason: 'Project reset' }] }, signal));
    if (await attempt(`archive experiment ${x.env}/${x.key}`, () => c.patchExperimentSemantic(projectKey, x.env, x.key, { instructions: [{ kind: 'archiveExperiment' }] }, signal))) report.archived.experiments++;
  }

  // 2. Flags, in passes: a flag used as a prerequisite can't go before its dependents.
  let flags = plan.flags.map((f) => f.key);
  const total = flags.length;
  for (let pass = 0; pass < 5 && flags.length; pass++) {
    const remaining: string[] = [];
    for (const key of flags) {
      progress('Deleting flags', total - flags.length + remaining.length, total, key);
      try {
        await c.deleteFlag(projectKey, key, signal);
        report.deleted.flags++;
      } catch (e) {
        if (signal?.aborted) throw new ResetCancelled();
        if (e instanceof LdWriteError && e.status === 404) continue;
        if (pass === 4) report.failures.push({ what: `delete flag ${key}`, reason: (e as Error).message });
        else remaining.push(key);
      }
    }
    flags = remaining;
  }

  // 3. Segments, per environment (flags referencing them are gone).
  for (const [i, s] of plan.segments.entries()) {
    progress('Deleting segments', i, plan.segments.length, `${s.env}/${s.key}`);
    if (await attempt(`delete segment ${s.env}/${s.key}`, () => c.deleteSegment(projectKey, s.env, s.key, signal))) report.deleted.segments++;
  }

  // 4. Metrics (experiments that used them are archived).
  for (const [i, m] of plan.metrics.entries()) {
    progress('Deleting metrics', i, plan.metrics.length, m.key);
    if (await attempt(`delete metric ${m.key}`, () => c.deleteMetric(projectKey, m.key, signal))) report.deleted.metrics++;
  }

  // 5. Custom context kinds: archived (LD has no delete).
  for (const [i, k] of plan.contextKinds.entries()) {
    progress('Archiving context kinds', i, plan.contextKinds.length, k.key);
    if (await attempt(`archive context kind ${k.key}`, () => c.putContextKind(projectKey, k.key, { name: k.name ?? k.key, archived: true }, signal))) report.archived.contextKinds++;
  }

  // 6. Environments the plan marked for deletion (ours, never the last one).
  const envs = plan.environments.filter((e) => e.action === 'delete');
  for (const [i, e] of envs.entries()) {
    progress('Deleting environments', i, envs.length, e.key);
    if (await attempt(`delete environment ${e.key}`, () => c.deleteEnvironment(projectKey, e.key, signal))) report.deleted.environments++;
  }

  progress('Done', 1, 1);
}

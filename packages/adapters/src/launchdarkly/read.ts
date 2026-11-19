/**
 * LaunchDarkly source adapter, read side (PLAN §20.2): everything the console needs from a
 * source LD project, read with the lenient schemas of @sslm/ld-client and never written to.
 * One request per flag (GET /flags/{p}/{key} carries every environment's targeting), one per
 * environment for segments, experiments and holdouts; one each for metrics, metric groups and
 * layers (PLAN §20.5). Experimentation routes answer 403 on plans without the add-on, so each of
 * them is optional: a failure is recorded in `skipped` and the collection stays empty.
 */
import type { LdClient, LdEnvironment, LdExperiment, LdFlag, LdFlagSummary, LdHoldout, LdLayer, LdMember, LdMetric, LdMetricGroup, LdProject, LdSchemaIssue, LdSegment } from '@sslm/ld-client';
import { HttpError } from '@sslm/http';

/** The reads the adapter makes; `LdClient` satisfies it, and tests can pass a fake. */
export type LdSourceReader = Pick<LdClient, 'getProject' | 'listEnvironments' | 'listContextKinds' | 'listFlags' | 'getFlag' | 'listSegments' | 'listMetrics' | 'listMetricGroups' | 'listExperiments' | 'listHoldouts' | 'getHoldout' | 'listLayers' | 'getMember'>;

export interface RawLdSnapshot {
  kind: 'launchdarkly';
  fetchedAt: string;
  projectKey: string;
  project: LdProject;
  environments: LdEnvironment[];
  contextKinds: { key: string; name?: string | null; archived?: boolean | null }[];
  /** Full flags, archived ones included (the listing hides them unless asked). */
  flags: LdFlag[];
  /** Segments per environment key. */
  segments: Record<string, LdSegment[]>;
  /** Experimentation (PLAN §20.5): empty when the route was skipped (see `skipped`). */
  metrics: LdMetric[];
  metricGroups: LdMetricGroup[];
  /** Experiments per environment key, expanded (treatments, draft and previous iterations, secondary metrics, analysis config). */
  experiments: Record<string, LdExperiment[]>;
  /** Holdouts per environment key, each read in full (the listing carries no design). */
  holdouts: Record<string, LdHoldout[]>;
  layers: LdLayer[];
  /** Members named as maintainers by metrics, experiments and holdouts, by id (the flag read carries its own `_maintainer`). */
  members: Record<string, LdMember>;
  schemaIssues: LdSchemaIssue[];
  /** Reads that failed without failing the whole read (a 403 on one route, a segment page). */
  skipped: { endpoint: string; reason: string }[];
}

export interface LdReadProgress {
  done: number;
  total: number;
  endpoint: string;
}

export interface LdReadOptions {
  signal?: AbortSignal;
  onProgress?: (p: LdReadProgress) => void;
  /** Flags fetched at a time. LD's per-route limits are generous for reads; 4 keeps the UI responsive. */
  concurrency?: number;
}

export class LdReadAuthError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
    this.name = 'LdReadAuthError';
  }
}

/** What `GET …/experiments` leaves out unless asked (reference/launchdarkly/openapi.json `expand`). */
export const EXPERIMENT_EXPAND = ['treatments', 'draftIteration', 'previousIterations', 'secondaryMetrics', 'analysisConfig'];

/** Read one LD project. A 401/403 on the project itself is an auth error; later 403s are skipped routes. */
export async function readLdProject(client: LdSourceReader, projectKey: string, opts: LdReadOptions = {}): Promise<RawLdSnapshot> {
  const skipped: RawLdSnapshot['skipped'] = [];
  let done = 0;
  let total = 4;
  const progress = (endpoint: string) => opts.onProgress?.({ done, total, endpoint });

  progress(`/projects/${projectKey}`);
  let project: LdProject;
  try {
    project = await client.getProject(projectKey, opts.signal);
  } catch (e) {
    throw new LdReadAuthError(`Could not read LaunchDarkly project “${projectKey}”: ${(e as Error).message}`, e);
  }
  done++;

  progress(`/projects/${projectKey}/environments`);
  const environments = await client.listEnvironments(projectKey, opts.signal);
  done++;

  progress(`/projects/${projectKey}/context-kinds`);
  let contextKinds: RawLdSnapshot['contextKinds'] = [];
  try {
    contextKinds = ((await client.listContextKinds(projectKey, opts.signal)).items ?? []).map((k) => ({ key: k.key, name: k.name, archived: k.archived }));
  } catch (e) {
    skipped.push({ endpoint: `/projects/${projectKey}/context-kinds`, reason: reason(e) });
  }
  done++;

  progress(`/flags/${projectKey}`);
  const summaries: LdFlagSummary[] = await client.listFlags(projectKey, { signal: opts.signal, includeArchived: true });
  done++;
  total += summaries.length + environments.length;

  const flags: LdFlag[] = [];
  const queue = [...summaries];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, queue.length || 1)) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const endpoint = `/flags/${projectKey}/${s.key}`;
      progress(endpoint);
      try {
        const f = await client.getFlag(projectKey, s.key, opts.signal);
        if (f) flags.push(f);
        else skipped.push({ endpoint, reason: 'listed but not found (deleted while reading?)' });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        skipped.push({ endpoint, reason: reason(e) });
      }
      done++;
    }
  });
  await Promise.all(workers);
  // The listing order is LD's; keep snapshots deterministic.
  flags.sort((a, b) => a.key.localeCompare(b.key));

  const segments: Record<string, LdSegment[]> = {};
  const experiments: Record<string, LdExperiment[]> = {};
  const holdouts: Record<string, LdHoldout[]> = {};
  // Routes a plan may not have (experimentation) or a token may not read: the failure is recorded, the read goes on.
  const optional = async <T>(endpoint: string, read: () => Promise<T>, empty: T): Promise<T> => {
    progress(endpoint);
    try {
      return await read();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      skipped.push({ endpoint, reason: reason(e) });
      return empty;
    } finally {
      done++;
    }
  };
  total += 3 + 2 * environments.length;
  for (const env of environments) {
    const endpoint = `/segments/${projectKey}/${env.key}`;
    progress(endpoint);
    try {
      segments[env.key] = (await client.listSegments(projectKey, env.key, opts.signal)).sort((a, b) => a.key.localeCompare(b.key));
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      segments[env.key] = [];
      skipped.push({ endpoint, reason: reason(e) });
    }
    done++;
    experiments[env.key] = (await optional(`/projects/${projectKey}/environments/${env.key}/experiments`, () => client.listExperiments(projectKey, env.key, opts.signal, { expand: EXPERIMENT_EXPAND }), [] as LdExperiment[])).sort((a, b) => a.key.localeCompare(b.key));
    // The holdout listing carries key, name and status; the design (base experiment, metrics, amount) needs one read per holdout.
    const listed = await optional(`/projects/${projectKey}/environments/${env.key}/holdouts`, () => client.listHoldouts(projectKey, env.key, opts.signal), [] as LdHoldout[]);
    const full: LdHoldout[] = [];
    for (const h of listed) {
      if (!h.key) continue;
      const detail = await optional(`/projects/${projectKey}/environments/${env.key}/holdouts/${h.key}`, () => client.getHoldout(projectKey, env.key, h.key!, opts.signal), null as LdHoldout | null);
      full.push(detail ? { ...h, ...detail } : h);
    }
    holdouts[env.key] = full.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
  }
  const metrics = (await optional(`/metrics/${projectKey}`, () => client.listMetrics(projectKey, opts.signal), [] as LdMetric[])).sort((a, b) => a.key.localeCompare(b.key));
  const metricGroups = (await optional(`/projects/${projectKey}/metric-groups`, () => client.listMetricGroups(projectKey, opts.signal), [] as LdMetricGroup[])).sort((a, b) => a.key.localeCompare(b.key));
  const layers = (await optional(`/projects/${projectKey}/layers`, () => client.listLayers(projectKey, opts.signal), [] as LdLayer[])).sort((a, b) => a.key.localeCompare(b.key));

  // Maintainers: experiments give only `_maintainerId`; metrics and holdouts may too. The email is what another account can match.
  const memberIds = new Set<string>();
  for (const m of metrics) if (m.maintainerId && !m._maintainer?.email) memberIds.add(m.maintainerId);
  for (const list of Object.values(experiments)) for (const x of list) if (x._maintainerId) memberIds.add(x._maintainerId);
  for (const list of Object.values(holdouts)) for (const h of list) if (h.baseExperiment?._maintainerId) memberIds.add(h.baseExperiment._maintainerId);
  for (const g of metricGroups) if (g.maintainer?.kind === 'member' && g.maintainer.key && !g.maintainer._member?.email) memberIds.add(g.maintainer.key);
  const members: Record<string, LdMember> = {};
  total += memberIds.size;
  for (const id of memberIds) {
    const m = await optional(`/members/${id}`, () => client.getMember(id, opts.signal), null as LdMember | null);
    if (m) members[id] = m;
  }
  progress('done');

  return { kind: 'launchdarkly', fetchedAt: new Date().toISOString(), projectKey, project, environments, contextKinds, flags, segments, metrics, metricGroups, experiments, holdouts, layers, members, schemaIssues: [], skipped };
}

function reason(e: unknown): string {
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  return (e as Error).message;
}

/**
 * LaunchDarkly source adapter, read side (PLAN §20.2, §20.6): everything the console needs from a
 * source LD project, read with the lenient schemas of @sslm/ld-client and never written to.
 *
 * The read is scoped (`LdResourceKind`, packages/canonical/src/ldResources.ts): the project,
 * its environments and context kinds are always read; every other kind only when the scope has
 * it. One request per flag (GET /flags/{p}/{key} carries every environment's targeting), one per
 * environment for segments, experiments, holdouts and adaptive triggers; one each for the
 * project-level and account-level lists; one per flag *and* environment for scheduled changes,
 * triggers and workflows (off by default for that reason). Every route after the project itself
 * is optional: a 403 (no add-on on the plan, a token without the scope) or any other failure is
 * recorded in `skipped` and the collection stays empty, so the flags still migrate.
 */
import { ldReadScope, type LdResourceKind } from '@sslm/canonical';
import { LdAuthError, type LdAdaptiveTrigger, type LdAiConfig, type LdApplication, type LdClient, type LdCustomRole, type LdDestination, type LdEnvironment, type LdExperiment, type LdExperimentationSettings, type LdFlag, type LdFlagLink, type LdFlagSummary, type LdFlagTrigger, type LdHoldout, type LdLayer, type LdMember, type LdMetric, type LdMetricGroup, type LdModelConfig, type LdProject, type LdReleasePipeline, type LdReleasePolicy, type LdRelayProxyConfig, type LdRepository, type LdScheduledChange, type LdSchemaIssue, type LdSegment, type LdTeam, type LdView, type LdWebhook, type LdWorkflow, type LdWorkflowTemplate } from '@sslm/ld-client';
import { HttpError } from '@sslm/http';

/** The reads the adapter makes; `LdClient` satisfies it, and tests can pass a fake. */
export type LdSourceReader = Pick<
  LdClient,
  | 'getProject'
  | 'listEnvironments'
  | 'listContextKinds'
  | 'listFlags'
  | 'getFlag'
  | 'listSegments'
  | 'listMetrics'
  | 'listMetricGroups'
  | 'listExperiments'
  | 'listHoldouts'
  | 'getHoldout'
  | 'listLayers'
  | 'getMember'
  | 'listMembers'
  | 'listTeams'
  | 'getExperimentationSettings'
  | 'listAiConfigs'
  | 'listModelConfigs'
  | 'listReleasePipelines'
  | 'listReleasePolicies'
  | 'listViews'
  | 'listScheduledChanges'
  | 'listFlagTriggers'
  | 'listWorkflows'
  | 'listFlagLinks'
  | 'listDestinations'
  | 'listAdaptiveTriggers'
  | 'listCustomRoles'
  | 'listWebhooks'
  | 'listRelayProxyConfigs'
  | 'listRepositories'
  | 'listWorkflowTemplates'
  | 'listApplications'
>;

/** Per environment, per flag key. */
export type PerFlagEnv<T> = Record<string, Record<string, T[]>>;

export interface RawLdSnapshot {
  kind: 'launchdarkly';
  fetchedAt: string;
  projectKey: string;
  /** The resource kinds this read was asked for (PLAN §20.6); what was actually read is in the collections, failures in `skipped`. */
  scope: LdResourceKind[];
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
  // --- Everything else (PLAN §20.6) ---
  experimentationSettings: LdExperimentationSettings | null;
  aiConfigs: LdAiConfig[];
  modelConfigs: LdModelConfig[];
  releasePipelines: LdReleasePipeline[];
  releasePolicies: LdReleasePolicy[];
  views: LdView[];
  scheduledChanges: PerFlagEnv<LdScheduledChange>;
  flagTriggers: PerFlagEnv<LdFlagTrigger>;
  workflows: PerFlagEnv<LdWorkflow>;
  /** Per flag key. */
  flagLinks: Record<string, LdFlagLink[]>;
  /** The source project's destinations, per environment key (the account list is filtered by the self link). */
  destinations: Record<string, LdDestination[]>;
  adaptiveTriggers: Record<string, LdAdaptiveTrigger[]>;
  /** The whole account's teams and members, when the scope has them (`members` is the by-id map for maintainers). */
  teams: LdTeam[];
  accountMembers: LdMember[];
  customRoles: LdCustomRole[];
  webhooks: LdWebhook[];
  relayProxyConfigs: LdRelayProxyConfig[];
  repositories: LdRepository[];
  workflowTemplates: LdWorkflowTemplate[];
  applications: LdApplication[];
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
  /** Resource kinds to read (PLAN §20.6). Undefined is the default scope (`LD_DEFAULT_RESOURCES`). */
  resources?: readonly string[];
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
  const scope = ldReadScope(opts.resources);
  const want = (k: LdResourceKind) => scope.includes(k);
  const skipped: RawLdSnapshot['skipped'] = [];
  let done = 0;
  let total = 3;
  const progress = (endpoint: string) => opts.onProgress?.({ done, total, endpoint });
  // Routes a plan may not have (experimentation, beta features) or a token may not read: the failure is recorded, the read goes on.
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

  // --- Flags: one request per flag ---------------------------------------------------------------
  const flags: LdFlag[] = [];
  if (want('flags')) {
    total += 1;
    progress(`/flags/${projectKey}`);
    const summaries: LdFlagSummary[] = await client.listFlags(projectKey, { signal: opts.signal, includeArchived: true });
    done++;
    total += summaries.length;
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
  }

  // --- Per environment: segments, experiments, holdouts, adaptive triggers ------------------------
  const segments: Record<string, LdSegment[]> = {};
  const experiments: Record<string, LdExperiment[]> = {};
  const holdouts: Record<string, LdHoldout[]> = {};
  const adaptiveTriggers: Record<string, LdAdaptiveTrigger[]> = {};
  total += environments.length * ((want('segments') ? 1 : 0) + (want('experiments') ? 1 : 0) + (want('holdouts') ? 1 : 0) + (want('adaptive_triggers') ? 1 : 0));
  for (const env of environments) {
    if (want('segments')) {
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
    }
    if (want('experiments')) {
      experiments[env.key] = (await optional(`/projects/${projectKey}/environments/${env.key}/experiments`, () => client.listExperiments(projectKey, env.key, opts.signal, { expand: EXPERIMENT_EXPAND }), [] as LdExperiment[])).sort((a, b) => a.key.localeCompare(b.key));
    }
    if (want('holdouts')) {
      // The holdout listing carries key, name and status; the design (base experiment, metrics, amount) needs one read per holdout.
      const listed = await optional(`/projects/${projectKey}/environments/${env.key}/holdouts`, () => client.listHoldouts(projectKey, env.key, opts.signal), [] as LdHoldout[]);
      total += listed.length;
      const full: LdHoldout[] = [];
      for (const h of listed) {
        if (!h.key) continue;
        const detail = await optional(`/projects/${projectKey}/environments/${env.key}/holdouts/${h.key}`, () => client.getHoldout(projectKey, env.key, h.key!, opts.signal), null as LdHoldout | null);
        full.push(detail ? { ...h, ...detail } : h);
      }
      holdouts[env.key] = full.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
    }
    if (want('adaptive_triggers')) {
      adaptiveTriggers[env.key] = await optional(`/projects/${projectKey}/environments/${env.key}/adaptive-triggers`, () => client.listAdaptiveTriggers(projectKey, env.key, opts.signal), [] as LdAdaptiveTrigger[]);
    }
  }

  // --- Project-level lists --------------------------------------------------------------------------
  const projectLevel = (['metrics', 'metric_groups', 'layers', 'experimentation_settings', 'ai_configs', 'model_configs', 'release_pipelines', 'release_policies', 'views'] as LdResourceKind[]).filter(want);
  total += projectLevel.length;
  const byKey = <T extends { key: string }>(xs: T[]) => xs.sort((a, b) => a.key.localeCompare(b.key));
  const metrics = want('metrics') ? byKey(await optional(`/metrics/${projectKey}`, () => client.listMetrics(projectKey, opts.signal), [] as LdMetric[])) : [];
  const metricGroups = want('metric_groups') ? byKey(await optional(`/projects/${projectKey}/metric-groups`, () => client.listMetricGroups(projectKey, opts.signal), [] as LdMetricGroup[])) : [];
  const layers = want('layers') ? byKey(await optional(`/projects/${projectKey}/layers`, () => client.listLayers(projectKey, opts.signal), [] as LdLayer[])) : [];
  const experimentationSettings = want('experimentation_settings') ? await optional(`/projects/${projectKey}/experimentation-settings`, () => client.getExperimentationSettings(projectKey, opts.signal), null as LdExperimentationSettings | null) : null;
  const aiConfigs = want('ai_configs') ? byKey(await optional(`/projects/${projectKey}/ai-configs`, () => client.listAiConfigs(projectKey, opts.signal), [] as LdAiConfig[])) : [];
  const modelConfigs = want('model_configs') ? byKey(await optional(`/projects/${projectKey}/ai-configs/model-configs`, () => client.listModelConfigs(projectKey, opts.signal), [] as LdModelConfig[])) : [];
  const releasePipelines = want('release_pipelines') ? byKey(await optional(`/projects/${projectKey}/release-pipelines`, () => client.listReleasePipelines(projectKey, opts.signal), [] as LdReleasePipeline[])) : [];
  const releasePolicies = want('release_policies') ? byKey(await optional(`/projects/${projectKey}/release-policies`, () => client.listReleasePolicies(projectKey, opts.signal), [] as LdReleasePolicy[])) : [];
  const views = want('views') ? byKey(await optional(`/projects/${projectKey}/views`, () => client.listViews(projectKey, opts.signal), [] as LdView[])) : [];

  // --- Per flag (and environment): scheduled changes, triggers, workflows, flag links -------------
  // No project-wide listing exists for these, so each is one request per live flag (per environment).
  // The first 403 on a kind means the plan or token lacks it: the kind is skipped once, not once per flag.
  const liveFlags = flags.filter((f) => !f.archived);
  const scheduledChanges: PerFlagEnv<LdScheduledChange> = {};
  const flagTriggers: PerFlagEnv<LdFlagTrigger> = {};
  const workflows: PerFlagEnv<LdWorkflow> = {};
  const flagLinks: Record<string, LdFlagLink[]> = {};
  const perFlagEnv = async <T>(kind: LdResourceKind, into: PerFlagEnv<T>, path: (flag: string, env: string) => string, read: (flag: string, env: string) => Promise<T[]>) => {
    if (!want(kind)) return;
    const jobs: { flag: string; env: string }[] = [];
    for (const env of environments) {
      into[env.key] = {};
      for (const f of liveFlags) jobs.push({ flag: f.key, env: env.key });
    }
    total += jobs.length;
    let unavailable: string | undefined;
    const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, jobs.length || 1)) }, async () => {
      for (let j = jobs.shift(); j; j = jobs.shift()) {
        const endpoint = path(j.flag, j.env);
        if (unavailable) {
          done++;
          continue;
        }
        progress(endpoint);
        try {
          const items = await read(j.flag, j.env);
          if (items.length) into[j.env]![j.flag] = items;
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          if (isForbidden(e)) {
            // Several workers may have been in flight on the first 403: the kind is recorded once.
            if (!unavailable) {
              unavailable = reason(e);
              skipped.push({ endpoint, reason: `${unavailable}; the rest of this kind was not read` });
            }
          } else skipped.push({ endpoint, reason: reason(e) });
        }
        done++;
      }
    });
    await Promise.all(workers);
  };
  await perFlagEnv('scheduled_changes', scheduledChanges, (f, e) => `/projects/${projectKey}/flags/${f}/environments/${e}/scheduled-changes`, (f, e) => client.listScheduledChanges(projectKey, f, e, opts.signal));
  await perFlagEnv('flag_triggers', flagTriggers, (f, e) => `/flags/${projectKey}/${f}/triggers/${e}`, (f, e) => client.listFlagTriggers(projectKey, f, e, opts.signal));
  await perFlagEnv('workflows', workflows, (f, e) => `/projects/${projectKey}/flags/${f}/environments/${e}/workflows`, (f, e) => client.listWorkflows(projectKey, f, e, opts.signal));
  if (want('flag_links')) {
    total += liveFlags.length;
    let unavailable: string | undefined;
    for (const f of liveFlags) {
      const endpoint = `/flag-links/projects/${projectKey}/flags/${f.key}`;
      if (unavailable) {
        done++;
        continue;
      }
      progress(endpoint);
      try {
        const items = await client.listFlagLinks(projectKey, f.key, opts.signal);
        if (items.length) flagLinks[f.key] = items;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (isForbidden(e)) {
          unavailable = reason(e);
          skipped.push({ endpoint, reason: `${unavailable}; the rest of this kind was not read` });
        } else skipped.push({ endpoint, reason: reason(e) });
      }
      done++;
    }
  }

  // --- Account-level lists --------------------------------------------------------------------------
  const accountLevel = (['destinations', 'teams', 'members', 'custom_roles', 'webhooks', 'relay_proxy_configs', 'code_references', 'workflow_templates', 'applications'] as LdResourceKind[]).filter(want);
  total += accountLevel.length;
  const destinations: Record<string, LdDestination[]> = {};
  if (want('destinations')) {
    // GET /destinations lists the whole account; the self link `/api/v2/destinations/{project}/{env}/{id}` says which project and environment each belongs to.
    const all = await optional('/destinations', () => client.listDestinations(opts.signal), [] as LdDestination[]);
    for (const d of all) {
      const m = /\/destinations\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(d._links?.self?.href ?? '');
      if (!m || decodeURIComponent(m[1]!) !== projectKey) continue;
      const env = decodeURIComponent(m[2]!);
      (destinations[env] ??= []).push(d);
    }
    for (const list of Object.values(destinations)) list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }
  const teams = want('teams') ? byKey(await optional('/teams', () => client.listTeams(opts.signal), [] as LdTeam[])) : [];
  const accountMembers = want('members') ? (await optional('/members', () => client.listMembers(opts.signal), [] as LdMember[])).sort((a, b) => a.email.localeCompare(b.email)) : [];
  const customRoles = want('custom_roles') ? byKey(await optional('/roles', () => client.listCustomRoles(opts.signal), [] as LdCustomRole[])) : [];
  const webhooks = want('webhooks') ? (await optional('/webhooks', () => client.listWebhooks(opts.signal), [] as LdWebhook[])).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')) : [];
  const relayProxyConfigs = want('relay_proxy_configs') ? (await optional('/account/relay-auto-configs', () => client.listRelayProxyConfigs(opts.signal), [] as LdRelayProxyConfig[])).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')) : [];
  const repositories = want('code_references') ? (await optional('/code-refs/repositories', () => client.listRepositories(opts.signal), [] as LdRepository[])).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const workflowTemplates = want('workflow_templates') ? (await optional('/templates', () => client.listWorkflowTemplates(opts.signal), [] as LdWorkflowTemplate[])).sort((a, b) => (a._key ?? a._id).localeCompare(b._key ?? b._id)) : [];
  const applications = want('applications') ? byKey(await optional('/applications', () => client.listApplications(opts.signal), [] as LdApplication[])) : [];

  // Maintainers: experiments give only `_maintainerId`; metrics and holdouts may too. The email is what another account can match.
  // With the account's members in scope they resolve from that list; otherwise one GET /members/{id} each.
  const members: Record<string, LdMember> = {};
  for (const m of accountMembers) members[m._id] = m;
  const memberIds = new Set<string>();
  const need = (id: string | null | undefined) => {
    if (id && !members[id]) memberIds.add(id);
  };
  for (const m of metrics) if (!m._maintainer?.email) need(m.maintainerId);
  for (const list of Object.values(experiments)) for (const x of list) need(x._maintainerId);
  for (const list of Object.values(holdouts)) for (const h of list) need(h.baseExperiment?._maintainerId);
  for (const g of metricGroups) if (g.maintainer?.kind === 'member' && !g.maintainer._member?.email) need(g.maintainer.key);
  total += memberIds.size;
  for (const id of memberIds) {
    const m = await optional(`/members/${id}`, () => client.getMember(id, opts.signal), null as LdMember | null);
    if (m) members[id] = m;
  }
  progress('done');

  return {
    kind: 'launchdarkly',
    fetchedAt: new Date().toISOString(),
    projectKey,
    scope,
    project,
    environments,
    contextKinds,
    flags,
    segments,
    metrics,
    metricGroups,
    experiments,
    holdouts,
    layers,
    members,
    experimentationSettings,
    aiConfigs,
    modelConfigs,
    releasePipelines,
    releasePolicies,
    views,
    scheduledChanges,
    flagTriggers,
    workflows,
    flagLinks,
    destinations,
    adaptiveTriggers,
    teams,
    accountMembers,
    customRoles,
    webhooks,
    relayProxyConfigs,
    repositories,
    workflowTemplates,
    applications,
    schemaIssues: [],
    skipped,
  };
}

function isForbidden(e: unknown): boolean {
  return e instanceof LdAuthError || (e instanceof HttpError && (e.status === 401 || e.status === 403));
}

function reason(e: unknown): string {
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  if (e instanceof LdAuthError) return `HTTP ${e.status}`;
  return (e as Error).message;
}

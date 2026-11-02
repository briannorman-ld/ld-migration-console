import {
  AlertSchema,
  AutotuneSchema,
  CompanySchema,
  DynamicConfigSchema,
  EnvironmentsSchema,
  ExperimentSchema,
  GateSchema,
  HoldoutSchema,
  LayerSchema,
  MetricSchema,
  MetricSourceSchema,
  OverridesSchema,
  ParamStoreSchema,
  ProjectSettingsSchema,
  PromptSchema,
  ReviewSettingsSchema,
  SegmentSchema,
  StatsigAuthError,
  StatsigUnreachableError,
  TagSchema,
  TargetAppSchema,
  TeamSchema,
  UnitIdTypeSchema,
  UserSchema,
  type SchemaIssue,
  type StatsigAlert,
  type StatsigAutotune,
  type StatsigCompany,
  type StatsigConsoleClient,
  type StatsigDynamicConfig,
  type StatsigEnvironments,
  type StatsigExperiment,
  type StatsigGate,
  type StatsigHoldout,
  type StatsigIdList,
  type StatsigLayer,
  type StatsigMetric,
  type StatsigMetricSource,
  type StatsigOverrides,
  type StatsigParamStore,
  type StatsigProject,
  type StatsigProjectSettings,
  type StatsigPrompt,
  type StatsigReviewSettings,
  type StatsigSegment,
  type StatsigTag,
  type StatsigTargetApp,
  type StatsigTeam,
  type StatsigUnitIdType,
  type StatsigUser,
} from '@sslm/statsig-client';
import type { EntityKind } from '@sslm/canonical';
import { HttpError } from '@sslm/http';

/** Everything fetched from one Console API project, as returned (after lenient validation). */
export interface RawConsoleSnapshot {
  kind: 'console_api';
  fetchedAt: string;
  project: StatsigProject;
  company: StatsigCompany | null;
  environments: StatsigEnvironments | null;
  gates: StatsigGate[];
  dynamicConfigs: StatsigDynamicConfig[];
  segments: StatsigSegment[];
  /** Fetched ID-list contents, by segment ID. Lists above the eager limit are absent. */
  idLists: Record<string, StatsigIdList>;
  experiments: StatsigExperiment[];
  layers: StatsigLayer[];
  holdouts: StatsigHoldout[];
  autotunes: StatsigAutotune[];
  unitIdTypes: StatsigUnitIdType[];
  tags: StatsigTag[];
  targetApps: StatsigTargetApp[];
  metrics: StatsigMetric[];
  metricSources: StatsigMetricSource[];
  paramStores: StatsigParamStore[];
  users: StatsigUser[];
  /** Team details (`/users/teams/{id}`, with members) when readable; otherwise the list entries. */
  teams: StatsigTeam[];
  prompts: StatsigPrompt[];
  alerts: StatsigAlert[];
  reviewSettings: StatsigReviewSettings | null;
  projectSettings: StatsigProjectSettings | null;
  overrides: StatsigOverrides | null;
  schemaIssues: SchemaIssue[];
  /** Endpoints that failed without failing the crawl (missing plan feature, 403 scope, …). */
  skipped: { endpoint: string; reason: string }[];
}

export interface CrawlProgress {
  done: number;
  total: number;
  endpoint: string;
}

/** Which crawl jobs each entity kind needs. Project-level endpoints (environments, tags, …) always run. */
const JOBS_BY_KIND = {
  gate: ['gates'],
  config: ['dynamicConfigs'],
  segment: ['segments'],
  experiment: ['experiments'],
  layer: ['layers'],
  holdout: ['holdouts'],
  autotune: ['autotunes'],
  metric: ['metrics'],
  param_store: ['paramStores'],
  prompt: ['prompts'],
} as const satisfies Record<EntityKind, readonly string[]>;

export interface CrawlOptions {
  signal?: AbortSignal;
  /** Entity kinds to read; undefined reads everything. Kinds left out are not requested at all. */
  kinds?: EntityKind[];
  onProgress?: (p: CrawlProgress) => void;
  /**
   * ID lists up to this many IDs are fetched during the crawl. Larger lists (e.g. a 20k fraud
   * blocklist) are fetched on request later (Source warnings), when a big-segment migration needs them.
   */
  eagerIdListMax?: number;
}

export class CrawlAuthError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
    this.name = 'CrawlAuthError';
  }
}

/**
 * Full first sync of a Console API project (PLAN §4.1). Incremental refresh via
 * version/lastModifiedTime and /audit_logs is not implemented yet: a refresh re-crawls.
 */
export async function crawlConsoleProject(
  client: StatsigConsoleClient,
  schemaIssues: SchemaIssue[],
  opts: CrawlOptions = {},
): Promise<RawConsoleSnapshot> {
  const { signal } = opts;
  const skipped: RawConsoleSnapshot['skipped'] = [];
  let done = 0;
  let total = 1;
  const tick = (endpoint: string) => opts.onProgress?.({ done: ++done, total, endpoint });

  // 1. Validate the key with a single request before anything else.
  let project: StatsigProject;
  try {
    project = await client.validateKey(signal);
    tick('/project');
  } catch (e) {
    if (e instanceof StatsigAuthError || e instanceof StatsigUnreachableError) throw new CrawlAuthError(e.message, e);
    throw e;
  }

  // Optional endpoints: a 403 (key lacks the scope) or 404 (not on this plan) becomes a warning,
  // not a failed crawl. A 429 or 5xx that outlived the transport's retries, or a connection
  // failure (in a browser, a CORS-masked 429 looks exactly like one), is transient: saving an
  // empty list as this sync's truth would show "0 gates", so the crawl fails and can be rerun.
  const optional = async <T>(endpoint: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      const out = await run();
      tick(endpoint);
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (isTransient(e)) throw new CrawlTransientError(endpoint, e);
      skipped.push({ endpoint, reason: describe(e) });
      tick(endpoint);
      return fallback;
    }
  };

  const jobs = {
    company: () => optional('/company', null, () => client.get('/company', CompanySchema, {}, signal)),
    environments: () => optional('/environments', null, () => client.get('/environments', EnvironmentsSchema, {}, signal)),
    gates: () => optional('/gates', [], () => client.list('/gates', GateSchema, { includeArchived: 'true' }, signal)),
    dynamicConfigs: () => optional('/dynamic_configs', [], () => client.list('/dynamic_configs', DynamicConfigSchema, {}, signal)),
    segments: () => optional('/segments', [], () => client.list('/segments', SegmentSchema, {}, signal)),
    experiments: () => optional('/experiments', [], () => client.list('/experiments', ExperimentSchema, {}, signal)),
    layers: () => optional('/layers', [], () => client.list('/layers', LayerSchema, {}, signal)),
    holdouts: () => optional('/holdouts', [], () => client.list('/holdouts', HoldoutSchema, {}, signal)),
    autotunes: () => optional('/autotunes', [], () => client.list('/autotunes', AutotuneSchema, {}, signal)),
    unitIdTypes: () => optional('/unit_id_types', [], () => client.list('/unit_id_types', UnitIdTypeSchema, {}, signal)),
    tags: () => optional('/tags', [], () => client.list('/tags', TagSchema, {}, signal)),
    targetApps: () => optional('/target_app', [], () => client.list('/target_app', TargetAppSchema, {}, signal)),
    metrics: () => optional('/metrics/list', [], () => client.list('/metrics/list', MetricSchema, {}, signal)),
    paramStores: () => optional('/param_stores', [], () => client.list('/param_stores', ParamStoreSchema, {}, signal)),
    users: () => optional('/users', [], () => client.list('/users', UserSchema, {}, signal)),
    teams: () => optional('/users/teams', [], () => client.list('/users/teams', TeamSchema, {}, signal)),
    prompts: () => optional('/prompts', [], () => client.list('/prompts', PromptSchema, {}, signal)),
    alerts: () => optional('/alerts', [], () => client.list('/alerts', AlertSchema, {}, signal)),
    reviewSettings: () => optional('/settings/reviews', null, () => client.get('/settings/reviews', ReviewSettingsSchema, {}, signal)),
    projectSettings: () => optional('/settings/project', null, () => client.get('/settings/project', ProjectSettingsSchema, {}, signal)),
    overrides: () => optional('/overrides', null, () => client.get('/overrides', OverridesSchema, {}, signal)),
  } as const;
  // Kinds the user left out are not fetched: their jobs resolve to the empty fallback without a request.
  const wanted = opts.kinds ? new Set<string>(opts.kinds.flatMap((k) => JOBS_BY_KIND[k])) : null;
  const entityJobs = new Set<string>(Object.values(JOBS_BY_KIND).flat());
  const runs = Object.keys(jobs).filter((k) => !wanted || !entityJobs.has(k) || wanted.has(k));
  total += runs.length;

  // The transport's AIMD limiter and rate budget pace these; firing them together is fine.
  const entries = await Promise.all(runs.map(async (k) => [k, await jobs[k as keyof typeof jobs]()] as const));
  const r = { ...EMPTY_JOBS, ...Object.fromEntries(entries) } as { [K in keyof typeof jobs]: Awaited<ReturnType<(typeof jobs)[K]>> };

  // 2. Warehouse Native projects also have metric sources (PLAN §4.1 "Detecting Warehouse Native").
  let metricSources: StatsigMetricSource[] = [];
  if (r.company?.isWarehouseNative && (!wanted || wanted.has('metrics'))) {
    total++;
    metricSources = await optional('/metrics/metric_source/list', [], () => client.list('/metrics/metric_source/list', MetricSourceSchema, {}, signal));
  }

  // 2b. Team members (for LD team creation and owner → maintainer matching): one detail call per team.
  total += r.teams.length;
  const teams = await Promise.all(r.teams.map((t) => optional(`/users/teams/${t.id}`, t, () => client.get(`/users/teams/${encodeURIComponent(t.id)}`, TeamSchema, {}, signal))));

  // 3. Small ID lists.
  const eagerMax = opts.eagerIdListMax ?? 1000;
  const idLists: Record<string, StatsigIdList> = {};
  const lists = r.segments.filter((s) => s.type === 'id_list' && (s.count ?? 0) <= eagerMax);
  total += lists.length;
  await Promise.all(
    lists.map(async (s) => {
      const list = await optional(`/segments/${s.id}/id_list`, null, () => client.getIdList(s.id, signal));
      if (list) idLists[s.id] = list;
    }),
  );
  for (const s of r.segments) {
    if (s.type === 'id_list' && (s.count ?? 0) > eagerMax) {
      skipped.push({ endpoint: `/segments/${s.id}/id_list`, reason: `deferred: ${s.count} IDs exceeds the eager limit of ${eagerMax}` });
    }
  }

  return {
    kind: 'console_api',
    fetchedAt: new Date().toISOString(),
    project,
    ...r,
    teams,
    metricSources,
    idLists,
    schemaIssues,
    skipped,
  };
}

const EMPTY_JOBS = {
  company: null,
  environments: null,
  gates: [],
  dynamicConfigs: [],
  segments: [],
  experiments: [],
  layers: [],
  holdouts: [],
  autotunes: [],
  unitIdTypes: [],
  tags: [],
  targetApps: [],
  metrics: [],
  paramStores: [],
  users: [],
  teams: [],
  prompts: [],
  alerts: [],
  reviewSettings: null,
  projectSettings: null,
  overrides: null,
};

function isTransient(e: unknown): boolean {
  return (e instanceof HttpError && (e.status === 429 || e.status >= 500)) || e instanceof StatsigUnreachableError;
}

/** A StatSig endpoint was throttled or unreachable after retries; the sync must be rerun, not saved. */
export class CrawlTransientError extends Error {
  constructor(
    readonly endpoint: string,
    override readonly cause: unknown,
  ) {
    super(
      cause instanceof HttpError && cause.status === 429
        ? `StatSig rate-limited ${endpoint} even after retries. Wait a minute and sync again; nothing from this attempt was saved.`
        : `StatSig ${endpoint} failed (${describe(cause)}) after retries. Sync again in a moment; nothing from this attempt was saved.`,
    );
    this.name = 'CrawlTransientError';
  }
}

function describe(e: unknown): string {
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  if (e instanceof StatsigAuthError) return e.message;
  if (e instanceof StatsigUnreachableError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

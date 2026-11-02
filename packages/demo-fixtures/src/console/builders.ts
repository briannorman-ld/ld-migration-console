/**
 * Builders for StatSig Console API response objects (API version 20240601).
 *
 * Every builder emits all properties the OpenAPI spec marks required, with realistic values, so
 * seed files stay short. Field names come from reference/statsig/console-api-openapi-20240601.json;
 * test/console-shapes.test.ts validates every built object against that spec.
 */
import { pseudoId } from '../ids.ts';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export interface Person {
  id: string;
  name: string;
  email: string;
}

export interface BuildContext {
  /** Project slug, used in permalinks and pseudo-IDs. */
  project: string;
  /** Epoch ms that "now" means for this snapshot. */
  now: number;
}

export type ConditionType =
  | 'app_version' | 'browser_name' | 'browser_version' | 'country' | 'custom_field' | 'email'
  | 'environment_tier' | 'fails_gate' | 'fails_segment' | 'ip_address' | 'locale' | 'os_name'
  | 'os_version' | 'passes_gate' | 'passes_segment' | 'public' | 'time' | 'unit_id' | 'user_id'
  | 'user_agent' | 'url' | 'javascript' | 'device_model' | 'target_app' | 'experiment_group';

export type Operator =
  | 'any' | 'none' | 'any_case_sensitive' | 'none_case_sensitive' | 'str_contains_any'
  | 'str_contains_none' | 'gt' | 'lt' | 'lte' | 'gte' | 'version_gt' | 'version_lt' | 'version_gte'
  | 'version_lte' | 'version_eq' | 'after' | 'before' | 'on' | 'is_null' | 'is_not_null'
  | 'str_matches' | 'encoded_any' | 'array_contains_any' | 'array_contains_none'
  | 'array_contains_all' | 'not_array_contains_all';

export interface ConditionSeed {
  type: ConditionType;
  operator?: Operator;
  targetValue?: string[] | number[] | string | number | null;
  field?: string;
  customID?: string;
}

export interface RuleSeed {
  name: string;
  passPercentage?: number;
  conditions: ConditionSeed[];
  environments?: string[] | null;
  returnValue?: JsonObject;
  variants?: { name: string; passPercentage: number; returnValue: JsonObject }[];
}

/** A condition in Console API form. Optional fields are emitted only when set, like the real API. */
export function condition(c: ConditionSeed): JsonObject {
  const out: JsonObject = { type: c.type };
  if (c.operator !== undefined) out.operator = c.operator;
  if (c.targetValue !== undefined) out.targetValue = c.targetValue as Json;
  else if (c.type !== 'public') out.targetValue = null;
  if (c.field !== undefined) out.field = c.field;
  if (c.customID !== undefined) out.customID = c.customID;
  return out;
}

/** Console rule `id` is `<baseID>:<pass%>:<n>`, like the IDs seen in real config specs. */
export function rule(ctx: BuildContext, ownerKey: string, index: number, r: RuleSeed, kind: 'gate' | 'config' | 'segment'): JsonObject {
  const baseID = pseudoId(`${ctx.project}/${ownerKey}/rule/${r.name}`);
  const pass = r.passPercentage ?? 100;
  const out: JsonObject = {
    name: r.name,
    passPercentage: pass,
    conditions: r.conditions.map(condition),
    environments: r.environments ?? null,
    id: `${baseID}:${pass.toFixed(2)}:${index + 1}`,
    baseID,
    returnValue: r.returnValue ?? (kind === 'config' ? {} : {}),
  };
  if (kind === 'config') {
    out.returnValueJson5 = JSON.stringify(r.returnValue ?? {}, null, 2);
    if (r.variants) {
      out.variants = r.variants.map((v) => ({
        id: pseudoId(`${ctx.project}/${ownerKey}/rule/${r.name}/variant/${v.name}`),
        name: v.name,
        passPercentage: v.passPercentage,
        returnValue: v.returnValue,
        returnValueJson5: JSON.stringify(v.returnValue, null, 2),
      }));
    }
  }
  if (kind !== 'segment') {
    out.completedAutomatedRollouts = [];
    out.pendingAutomatedRollouts = [];
    out.safeguard = null;
  }
  return out;
}

function audit(ctx: BuildContext, creator: Person, createdDaysAgo: number, modifiedDaysAgo: number): JsonObject {
  return {
    lastModifierID: creator.id,
    lastModifiedTime: ctx.now - modifiedDaysAgo * 86_400_000,
    lastModifierEmail: creator.email,
    lastModifierName: creator.name,
    creatorID: creator.id,
    createdTime: ctx.now - createdDaysAgo * 86_400_000,
    creatorName: creator.name,
    creatorEmail: creator.email,
  };
}

function owner(p: Person): JsonObject {
  return { ownerID: p.id, ownerType: 'USER', ownerName: p.name, ownerEmail: p.email };
}

export function permalink(ctx: BuildContext, kind: string, id: string): string {
  return `https://console.statsig.com/${pseudoId(ctx.project).slice(0, 10)}/${kind}/${id}`;
}

export interface GateSeed {
  id: string;
  /** Display name. StatSig derives the ID from the name at creation and never changes it, so a renamed gate's name and ID differ. Defaults to the ID. */
  name?: string;
  description: string;
  owner: Person;
  idType?: string;
  tags?: string[];
  rules: RuleSeed[];
  isEnabled?: boolean;
  status?: 'In Progress' | 'Launched' | 'Disabled' | 'Archived';
  type?: 'TEMPORARY' | 'PERMANENT' | 'STALE' | 'TEMPLATE';
  typeReason?: 'NONE' | 'STALE_PROBABLY_LAUNCHED' | 'STALE_PROBABLY_UNLAUNCHED' | 'STALE_PROBABLY_FORGOTTEN' | 'STALE_NO_RULES' | 'STALE_PROBABLY_DEAD_CHECK' | 'STALE_EMPTY_CHECKS' | 'STALE_ALL_TRUE' | 'STALE_ALL_FALSE';
  targetApps?: string[];
  holdoutIDs?: string[];
  team?: string;
  checksPerHour?: number | null;
  createdDaysAgo?: number;
  modifiedDaysAgo?: number;
  version?: number;
  archivedDaysAgo?: number;
  archiveReason?: string;
}

export function gate(ctx: BuildContext, s: GateSeed): JsonObject {
  const archived = s.status === 'Archived';
  return {
    id: s.id,
    name: s.name ?? s.id,
    idType: s.idType ?? 'userID',
    description: s.description,
    ...audit(ctx, s.owner, s.createdDaysAgo ?? 120, s.modifiedDaysAgo ?? 10),
    tags: s.tags ?? [],
    targetApps: s.targetApps ?? [],
    holdoutIDs: s.holdoutIDs ?? [],
    team: s.team ?? null,
    teamID: s.team ? pseudoId(`${ctx.project}/team/${s.team}`) : null,
    version: s.version ?? 3,
    checksPerHour: s.checksPerHour === undefined ? 1200 : s.checksPerHour,
    status: s.status ?? (s.isEnabled === false ? 'Disabled' : 'In Progress'),
    type: s.type ?? 'TEMPORARY',
    typeReason: s.typeReason ?? 'NONE',
    owner: owner(s.owner),
    isTemplate: false,
    store0100Exposures: false,
    permalink: permalink(ctx, 'gates', s.id),
    archivedAt: archived ? ctx.now - (s.archivedDaysAgo ?? 30) * 86_400_000 : null,
    archivedByID: archived ? s.owner.id : null,
    archivedByName: archived ? s.owner.name : null,
    archivedByEmail: archived ? s.owner.email : null,
    archiveReason: archived ? (s.archiveReason ?? null) : null,
    isEnabled: s.isEnabled ?? true,
    rules: s.rules.map((r, i) => rule(ctx, `gate/${s.id}`, i, r, 'gate')),
    measureMetricLifts: false,
    monitoringMetrics: [],
    reviewSettings: { requiredReview: false, allowedReviewers: null },
    releasePipelineID: null,
  };
}

export interface ConfigSeed {
  id: string;
  /** Display name; defaults to the ID (see GateSeed.name). */
  name?: string;
  description: string;
  owner: Person;
  idType?: string;
  tags?: string[];
  defaultValue: JsonObject;
  rules: RuleSeed[];
  isEnabled?: boolean;
  schema?: JsonObject;
  targetApps?: string[];
  holdoutIDs?: string[];
  team?: string;
  checksPerHour?: number | null;
  version?: number;
  type?: 'PERMANENT' | 'TEMPORARY' | 'STALE' | 'TEMPLATE';
  createdDaysAgo?: number;
  modifiedDaysAgo?: number;
}

export function dynamicConfig(ctx: BuildContext, s: ConfigSeed): JsonObject {
  return {
    id: s.id,
    name: s.name ?? s.id,
    idType: s.idType ?? 'userID',
    description: s.description,
    ...audit(ctx, s.owner, s.createdDaysAgo ?? 200, s.modifiedDaysAgo ?? 14),
    tags: s.tags ?? [],
    targetApps: s.targetApps ?? [],
    holdoutIDs: s.holdoutIDs ?? [],
    team: s.team ?? null,
    teamID: s.team ? pseudoId(`${ctx.project}/team/${s.team}`) : null,
    version: s.version ?? 5,
    isEnabled: s.isEnabled ?? true,
    rules: s.rules.map((r, i) => rule(ctx, `config/${s.id}`, i, r, 'config')),
    defaultValue: s.defaultValue,
    defaultValueJson5: JSON.stringify(s.defaultValue, null, 2),
    owner: owner(s.owner),
    schema: s.schema ? JSON.stringify(s.schema) : null,
    schemaJson5: s.schema ? JSON.stringify(s.schema, null, 2) : null,
    releasePipelineID: null,
    isTemplate: false,
    status: s.isEnabled === false ? 'Disabled' : 'Enabled',
    checksPerHour: s.checksPerHour === undefined ? 800 : s.checksPerHour,
    permalink: permalink(ctx, 'dynamic_configs', s.id),
    type: s.type ?? 'PERMANENT',
    typeReason: 'NONE',
    isPermanent: (s.type ?? 'PERMANENT') === 'PERMANENT',
  };
}

export interface SegmentSeed {
  id: string;
  description: string;
  owner: Person;
  type: 'id_list' | 'rule_based';
  idType?: string;
  tags?: string[];
  rules?: RuleSeed[];
  /** id_list segments: the deterministic ID generator (expanded by the mock / generators). */
  idList?: IdListSeed;
  isEnabled?: boolean;
}

/** ID lists are stored as generator descriptors, not 20k literal IDs, and expanded on demand. */
export interface IdListSeed {
  /** printf-like pattern with `{n}` → zero-padded index. */
  pattern: string;
  count: number;
  pad?: number;
}

export function expandIdList(s: IdListSeed): string[] {
  const pad = s.pad ?? String(s.count).length;
  return Array.from({ length: s.count }, (_, i) => s.pattern.replace('{n}', String(i + 1).padStart(pad, '0')));
}

export function segment(ctx: BuildContext, s: SegmentSeed): JsonObject {
  const out: JsonObject = {
    isEnabled: s.isEnabled ?? true,
    type: s.type,
    tags: s.tags ?? [],
    id: s.id,
    name: s.id,
    idType: s.idType ?? 'userID',
    description: s.description,
    ...audit(ctx, s.owner, 300, 20),
    targetApps: [],
    holdoutIDs: [],
    team: null,
    teamID: null,
    version: 4,
  };
  if (s.type === 'id_list') out.count = s.idList?.count ?? 0;
  if (s.type === 'rule_based') out.rules = (s.rules ?? []).map((r, i) => rule(ctx, `segment/${s.id}`, i, r, 'segment'));
  return out;
}

export interface GroupSeed {
  name: string;
  size: number;
  parameterValues: JsonObject;
  isControl?: boolean;
  description?: string;
}

export interface ExperimentSeed {
  id: string;
  description: string;
  hypothesis: string;
  owner: Person;
  idType?: string;
  tags?: string[];
  status: 'active' | 'setup' | 'decision_made' | 'abandoned' | 'archived';
  groups: GroupSeed[];
  allocation: number;
  layerID?: string | null;
  targetingGateID?: string | null;
  launchedGroup?: string;
  primaryMetrics?: { name: string; type: string }[];
  secondaryMetrics?: { name: string; type: string }[];
  startedDaysAgo?: number;
  endedDaysAgo?: number;
  decisionReason?: string;
  holdoutIDs?: string[];
  duration?: number;
}

export function groupId(ctx: BuildContext, expId: string, groupName: string): string {
  return pseudoId(`${ctx.project}/experiment/${expId}/group/${groupName}`);
}

export function experiment(ctx: BuildContext, s: ExperimentSeed): JsonObject {
  const day = 86_400_000;
  const started = s.status !== 'setup' ? ctx.now - (s.startedDaysAgo ?? 21) * day : null;
  const ended = s.endedDaysAgo !== undefined ? ctx.now - s.endedDaysAgo * day : null;
  const groups = s.groups.map((g, i) => ({
    name: g.name,
    id: groupId(ctx, s.id, g.name),
    size: g.size,
    parameterValues: g.parameterValues,
    disabled: false,
    description: g.description ?? '',
    isControl: g.isControl ?? i === 0,
    shipped: s.launchedGroup === g.name,
  }));
  const launched = s.launchedGroup ? groupId(ctx, s.id, s.launchedGroup) : null;
  return {
    reviewSettings: { requiredReview: false, allowedReviewers: null },
    id: s.id,
    name: s.id,
    idType: s.idType ?? 'userID',
    description: s.description,
    ...audit(ctx, s.owner, 60, 3),
    tags: s.tags ?? [],
    targetApps: [],
    holdoutIDs: s.holdoutIDs ?? [],
    team: null,
    teamID: null,
    version: 7,
    hypothesis: s.hypothesis,
    links: [],
    groups,
    controlGroupID: groups[0]?.id ?? '',
    allocation: s.allocation,
    primaryMetrics: s.primaryMetrics ?? [],
    secondaryMetrics: s.secondaryMetrics ?? [],
    duration: s.duration ?? 14,
    targetingGateID: s.targetingGateID ?? null,
    sequentialTesting: false,
    bonferroniCorrection: false,
    defaultConfidenceInterval: '95',
    status: s.status,
    launchedGroupID: launched,
    decisionReason: s.decisionReason ?? null,
    layerID: s.layerID ?? null,
    startTime: started,
    endTime: ended,
    decisionTime: s.status === 'decision_made' || s.status === 'abandoned' ? ended : null,
    healthCheckStatus: s.status === 'active' ? 'PASSED' : 'NOT_APPLIED',
    experimentType: 'BASE',
    isStale: false,
    owner: owner(s.owner),
    inlineTargetingRulesJSON: null,
    inlineTargetingRules: [],
    permalink: permalink(ctx, 'experiments', s.id),
    powerAnalyses: [],
    salt: pseudoUuid(`${ctx.project}/experiment/${s.id}/salt`),
  };
}

export interface LayerSeed {
  id: string;
  description: string;
  owner: Person;
  isImplicitLayer?: boolean;
  parameters: { name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; defaultValue: Json; description?: string }[];
}

export function layer(ctx: BuildContext, s: LayerSeed): JsonObject {
  return {
    id: s.id,
    name: s.id,
    idType: 'userID',
    description: s.description,
    ...audit(ctx, s.owner, 90, 5),
    tags: [],
    targetApps: [],
    holdoutIDs: [],
    team: null,
    teamID: null,
    version: 2,
    isImplicitLayer: s.isImplicitLayer ?? false,
    parameters: s.parameters.map((p) => ({ name: p.name, type: p.type, defaultValue: p.defaultValue, description: p.description ?? '', schema: null })),
    targeting_gate_parameter_values: [],
    holdout_parameter_values: [],
    permalink: permalink(ctx, 'layers', s.id),
  };
}

export interface HoldoutSeed {
  id: string;
  description: string;
  owner: Person;
  passPercentage: number;
  isGlobal?: boolean;
  gateIDs?: string[];
  experimentIDs?: string[];
  layerIDs?: string[];
}

export function holdout(ctx: BuildContext, s: HoldoutSeed): JsonObject {
  return {
    id: s.id,
    name: s.id,
    idType: 'userID',
    description: s.description,
    ...audit(ctx, s.owner, 180, 30),
    tags: [],
    targetApps: [],
    holdoutIDs: [],
    team: null,
    teamID: null,
    version: 3,
    permalink: permalink(ctx, 'holdouts', s.id),
    isEnabled: true,
    passPercentage: s.passPercentage,
    gateIDs: s.gateIDs ?? [],
    experimentIDs: s.experimentIDs ?? [],
    layerIDs: s.layerIDs ?? [],
    isGlobal: s.isGlobal ?? false,
    targetingGateID: null,
    monitoringMetrics: [],
  };
}

export interface AutotuneSeed {
  id: string;
  description: string;
  owner: Person;
  /** Absent = no success event (KNOWN-EDGE-CASES 11.11). */
  successEvent?: string;
  /** `size` defaults to an equal split rounded down (so three arms sum to 99, as StatSig does). */
  variants: { name: string; json: JsonObject; size?: number }[];
  isStarted: boolean;
  /** Name of the winning variant once StatSig concluded (11.10). */
  winner?: string;
  idType?: string;
  tags?: string[];
}

export function autotune(ctx: BuildContext, s: AutotuneSeed): JsonObject {
  const variantId = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return {
    description: s.description,
    variants: s.variants.map((v) => ({ name: v.name, json: v.json, size: v.size ?? Math.floor(100 / s.variants.length), id: variantId(v.name) })),
    successEvent: s.successEvent ?? '',
    successEventValue: '',
    explorationWindow: '24hr',
    attributionWindow: '1hr',
    winnerThreshold: '95%',
    inlineTargetingRulesJSON: null,
    inlineTargetingRules: [],
    id: s.id,
    name: s.id,
    idType: s.idType ?? 'userID',
    ...audit(ctx, s.owner, 40, 2),
    tags: s.tags ?? [],
    targetApps: [],
    holdoutIDs: [],
    team: null,
    teamID: null,
    version: 2,
    isStarted: s.isStarted,
    winner: s.winner ? { id: variantId(s.winner), name: s.winner } : null,
  };
}

export type MetricType = 'ratio' | 'sum' | 'composite' | 'mean' | 'event_count_custom' | 'event_user' | 'funnel';

export interface MetricSeed {
  name: string;
  type: MetricType;
  description: string;
  owner: Person;
  events?: string[];
  directionality?: 'increase' | 'decrease';
  /** Composite metrics: component metric names. */
  components?: { name: string; type: string }[];
  funnel?: string[];
  warehouseNative?: JsonObject;
  tags?: string[];
}

export function metric(ctx: BuildContext, s: MetricSeed): JsonObject {
  const out: JsonObject = {
    name: s.name,
    type: s.type,
    isVerified: true,
    isReadOnly: false,
    unitTypes: ['userID'],
    description: s.description,
    directionality: s.directionality ?? 'increase',
    tags: s.tags ?? [],
    isPermanent: false,
    team: null,
    teamID: null,
    id: `${s.name}::${s.type}`,
    isHidden: false,
    lineage: { events: s.events ?? [], metrics: (s.components ?? []).map((c) => c.name) },
    creatorName: s.owner.name,
    creatorEmail: s.owner.email,
    createdTime: ctx.now - 365 * 86_400_000,
    lastModifierID: s.owner.id,
    lastModifiedTime: ctx.now - 30 * 86_400_000,
    lastModifierEmail: s.owner.email,
    lastModifierName: s.owner.name,
    owner: owner(s.owner),
    permalink: permalink(ctx, 'metrics', `${s.name}::${s.type}`),
  };
  if (s.events) out.metricEvents = s.events.map((e) => ({ name: e, type: s.type === 'sum' || s.type === 'mean' ? 'value' : 'count', criteria: [] }));
  if (s.components) out.metricComponentMetrics = s.components;
  if (s.funnel) {
    out.funnelEventList = s.funnel.map((e) => ({ name: e, type: 'event_user' }));
    out.funnelCountDistinct = 'users';
  }
  if (s.warehouseNative) out.warehouseNative = s.warehouseNative;
  return out;
}

/** A StatSig prompt / AI Config (`/prompts`): the shell only, as the Console API lists it. */
export interface PromptSeed {
  id: string;
  description: string;
  owner: Person;
  team?: string;
  tags?: string[];
  targetApps?: string[];
  holdoutIDs?: string[];
  /** StatSig's version counter (how many versions exist). */
  version?: number;
}

/** A topline alert (`/alerts`). */
export interface AlertSeed {
  id: string;
  name: string;
  alertType: 'threshold' | 'change' | 'pct_change';
  metrics: string[];
  message: string;
  condition: 'greater' | 'greater_or_equal' | 'less' | 'less_or_equal' | 'equal' | 'not_equal';
  threshold: number;
  windowMs: number;
  owner: Person;
  team?: string;
  tags?: string[];
  /** Subscriber emails (users). */
  subscribers?: string[];
}

/** ExternalPromptDto (`/prompts`): the prompt shell. Versions have no read endpoint in the 20240601 spec. */
export function prompt(ctx: BuildContext, s: PromptSeed): JsonObject {
  return {
    id: s.id,
    name: s.id,
    idType: 'userID',
    description: s.description,
    lastModifierID: s.owner.id,
    lastModifiedTime: ctx.now - 9 * 86_400_000,
    lastModifierEmail: s.owner.email,
    lastModifierName: s.owner.name,
    creatorID: s.owner.id,
    createdTime: ctx.now - 120 * 86_400_000,
    creatorName: s.owner.name,
    creatorEmail: s.owner.email,
    tags: s.tags ?? [],
    targetApps: s.targetApps ?? [],
    holdoutIDs: s.holdoutIDs ?? [],
    team: s.team ?? null,
    teamID: s.team ? pseudoId(`${ctx.project}/team/${s.team}`) : null,
    version: s.version ?? 1,
  };
}

/** AlertSchemaDto (`/alerts`): a topline alert on one or more metrics. */
export function alert(ctx: BuildContext, s: AlertSeed): JsonObject {
  return {
    id: s.id,
    name: s.name,
    alertType: s.alertType,
    metrics: Object.fromEntries(s.metrics.map((m) => [m, { type: 'event_count_custom' }])),
    metricGroupBys: {},
    message: s.message,
    creatorID: s.owner.id,
    companyID: pseudoId(`company/${ctx.project}`),
    priority: 'P2',
    alertThreshold: s.threshold,
    windowMs: s.windowMs,
    evaluationDelayMs: 0,
    condition: s.condition,
    renotificationConditions: [],
    renotificationWindowMs: 0,
    team: s.team ?? null,
    owner: owner(s.owner),
    tags: s.tags ?? [],
    subscribers: (s.subscribers ?? [s.owner.email]).map((email) => ({ type: 'user', id: pseudoId(`person/${email}`) })),
  };
}

export function pseudoUuid(seed: string): string {
  const h = pseudoId(seed, 32).toLowerCase().replace(/[^0-9a-z]/g, '0');
  const hex = [...h].map((c) => (parseInt(c, 36) % 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

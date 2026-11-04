/**
 * Canonical, source-agnostic model of StatSig resources (PLAN §4).
 *
 * Both source adapters (Console API, config spec v1/v2) produce these types; the mapper, UI and
 * monitor only ever see this model. Vocabulary follows the StatSig Console API
 * (reference/statsig/console-api-openapi-20240601.json) because it is the richer, human-facing
 * one. Config-spec forms are normalized into it (PLAN §4.2 table).
 *
 * N-source ready: every object carries its `source`, and `uid` is unique across sources.
 */

/**
 * Where a source's data comes from. The two StatSig kinds fill the StatSig-vocabulary collections
 * below; `launchdarkly` (another LD project, PLAN §20) fills the neutral block (`neutral`).
 */
import type { NeutralProject } from './neutral.ts';

export type SourceKind = 'console_api' | 'config_spec' | 'launchdarkly';

export interface SourceRef {
  sourceId: string;
  sourceKind: SourceKind;
}

/** A StatSig project attached to a workspace. A workspace has 1 LD project and N of these (§3.6). */
export interface SourceDescriptor {
  id: string;
  /** Short alias used for consolidation prefixes and LD tags (`migration-src-<alias>`), e.g. `web`. */
  alias: string;
  label: string;
  kind: SourceKind;
  /** Console API sources: base URL (production: https://statsigapi.net/console/v1; demo: the mock). */
  baseUrl?: string;
  /** Spec sources: the StatSig `company_id` seen in the first upload (sanity check, §4.2). */
  companyId?: string;
  /**
   * LaunchDarkly sources (PLAN §20.2): which instance and project to read. `baseUrl` overrides the
   * instance origin (the demo's in-browser mock). The token is never stored here.
   */
  ld?: { instance: 'us' | 'eu' | 'federal'; projectKey: string; baseUrl?: string };
  isDemo?: boolean;
  /**
   * Console API sources: the entity kinds to read. Undefined means everything. Gates reference
   * segments, so a gate-only scope still usually wants `segment`.
   */
  resources?: EntityKind[];
  createdAt: string;
}

/**
 * Field groups an object may lack because of where it came from. The UI shows these as
 * "needs Console key" rather than hiding the feature (§4.2).
 */
export type FieldGroup =
  | 'description'
  | 'tags'
  | 'owner'
  | 'timestamps'
  | 'ruleNames'
  | 'lifecycle'
  | 'checks'
  | 'targetAppNames'
  | 'idListMembers'
  | 'metrics'
  | 'hypothesis'
  | 'salts'
  | 'archived';

export interface Completeness {
  /** Field groups that are absent from this object's source. Empty = complete. */
  missing: FieldGroup[];
}

export type EntityKind =
  | 'gate'
  | 'config'
  | 'segment'
  | 'experiment'
  | 'layer'
  | 'holdout'
  | 'autotune'
  | 'metric'
  | 'param_store'
  /** StatSig prompt / AI Config (Console `/prompts`); becomes an LD AI Config. */
  | 'prompt';

export interface Owner {
  id?: string;
  type?: string;
  name?: string;
  email?: string;
}

interface EntityBase {
  kind: EntityKind;
  /** Unique across all sources in a workspace: `<sourceId>/<kind>/<id>`. */
  uid: string;
  /** StatSig ID. For most resources this is the name used in SDK calls. */
  id: string;
  /** Display name; equals `id` when the source has no display name. */
  name: string;
  source: SourceRef;
  completeness: Completeness;
  description?: string;
  tags: string[];
  owner?: Owner;
  team?: string | null;
  createdTime?: number;
  lastModifiedTime?: number | null;
  /** StatSig version counter (Console `version`, spec `version` in v2). */
  version?: number;
  permalink?: string;
  archived: boolean;
  targetApps: string[];
}

// ---------------------------------------------------------------------------------------------
// Conditions and rules
// ---------------------------------------------------------------------------------------------

/** Canonical condition types: the Console API vocabulary, plus forms only the spec has. */
export const CONDITION_TYPES = [
  'public',
  'user_id',
  'email',
  'ip_address',
  'locale',
  'app_version',
  'country',
  'custom_field',
  'browser_name',
  'browser_version',
  'os_name',
  'os_version',
  'device_model',
  'user_agent',
  'environment_tier',
  'passes_gate',
  'fails_gate',
  'passes_segment',
  'fails_segment',
  'time',
  'unit_id',
  'target_app',
  'javascript',
  'experiment_group',
  'url',
  /** Spec-only: experiment/layer bucketing; consumed when reconstructing allocations (§4.2). */
  'user_bucket',
  /** Anything a source sent that we don't recognize. Never dropped: it becomes a decision (§8). */
  'unknown',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const OPERATORS = [
  'any',
  'none',
  'any_case_sensitive',
  'none_case_sensitive',
  'str_contains_any',
  'str_contains_none',
  'str_starts_with_any',
  'str_ends_with_any',
  'str_matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
  'version_gt',
  'version_gte',
  'version_lt',
  'version_lte',
  'version_eq',
  'version_neq',
  'before',
  'after',
  'on',
  'is_null',
  'is_not_null',
  'encoded_any',
  'array_contains_any',
  'array_contains_none',
  'array_contains_all',
  'not_array_contains_all',
  'in_segment_list',
  'not_in_segment_list',
] as const;
export type Operator = (typeof OPERATORS)[number];

/** How StatSig derives a value when the SDK user doesn't supply it (relevant to `derived_attribute`). */
export type DerivedFrom = 'ip' | 'user_agent';

export interface Condition {
  type: ConditionType;
  /** Unknown operators are kept verbatim as strings so nothing is silently lost. */
  operator: Operator | string | null;
  targetValue: unknown;
  /** `custom_field` attribute name. */
  field?: string | null;
  /** `unit_id` condition: the custom unit type (e.g. `companyID`). */
  customID?: string | null;
  derivedFrom?: DerivedFrom;
  /** The exact source JSON, used as DecisionPoint.sourceFragment (§8.1). */
  raw: unknown;
}

export interface RuleVariant {
  id?: string;
  name: string;
  /** Percent (0–100) of the rule's passing units that get this variant. */
  passPercentage: number;
  returnValue: unknown;
}

export interface Rule {
  id: string;
  baseId?: string;
  /** Human-readable on the Console API; an opaque ID on spec sources. */
  name: string;
  /** 0–100. Of the units matching the conditions, the share that pass. */
  passPercentage: number;
  /** ANDed. */
  conditions: Condition[];
  /**
   * Console API: environments this rule is enabled for; `null` means all. Spec sources encode
   * environment scoping as `environment_tier` conditions instead, so this is always `null` there.
   */
  environments: string[] | null;
  /** Configs: value served on pass. Gates: `true`. */
  returnValue?: unknown;
  variants?: RuleVariant[];
  /** Unit type the pass percentage buckets on. */
  idType: string;
  salt?: string;
}

/** Forced values for specific IDs. */
export interface Override {
  /** `userID` or a custom unit type. */
  unitType: string;
  ids: string[];
  /** Gates: pass/fail. Experiments: the forced group. Configs (spec sources only): the forced value. */
  value: { kind: 'gate'; pass: boolean } | { kind: 'group'; groupId?: string; groupName?: string } | { kind: 'value'; returnValue: unknown };
  /** `null` = all environments. */
  environment: string | null;
}

export type GateStatus = 'In Progress' | 'Launched' | 'Disabled' | 'Archived';

export interface Lifecycle {
  type?: string;
  typeReason?: string;
}

/**
 * Recent traffic a Console API source reports for a gate or config (PLAN §14 "StatSig side"):
 * `/exposure_count` (`pastDay` / `past7Days`, every environment together) and, for gates with no
 * exposures, `/gates/{id}/checks`. Null = the route was not readable; absent = not a Console source.
 * Exposure counts come from SDK exposure events, so a gate checked with exposure logging off
 * can look unused while it is not: the production-checks flag is the second opinion.
 */
export interface Usage {
  /** Exposure events in the past 24 hours, all environments. */
  exposuresPastDay: number | null;
  /** Exposure events in the past 7 days, all environments. */
  exposuresPast7Days: number | null;
  /** `has_production_checks_in_last_7_days`; read only when the 7-day exposure count is 0 (gates only). */
  productionChecksPast7Days?: boolean | null;
}

export interface Gate extends EntityBase {
  kind: 'gate';
  enabled: boolean;
  idType: string;
  rules: Rule[];
  overrides: Override[];
  status?: GateStatus;
  lifecycle?: Lifecycle;
  checksPerHour?: number | null;
  usage?: Usage;
  holdoutIds: string[];
  salt?: string;
}

export interface Config extends EntityBase {
  kind: 'config';
  enabled: boolean;
  idType: string;
  defaultValue: unknown;
  rules: Rule[];
  overrides: Override[];
  /** JSON Schema (string) that rule values must satisfy, if any. */
  schema?: string | null;
  lifecycle?: Lifecycle;
  checksPerHour?: number | null;
  usage?: Usage;
  holdoutIds: string[];
  salt?: string;
}

export type SegmentType = 'rule_based' | 'id_list' | 'analysis_list' | 'user_store_id_list';

export interface IdListContents {
  /** Number of IDs, when known. */
  count?: number;
  /** Plaintext IDs: Console API lists and small inline spec lists. */
  ids?: string[];
  /**
   * Spec-only large lists: StatSig ships them only as hashes (first 8 chars of
   * base64(sha256(id))), behind get_id_lists. Reconciliation needs a raw-ID CSV (§4.2).
   */
  hashed?: { listName: string; hashes?: string[] };
}

export interface Segment extends EntityBase {
  kind: 'segment';
  segmentType: SegmentType;
  enabled: boolean;
  idType: string;
  rules: Rule[];
  idList?: IdListContents;
}

export type ExperimentStatus =
  | 'setup'
  | 'active'
  | 'decision_made'
  | 'abandoned'
  | 'archived'
  | 'experiment_stopped'
  | 'assignment_stopped';

export interface ExperimentGroup {
  id?: string;
  name: string;
  /** Percent of the experiment's allocation (0–100). */
  size: number;
  parameterValues: Record<string, unknown>;
  isControl?: boolean;
}

export interface MetricRef {
  name: string;
  type: string;
}

export interface Experiment extends EntityBase {
  kind: 'experiment';
  status: ExperimentStatus;
  idType: string;
  groups: ExperimentGroup[];
  /** Percent of the layer (or of all units) allocated (0–100). */
  allocation: number;
  layerId: string | null;
  targetingGateId: string | null;
  launchedGroupId: string | null;
  hypothesis?: string;
  primaryMetrics: MetricRef[];
  secondaryMetrics: MetricRef[];
  overrides: Override[];
  /** Inline targeting rules (Console `inlineTargetingRules`). */
  targetingRules: Rule[];
  holdoutIds: string[];
  salt?: string;
}

export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface LayerParameter {
  name: string;
  type?: ParamType;
  defaultValue: unknown;
}

export interface Layer extends EntityBase {
  kind: 'layer';
  idType: string;
  isImplicit: boolean;
  parameters: LayerParameter[];
  experimentIds: string[];
  holdoutIds: string[];
}

export interface Holdout extends EntityBase {
  kind: 'holdout';
  enabled: boolean;
  idType: string;
  /** Percent held out (0–100). */
  passPercentage: number;
  isGlobal: boolean;
  gateIds: string[];
  experimentIds: string[];
  layerIds: string[];
  targetingGateId: string | null;
}

export interface AutotuneVariant {
  id: string;
  name: string;
  json: unknown;
  size?: number;
}

export interface Autotune extends EntityBase {
  kind: 'autotune';
  idType: string;
  variants: AutotuneVariant[];
  successEvent?: string;
  isStarted: boolean;
  winner: { id: string; name: string } | null;
}

export interface Metric extends EntityBase {
  kind: 'metric';
  metricType: string;
  /** Raw StatSig definition; metric conversion is M6. */
  definition: unknown;
  isWarehouseNative: boolean;
}

export interface ParamStoreParameter {
  name: string;
  refType: string;
  paramType: string;
  value?: unknown;
  /** For gate/experiment/config-backed params: the referenced entity. */
  ref?: { kind: 'gate' | 'config' | 'experiment' | 'layer'; id: string; param?: string };
  raw: unknown;
}

export interface ParamStore extends EntityBase {
  kind: 'param_store';
  parameters: ParamStoreParameter[];
}

/**
 * A StatSig prompt ("AI Config" in newer StatSig UIs). The Console API (20240601) exposes only the
 * shell: name, description, tags, owner, team, target apps and a version counter. The prompt
 * versions themselves (messages, model, parameters) have no read endpoint, so they are not here.
 */
export interface Prompt extends EntityBase {
  kind: 'prompt';
  idType: string;
  holdoutIds: string[];
}

export type Entity = Gate | Config | Segment | Experiment | Layer | Holdout | Autotune | Metric | ParamStore | Prompt;

// ---------------------------------------------------------------------------------------------
// Project-level resources
// ---------------------------------------------------------------------------------------------

export interface Environment {
  /** The tier name rules refer to, e.g. `production`. */
  name: string;
  id?: string;
  isProduction?: boolean;
  /** StatSig "requires review" on this environment: changes need a reviewer (→ LD approvals). */
  requiresReview?: boolean;
  /** Spec sources infer environments; the user confirms them during setup (§4.2). */
  inferred: boolean;
}

/** A StatSig team (Console `/users/teams`). Members are emails, read from the team detail when permitted. */
export interface StatsigTeam {
  id: string;
  name: string;
  description?: string;
  /** Lower-cased member emails; absent when the detail endpoint was not readable. */
  memberEmails?: string[];
}

/** Project-wide review settings (Console `/settings/reviews`). */
export interface ReviewSettings {
  configReviewRequired?: boolean;
  metricReviewRequired?: boolean;
}

/** Project settings (Console `/settings/project`). */
export interface ProjectSettings {
  /** Default unit ID type for new gates, experiments and metrics (→ LD default randomization unit). */
  defaultUnitType?: string;
  visibility?: string;
}

/** A topline alert (Console `/alerts`): a metric threshold that notifies people. LD has no equivalent; listed for the cut-over checklist. */
export interface Alert {
  id: string;
  name: string;
  alertType?: string;
  message?: string;
  /** Metric names the alert watches. */
  metrics: string[];
  condition?: string;
  threshold?: number;
  windowMs?: number;
  team?: string;
  owner?: Owner;
  tags: string[];
  subscribers: number;
}

export interface UnitType {
  name: string;
  description?: string;
}

export interface Tag {
  name: string;
  description?: string;
}

export interface TargetApp {
  id: string;
  name?: string;
}

export interface StatsigUser {
  id?: string;
  email: string;
  name?: string;
  role?: string;
}

export interface SnapshotWarning {
  code:
    | 'schema_mismatch'
    | 'partial_spec'
    | 'unknown_condition'
    | 'unknown_entity'
    | 'unresolved_reference'
    | 'fetch_skipped'
    | 'ambiguous_override';
  message: string;
  path?: string;
}

/** Everything read from one source at one point in time. Immutable once taken (§4.2). */
export interface CanonicalSnapshot {
  schemaVersion: 1;
  source: SourceRef & { alias: string };
  takenAt: string;
  /** Source-native freshness marker: spec `time`, or max lastModifiedTime for the Console API. */
  sourceTime?: number;
  companyId?: string;
  projectName?: string;
  isWarehouseNative?: boolean;
  environments: Environment[];
  unitTypes: UnitType[];
  tags: Tag[];
  targetApps: TargetApp[];
  users: StatsigUser[];
  gates: Gate[];
  configs: Config[];
  segments: Segment[];
  experiments: Experiment[];
  layers: Layer[];
  holdouts: Holdout[];
  autotunes: Autotune[];
  metrics: Metric[];
  paramStores: ParamStore[];
  /** Optional on the type because snapshots taken before 2026-11-02 lack them; read with `?? []`. */
  prompts?: Prompt[];
  teams?: StatsigTeam[];
  alerts?: Alert[];
  reviews?: ReviewSettings;
  settings?: ProjectSettings;
  /**
   * Provider-neutral resources (PLAN §20.1): filled by the LaunchDarkly source adapter; absent on
   * StatSig sources until they move onto the neutral model too.
   */
  neutral?: NeutralProject;
  /** Source-level completeness (what this source kind can never provide). */
  completeness: Completeness;
  warnings: SnapshotWarning[];
}

export function entityUid(sourceId: string, kind: EntityKind, id: string): string {
  return `${sourceId}/${kind}/${id}`;
}

export function emptySnapshot(source: CanonicalSnapshot['source'], takenAt: string): CanonicalSnapshot {
  return {
    schemaVersion: 1,
    source,
    takenAt,
    environments: [],
    unitTypes: [],
    tags: [],
    targetApps: [],
    users: [],
    gates: [],
    configs: [],
    segments: [],
    experiments: [],
    layers: [],
    holdouts: [],
    autotunes: [],
    metrics: [],
    paramStores: [],
    prompts: [],
    teams: [],
    alerts: [],
    completeness: { missing: [] },
    warnings: [],
  };
}

/** Field groups a config-spec source can never provide (§4.2 "What the config spec is missing"). */
export const SPEC_MISSING_FIELDS: FieldGroup[] = [
  'description',
  'tags',
  'owner',
  'timestamps',
  'ruleNames',
  'lifecycle',
  'checks',
  'targetAppNames',
  'metrics',
  'hypothesis',
  'archived',
];

/** Field groups the Console API doesn't give us (salts live only in the spec, §4.2 "Hybrid source"). */
export const CONSOLE_MISSING_FIELDS: FieldGroup[] = ['salts'];

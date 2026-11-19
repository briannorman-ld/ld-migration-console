/**
 * The provider-neutral core (PLAN §20.1): the flag-platform concepts every source has, in
 * LD-shaped vocabulary because LaunchDarkly is the target and the richest of the sources.
 *
 * The LaunchDarkly source adapter (PLAN §20) and the PostHog adapter (PLAN §22) emit it
 * (`CanonicalSnapshot.neutral`); the StatSig adapters still fill the StatSig-vocabulary
 * collections of the snapshot. Step 2 moves them onto this model too (PLAN §20.1 "How it plugs
 * in"). Field names follow reference/launchdarkly/openapi.json (Clause, Rule, Rollout, Target,
 * UserSegmentRule). The optional fields marked "PLAN §21.4 / §22.4" carry what other platforms
 * have and LD does not; an LD source never sets them, so its mapping stays an identity.
 */

/** One `{ uid, id, name }` style identity for neutral resources: `<sourceId>/<kind>/<key>`. */
export type NeutralKind = 'flag' | 'segment' | 'metric' | 'metric_group' | 'experiment' | 'holdout' | 'layer';

export function neutralUid(sourceId: string, kind: NeutralKind, key: string): string {
  return `${sourceId}/${kind}/${key}`;
}

export interface NeutralClause {
  /** Context kind the attribute belongs to; `user` when the source has no kinds. */
  contextKind: string;
  attribute: string;
  /** The source's operator name, LD spelling (`in`, `semVerLessThan`, `segmentMatch`, …). Unknown names are kept verbatim. */
  op: string;
  values: unknown[];
  negate: boolean;
  /**
   * The source compares case-insensitively (StatSig `any`, PostHog `exact` / `icontains`,
   * GrowthBook `$ini`); LD's operators do not, so the mapper raises `case_insensitive_match`.
   */
  caseInsensitive?: boolean;
}

/** Weights are thousandths of a percent (0–100000), as in LD `WeightedVariation`. */
export interface NeutralRollout {
  contextKind: string;
  /** Attribute to bucket by instead of the context key. */
  bucketBy?: string;
  variations: { variation: number; weight: number }[];
}

/** Exactly one of `variation` (index into the flag's variations) or `rollout`. */
export interface NeutralServe {
  variation?: number;
  rollout?: NeutralRollout;
}

export interface NeutralRule extends NeutralServe {
  /** Source rule id, when it has one (kept for decision paths and diffs). */
  id?: string;
  description: string;
  clauses: NeutralClause[];
  /** A rule the source keeps but does not evaluate. */
  disabled?: boolean;
  /** The source records evaluation events for this rule (experimentation); not a targeting concern. */
  trackEvents?: boolean;
  /**
   * PLAN §21.4: the share (0–1) of matched contexts the rule applies to; the rest fall through to
   * the *next* rule (GrowthBook `coverage`, PostHog set `rollout_percentage`). Absent means 1.
   */
  coverage?: number;
  /** PLAN §21.4: the rule is an experiment allocation, not a plain rollout (weights stay in `rollout`). */
  experiment?: { key: string; sticky?: boolean; namespace?: { id: string; range: [number, number] } };
  /**
   * PLAN §22.3: prerequisites that gate this rule only (GrowthBook rule `prerequisites`, PostHog
   * `flag_evaluates_to` filters). LD prerequisites are flag-level, so the mapper decides (`rule_prerequisite`).
   */
  prerequisites?: NeutralPrerequisite[];
}

export interface NeutralTarget {
  contextKind: string;
  variation: number;
  values: string[];
}

export interface NeutralPrerequisite {
  /** Key of the prerequisite flag in the source project. */
  key: string;
  variation: number;
}

/** One environment's targeting of a flag. */
export interface NeutralFlagEnv {
  /** Source environment key. */
  env: string;
  on: boolean;
  offVariation: number;
  fallthrough: NeutralServe;
  rules: NeutralRule[];
  targets: NeutralTarget[];
  prerequisites: NeutralPrerequisite[];
  trackEvents?: boolean;
  /** Source-side version counter of this environment's config, when the source has one. */
  version?: number;
  lastModified?: number;
}

export interface NeutralVariation {
  value: unknown;
  name?: string;
  description?: string;
  /**
   * PLAN §22.3: a payload the source serves next to the value (PostHog `payloads`). LD has one
   * value per variation, so the mapper raises `variant_payloads`.
   */
  payload?: unknown;
  /**
   * PLAN §22.3: the source has no such variation; the adapter added it to stand for the source's
   * "no value" result (PostHog multivariate flags return `false` when no set matches). The mapper
   * raises `multivariate_no_match`.
   */
  synthetic?: 'no_match';
}

/**
 * One pending scheduled change in the source (PostHog `ScheduledChange`, PLAN §22.3). `at`,
 * `operation` and `recurring` are always set; the typed fields are set when the adapter could
 * translate the payload, so the mapper can carry the change as an LD scheduled change:
 * - `on`: a status flip (`update_status`);
 * - `rules`: condition sets the change appends to the flag's targeting (`add_release_condition`),
 *   translated like the flag's own rules (variation indexes into the flag's variations);
 * - `variants`: a new variant split (`update_variants`), kept as a note only.
 * A change with none of them (an unknown operation, or a payload the adapter could not read) is
 * noted, never scheduled.
 */
export interface NeutralScheduledChange {
  /** ISO instant the source applies the change (empty when the source gave none). */
  at: string;
  /** The source's operation name, verbatim. */
  operation: string;
  /** A cron or interval schedule; LD scheduled changes are one-off. */
  recurring: boolean;
  on?: boolean;
  rules?: NeutralRule[];
  /** Weights in thousandths of a percent, as in `NeutralRollout`. */
  variants?: { key: string; weight: number }[];
}

/**
 * Facts about a flag or segment that LD has no field for and the mapper must surface as a
 * decision or note (PLAN §22.3). Adapters emit them; the mapper owns the wording and the options.
 */
export type NeutralCaveat =
  /** The source persists the pre-login assignment to the identified person (PostHog experience continuity). */
  | { kind: 'experience_continuity' }
  /**
   * Early-access opt-in overrides every rule through a person attribute. `name`, `description` and
   * `documentationUrl` come from the source's early-access feature definition when it was read.
   */
  | { kind: 'early_access_enrollment'; detail: { attribute: string; stage?: string; name?: string; description?: string; documentationUrl?: string } }
  /** Rollouts bucket by an attribute other than the context key (PostHog `bucketing_identifier: device_id`). */
  | { kind: 'device_bucketing'; detail: { attribute: string } }
  /** The flag evaluates only for requests that pass these contexts (PostHog `evaluation_contexts`). */
  | { kind: 'evaluation_contexts'; detail: { contexts: string[] } }
  /** Payloads are stored encrypted in the source; `readable` says whether this read decrypted them. */
  | { kind: 'encrypted_payload'; detail: { readable: boolean } }
  /** A holdout excludes a share of contexts before the rules run. */
  | { kind: 'holdout'; detail: { id: string; percentage: number } }
  /** Pending scheduled changes in the source (see `NeutralScheduledChange`). */
  | { kind: 'scheduled_changes'; detail: { changes: NeutralScheduledChange[] } }
  /** The source hashes rollouts without a per-flag salt, so equal percentages pick the same contexts across flags. */
  | { kind: 'unsalted_rollout' }
  /** The flag always serves one static payload (PostHog remote config). */
  | { kind: 'remote_config' }
  /** A list segment whose members had several ids each; all of them were included. */
  | { kind: 'multi_id_members'; detail: { persons: number; ids: number } }
  /** The membership was computed by the source (behavioral or realtime cohort) and frozen into a list at read time. */
  | { kind: 'frozen_membership'; detail: { cohortType: string; count: number } }
  /** The source could not give the membership of a list segment (route closed, or not in a payload). */
  | { kind: 'membership_unreadable'; detail: { reason: string } };

export interface NeutralCustomProperty {
  name: string;
  value: string[];
}

export interface NeutralFlag {
  kind: 'flag';
  /** `<sourceId>/flag/<key>`. */
  uid: string;
  /** The flag key in the source project. */
  key: string;
  name: string;
  description: string;
  flagKind: 'boolean' | 'multivariate';
  variations: NeutralVariation[];
  tags: string[];
  temporary: boolean;
  archived: boolean;
  /** Non-targeting purpose the source marks the flag with (`migration`, `holdout`, …); such flags do not copy as plain flags. */
  purpose?: string;
  deprecated?: boolean;
  clientSideAvailability?: { usingEnvironmentId: boolean; usingMobileKey: boolean };
  defaults?: { onVariation: number; offVariation: number };
  customProperties: Record<string, NeutralCustomProperty>;
  maintainer?: { id?: string; email?: string; teamKey?: string };
  /**
   * Experiments the source runs on this flag; keys or names. An LD source also reads them in full
   * (`NeutralProject.experiments`, PLAN §20.5); other sources only note them (PLAN §11).
   */
  experiments: string[];
  /** Project-level version counter, when the source has one. */
  version?: number;
  creationDate?: number;
  /** Per source environment. Every environment of the source appears, even when off and empty. */
  environments: NeutralFlagEnv[];
  /** PLAN §22.3: source facts the mapper must decide on or note. */
  caveats?: NeutralCaveat[];
}

export interface NeutralSegmentRule {
  id?: string;
  description: string;
  clauses: NeutralClause[];
  /** Thousandths of a percent; omitted = everyone matching the clauses. */
  weight?: number;
  rolloutContextKind?: string;
  bucketBy?: string;
}

export interface NeutralSegmentEnv {
  env: string;
  rules: NeutralSegmentRule[];
  /** Included / excluded keys per context kind (`user` entries hold what LD keeps in `included` / `excluded`). */
  included: { contextKind: string; values: string[] }[];
  excluded: { contextKind: string; values: string[] }[];
  /** Big segment: membership lives in the source's store and is not readable in bulk. */
  unbounded?: { contextKind: string };
  version?: number;
  lastModified?: number;
}

/** Segments are per environment in LD; a neutral segment groups the environments that share one key. */
export interface NeutralSegment {
  kind: 'segment';
  /** `<sourceId>/segment/<key>`. */
  uid: string;
  key: string;
  name: string;
  description: string;
  tags: string[];
  archived: boolean;
  environments: NeutralSegmentEnv[];
  /** PLAN §22.3: source facts the mapper must decide on or note. */
  caveats?: NeutralCaveat[];
}

/** PLAN §21.4: an attribute the source declares (its property schema), for typing clause values and the explorer. */
export interface NeutralAttribute {
  name: string;
  /** Context kind the attribute belongs to (`user` for person properties). */
  contextKind: string;
  type?: 'string' | 'number' | 'boolean' | 'datetime' | 'unknown';
  /** The source hashes or targets by this attribute (an identifier). */
  identifier?: boolean;
}

export interface NeutralContextKind {
  key: string;
  name?: string;
  description?: string;
  archived?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Experimentation (PLAN §20.5): metrics, metric groups, experiments, holdouts and layers of an LD
// source. LD-shaped (reference/launchdarkly/openapi.json MetricRep, MetricGroupRep, Experiment,
// IterationRep, HoldoutRep, LayerRep) with the account-specific ids resolved to keys and indexes:
// a treatment names a flag *variation index*, an experiment's flag names a *source rule id*, a
// holdout is referenced by *key*. Results, exposures and iteration history cannot be written
// into another project, so an iteration carries its design and its outcome, not its data.
// ---------------------------------------------------------------------------------------------

/** A person the source names as a maintainer; the id belongs to the source account, the email is what the target can match. */
export interface NeutralMaintainer {
  id?: string;
  email?: string;
  teamKey?: string;
}

/** An LD event filter (MetricRep.filters / EventFilter), kept as the source gave it. */
export interface NeutralMetricFilter {
  type: string;
  attribute?: string;
  op: string;
  values: unknown[];
  contextKind?: string;
  negate: boolean;
}

/** A metric (MetricRep). Every field LD's MetricPost accepts is carried, so the copy is an identity where the target allows it. */
export interface NeutralMetric {
  kind: 'metric';
  /** `<sourceId>/metric/<key>`. */
  uid: string;
  key: string;
  name: string;
  description: string;
  /** `pageview`, `click`, `custom` or `trace`; unknown kinds are kept verbatim and the mapper decides. */
  metricKind: string;
  tags: string[];
  archived: boolean;
  maintainer?: NeutralMaintainer;
  isNumeric?: boolean;
  unit?: string;
  /** Custom metrics: the event name the SDK sends. */
  eventKey?: string;
  /** Click metrics: the CSS selector. */
  selector?: string;
  /** Click and pageview metrics: URL matchers (UrlMatchers), kept as given. */
  urls?: unknown[];
  successCriteria?: 'HigherThanBaseline' | 'LowerThanBaseline' | string;
  /** Context kinds the metric can be analyzed by (`analysisUnits`, or the deprecated `randomizationUnits`). */
  analysisUnits: string[];
  unitAggregationType?: string;
  analysisType?: string;
  percentileValue?: number;
  eventDefault?: { disabled?: boolean; value?: number };
  filters?: NeutralMetricFilter;
  /** Warehouse-native metric: the data source it reads from (must exist in the target, PLAN §11). */
  dataSource?: { key: string; environmentKey?: string; name?: string; integrationKey?: string };
  windowStartOffset?: number;
  windowEndOffset?: number;
  winsorLowerPercentile?: number;
  winsorUpperPercentile?: number;
  winsorIncludeImputed?: boolean;
  traceQuery?: string;
  traceValueLocation?: string;
  unitAggregationField?: string;
  valueColumn?: string;
  /** Ratio metric denominator (MetricDenominatorRep), kept as given. */
  denominator?: Record<string, unknown>;
  creationDate?: number;
  lastModified?: number;
  version?: number;
}

/** A metric group (MetricGroupRep): an ordered funnel or a standard group of metrics. */
export interface NeutralMetricGroup {
  kind: 'metric_group';
  /** `<sourceId>/metric_group/<key>`. */
  uid: string;
  key: string;
  name: string;
  description: string;
  groupKind: 'funnel' | 'standard' | string;
  tags: string[];
  archived: boolean;
  maintainer?: NeutralMaintainer;
  /** Ordered; `nameInGroup` is the step name of a funnel. */
  metrics: { key: string; nameInGroup: string }[];
  creationDate?: number;
  lastModified?: number;
  version?: number;
}

/** One arm of an iteration (TreatmentRep). `variation` indexes the flag's variations in the source. */
export interface NeutralTreatment {
  id?: string;
  name: string;
  baseline: boolean;
  /** LD's percent string ("33.34"). */
  allocationPercent: string;
  parameters: { flagKey: string; variation: number }[];
}

/** A metric or metric group an iteration measures (DependentMetricOrMetricGroupRep). */
export interface NeutralIterationMetric {
  key: string;
  isGroup: boolean;
  analysisUnit?: string;
}

/** The flag an iteration runs on (IterationRep.flags[key]). `ruleId` is `fallthrough` or a source rule id. */
export interface NeutralIterationFlag {
  flagKey: string;
  ruleId: string;
  ruleDescription?: string;
  flagConfigVersion?: number;
  /** Index into the flag's variations in the source: what contexts outside the experiment get. */
  notInExperimentVariation?: number;
}

/** One iteration of an experiment (IterationRep): the design, and how it ended. */
export interface NeutralIteration {
  id?: string;
  hypothesis: string;
  status: 'not_started' | 'running' | 'stopped' | string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  winningTreatment?: { id?: string; name?: string };
  winningReason?: string;
  canReshuffleTraffic?: boolean;
  randomizationUnit: string;
  attributes?: string[];
  /** Bandits only. */
  reallocationFrequencyMillis?: number;
  treatments: NeutralTreatment[];
  metrics: NeutralIterationMetric[];
  /** The primary metric or funnel. */
  primary?: { key: string; isGroup: boolean };
  flags: NeutralIterationFlag[];
  /** Layer membership LD records when an iteration in a layer stops. */
  layerSnapshot?: { key: string; name?: string; reservationPercent: number; otherReservationPercent?: number };
}

/** An experiment in one source environment (Experiment). */
export interface NeutralExperimentEnv {
  env: string;
  id?: string;
  name: string;
  description: string;
  /** `experiment`, `mab` or `holdout` (the base experiment of a holdout). */
  experimentType: string;
  tags: string[];
  archived: boolean;
  maintainer?: NeutralMaintainer;
  methodology?: string;
  analysisConfig?: { bayesianThreshold?: string; significanceThreshold?: string; testDirection?: string; multipleComparisonCorrectionMethod?: string; multipleComparisonCorrectionScope?: string; sequentialTestingEnabled?: boolean };
  /** `launchdarkly` (events) or a warehouse. */
  dataSource?: string;
  /** The holdout the experiment belongs to, by key when the adapter could resolve the id. */
  holdout?: { id: string; key?: string };
  currentIteration?: NeutralIteration;
  draftIteration?: NeutralIteration;
  previousIterations: NeutralIteration[];
  /** The layer the experiment is reserved in, from the source's layer list. */
  layer?: { key: string; reservationPercent: number };
  creationDate?: number;
}

/** Experiments are per environment in LD; a neutral experiment groups the environments that share one key. */
export interface NeutralExperiment {
  kind: 'experiment';
  /** `<sourceId>/experiment/<key>`. */
  uid: string;
  key: string;
  /** The first environment's name, description and tags; the rest are per environment. */
  name: string;
  description: string;
  tags: string[];
  /** Archived in every environment it exists in. */
  archived: boolean;
  environments: NeutralExperimentEnv[];
}

/** A holdout in one source environment (HoldoutRep + its base experiment). */
export interface NeutralHoldoutEnv {
  env: string;
  id?: string;
  name: string;
  description: string;
  /** `created`, `enabled`, `running` or `ended`. */
  status: string;
  /** LD's percent string ("10"). */
  holdoutAmount: string;
  randomizationUnit: string;
  attributes?: string[];
  metrics: NeutralIterationMetric[];
  primaryMetricKey?: string;
  prerequisiteFlagKey?: string;
  maintainer?: NeutralMaintainer;
  /** Keys of the experiments attached to the holdout. */
  experiments: string[];
  createdAt?: number;
}

export interface NeutralHoldout {
  kind: 'holdout';
  /** `<sourceId>/holdout/<key>`. */
  uid: string;
  key: string;
  name: string;
  description: string;
  /** Ended in every environment: nothing to create. */
  archived: boolean;
  environments: NeutralHoldoutEnv[];
}

/** A layer (LayerRep): project-level, with per-environment reservations. */
export interface NeutralLayer {
  kind: 'layer';
  /** `<sourceId>/layer/<key>`. */
  uid: string;
  key: string;
  name: string;
  description: string;
  randomizationUnit?: string;
  archived: false;
  environments: { env: string; reservations: { experimentKey: string; flagKey: string; reservationPercent: number }[] }[];
  createdAt?: number;
}

/** The neutral block of a snapshot (PLAN §20.1 "How it plugs in"). */
export interface NeutralProject {
  flags: NeutralFlag[];
  segments: NeutralSegment[];
  contextKinds: NeutralContextKind[];
  /** PLAN §21.4: the source's attribute schema, when it has one. */
  attributes?: NeutralAttribute[];
  /** PLAN §20.5: experimentation resources of an LD source. Absent on snapshots taken before 2026-11-19 and on sources that do not read them. */
  metrics?: NeutralMetric[];
  metricGroups?: NeutralMetricGroup[];
  experiments?: NeutralExperiment[];
  holdouts?: NeutralHoldout[];
  layers?: NeutralLayer[];
}

export function emptyNeutralProject(): NeutralProject {
  return { flags: [], segments: [], contextKinds: [] };
}

/** The flag's targeting in one source environment, or an "off, nothing" config when the source has none for it. */
export function neutralEnvOf(flag: NeutralFlag, env: string): NeutralFlagEnv | undefined {
  return flag.environments.find((e) => e.env === env);
}

export function neutralSegmentEnvOf(seg: NeutralSegment, env: string): NeutralSegmentEnv | undefined {
  return seg.environments.find((e) => e.env === env);
}

export function neutralExperimentEnvOf(x: NeutralExperiment, env: string): NeutralExperimentEnv | undefined {
  return x.environments.find((e) => e.env === env);
}

export function neutralHoldoutEnvOf(h: NeutralHoldout, env: string): NeutralHoldoutEnv | undefined {
  return h.environments.find((e) => e.env === env);
}

/**
 * The iteration a copy of the experiment is designed from (PLAN §20.5): the draft when there is one
 * (a not-started experiment), else the current iteration (running or stopped), else the last
 * previous one. `undefined` for an experiment that never had an iteration.
 */
export function neutralDesignIteration(x: NeutralExperimentEnv): NeutralIteration | undefined {
  return x.draftIteration ?? x.currentIteration ?? x.previousIterations[x.previousIterations.length - 1];
}

/** Provenance tags and properties an earlier migration wrote into the *source* project; never copied onward. */
export const PROVENANCE_TAG_RE = /^(migrated-from-|migration-src-|statsig-migrated$|statsig-src-)/;
export const PROVENANCE_PROPERTY_RE = /^(migration|statsig)\./;

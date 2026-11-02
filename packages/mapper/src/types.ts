/**
 * Mapper types (PLAN §8.1, §10). Field names for the LD side follow
 * reference/launchdarkly/openapi.json (Clause, Rule, Rollout, Target, UserSegmentRule).
 */
import type { EntityKind } from '@sslm/canonical';

// ---------------------------------------------------------------------------------------------
// Desired LD state
// ---------------------------------------------------------------------------------------------

/** LD clause. `op` is lower-case per the semantic-patch reference. */
export interface LdClause {
  contextKind: string;
  attribute: string;
  op: LdOperator;
  values: unknown[];
  negate: boolean;
}

export type LdOperator =
  | 'in'
  | 'endsWith'
  | 'startsWith'
  | 'matches'
  | 'contains'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'before'
  | 'after'
  | 'segmentMatch'
  | 'semVerEqual'
  | 'semVerLessThan'
  | 'semVerGreaterThan';

/** Weights are thousandths of a percent (0–100000), as in LD `WeightedVariation`. */
export interface LdRollout {
  contextKind: string;
  /** Attribute to bucket by instead of the context key (LD-source rollouts, PLAN §20.3). */
  bucketBy?: string;
  variations: { variation: number; weight: number }[];
}

/** Exactly one of `variation` / `rollout`. Variations are indexes into the flag's variations. */
export interface VariationOrRollout {
  variation?: number;
  rollout?: LdRollout;
}

export interface DesiredRule extends VariationOrRollout {
  description: string;
  clauses: LdClause[];
}

export interface DesiredTarget {
  contextKind: string;
  variation: number;
  values: string[];
}

export interface DesiredPrerequisite {
  key: string;
  variation: number;
}

export interface ClientSideAvailability {
  usingEnvironmentId: boolean;
  usingMobileKey: boolean;
}

export interface CustomProperty {
  name: string;
  value: string[];
}

/** Project-level part of a flag (PLAN §10.1). Changing it affects every environment (§7). */
export interface DesiredFlagShell {
  key: string;
  name: string;
  description: string;
  variations: { value: unknown; name: string }[];
  defaults: { onVariation: number; offVariation: number };
  temporary: boolean;
  tags: string[];
  clientSideAvailability: ClientSideAvailability;
  /** Provenance (PLAN §3.3) minus the per-environment `migration.sync.<env>` entries. */
  customProperties: Record<string, CustomProperty>;
  /** LD member `_id` matched to the source owner's email (PLAN §8.3 `maintainer_unknown`). At most one of the two. */
  maintainerId?: string;
  /** LD team key matched to the source team, when no member matched (or the user chose the team). */
  maintainerTeamKey?: string;
}

/**
 * An LD AI Config from a StatSig prompt. The Console API (20240601) exposes no prompt versions,
 * so only the shell migrates; variations are added in LD by hand (`manual` fidelity).
 */
export interface DesiredAiConfig {
  key: string;
  name: string;
  /** Without the migration footer; the executor appends it (AI Configs have no custom properties). */
  description: string;
  tags: string[];
  mode: 'completion';
  maintainerId?: string;
  maintainerTeamKey?: string;
}

/** One environment's targeting (PLAN §10.2). Applied as one atomic semantic PATCH. */
export interface DesiredFlagEnv {
  ldEnv: string;
  statsigEnv: string;
  on: boolean;
  offVariation: number;
  fallthrough: VariationOrRollout;
  rules: DesiredRule[];
  targets: DesiredTarget[];
  prerequisites: DesiredPrerequisite[];
  /**
   * LD scheduled changes (Enterprise) that flip the targeting when a StatSig `time` condition
   * crosses its timestamp (PLAN §5.1, §8.3 `time_condition` "schedule"). Each one carries the whole
   * targeting as of that moment, so the flag converges on the same state however it gets there.
   * Present only when at least one time condition chose to be scheduled.
   */
  scheduledChanges?: DesiredScheduledChange[];
}

/** The environment's targeting as of `executionDate`, applied by an LD scheduled change. */
export interface DesiredScheduledChange {
  /** ISO 8601 instant at which LD applies the change. */
  executionDate: string;
  /** Why, e.g. `Time condition after 2027-11-26T00:00:00Z in rule "Black Friday"`. */
  description: string;
  state: Pick<DesiredFlagEnv, 'on' | 'offVariation' | 'fallthrough' | 'rules' | 'targets' | 'prerequisites'>;
}

export interface DesiredSegmentRule {
  description: string;
  clauses: LdClause[];
  /** Thousandths of a percent; omitted = everyone matching the clauses. */
  weight?: number;
  rolloutContextKind?: string;
  bucketBy?: string;
}

/** An LD segment in one environment. Segments are per environment in LD. */
export interface DesiredSegment {
  key: string;
  ldEnv: string;
  statsigEnv: string;
  name: string;
  description: string;
  tags: string[];
  rules: DesiredSegmentRule[];
  /** Included `user` keys (standard segments only). */
  included: string[];
  /** Included keys for other context kinds (standard segments only). */
  includedContexts: { contextKind: string; values: string[] }[];
  /** Excluded `user` keys and keys of other kinds (LD-source segments, PLAN §20.3). Absent = none. */
  excluded?: string[];
  excludedContexts?: { contextKind: string; values: string[] }[];
  /**
   * Set for a big segment (LD `unbounded: true`, Enterprise): a list above LD's 15,000-ID limit for
   * standard segments. Membership is written with a CSV import in `replace` mode, never with
   * `included`, and `rules` stay empty (big segments have no rules).
   */
  unbounded?: {
    contextKind: string;
    ids: string[];
    /** The membership is not known to the console (LD-source big segment, PLAN §20.3): create the segment, import nothing. */
    manual?: true;
  };
}

/** An LD custom conversion metric (POST /metrics/{projectKey}; PLAN §11 "the success event becomes a metric"). */
export interface DesiredMetric {
  key: string;
  name: string;
  description: string;
  kind: 'custom';
  /** The event name the app must send through LD `track()`. */
  eventKey: string;
  isNumeric: false;
  successCriteria: 'HigherThanBaseline';
  tags: string[];
  /** Context kinds the metric can be analyzed by (the bandit's randomization unit). */
  analysisUnits: string[];
}

export interface DesiredTreatment {
  name: string;
  baseline: boolean;
  /** Percent of traffic, as LD's `TreatmentInput.allocationPercent` string, e.g. "33.34". */
  allocationPercent: string;
  /** Index into the flag's variations. */
  variation: number;
}

/**
 * A drafted LD multi-armed bandit (an experiment with `type: mab`, PLAN §11 "Autotune"), in one
 * environment. Created with its first iteration as a draft: nothing runs until someone starts it in LD.
 */
export interface DesiredBandit {
  key: string;
  ldEnv: string;
  statsigEnv: string;
  name: string;
  description: string;
  hypothesis: string;
  flagKey: string;
  /** The flag rule the bandit runs on. Always the default rule for a migrated autotune. */
  ruleId: 'fallthrough';
  treatments: DesiredTreatment[];
  /** The primary metric the bandit optimizes (`primarySingleMetricKey`). */
  metricKey: string;
  randomizationUnit: string;
  reallocationFrequencyMillis: number;
  tags: string[];
}

// ---------------------------------------------------------------------------------------------
// Decisions (PLAN §8)
// ---------------------------------------------------------------------------------------------

export type DecisionType =
  | 'holdout_attached'
  | 'value_type'
  | 'version_format'
  | 'case_insensitive_match'
  | 'negated_missing_attribute'
  | 'partial_rollout_rebucket'
  | 'gate_reference'
  | 'time_condition'
  | 'derived_attribute'
  | 'unit_type_kind'
  | 'key_collision'
  | 'source_collision'
  | 'big_segment'
  | 'hashed_id_list'
  | 'id_list_unavailable'
  | 'missing_reference'
  | 'regex_dialect'
  | 'null_check'
  | 'client_side_availability'
  | 'unsupported_condition'
  | 'rule_expansion'
  | 'autotune_running'
  | 'missing_metric'
  | 'duplicate_variant_value'
  | 'variation_change_affects_migrated_env'
  /** LD source (PLAN §20.3): copy the source flag's own custom properties, or leave them. */
  | 'copy_custom_properties'
  /** LD source: the target plan or token has no prerequisites. */
  | 'prerequisite_unsupported'
  /** The owner's email is not an LD member (PLAN §8.3): leave unassigned, assign the team, or pick a member (`member:<id>`). */
  | 'maintainer_unknown';

/**
 * - blocking: no safe default; the item can't migrate until resolved.
 * - choice: has a recommended default ("use recommended" applies it in bulk).
 * - acknowledge: information the user must accept.
 */
export type Severity = 'blocking' | 'choice' | 'acknowledge';

export type Fidelity = 'full' | 'partial' | 'manual' | 'skipped';

export interface DecisionOption {
  key: string;
  label: string;
  explanation: string;
  resultingFidelity: Fidelity;
}

export interface DecisionSubject {
  sourceId: string;
  /** `flag`: a neutral (LD-source) flag, PLAN §20. */
  kind: EntityKind | 'unit_type' | 'flag';
  /** Entity uid, or `<sourceId>/unit_type/<name>` for project-level decisions. */
  uid: string;
  id: string;
  ruleId?: string;
  ruleName?: string;
  /** Human-readable location, e.g. `rule "Beta testers" › condition 2`. */
  location?: string;
}

export interface DecisionPoint {
  /**
   * Stable across environments and snapshots: `<type>:<uid>:<path>`. A decision about a
   * condition is the same decision in staging and production, so it's asked once.
   */
  id: string;
  type: DecisionType;
  severity: Severity;
  subject: DecisionSubject;
  title: string;
  explanation: string;
  /** The exact StatSig JSON that triggered it (PLAN §8.1). */
  sourceFragment: unknown;
  options: DecisionOption[];
  recommended?: string;
  /** Hash of type + normalized fragment. A resolution goes stale when this changes. */
  fingerprint: string;
}

export type ResolutionScope = 'resource' | 'policy';

/** Stored per workspace (IndexedDB) and exported in the workspace file. */
export interface Resolution {
  /** DecisionPoint.id for `resource` scope; `policy:<type>` for policies. */
  id: string;
  type: DecisionType;
  optionKey: string;
  scope: ResolutionScope;
  /** Fingerprint at decision time (`resource` scope only). */
  fingerprint?: string;
  decidedAt: string;
  decidedBy?: string;
  note?: string;
}

export interface AppliedDecision {
  decision: DecisionPoint;
  optionKey: string;
  via: 'resource' | 'policy';
}

export interface StaleDecision {
  decision: DecisionPoint;
  previous: Resolution;
}

// ---------------------------------------------------------------------------------------------
// Profile, capabilities, inputs
// ---------------------------------------------------------------------------------------------

export interface SourceProfile {
  /** StatSig environment name → LD environment key, or `null` = not migrated (§7). */
  envMapping: Record<string, string | null>;
  /** StatSig unit type → LD context kind (§10.3 `unit_type_kind`). */
  unitTypeKinds: Record<string, string>;
}

/** How a source owner becomes an LD maintainer, decided once per owner on the guide's People step. */
export type MaintainerChoice = { memberId: string } | { teamKey: string } | 'unassigned';

/** The mapping profile (PLAN §8.1). Travels with the workspace file. */
export interface MappingProfile {
  version: 1;
  sources: Record<string, SourceProfile>;
  /** StatSig condition type → LD attribute name, overriding the defaults in profile.ts. */
  attributes: Record<string, string>;
  /** Workspace policies: decision type → option key (PLAN §8.1 "workspace policy"). */
  policies: Partial<Record<DecisionType, string>>;
  /**
   * Owner email (lower-cased) → maintainer. Owners without an entry are matched by email against
   * the LD member directory; an unmatched one raises `maintainer_unknown` on each of their items.
   */
  maintainers?: Record<string, MaintainerChoice>;
  /** Source team name → LD team key (`null`: no team). Teams without an entry match an LD team whose key is the sanitized name. */
  teams?: Record<string, string | null>;
}

/**
 * The LD account's members and teams, as far as the token can read them (PLAN §5.2 `members`,
 * `teams`). A mapper input like the capability matrix: owners are matched against it by email.
 */
export interface LdDirectory {
  members: { id: string; email: string }[];
  teams: { key: string; name?: string }[];
  /** False when the list route was not readable (403/404): nothing can be matched, and the notes say so. */
  membersReadable: boolean;
  teamsReadable: boolean;
}

export type CapabilityState = 'available' | 'not_permitted' | 'unavailable' | 'unknown' | 'manual';

/** The slice of the LD capability matrix (PLAN §5.2) the mapper depends on. */
export interface MapperCapabilities {
  prerequisites: CapabilityState;
  contextKinds: CapabilityState;
  /** Big (unbounded) segments with CSV import; Enterprise. `unknown` until the first write. */
  bigSegments?: CapabilityState;
  /** Scheduled flag changes; Enterprise. `unknown` until the first write. */
  scheduledChanges?: CapabilityState;
  /** Context kind keys that already exist in the LD project. */
  existingContextKinds: string[];
}

/** A (source environment, target LD environment) pair. `statsig` is the source environment key for every source kind (PLAN §20.1 "Trade-offs"). */
export interface EnvTarget {
  statsig: string;
  ld: string;
}

/**
 * Plaintext ID lists by segment uid: fetched on demand for segments the snapshot deferred (PLAN
 * §4.1), or uploaded as a raw-ID CSV and reconciled against a spec's hashed list (PLAN §4.2).
 */
export type IdLists = Record<string, string[]>;

/**
 * Result of reconciling a raw-ID upload with the hashed list StatSig ships in `get_id_lists`
 * (PLAN §4.2 step 3), by segment uid. `missing` hashes have no raw ID in the upload; `extra` raw IDs
 * are not in StatSig's list and are not migrated. `verified` is false when no hash file was
 * uploaded, so the raw list could only be checked against StatSig's count.
 */
export interface IdListCoverage {
  total: number;
  matched: number;
  missing: number;
  extra: number;
  verified: boolean;
}
export type IdListCoverages = Record<string, IdListCoverage>;

export interface Dependency {
  kind: 'segment' | 'context_kind' | 'flag' | 'metric' | 'randomization_unit';
  key: string;
  /** For segments and prerequisite flags: the StatSig entity id it comes from; for metrics, the event name. */
  entityId?: string;
}

export interface FidelityNote {
  fidelity: Fidelity;
  message: string;
  location?: string;
}

export interface FidelityReport {
  overall: Fidelity;
  notes: FidelityNote[];
}

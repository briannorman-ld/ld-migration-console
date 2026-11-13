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
export type NeutralKind = 'flag' | 'segment';

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
 * Facts about a flag or segment that LD has no field for and the mapper must surface as a
 * decision or note (PLAN §22.3). Adapters emit them; the mapper owns the wording and the options.
 */
export type NeutralCaveat =
  /** The source persists the pre-login assignment to the identified person (PostHog experience continuity). */
  | { kind: 'experience_continuity' }
  /** Early-access opt-in overrides every rule through a person attribute. */
  | { kind: 'early_access_enrollment'; detail: { attribute: string; stage?: string } }
  /** Rollouts bucket by an attribute other than the context key (PostHog `bucketing_identifier: device_id`). */
  | { kind: 'device_bucketing'; detail: { attribute: string } }
  /** The flag evaluates only for requests that pass these contexts (PostHog `evaluation_contexts`). */
  | { kind: 'evaluation_contexts'; detail: { contexts: string[] } }
  /** Payloads are stored encrypted in the source; `readable` says whether this read decrypted them. */
  | { kind: 'encrypted_payload'; detail: { readable: boolean } }
  /** A holdout excludes a share of contexts before the rules run. */
  | { kind: 'holdout'; detail: { id: string; percentage: number } }
  /** Pending scheduled changes in the source (ISO instants; `recurring` for cron schedules). */
  | { kind: 'scheduled_changes'; detail: { changes: { at: string; operation: string; recurring: boolean }[] } }
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
  /** Experiments the source runs on this flag (not migrated, PLAN §11); keys or names. */
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

/** The neutral block of a snapshot (PLAN §20.1 "How it plugs in"). */
export interface NeutralProject {
  flags: NeutralFlag[];
  segments: NeutralSegment[];
  contextKinds: NeutralContextKind[];
  /** PLAN §21.4: the source's attribute schema, when it has one. */
  attributes?: NeutralAttribute[];
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

/** Provenance tags and properties an earlier migration wrote into the *source* project; never copied onward. */
export const PROVENANCE_TAG_RE = /^(migrated-from-|migration-src-|statsig-migrated$|statsig-src-)/;
export const PROVENANCE_PROPERTY_RE = /^(migration|statsig)\./;

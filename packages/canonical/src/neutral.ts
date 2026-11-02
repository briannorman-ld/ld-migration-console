/**
 * The provider-neutral core (PLAN §20.1): the flag-platform concepts every source has, in
 * LD-shaped vocabulary because LaunchDarkly is the target and the richest of the sources.
 *
 * Today only the LaunchDarkly source adapter emits it (`CanonicalSnapshot.neutral`); the StatSig
 * adapters still fill the StatSig-vocabulary collections of the snapshot. Step 2 moves them onto
 * this model too (PLAN §20.1 "How it plugs in"). Field names follow
 * reference/launchdarkly/openapi.json (Clause, Rule, Rollout, Target, UserSegmentRule).
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
}

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

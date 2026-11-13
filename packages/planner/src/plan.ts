/**
 * The planner (PLAN §9 "Migrate flow" step 2, §10.4, §11): selected gates, dynamic configs and
 * autotunes × LD environments → dependency closure (segments, context kinds, prerequisite gates,
 * metrics, randomization units), collision checks against what's already in LD, and an ordered
 * list of idempotent steps. Pure: LD state is an input.
 */
import { hasMigratedTag, hasSourceTag, migrationKindOf, PROP, readFlagProvenance, readSync, stableStringify, syncedEnvsOf, syncPropertyKey, type Autotune, type CanonicalSnapshot, type Config, type Gate, type MigrationSourceKind, type NeutralFlag, type Prompt } from '@sslm/canonical';
import { gateById, neutralFlagByKey, neutralSegmentByKey, segmentById } from '@sslm/mapper';
import { ldChange, type LdFlagEnvInfo } from './drift.ts';
import {
  decisionPoint,
  lookupResolution,
  mapAutotune,
  mapConfig,
  mapGate,
  mapNeutralFlag,
  mapNeutralSegment,
  mapPrompt,
  mapSegment,
  type AutotuneMapResult,
  type ConfigMapResult,
  type DecisionPoint,
  type DesiredAiConfig,
  type DesiredBandit,
  type DesiredFlagEnv,
  type DesiredFlagShell,
  type DesiredMetric,
  type DesiredSegment,
  type FidelityReport,
  type GateMapResult,
  type IdListCoverages,
  type IdLists,
  type LdDirectory,
  type MapperCapabilities,
  type MappingProfile,
  type NeutralFlagMapResult,
  type NeutralSegmentMapResult,
  type Resolution,
  type SegmentMapResult,
  type StaleDecision,
} from '@sslm/mapper';

export interface LdFlagState {
  key: string;
  tags: string[];
  customProperties: Record<string, { name?: string | null; value?: string[] | null }>;
  kind?: string | null;
  archived?: boolean | null;
  /** The flag's variations, when the LD read included them (append-only guard, PLAN §7). */
  variations?: { value: unknown; name?: string | null }[] | null;
  /** Per-environment version and modification time, when the LD read included them: the `ld_drift_on_sync` guard (PLAN §8.3). */
  environments?: Record<string, LdFlagEnvInfo> | null;
}

export interface LdSegmentState {
  key: string;
  tags: string[];
}

export interface LdMetricState {
  key: string;
  tags: string[];
  eventKey?: string | null;
  kind?: string | null;
}

export interface LdExperimentState {
  key: string;
  tags: string[];
  type?: string | null;
  archived?: boolean;
  /** Status of the iteration a new draft would replace: `not_started`, `running` or `stopped`. */
  iterationStatus?: string | null;
}

/** What the planner needs to know about the LD project (read by the app before planning). */
export interface LdProjectState {
  flags: ReadonlyMap<string, LdFlagState>;
  /** Segments per LD environment key. */
  segments: Readonly<Record<string, ReadonlyMap<string, LdSegmentState>>>;
  contextKinds: string[];
  /** LD environments that need a typed confirmation (`critical`, or production). */
  criticalEnvs: string[];
  /** Project-level metrics; absent when the LD plan has no Experimentation (or they weren't read). */
  metrics?: ReadonlyMap<string, LdMetricState>;
  /** Experiments (including bandits) per LD environment key. */
  experiments?: Readonly<Record<string, ReadonlyMap<string, LdExperimentState>>>;
  /** Context kinds enabled as experiment randomization units. Absent = unknown (`user` assumed). */
  randomizationUnits?: string[];
  /** AI Configs in the project; absent when the plan has none or they weren't read. Ownership is the pair of tags, like segments. */
  aiConfigs?: ReadonlyMap<string, LdSegmentState>;
}

export interface PlanRequest {
  /** Gate uids to migrate. */
  gates: string[];
  /** Dynamic config uids to migrate (JSON multivariate flags, PLAN §10.1). */
  configs?: string[];
  /** Autotune uids to migrate (PLAN §11: flag + metric + drafted bandit). */
  autotunes?: string[];
  /** Neutral flag uids (an LD-source project, PLAN §20). */
  flags?: string[];
  /** Prompt uids → LD AI Configs (project-level; `ldEnvs` is not consulted). */
  prompts?: string[];
  /** Segment uids to migrate on their own (neutral or StatSig); segments a flag needs are pulled in regardless. */
  segments?: string[];
  /**
   * Context kinds to create on their own (the guide's "create the kinds first"); kinds an item
   * needs are pulled in regardless. `availableForExperiments` also enables the kind as a
   * randomization unit (an existing kind may be listed for that alone).
   */
  contextKinds?: { key: string; unitType: string; availableForExperiments?: boolean }[];
  ldEnvs: string[];
  snapshots: CanonicalSnapshot[];
  idLists?: IdLists;
  /** Reconciliation results for uploaded raw-ID lists (PLAN §4.2), by segment uid. */
  coverage?: IdListCoverages;
  profile: MappingProfile;
  resolutions: ReadonlyMap<string, Resolution>;
  capabilities: MapperCapabilities;
  /** LD members and teams for owner → maintainer matching (PLAN §8.3). */
  directory?: LdDirectory;
  ld: LdProjectState;
  now: string;
  /**
   * Leave out flags (gates, configs, autotunes, source flags) whose LaunchDarkly provenance says
   * they are in sync with the source and the decisions: a re-plan then writes only what is new or
   * changed. Such items are `skipped` with `IN_SYNC_REASON`; an in-sync prerequisite still
   * satisfies its dependents. Segments are pulled in by their flags as before.
   */
  skipInSync?: boolean;
  /**
   * The mapper functions to use in place of @sslm/mapper's, same signatures and results. The web
   * app passes memoized ones, so a plan reuses what the explorers mapped instead of mapping every
   * selected item again for each environment. Left out, the pure mappers run.
   */
  mappers?: Partial<PlanMappers>;
}

/** The entity mappers a plan calls, by name; see `PlanRequest.mappers`. */
export interface PlanMappers {
  mapGate: typeof mapGate;
  mapSegment: typeof mapSegment;
  mapConfig: typeof mapConfig;
  mapAutotune: typeof mapAutotune;
  mapNeutralFlag: typeof mapNeutralFlag;
  mapNeutralSegment: typeof mapNeutralSegment;
  mapPrompt: typeof mapPrompt;
}

/**
 * What the executor writes as provenance (PLAN §3.3). The `statsig*` names date from the
 * StatSig-only days and mean "source": `sourceKind` says which kind (PLAN §20.1 "Trade-offs").
 */
export interface Provenance {
  sourceKind: MigrationSourceKind;
  sourceAlias: string;
  statsigType: 'gate' | 'config' | 'autotune' | 'flag' | 'prompt';
  statsigId: string;
  statsigVersion?: number;
  statsigFingerprint: string;
  decisionSetHash: string;
}

export type PlanStep =
  | { id: string; deps: string[]; op: 'ensure_context_kind'; key: string; name: string; unitType: string; sourceKind?: MigrationSourceKind }
  | { id: string; deps: string[]; op: 'upsert_segment'; ldEnv: string; key: string; exists: boolean; adopt: boolean; desired: DesiredSegment; provenance: Omit<Provenance, 'statsigType'> & { statsigType: 'segment' } }
  | { id: string; deps: string[]; op: 'upsert_flag_shell'; key: string; exists: boolean; adopt: boolean; desired: DesiredFlagShell }
  | { id: string; deps: string[]; op: 'ensure_randomization_unit'; key: string }
  | { id: string; deps: string[]; op: 'upsert_metric'; key: string; exists: boolean; adopt: boolean; desired: DesiredMetric; provenance: Omit<Provenance, 'statsigType'> & { statsigType: 'metric' } }
  | { id: string; deps: string[]; op: 'create_bandit'; key: string; ldEnv: string; statsigEnv: string; flagKey: string; exists: boolean; adopt: boolean; desired: DesiredBandit; provenance: Provenance }
  | { id: string; deps: string[]; op: 'upsert_ai_config'; key: string; exists: boolean; adopt: boolean; desired: DesiredAiConfig; provenance: Omit<Provenance, 'statsigType'> & { statsigType: 'prompt' } }
  | {
      id: string;
      deps: string[];
      op: 'update_flag_env';
      key: string;
      ldEnv: string;
      statsigEnv: string;
      /** Values of the flag's variations, in the order `desired` indexes them. */
      variations: unknown[];
      desired: DesiredFlagEnv;
      provenance: Provenance;
      /** The user chose to overwrite targeting edited in LaunchDarkly since the last sync (`ld_drift_on_sync`); without it the executor refuses to write over such an edit. */
      overwriteLdChanges?: boolean;
    };

export type ItemStatus = 'ready' | 'blocked' | 'skipped' | 'error';

export interface PlanItem {
  uid: string;
  /** `flag`: a neutral (LD-source) flag, PLAN §20. `prompt`: a StatSig prompt → LD AI Config (project-level, `ldEnv` empty). */
  kind: 'gate' | 'config' | 'segment' | 'autotune' | 'metric' | 'flag' | 'prompt';
  entityId: string;
  sourceId: string;
  ldKey: string;
  ldEnv: string;
  statsigEnv?: string;
  status: ItemStatus;
  /** True when pulled in by another item (a segment, or a prerequisite gate). */
  dependency: boolean;
  requiredBy: string[];
  reason?: string;
  fidelity?: FidelityReport;
  decisions: DecisionPoint[];
  exists: boolean;
  /** For flags: LD has it and the console created it (provenance present). */
  owned?: boolean;
  /** For flags: where LD's provenance for this environment stands against the current mapping. */
  sync?: MigrationStatus;
}

/** The reason on a flag item `skipInSync` left out. */
export const IN_SYNC_REASON = 'already in sync with StatSig (unchanged since its last sync)';

/**
 * One LD flag of the plan, at project level (PLAN §7 "Changes at project level affect every
 * environment"): the flag is created once and exists in every LD environment; `envs` are the
 * environments this plan configures targeting in. The rest keep LD's default (off) and show as
 * not migrated.
 */
export interface PlanFlag {
  uid: string;
  kind: 'gate' | 'config' | 'autotune' | 'flag';
  entityId: string;
  sourceId: string;
  ldKey: string;
  /** `boolean` for gates, `multivariate` (JSON) for configs, autotunes and multivariate source flags. */
  flagKind: 'boolean' | 'multivariate';
  variations: { value: unknown; name: string }[];
  /** The flag already exists in LD. */
  exists: boolean;
  /** It exists, was not created by the console, and the user chose to adopt it. */
  adopt: boolean;
  /** It exists and carries the console's provenance (an earlier run created it, maybe for another environment). */
  owned: boolean;
  /** `ready` when the shell step runs (targeting is ready in at least one environment). */
  status: ItemStatus;
  reason?: string;
  /** Every planned environment is in sync per LD's provenance: nothing to write unless asked. */
  inSync: boolean;
  /** Per-environment outcome, in the plan's environment order. */
  envs: { ldEnv: string; statsigEnv?: string; status: ItemStatus; reason?: string }[];
}

export interface Plan {
  items: PlanItem[];
  /** The flags, rolled up at project level: one row per LD key (PLAN §9 "Plan"). */
  flags: PlanFlag[];
  steps: PlanStep[];
  /** Every open decision across the plan, deduplicated by id. */
  decisions: DecisionPoint[];
  stale: StaleDecision[];
  errors: string[];
  /** LD environments in this plan that need a typed confirmation (PLAN §9 step 5). */
  confirmEnvs: string[];
  /** True when every requested item is ready (nothing blocked or failing). */
  ready: boolean;
  /** Rough write count, for the duration estimate (PLAN §15). */
  requests: number;
}

/**
 * "Use recommended for all *choice* decisions" (PLAN §8.2). Blocking and acknowledge decisions
 * are left for the user.
 */
export function recommendedResolutions(ds: DecisionPoint[], decidedAt: string): Resolution[] {
  return ds
    .filter((d) => d.severity === 'choice' && d.recommended)
    .map((d) => ({ id: d.id, type: d.type, optionKey: d.recommended!, scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt }));
}

/** `migration.sync.<env>`: `[fingerprint, version, syncedAt, decisionSetHash]` (PLAN §3.3). */
export { syncPropertyKey };

export function planMigration(req: PlanRequest): Plan {
  const errors: string[] = [];
  const items = new Map<string, PlanItem>();
  const decisions = new Map<string, DecisionPoint>();
  const stale = new Map<string, StaleDecision>();
  const steps = new Map<string, PlanStep>();
  const snapshotOf = new Map(req.snapshots.map((s) => [s.source.sourceId, s]));
  const gatesByUid = new Map(req.snapshots.flatMap((s) => s.gates.map((g) => [g.uid, g] as const)));
  const shellOwner = new Map<string, string>();
  const dir = req.directory ? { directory: req.directory } : {};
  const aliasOf = (sourceId: string): string => snapshotOf.get(sourceId)?.source.alias ?? sourceId;

  /**
   * Consolidation of neutral flags (PLAN §12, §22.1 "What is a source?"; KNOWN-EDGE-CASES §16):
   * several sources may produce one LaunchDarkly key, typically one PostHog project per stage
   * mapped to one LaunchDarkly environment each. The first source to plan a key claims its shell
   * (kind and variations, which are project-level in LaunchDarkly); a later source must match it
   * and gets its own environment step with its own provenance. Two sources mapped to the *same*
   * environment is a `source_collision` decision: one environment holds one targeting.
   */
  interface ShellClaim {
    uid: string;
    alias: string;
    flagKind: 'boolean' | 'multivariate';
    /** Variation values, stable JSON, in order. */
    variations: string[];
  }
  const shellClaims = new Map<string, ShellClaim>();
  /** Alias of the source whose item created the `shell:<key>` step (its name, description and tags are the flag's). */
  const shellSource = new Map<string, string>();
  /** `<ldEnv>|<key>` → the item whose targeting the environment step carries. */
  const envClaims = new Map<string, PlanItem>();
  /** `<ldEnv>|<segment key>` → the item whose rules the segment step carries. */
  const segmentClaims = new Map<string, PlanItem>();

  /**
   * A source that maps no environment to `ldEnv` but does to another environment of this plan is
   * planned there, not here (one PostHog project per stage, PLAN §22.1). A source that maps to
   * none of the plan's environments still reports an error on its items, as before.
   */
  const plannedElsewhere = (snapshot: CanonicalSnapshot, ldEnv: string): boolean => {
    const mapping = req.profile.sources[snapshot.source.sourceId]?.envMapping ?? {};
    const to = new Set(Object.values(mapping).filter((v): v is string => !!v));
    return !to.has(ldEnv) && req.ldEnvs.some((e) => e !== ldEnv && to.has(e));
  };

  /** Another source of this plan (not `snapshot`) with alias `alias` that produces neutral flag `key`. */
  const peerFlagSource = (alias: string, snapshot: CanonicalSnapshot, key: string): CanonicalSnapshot | undefined =>
    req.snapshots.find((s) => s !== snapshot && s.source.alias === alias && neutralFlagByKey(s).has(key));
  /** The alias of another source of this plan whose provenance tags an existing LaunchDarkly segment carries. */
  const peerSegmentOwner = (ldSeg: LdSegmentState, snapshot: CanonicalSnapshot): string | undefined =>
    hasMigratedTag(ldSeg.tags) ? req.snapshots.find((s) => s !== snapshot && hasSourceTag(ldSeg.tags, s.source.alias))?.source.alias : undefined;

  /**
   * A flag another source of this workspace created keeps its flag-level provenance
   * (`migration.source`, `migration.id`, …): the shell owner stays whoever created the flag in
   * LaunchDarkly, however the plan's environment order falls, and each environment's sync record
   * (`migration.sync.<env>`) is written by the source mapped to it.
   */
  const inheritProvenance = (shell: DesiredFlagShell, ldFlag: LdFlagState): DesiredFlagShell => {
    const customProperties = { ...shell.customProperties };
    for (const k of Object.values(PROP)) {
      const cur = ldFlag.customProperties[k];
      if (cur?.value?.length) customProperties[k] = { name: cur.name ?? customProperties[k]?.name ?? k, value: [...cur.value] };
      else delete customProperties[k];
    }
    return { ...shell, customProperties };
  };

  const addDecisions = (item: PlanItem, ds: DecisionPoint[], st: StaleDecision[]) => {
    for (const d of ds) {
      decisions.set(d.id, d);
      if (!item.decisions.some((x) => x.id === d.id)) item.decisions.push(d);
    }
    for (const s of st) stale.set(s.decision.id, s);
  };

  const collision = (item: PlanItem, subject: DecisionPoint['subject'], ldKey: string, what: 'flag' | 'segment' | 'metric' | 'bandit' | 'AI Config', where: string): 'adopt' | 'skip' | 'open' => {
    const overwrites = what === 'flag' ? 'targeting in the migrated environments' : what === 'segment' ? 'rules and targets' : what === 'metric' ? 'event key, success criteria and tags' : what === 'AI Config' ? 'name, description, tags and maintainer (its variations are left alone)' : 'draft iteration';
    const dp = decisionPoint({
      type: 'key_collision',
      severity: 'blocking',
      subject: { ...subject, location: where },
      path: `${what}:${ldKey}${what === 'segment' || what === 'bandit' ? `:${where}` : ''}`,
      title: `LaunchDarkly ${what === 'bandit' ? 'experiment' : what} “${ldKey}” already exists`,
      explanation:
        what === 'bandit'
          ? `An experiment with this key exists in ${where} and wasn't created by this app. Adopting it replaces its draft iteration with the bandit's; an iteration that already ran is left alone.`
          : `A ${what} with this key exists in LaunchDarkly and wasn't created by this app. Adopting it overwrites its ${overwrites} on every sync; the current state is saved first so the run can be undone.`,
      sourceFragment: { key: ldKey, kind: what === 'AI Config' ? 'ai_config' : what },
      options: [
        { key: 'adopt', label: 'Adopt it (link and overwrite on sync)', explanation: 'The existing LaunchDarkly resource becomes the migration target. A pre-image is kept for undo.', resultingFidelity: 'full' },
        { key: 'skip', label: 'Skip this item', explanation: 'Leave the LaunchDarkly resource alone and keep the item in StatSig.', resultingFidelity: 'skipped' },
      ],
    });
    const l = lookupResolution(dp, req.resolutions, req.profile);
    if (l.status === 'resolved') return l.optionKey === 'adopt' ? 'adopt' : 'skip';
    addDecisions(item, [dp], l.stale ? [{ decision: dp, previous: l.stale }] : []);
    return 'open';
  };

  /**
   * Someone changed the flag's targeting in LaunchDarkly after the last sync (PLAN §8.3
   * `ld_drift_on_sync`). Writing the source's targeting again would revert their edit, so the
   * item is blocked until the user says which side wins. The fingerprint carries the modification
   * time, so a further LaunchDarkly edit asks again.
   */
  const drift = (item: PlanItem, subject: DecisionPoint['subject'], ldFlag: LdFlagState | undefined, ldEnv: string): 'overwrite' | 'keep' | 'open' | 'none' => {
    if (!ldFlag) return 'none';
    const sync = readSync(ldFlag.customProperties, ldEnv);
    const env = ldFlag.environments?.[ldEnv];
    const change = ldChange(env, sync?.[2] ?? undefined);
    if (!change.changed) return 'none';
    const dp = decisionPoint({
      type: 'ld_drift_on_sync',
      severity: 'blocking',
      subject: { ...subject, location: ldEnv },
      path: `drift:${ldFlag.key}:${ldEnv}`,
      title: `LaunchDarkly targeting for “${ldFlag.key}” in ${ldEnv} changed since the last sync`,
      explanation: `Someone edited this flag's targeting in LaunchDarkly after the console synced it (${change.evidence}). Syncing again would replace that edit with the source's targeting.`,
      sourceFragment: { key: ldFlag.key, ldEnv, lastModified: env?.lastModified ?? null, version: env?.version ?? null },
      options: [
        { key: 'keep_ld', label: 'Keep LaunchDarkly’s targeting (skip this environment)', explanation: 'Nothing is written for this environment on this run. Monitoring keeps showing the item as changed in LaunchDarkly.', resultingFidelity: 'skipped' },
        { key: 'overwrite', label: 'Overwrite with the source’s targeting', explanation: 'The LaunchDarkly edit is replaced. The state before the write is kept so the run can be undone.', resultingFidelity: 'full' },
      ],
      recommended: 'keep_ld',
    });
    const l = lookupResolution(dp, req.resolutions, req.profile);
    if (l.status === 'resolved') return l.optionKey === 'overwrite' ? 'overwrite' : 'keep';
    addDecisions(item, [dp], l.stale ? [{ decision: dp, previous: l.stale }] : []);
    return 'open';
  };

  /**
   * Two sources of this workspace produce one LaunchDarkly key (PLAN §12 consolidation;
   * KNOWN-EDGE-CASES 16.2, 16.3, 19.26). With `difference` the shells cannot be one flag
   * (different kind or variations): the later source can only skip. Without it, both sources are
   * mapped to the same environment, which holds one targeting: keep the first source's (skip this
   * item) or let this source win (the first source's item for the environment is skipped).
   */
  const sourceCollision = (item: PlanItem, subject: DecisionPoint['subject'], what: 'flag' | 'segment', ldKey: string, ldEnv: string, first: string, difference?: string): 'skip' | 'replace' | 'open' => {
    const alias = aliasOf(item.sourceId);
    const content = what === 'flag' ? 'targeting' : 'rules and targets';
    const dp = decisionPoint({
      type: 'source_collision',
      severity: 'blocking',
      subject: { ...subject, location: ldEnv },
      path: `source_collision:${ldKey}:${ldEnv}`,
      title: difference ? `“${ldKey}” comes from ${first} and ${alias} with different ${what === 'flag' ? 'variations' : 'rules'}` : `“${ldKey}” comes from both ${first} and ${alias} for ${ldEnv}`,
      explanation: difference
        ? `Sources ${first} and ${alias} both produce LaunchDarkly ${what} “${ldKey}”, but one flag cannot carry both: ${difference}. Variations are project-level in LaunchDarkly, shared by every environment. To migrate ${alias}'s flag under this key instead, deselect ${first}'s.`
        : `Sources ${first} and ${alias} both produce LaunchDarkly ${what} “${ldKey}” and both are mapped to environment ${ldEnv}, which holds one ${content === 'targeting' ? 'targeting configuration' : 'set of rules and targets'}. ${first} planned it first.`,
      sourceFragment: { key: ldKey, ldEnv, sources: [first, alias], ...(difference ? { difference } : {}) },
      options: difference
        ? [{ key: 'skip', label: 'Skip this item', explanation: `${first}'s ${what} is migrated under “${ldKey}”; ${alias}'s stays in its source.`, resultingFidelity: 'skipped' }]
        : [
            { key: 'skip', label: `Keep ${first}'s ${content}; skip this one`, explanation: `${ldEnv} gets ${first}'s ${content}; nothing from ${alias} is written for this ${what} in ${ldEnv}.`, resultingFidelity: 'skipped' },
            { key: 'replace', label: `This source's ${content} wins; ${first}'s ${what} for this environment is skipped`, explanation: `${ldEnv} gets ${alias}'s ${content}; ${first}'s ${what} is skipped for ${ldEnv} with a reason. Other environments are not affected.`, resultingFidelity: 'full' },
          ],
      recommended: 'skip',
    });
    const l = lookupResolution(dp, req.resolutions, req.profile);
    if (l.status === 'resolved') return l.optionKey === 'replace' && !difference ? 'replace' : 'skip';
    addDecisions(item, [dp], l.stale ? [{ decision: dp, previous: l.stale }] : []);
    return 'open';
  };

  const envFor = (sourceId: string, ldEnv: string): string | null => {
    const mapping = req.profile.sources[sourceId]?.envMapping ?? {};
    const matches = Object.entries(mapping).filter(([, v]) => v === ldEnv).map(([k]) => k);
    if (matches.length > 1) {
      errors.push(`StatSig environments ${matches.join(' and ')} of one source both map to LaunchDarkly “${ldEnv}”. Map at most one per source.`);
      return null;
    }
    return matches[0] ?? null;
  };

  const ensureKinds = (deps: { kind: string; key: string; entityId?: string }[], sourceKind: MigrationSourceKind = 'statsig'): string[] => {
    const out: string[] = [];
    for (const d of deps) {
      if (d.kind !== 'context_kind') continue;
      const id = `context_kind:${d.key}`;
      if (!req.ld.contextKinds.includes(d.key) && !steps.has(id)) steps.set(id, { id, deps: [], op: 'ensure_context_kind', key: d.key, name: d.key, unitType: d.entityId ?? d.key, ...(sourceKind !== 'statsig' ? { sourceKind } : {}) });
      if (steps.has(id)) out.push(id);
    }
    return out;
  };
  ensureKinds((req.contextKinds ?? []).map((k) => ({ kind: 'context_kind', key: k.key, entityId: k.unitType })));

  const planSegment = (snapshot: CanonicalSnapshot, segmentId: string, statsigEnv: string, ldEnv: string, requiredBy: string | null, stack: string[] = []): { stepId?: string; ok: boolean; reason?: string } => {
    const seg = segmentById(snapshot).get(segmentId);
    if (!seg) return { ok: false, reason: `segment “${segmentId}” not found` };
    if (stack.includes(seg.uid)) return { ok: false, reason: `segment “${segmentId}” references itself through other segments` };
    const itemKey = `${seg.uid}|${ldEnv}`;
    const existing = items.get(itemKey);
    if (existing) {
      if (requiredBy) existing.requiredBy.push(requiredBy);
      else existing.dependency = false;
      return existing.status === 'ready' ? { ok: true, stepId: `segment:${ldEnv}:${existing.ldKey}` } : { ok: false, reason: `segment “${segmentId}” is ${existing.status}` };
    }
    const r: SegmentMapResult = (req.mappers?.mapSegment ?? mapSegment)({ canonical: { snapshot, idLists: req.idLists, ...(req.coverage ? { coverage: req.coverage } : {}) }, entity: seg, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: statsigEnv, ld: ldEnv }, now: req.now, ...dir });
    const ldSeg = req.ld.segments[ldEnv]?.get(r.segmentKey);
    const item: PlanItem = { uid: seg.uid, kind: 'segment', entityId: seg.id, sourceId: seg.source.sourceId, ldKey: r.segmentKey, ldEnv, statsigEnv, status: 'ready', dependency: requiredBy !== null, requiredBy: requiredBy ? [requiredBy] : [], fidelity: r.fidelity, decisions: [], exists: !!ldSeg };
    items.set(itemKey, item);
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped || !r.desired) return finishItem(item, 'skipped', r.skipped ?? 'not migratable');
    let adopt = false;
    if (ldSeg && !ownsSegment(ldSeg, snapshot.source.alias)) {
      const c = collision(item, { sourceId: seg.source.sourceId, kind: 'segment', uid: seg.uid, id: seg.id }, r.segmentKey, 'segment', ldEnv);
      if (c === 'skip') return finishItem(item, 'skipped', `LaunchDarkly segment “${r.segmentKey}” exists and was not adopted`);
      if (c === 'open') return finishItem(item, 'blocked', `LaunchDarkly segment “${r.segmentKey}” already exists`);
      adopt = true;
    }
    if (r.unresolved.length) return finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    // A segment rule that matches another segment (segmentMatch) needs that segment in the same
    // environment first: LD refuses the rule otherwise.
    const deps = ensureKinds(r.dependencies);
    for (const d of r.dependencies) {
      if (d.kind !== 'segment') continue;
      const inner = planSegment(snapshot, d.entityId ?? d.key, statsigEnv, ldEnv, seg.uid, [...stack, seg.uid]);
      if (inner.ok && inner.stepId) deps.push(inner.stepId);
      else return finishItem(item, 'blocked', `depends on ${inner.reason ?? `segment “${d.key}”`}`);
    }
    const stepId = `segment:${ldEnv}:${r.segmentKey}`;
    steps.set(stepId, {
      id: stepId,
      deps,
      op: 'upsert_segment',
      ldEnv,
      key: r.segmentKey,
      exists: !!ldSeg,
      adopt,
      desired: r.desired,
      provenance: { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'segment', statsigId: seg.id, ...(seg.version !== undefined ? { statsigVersion: seg.version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
    return { ok: true, stepId };
  };

  /**
   * A segment the mapper split off a flag's targeting so the flag stays under LaunchDarkly's size
   * limit (mapper size.ts; KNOWN-EDGE-CASES 15.22). It has no StatSig entity of its own: its item
   * hangs off the flag's uid, its provenance names the flag, and it is written before the flag's
   * targeting, after the context kinds the flag needs.
   */
  const planSplitSegment = (snapshot: CanonicalSnapshot, desired: DesiredSegment, owner: { uid: string; id: string; kind: 'gate' | 'config'; sourceId: string; version?: number }, statsigEnv: string, ldEnv: string, r: { statsigFingerprint: string; decisionSetHash: string }, kindSteps: string[]): { stepId?: string; ok: boolean; reason?: string } => {
    const uid = `${owner.uid}/list/${desired.key}`;
    const itemKey = `${uid}|${ldEnv}`;
    const existing = items.get(itemKey);
    if (existing) {
      existing.requiredBy.push(owner.uid);
      return existing.status === 'ready' ? { ok: true, stepId: `segment:${ldEnv}:${existing.ldKey}` } : { ok: false, reason: `segment “${desired.key}” is ${existing.status}` };
    }
    const ldSeg = req.ld.segments[ldEnv]?.get(desired.key);
    const item: PlanItem = { uid, kind: 'segment', entityId: desired.key, sourceId: owner.sourceId, ldKey: desired.key, ldEnv, statsigEnv, status: 'ready', dependency: true, requiredBy: [owner.uid], fidelity: { overall: 'full', notes: [{ fidelity: 'full', message: desired.description }] }, decisions: [], exists: !!ldSeg };
    items.set(itemKey, item);
    let adopt = false;
    if (ldSeg && !ownsSegment(ldSeg, snapshot.source.alias)) {
      const c = collision(item, { sourceId: owner.sourceId, kind: owner.kind, uid: owner.uid, id: owner.id, location: `segment “${desired.key}”` }, desired.key, 'segment', ldEnv);
      if (c === 'skip') return finishItem(item, 'skipped', `LaunchDarkly segment “${desired.key}” exists and was not adopted`);
      if (c === 'open') return finishItem(item, 'blocked', `LaunchDarkly segment “${desired.key}” already exists`);
      adopt = true;
    }
    const stepId = `segment:${ldEnv}:${desired.key}`;
    steps.set(stepId, {
      id: stepId,
      deps: kindSteps,
      op: 'upsert_segment',
      ldEnv,
      key: desired.key,
      exists: !!ldSeg,
      adopt,
      desired,
      provenance: { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'segment', statsigId: owner.id, ...(owner.version !== undefined ? { statsigVersion: owner.version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
    return { ok: true, stepId };
  };

  const finishItem = (item: PlanItem, status: ItemStatus, reason: string) => {
    item.status = status;
    item.reason = reason;
    return { ok: false, reason: `${item.kind} “${item.entityId}” is ${status}: ${reason}` };
  };

  const planGate = (gate: Gate, ldEnv: string, requiredBy: string | null, stack: string[]): { ok: boolean; reason?: string; stepId?: string } => {
    const itemKey = `${gate.uid}|${ldEnv}`;
    const existing = items.get(itemKey);
    if (existing) {
      if (requiredBy) existing.requiredBy.push(requiredBy);
      if (stack.includes(gate.uid)) {
        errors.push(`Prerequisites form a cycle: ${[...stack, gate.uid].map((u) => gatesByUid.get(u)?.id ?? u).join(' → ')}.`);
        return { ok: false, reason: 'prerequisite cycle' };
      }
      if (existing.status === 'skipped' && existing.sync === 'in_sync') return { ok: true };
      return existing.status === 'ready' ? { ok: true, stepId: `env:${ldEnv}:${existing.ldKey}` } : { ok: false, reason: `gate “${gate.id}” is ${existing.status}` };
    }
    const snapshot = snapshotOf.get(gate.source.sourceId)!;
    const statsigEnv = envFor(gate.source.sourceId, ldEnv);
    const item: PlanItem = { uid: gate.uid, kind: 'gate', entityId: gate.id, sourceId: gate.source.sourceId, ldKey: gate.id, ldEnv, status: 'ready', dependency: requiredBy !== null, requiredBy: requiredBy ? [requiredBy] : [], decisions: [], exists: false };
    items.set(itemKey, item);
    if (!statsigEnv) return finishItem(item, 'error', `no StatSig environment of ${snapshot.source.alias} is mapped to LaunchDarkly “${ldEnv}”`);
    item.statsigEnv = statsigEnv;

    const r: GateMapResult = (req.mappers?.mapGate ?? mapGate)({ canonical: { snapshot, idLists: req.idLists, ...(req.coverage ? { coverage: req.coverage } : {}) }, entity: gate, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: statsigEnv, ld: ldEnv }, now: req.now, ...dir });
    item.ldKey = r.flagKey;
    item.fidelity = r.fidelity;
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped) return finishItem(item, 'skipped', r.skipped);

    // Ownership guard (PLAN §15) and consolidation collisions (§12, M8).
    const ldFlag = req.ld.flags.get(r.flagKey);
    item.exists = !!ldFlag;
    item.owned = !!ldFlag && !!flagOwner(ldFlag);
    let adopt = false;
    const other = shellOwner.get(r.flagKey);
    if (other && other !== gate.uid) return finishItem(item, 'error', `${describeOwner(other)} also produces LaunchDarkly key “${r.flagKey}” (${other.includes('/config/') ? 'StatSig keeps gates and configs in separate namespaces, LaunchDarkly has one key space' : 'consolidation arrives in M8; migrate one source at a time'})`);
    shellOwner.set(r.flagKey, gate.uid);
    if (ldFlag) {
      const owner = flagOwner(ldFlag);
      if (owner && (owner.id !== gate.id || owner.source !== snapshot.source.alias)) return finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” was migrated from ${owner.source}/${owner.id}; consolidation arrives in M8`);
      if (owner && owner.type && owner.type !== 'gate') return finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” was migrated from the StatSig ${owner.type} of the same name (gates and configs share one LaunchDarkly key space)`);
      if (ldFlag.kind && ldFlag.kind !== 'boolean') return finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” exists and is not a boolean flag`);
      if (!owner) {
        const c = collision(item, { sourceId: gate.source.sourceId, kind: 'gate', uid: gate.uid, id: gate.id }, r.flagKey, 'flag', 'flag key');
        if (c === 'skip') return finishItem(item, 'skipped', `LaunchDarkly flag “${r.flagKey}” exists and was not adopted`);
        if (c === 'open') return finishItem(item, 'blocked', `LaunchDarkly flag “${r.flagKey}” already exists`);
        adopt = true;
      }
    }

    item.sync = migrationStatus(ldFlag, ldEnv, r).status;
    if (req.skipInSync && item.sync === 'in_sync') return finishItem(item, 'skipped', IN_SYNC_REASON);
    const ldDrift = drift(item, { sourceId: gate.source.sourceId, kind: 'gate', uid: gate.uid, id: gate.id }, ldFlag, ldEnv);
    if (ldDrift === 'keep') return finishItem(item, 'skipped', `LaunchDarkly targeting in ${ldEnv} changed since the last sync and is kept`);
    if (ldDrift === 'open') return finishItem(item, 'blocked', `LaunchDarkly targeting in ${ldEnv} changed since the last sync`);

    // Dependencies in the same environment.
    const depSteps: string[] = ensureKinds(r.dependencies);
    const kindSteps = [...depSteps];
    const depProblems: string[] = [];
    for (const d of r.dependencies) {
      if (d.kind === 'segment') {
        const split = r.segments.find((x) => x.key === d.key);
        const s = split ? planSplitSegment(snapshot, split, { uid: gate.uid, id: gate.id, kind: 'gate', sourceId: gate.source.sourceId, ...(gate.version !== undefined ? { version: gate.version } : {}) }, statsigEnv, ldEnv, r, kindSteps) : planSegment(snapshot, d.entityId ?? d.key, statsigEnv, ldEnv, gate.uid);
        if (s.ok && s.stepId) depSteps.push(s.stepId);
        else depProblems.push(s.reason ?? `segment ${d.key}`);
      } else if (d.kind === 'flag') {
        const ref = d.entityId === undefined ? undefined : gateById(snapshot).get(d.entityId);
        if (!ref) {
          depProblems.push(`prerequisite gate “${d.entityId}” not found`);
          continue;
        }
        const p = planGate(ref, ldEnv, gate.uid, [...stack, gate.uid]);
        // An in-sync prerequisite (skipInSync) is satisfied with no step of its own.
        if (p.ok) {
          if (p.stepId) depSteps.push(p.stepId);
        } else depProblems.push(`prerequisite ${p.reason ?? d.key}`);
      }
    }

    if (r.unresolved.length) return finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    if (depProblems.length) return finishItem(item, 'blocked', `depends on: ${depProblems.join('; ')}`);

    const shellId = `shell:${r.flagKey}`;
    if (!steps.has(shellId)) steps.set(shellId, { id: shellId, deps: [], op: 'upsert_flag_shell', key: r.flagKey, exists: !!ldFlag, adopt, desired: r.shell });
    const stepId = `env:${ldEnv}:${r.flagKey}`;
    steps.set(stepId, {
      id: stepId,
      deps: [shellId, ...depSteps],
      op: 'update_flag_env',
      key: r.flagKey,
      ...(ldDrift === 'overwrite' ? { overwriteLdChanges: true } : {}),
      ldEnv,
      statsigEnv,
      variations: r.shell.variations.map((v) => v.value),
      desired: r.env,
      provenance: { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'gate', statsigId: gate.id, ...(gate.version !== undefined ? { statsigVersion: gate.version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
    return { ok: true, stepId };
  };

  /**
   * PLAN §7 "variations are append-only": a flag the app owns keeps every variation it has; new
   * values are appended by the executor. Appending to a flag whose other environments are already
   * migrated is a project-level change those environments see, so it is acknowledged first.
   */
  const variationGuard = (item: PlanItem, subject: DecisionPoint['subject'], ldFlag: LdFlagState, desired: DesiredFlagShell, ldEnv: string): 'ok' | 'skip' | 'open' => {
    if (!ldFlag.variations) return 'ok';
    const have = new Set(ldFlag.variations.map((v) => stableStringify(v.value)));
    const added = desired.variations.filter((v) => !have.has(stableStringify(v.value)));
    if (added.length === 0) return 'ok';
    const migratedElsewhere = syncedEnvsOf(ldFlag.customProperties).filter((e) => e !== ldEnv && !req.ldEnvs.includes(e));
    if (migratedElsewhere.length === 0) return 'ok';
    const dp = decisionPoint({
      type: 'variation_change_affects_migrated_env',
      severity: 'acknowledge',
      subject: { ...subject, location: 'variations' },
      path: `variations:${desired.key}:${added.map((v) => stableStringify(v.value)).join('|')}`,
      title: `New value${added.length === 1 ? '' : 's'} ${added.map((v) => `“${v.name}”`).join(', ')} for a flag already migrated to ${migratedElsewhere.join(', ')}`,
      explanation: `LaunchDarkly variations are project-level. Appending ${added.length === 1 ? 'this variation' : 'these variations'} to “${desired.key}” is visible in ${migratedElsewhere.join(', ')}, where nothing serves ${added.length === 1 ? 'it' : 'them'} until that environment is synced again. Existing variations are never removed or reordered.`,
      sourceFragment: { key: desired.key, added: added.map((v) => v.value), migratedEnvironments: migratedElsewhere },
      fingerprintOf: { added: added.map((v) => v.value), migratedElsewhere },
      options: [
        { key: 'acknowledge', label: 'Append the new variations', explanation: 'The flag gains the new values; other environments keep serving what they serve today.', resultingFidelity: 'full' },
        { key: 'skip', label: 'Skip this item', explanation: 'Leave the LaunchDarkly flag unchanged for now.', resultingFidelity: 'skipped' },
      ],
      recommended: 'acknowledge',
    });
    const l = lookupResolution(dp, req.resolutions, req.profile);
    if (l.status === 'resolved') return l.optionKey === 'acknowledge' ? 'ok' : 'skip';
    addDecisions(item, [dp], l.stale ? [{ decision: dp, previous: l.stale }] : []);
    return 'open';
  };

  const planConfig = (config: Config, ldEnv: string): void => {
    const itemKey = `${config.uid}|${ldEnv}`;
    if (items.has(itemKey)) return;
    const snapshot = snapshotOf.get(config.source.sourceId)!;
    const statsigEnv = envFor(config.source.sourceId, ldEnv);
    const item: PlanItem = { uid: config.uid, kind: 'config', entityId: config.id, sourceId: config.source.sourceId, ldKey: config.id, ldEnv, status: 'ready', dependency: false, requiredBy: [], decisions: [], exists: false };
    items.set(itemKey, item);
    if (!statsigEnv) return void finishItem(item, 'error', `no StatSig environment of ${snapshot.source.alias} is mapped to LaunchDarkly “${ldEnv}”`);
    item.statsigEnv = statsigEnv;

    const r: ConfigMapResult = (req.mappers?.mapConfig ?? mapConfig)({ canonical: { snapshot, idLists: req.idLists, ...(req.coverage ? { coverage: req.coverage } : {}) }, entity: config, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: statsigEnv, ld: ldEnv }, now: req.now, ...dir });
    item.ldKey = r.flagKey;
    item.fidelity = r.fidelity;
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped) return void finishItem(item, 'skipped', r.skipped);

    // Ownership guard (PLAN §15), the gate ↔ config key space (KNOWN-EDGE-CASES 1.2 / 10.8) and consolidation collisions (§12, M8).
    const ldFlag = req.ld.flags.get(r.flagKey);
    item.exists = !!ldFlag;
    item.owned = !!ldFlag && !!flagOwner(ldFlag);
    let adopt = false;
    const other = shellOwner.get(r.flagKey);
    if (other && other !== config.uid) return void finishItem(item, 'error', `${describeOwner(other)} also produces LaunchDarkly key “${r.flagKey}”: StatSig keeps gates and configs in separate namespaces, LaunchDarkly has one key space. Rename one in StatSig or migrate one at a time.`);
    shellOwner.set(r.flagKey, config.uid);
    if (ldFlag) {
      const owner = flagOwner(ldFlag);
      if (owner && (owner.id !== config.id || owner.source !== snapshot.source.alias)) return void finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” was migrated from ${owner.source}/${owner.id}; consolidation arrives in M8`);
      if (owner && owner.type && owner.type !== 'config') return void finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” was migrated from the StatSig ${owner.type} of the same name (gates and configs share one LaunchDarkly key space)`);
      if (ldFlag.kind && ldFlag.kind !== 'multivariate') return void finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” exists and is not a multivariate (JSON) flag`);
      if (!owner) {
        const c = collision(item, { sourceId: config.source.sourceId, kind: 'config', uid: config.uid, id: config.id }, r.flagKey, 'flag', 'flag key');
        if (c === 'skip') return void finishItem(item, 'skipped', `LaunchDarkly flag “${r.flagKey}” exists and was not adopted`);
        if (c === 'open') return void finishItem(item, 'blocked', `LaunchDarkly flag “${r.flagKey}” already exists`);
        adopt = true;
      } else {
        const g = variationGuard(item, { sourceId: config.source.sourceId, kind: 'config', uid: config.uid, id: config.id }, ldFlag, r.shell, ldEnv);
        if (g === 'skip') return void finishItem(item, 'skipped', `new variations for “${r.flagKey}” were not appended`);
        if (g === 'open') return void finishItem(item, 'blocked', `new variations affect environments already migrated`);
      }
    }

    item.sync = migrationStatus(ldFlag, ldEnv, r).status;
    if (req.skipInSync && item.sync === 'in_sync') return void finishItem(item, 'skipped', IN_SYNC_REASON);
    const ldDrift = drift(item, { sourceId: config.source.sourceId, kind: 'config', uid: config.uid, id: config.id }, ldFlag, ldEnv);
    if (ldDrift === 'keep') return void finishItem(item, 'skipped', `LaunchDarkly targeting in ${ldEnv} changed since the last sync and is kept`);
    if (ldDrift === 'open') return void finishItem(item, 'blocked', `LaunchDarkly targeting in ${ldEnv} changed since the last sync`);

    // Dependencies in the same environment.
    const depSteps: string[] = ensureKinds(r.dependencies);
    const kindSteps = [...depSteps];
    const depProblems: string[] = [];
    for (const d of r.dependencies) {
      if (d.kind === 'segment') {
        const split = r.segments.find((x) => x.key === d.key);
        const s = split ? planSplitSegment(snapshot, split, { uid: config.uid, id: config.id, kind: 'config', sourceId: config.source.sourceId, ...(config.version !== undefined ? { version: config.version } : {}) }, statsigEnv, ldEnv, r, kindSteps) : planSegment(snapshot, d.entityId ?? d.key, statsigEnv, ldEnv, config.uid);
        if (s.ok && s.stepId) depSteps.push(s.stepId);
        else depProblems.push(s.reason ?? `segment ${d.key}`);
      } else if (d.kind === 'flag') {
        const ref = d.entityId === undefined ? undefined : gateById(snapshot).get(d.entityId);
        if (!ref) {
          depProblems.push(`prerequisite gate “${d.entityId}” not found`);
          continue;
        }
        const p = planGate(ref, ldEnv, config.uid, [config.uid]);
        // An in-sync prerequisite (skipInSync) is satisfied with no step of its own.
        if (p.ok) {
          if (p.stepId) depSteps.push(p.stepId);
        } else depProblems.push(`prerequisite ${p.reason ?? d.key}`);
      }
    }

    if (r.unresolved.length) return void finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    if (depProblems.length) return void finishItem(item, 'blocked', `depends on: ${depProblems.join('; ')}`);

    const shellId = `shell:${r.flagKey}`;
    if (!steps.has(shellId)) steps.set(shellId, { id: shellId, deps: [], op: 'upsert_flag_shell', key: r.flagKey, exists: !!ldFlag, adopt, desired: r.shell });
    const stepId = `env:${ldEnv}:${r.flagKey}`;
    steps.set(stepId, {
      id: stepId,
      deps: [shellId, ...depSteps],
      op: 'update_flag_env',
      key: r.flagKey,
      ...(ldDrift === 'overwrite' ? { overwriteLdChanges: true } : {}),
      ldEnv,
      statsigEnv,
      variations: r.shell.variations.map((v) => v.value),
      desired: r.env,
      provenance: { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'config', statsigId: config.id, ...(config.version !== undefined ? { statsigVersion: config.version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
  };

  // Metrics are project-level, like flag shells: one step per key, shared across environments.
  const planMetric = (snapshot: CanonicalSnapshot, desired: DesiredMetric, owner: AutotuneMapResult, requiredBy: PlanItem): { ok: boolean; stepId?: string; reason?: string } => {
    const stepId = `metric:${desired.key}`;
    const itemKey = `metric:${desired.key}`;
    const existing = items.get(itemKey);
    if (existing) {
      existing.requiredBy.push(requiredBy.uid);
      return existing.status === 'ready' ? { ok: true, stepId } : { ok: false, reason: `metric “${desired.key}” is ${existing.status}` };
    }
    const ldMetric = req.ld.metrics?.get(desired.key);
    const item: PlanItem = { uid: `${snapshot.source.sourceId}/metric/${desired.key}`, kind: 'metric', entityId: desired.eventKey, sourceId: snapshot.source.sourceId, ldKey: desired.key, ldEnv: '', status: 'ready', dependency: true, requiredBy: [requiredBy.uid], decisions: [], exists: !!ldMetric };
    items.set(itemKey, item);
    let adopt = false;
    if (ldMetric && !ownsSegment(ldMetric, snapshot.source.alias)) {
      // Same event key under the same metric key: that *is* the metric; reuse it without a question.
      if (ldMetric.kind === 'custom' && ldMetric.eventKey === desired.eventKey) adopt = true;
      else {
        const c = collision(item, { sourceId: owner.sourceId, kind: 'autotune', uid: owner.uid, id: owner.entityId }, desired.key, 'metric', 'metric key');
        if (c === 'skip') return finishItem(item, 'skipped', `LaunchDarkly metric “${desired.key}” exists and was not adopted`);
        if (c === 'open') return finishItem(item, 'blocked', `LaunchDarkly metric “${desired.key}” already exists`);
        adopt = true;
      }
    }
    steps.set(stepId, {
      id: stepId,
      deps: desired.analysisUnits.filter((u) => u !== 'user').flatMap((u) => ensureRandomizationUnit(u) ?? []),
      op: 'upsert_metric',
      key: desired.key,
      exists: !!ldMetric,
      adopt,
      desired,
      provenance: { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'metric', statsigId: desired.eventKey, statsigFingerprint: owner.statsigFingerprint, decisionSetHash: owner.decisionSetHash },
    });
    return { ok: true, stepId };
  };

  /** The step enabling `kind` as a randomization unit, or null when the project already has it. */
  const ensureRandomizationUnit = (kind: string): string | null => {
    if ((req.ld.randomizationUnits ?? ['user']).includes(kind)) return null;
    const id = `randomization_unit:${kind}`;
    if (!steps.has(id)) {
      const ck = `context_kind:${kind}`;
      steps.set(id, { id, deps: steps.has(ck) ? [ck] : [], op: 'ensure_randomization_unit', key: kind });
    }
    return id;
  };
  // Kinds the guide asked to make "available for experiments" (profile.contextKinds), whether the
  // kind is created in this run or already exists.
  for (const k of req.contextKinds ?? []) if (k.availableForExperiments && k.key !== 'user') ensureRandomizationUnit(k.key);

  const planAutotune = (a: Autotune, ldEnv: string): void => {
    const itemKey = `${a.uid}|${ldEnv}`;
    if (items.has(itemKey)) return;
    const snapshot = snapshotOf.get(a.source.sourceId)!;
    const statsigEnv = envFor(a.source.sourceId, ldEnv);
    const item: PlanItem = { uid: a.uid, kind: 'autotune', entityId: a.id, sourceId: a.source.sourceId, ldKey: a.id, ldEnv, status: 'ready', dependency: false, requiredBy: [], decisions: [], exists: false };
    items.set(itemKey, item);
    if (!statsigEnv) {
      finishItem(item, 'error', `no StatSig environment of ${snapshot.source.alias} is mapped to LaunchDarkly “${ldEnv}”`);
      return;
    }
    item.statsigEnv = statsigEnv;
    const r = (req.mappers?.mapAutotune ?? mapAutotune)({ canonical: { snapshot, idLists: req.idLists, ...(req.coverage ? { coverage: req.coverage } : {}) }, entity: a, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: statsigEnv, ld: ldEnv }, now: req.now, ...dir });
    item.ldKey = r.flagKey;
    item.fidelity = r.fidelity;
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped) {
      // "Skipped" only once the user said so: a preview skipped by a recommended-but-unanswered
      // decision (a running autotune defaults to "wait") is still a question.
      if (r.unresolved.length) finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
      else finishItem(item, 'skipped', r.skipped);
      return;
    }

    const ldFlag = req.ld.flags.get(r.flagKey);
    item.exists = !!ldFlag;
    item.owned = !!ldFlag && !!flagOwner(ldFlag);
    let adopt = false;
    const other = shellOwner.get(r.flagKey);
    if (other && other !== a.uid) {
      finishItem(item, 'error', `${describeOwner(other)} also produces LaunchDarkly key “${r.flagKey}” (consolidation arrives in M8; migrate one source at a time)`);
      return;
    }
    shellOwner.set(r.flagKey, a.uid);
    if (ldFlag) {
      const owner = flagOwner(ldFlag);
      if (owner && (owner.id !== a.id || owner.source !== snapshot.source.alias)) {
        finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” was migrated from ${owner.source}/${owner.id}; consolidation arrives in M8`);
        return;
      }
      if (ldFlag.kind && ldFlag.kind !== 'multivariate') {
        finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” exists and is not a multivariate (JSON) flag`);
        return;
      }
      if (!owner) {
        const c = collision(item, { sourceId: a.source.sourceId, kind: 'autotune', uid: a.uid, id: a.id }, r.flagKey, 'flag', 'flag key');
        if (c === 'skip') return void finishItem(item, 'skipped', `LaunchDarkly flag “${r.flagKey}” exists and was not adopted`);
        if (c === 'open') return void finishItem(item, 'blocked', `LaunchDarkly flag “${r.flagKey}” already exists`);
        adopt = true;
      }
    }

    item.sync = migrationStatus(ldFlag, ldEnv, r).status;
    if (req.skipInSync && item.sync === 'in_sync') return void finishItem(item, 'skipped', IN_SYNC_REASON);
    const ldDrift = drift(item, { sourceId: a.source.sourceId, kind: 'autotune', uid: a.uid, id: a.id }, ldFlag, ldEnv);
    if (ldDrift === 'keep') return void finishItem(item, 'skipped', `LaunchDarkly targeting in ${ldEnv} changed since the last sync and is kept`);
    if (ldDrift === 'open') return void finishItem(item, 'blocked', `LaunchDarkly targeting in ${ldEnv} changed since the last sync`);

    const depSteps: string[] = ensureKinds(r.dependencies);
    const depProblems: string[] = [];
    if (r.metric) {
      const m = planMetric(snapshot, r.metric, r, item);
      if (m.ok && m.stepId) depSteps.push(m.stepId);
      else depProblems.push(m.reason ?? `metric ${r.metric.key}`);
    }
    for (const d of r.dependencies) {
      if (d.kind !== 'randomization_unit') continue;
      const id = ensureRandomizationUnit(d.key);
      if (id) depSteps.push(id);
    }

    // An existing experiment under the bandit's key.
    let banditExists = false;
    let banditAdopt = false;
    if (r.bandit) {
      const ex = req.ld.experiments?.[ldEnv]?.get(r.bandit.key);
      if (ex) {
        banditExists = true;
        if (!ownsSegment(ex, snapshot.source.alias)) {
          const c = collision(item, { sourceId: a.source.sourceId, kind: 'autotune', uid: a.uid, id: a.id }, r.bandit.key, 'bandit', ldEnv);
          if (c === 'skip') return void finishItem(item, 'skipped', `LaunchDarkly experiment “${r.bandit.key}” exists in ${ldEnv} and was not adopted`);
          if (c === 'open') return void finishItem(item, 'blocked', `LaunchDarkly experiment “${r.bandit.key}” already exists in ${ldEnv}`);
          banditAdopt = true;
        }
      }
    }

    if (r.unresolved.length) return void finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    if (depProblems.length) return void finishItem(item, 'blocked', `depends on: ${depProblems.join('; ')}`);

    const provenance: Provenance = { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'autotune', statsigId: a.id, ...(a.version !== undefined ? { statsigVersion: a.version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash };
    const shellId = `shell:${r.flagKey}`;
    if (!steps.has(shellId)) steps.set(shellId, { id: shellId, deps: [], op: 'upsert_flag_shell', key: r.flagKey, exists: !!ldFlag, adopt, desired: r.shell });
    const envId = `env:${ldEnv}:${r.flagKey}`;
    steps.set(envId, { id: envId, deps: [shellId, ...depSteps.filter((d) => d.startsWith('context_kind:'))], op: 'update_flag_env', key: r.flagKey, ldEnv, statsigEnv, variations: r.shell.variations.map((v) => v.value), desired: r.env, provenance, ...(ldDrift === 'overwrite' ? { overwriteLdChanges: true } : {}) });
    if (r.bandit) {
      const banditId = `bandit:${ldEnv}:${r.bandit.key}`;
      steps.set(banditId, { id: banditId, deps: [envId, ...depSteps], op: 'create_bandit', key: r.bandit.key, ldEnv, statsigEnv, flagKey: r.flagKey, exists: banditExists, adopt: banditAdopt, desired: r.bandit, provenance });
    }
  };

  // --- Neutral (LD-source) flags and segments, PLAN §20 -----------------------------------------
  const neutralFlagsByUid = new Map(req.snapshots.flatMap((s) => (s.neutral?.flags ?? []).map((f) => [f.uid, { flag: f, snapshot: s }] as const)));
  const neutralSegmentsByUid = new Map(req.snapshots.flatMap((s) => (s.neutral?.segments ?? []).map((g) => [g.uid, { segment: g, snapshot: s }] as const)));
  const segmentsByUid = new Map(req.snapshots.flatMap((s) => s.segments.map((g) => [g.uid, { segment: g, snapshot: s }] as const)));

  const planNeutralSegment = (snapshot: CanonicalSnapshot, key: string, sourceEnv: string, ldEnv: string, requiredBy: string | null, stack: string[] = []): { stepId?: string; ok: boolean; reason?: string } => {
    const seg = neutralSegmentByKey(snapshot).get(key);
    if (!seg) return { ok: false, reason: `segment “${key}” not found` };
    if (stack.includes(seg.uid)) return { ok: false, reason: `segment “${key}” references itself through other segments` };
    const itemKey = `${seg.uid}|${ldEnv}`;
    const existing = items.get(itemKey);
    if (existing) {
      if (requiredBy) existing.requiredBy.push(requiredBy);
      else existing.dependency = false;
      if (existing.status === 'ready') return { ok: true, stepId: `segment:${ldEnv}:${existing.ldKey}` };
      // Replaced by another source's segment of the same key in this environment (source_collision): that step satisfies the dependency.
      const holder = segmentClaims.get(`${ldEnv}|${existing.ldKey}`);
      if (existing.status === 'skipped' && holder && holder !== existing && holder.status === 'ready') return { ok: true, stepId: `segment:${ldEnv}:${existing.ldKey}` };
      return { ok: false, reason: `segment “${key}” is ${existing.status}` };
    }
    const alias = snapshot.source.alias;
    const r: NeutralSegmentMapResult = (req.mappers?.mapNeutralSegment ?? mapNeutralSegment)({ canonical: { snapshot }, entity: seg, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: sourceEnv, ld: ldEnv }, now: req.now, ...dir });
    const ldSeg = req.ld.segments[ldEnv]?.get(r.segmentKey);
    const item: PlanItem = { uid: seg.uid, kind: 'segment', entityId: seg.key, sourceId: snapshot.source.sourceId, ldKey: r.segmentKey, ldEnv, statsigEnv: sourceEnv, status: 'ready', dependency: requiredBy !== null, requiredBy: requiredBy ? [requiredBy] : [], fidelity: r.fidelity, decisions: [], exists: !!ldSeg };
    items.set(itemKey, item);
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped || !r.desired) {
      if (r.unresolved.length) return finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
      return finishItem(item, 'skipped', r.skipped ?? 'not migratable');
    }
    const subject: DecisionPoint['subject'] = { sourceId: snapshot.source.sourceId, kind: 'segment', uid: seg.uid, id: seg.key };
    // Consolidation (PLAN §12): another source of this plan already produces this segment key in this environment.
    const claimKey = `${ldEnv}|${r.segmentKey}`;
    const held = segmentClaims.get(claimKey);
    if (held && held.uid !== seg.uid) {
      const first = aliasOf(held.sourceId);
      const c = sourceCollision(item, subject, 'segment', r.segmentKey, ldEnv, first);
      if (c === 'skip') {
        // The other source's segment of this key stands in for this one: a flag that needs it is satisfied by that step.
        finishItem(item, 'skipped', `segment “${r.segmentKey}” in ${ldEnv} keeps ${first}'s rules (source_collision)`);
        return held.status === 'ready' ? { ok: true, stepId: `segment:${ldEnv}:${r.segmentKey}` } : { ok: false, reason: `segment “${key}” is skipped and ${first}'s is ${held.status}` };
      }
      if (c === 'open') return finishItem(item, 'blocked', `segment “${r.segmentKey}” in ${ldEnv} also comes from ${first}`);
      steps.delete(`segment:${ldEnv}:${r.segmentKey}`);
      finishItem(held, 'skipped', `${alias}'s rules for segment “${r.segmentKey}” in ${ldEnv} replace this one (source_collision)`);
    }
    segmentClaims.set(claimKey, item);
    let adopt = false;
    if (ldSeg && !ownsSegment(ldSeg, alias)) {
      // Written by another source of this workspace for this environment: the same question, unless it was just answered above.
      const peer = peerSegmentOwner(ldSeg, snapshot);
      if (peer && held) {
        // `replace` chosen over the source whose item holds the environment: its LaunchDarkly segment is taken over.
      } else if (peer) {
        const c = sourceCollision(item, subject, 'segment', r.segmentKey, ldEnv, peer);
        if (c === 'skip') {
          // The LaunchDarkly segment the other source wrote stands in for this one; nothing to write.
          finishItem(item, 'skipped', `segment “${r.segmentKey}” in ${ldEnv} keeps ${peer}'s rules (source_collision)`);
          return { ok: true };
        }
        if (c === 'open') return finishItem(item, 'blocked', `segment “${r.segmentKey}” in ${ldEnv} was migrated from ${peer}`);
      } else {
        const c = collision(item, subject, r.segmentKey, 'segment', ldEnv);
        if (c === 'skip') return finishItem(item, 'skipped', `LaunchDarkly segment “${r.segmentKey}” exists and was not adopted`);
        if (c === 'open') return finishItem(item, 'blocked', `LaunchDarkly segment “${r.segmentKey}” already exists`);
      }
      adopt = true;
    }
    if (r.unresolved.length) return finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    const deps = ensureKinds(r.dependencies, migrationKindOf(snapshot.source.sourceKind));
    for (const d of r.dependencies) {
      if (d.kind !== 'segment') continue;
      const inner = planNeutralSegment(snapshot, d.entityId ?? d.key, sourceEnv, ldEnv, seg.uid, [...stack, seg.uid]);
      if (inner.ok) {
        if (inner.stepId) deps.push(inner.stepId);
      } else return finishItem(item, 'blocked', `depends on ${inner.reason ?? `segment “${d.key}”`}`);
    }
    const stepId = `segment:${ldEnv}:${r.segmentKey}`;
    const version = seg.environments.find((e) => e.env === sourceEnv)?.version;
    steps.set(stepId, {
      id: stepId,
      deps,
      op: 'upsert_segment',
      ldEnv,
      key: r.segmentKey,
      exists: !!ldSeg,
      adopt,
      desired: r.desired,
      provenance: { sourceKind: migrationKindOf(snapshot.source.sourceKind), sourceAlias: snapshot.source.alias, statsigType: 'segment', statsigId: seg.key, ...(version !== undefined ? { statsigVersion: version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
    return { ok: true, stepId };
  };

  const planNeutralFlag = (flag: NeutralFlag, snapshot: CanonicalSnapshot, ldEnv: string, requiredBy: string | null, stack: string[]): { ok: boolean; reason?: string; stepId?: string } => {
    const itemKey = `${flag.uid}|${ldEnv}`;
    const existing = items.get(itemKey);
    if (existing) {
      if (requiredBy) existing.requiredBy.push(requiredBy);
      if (stack.includes(flag.uid)) {
        errors.push(`Prerequisites form a cycle: ${[...stack, flag.uid].map((u) => neutralFlagsByUid.get(u)?.flag.key ?? u).join(' → ')}.`);
        return { ok: false, reason: 'prerequisite cycle' };
      }
      if (existing.status === 'skipped' && existing.sync === 'in_sync') return { ok: true };
      if (existing.status === 'ready') return { ok: true, stepId: `env:${ldEnv}:${existing.ldKey}` };
      // Replaced by another source's flag of the same key in this environment (source_collision): that step satisfies the prerequisite.
      const holder = envClaims.get(`${ldEnv}|${existing.ldKey}`);
      if (existing.status === 'skipped' && holder && holder !== existing && holder.status === 'ready') return { ok: true, stepId: `env:${ldEnv}:${existing.ldKey}` };
      return { ok: false, reason: `flag “${flag.key}” is ${existing.status}` };
    }
    const sourceEnv = envFor(snapshot.source.sourceId, ldEnv);
    const item: PlanItem = { uid: flag.uid, kind: 'flag', entityId: flag.key, sourceId: snapshot.source.sourceId, ldKey: flag.key, ldEnv, status: 'ready', dependency: requiredBy !== null, requiredBy: requiredBy ? [requiredBy] : [], decisions: [], exists: false };
    items.set(itemKey, item);
    if (!sourceEnv) return finishItem(item, 'error', `no environment of ${snapshot.source.alias} is mapped to LaunchDarkly “${ldEnv}”`);
    item.statsigEnv = sourceEnv;

    const r: NeutralFlagMapResult = (req.mappers?.mapNeutralFlag ?? mapNeutralFlag)({ canonical: { snapshot }, entity: flag, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: sourceEnv, ld: ldEnv }, now: req.now, ...dir });
    item.ldKey = r.flagKey;
    item.fidelity = r.fidelity;
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped) return finishItem(item, 'skipped', r.skipped);

    const ldFlag = req.ld.flags.get(r.flagKey);
    item.exists = !!ldFlag;
    item.owned = !!ldFlag && !!flagOwner(ldFlag);
    const alias = snapshot.source.alias;
    const subject: DecisionPoint['subject'] = { sourceId: snapshot.source.sourceId, kind: 'flag', uid: flag.uid, id: flag.key };
    let adopt = false;
    /** The flag exists and another source of this workspace created it: its flag-level provenance is kept. */
    let inheritFrom: LdFlagState | undefined;
    const variations = r.shell.variations.map((v) => stableStringify(v.value));
    const other = shellOwner.get(r.flagKey);
    if (other && other !== flag.uid) {
      const claim = shellClaims.get(r.flagKey);
      // A StatSig gate, config or autotune under the same key: the two vocabularies are not consolidated.
      if (!claim) return finishItem(item, 'error', `${describeOwner(other)} also produces LaunchDarkly key “${r.flagKey}” (migrate one source at a time)`);
      // Consolidation (PLAN §12): another source of this plan produces this key. The shell (kind and
      // variations) is project-level, so it must be the same flag; the targeting is per environment.
      const difference =
        r.flagKind !== claim.flagKind
          ? `${claim.alias} has a ${claim.flagKind} flag and ${alias} a ${r.flagKind} one`
          : variations.join('\u0000') !== claim.variations.join('\u0000')
            ? `${claim.alias}'s variations are ${claim.variations.join(', ')} and ${alias}'s are ${variations.join(', ')}`
            : undefined;
      if (difference) {
        const c = sourceCollision(item, subject, 'flag', r.flagKey, ldEnv, claim.alias, difference);
        if (c === 'skip') return finishItem(item, 'skipped', `“${r.flagKey}” is migrated from ${claim.alias}, whose flag has ${r.flagKind !== claim.flagKind ? 'another kind' : 'other variations'} (source_collision)`);
        return finishItem(item, 'blocked', `“${r.flagKey}” also comes from ${claim.alias}, with ${r.flagKind !== claim.flagKind ? 'another kind' : 'other variations'}`);
      }
    } else {
      shellOwner.set(r.flagKey, flag.uid);
      shellClaims.set(r.flagKey, { uid: flag.uid, alias, flagKind: r.flagKind, variations });
    }
    // One targeting per environment: a second source mapped to the same environment must skip or replace.
    const envKey = `${ldEnv}|${r.flagKey}`;
    const held = envClaims.get(envKey);
    if (held && held.uid !== flag.uid) {
      const first = aliasOf(held.sourceId);
      const c = sourceCollision(item, subject, 'flag', r.flagKey, ldEnv, first);
      if (c === 'skip') return finishItem(item, 'skipped', `“${r.flagKey}” in ${ldEnv} keeps ${first}'s targeting (source_collision)`);
      if (c === 'open') return finishItem(item, 'blocked', `“${r.flagKey}” in ${ldEnv} also comes from ${first}`);
      steps.delete(`env:${ldEnv}:${r.flagKey}`);
      finishItem(held, 'skipped', `${alias}'s targeting for “${r.flagKey}” in ${ldEnv} replaces this one (source_collision)`);
    }
    envClaims.set(envKey, item);
    if (ldFlag) {
      const owner = flagOwner(ldFlag);
      if (owner && (owner.id !== flag.key || owner.source !== alias)) {
        // Created by another source of this workspace that produces the same key (consolidation):
        // accepted when that source is mapped to other environments; when it is mapped to this one
        // too and its item is not in this plan, the environment's targeting is its, so the same
        // question as above is asked. Anything else is a flag of another migration.
        const peer = owner.id === flag.key ? peerFlagSource(owner.source, snapshot, flag.key) : undefined;
        if (!peer) return finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” was migrated from ${owner.source}/${owner.id}, which is not a source of this workspace producing this key`);
        inheritFrom = ldFlag;
        if (!held && envFor(peer.source.sourceId, ldEnv)) {
          const c = sourceCollision(item, subject, 'flag', r.flagKey, ldEnv, owner.source);
          if (c === 'skip') return finishItem(item, 'skipped', `“${r.flagKey}” in ${ldEnv} keeps ${owner.source}'s targeting (source_collision)`);
          if (c === 'open') return finishItem(item, 'blocked', `“${r.flagKey}” in ${ldEnv} was migrated from ${owner.source}`);
        }
      }
      if (ldFlag.kind && ldFlag.kind !== r.flagKind) return finishItem(item, 'error', `LaunchDarkly flag “${r.flagKey}” exists and is a ${ldFlag.kind} flag, the source flag is ${r.flagKind}`);
      if (!owner) {
        const c = collision(item, subject, r.flagKey, 'flag', 'flag key');
        if (c === 'skip') return finishItem(item, 'skipped', `LaunchDarkly flag “${r.flagKey}” exists and was not adopted`);
        if (c === 'open') return finishItem(item, 'blocked', `LaunchDarkly flag “${r.flagKey}” already exists`);
        adopt = true;
      } else if (r.flagKind === 'multivariate') {
        const g = variationGuard(item, subject, ldFlag, r.shell, ldEnv);
        if (g === 'skip') return finishItem(item, 'skipped', `new variations for “${r.flagKey}” were not appended`);
        if (g === 'open') return finishItem(item, 'blocked', `new variations affect environments already migrated`);
      }
    }

    item.sync = migrationStatus(ldFlag, ldEnv, r).status;
    if (req.skipInSync && item.sync === 'in_sync') return finishItem(item, 'skipped', IN_SYNC_REASON);
    const ldDrift = drift(item, subject, ldFlag, ldEnv);
    if (ldDrift === 'keep') return finishItem(item, 'skipped', `LaunchDarkly targeting in ${ldEnv} changed since the last sync and is kept`);
    if (ldDrift === 'open') return finishItem(item, 'blocked', `LaunchDarkly targeting in ${ldEnv} changed since the last sync`);

    const depSteps: string[] = ensureKinds(r.dependencies, migrationKindOf(snapshot.source.sourceKind));
    const depProblems: string[] = [];
    for (const d of r.dependencies) {
      if (d.kind === 'segment') {
        const sg = planNeutralSegment(snapshot, d.entityId ?? d.key, sourceEnv, ldEnv, flag.uid);
        if (sg.ok) {
          if (sg.stepId) depSteps.push(sg.stepId);
        } else depProblems.push(sg.reason ?? `segment ${d.key}`);
      } else if (d.kind === 'flag') {
        const ref = d.entityId === undefined ? undefined : neutralFlagByKey(snapshot).get(d.entityId);
        if (!ref) {
          depProblems.push(`prerequisite flag “${d.entityId}” not found`);
          continue;
        }
        const p = planNeutralFlag(ref, snapshot, ldEnv, flag.uid, [...stack, flag.uid]);
        // An in-sync prerequisite (skipInSync) is satisfied with no step of its own.
        if (p.ok) {
          if (p.stepId) depSteps.push(p.stepId);
        } else depProblems.push(`prerequisite ${p.reason ?? d.key}`);
      }
    }

    if (r.unresolved.length) return finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    if (depProblems.length) return finishItem(item, 'blocked', `depends on: ${depProblems.join('; ')}`);

    const shellId = `shell:${r.flagKey}`;
    if (!steps.has(shellId)) {
      steps.set(shellId, { id: shellId, deps: [], op: 'upsert_flag_shell', key: r.flagKey, exists: !!ldFlag, adopt, desired: inheritFrom ? inheritProvenance(r.shell, inheritFrom) : r.shell });
      shellSource.set(r.flagKey, alias);
    } else if (shellSource.get(r.flagKey) !== alias) {
      // Another source's item created the shell: the flag's settings are its; this source writes its environment.
      item.fidelity?.notes.push({ fidelity: 'full', message: `Flag settings (name, description, tags) come from source ${shellSource.get(r.flagKey)}, which planned this key first.`, location: 'flag settings' });
    }
    const stepId = `env:${ldEnv}:${r.flagKey}`;
    const version = flag.environments.find((e) => e.env === sourceEnv)?.version ?? flag.version;
    steps.set(stepId, {
      id: stepId,
      deps: [shellId, ...depSteps],
      op: 'update_flag_env',
      key: r.flagKey,
      ...(ldDrift === 'overwrite' ? { overwriteLdChanges: true } : {}),
      ldEnv,
      statsigEnv: sourceEnv,
      variations: r.shell.variations.map((v) => v.value),
      desired: r.env,
      provenance: { sourceKind: migrationKindOf(snapshot.source.sourceKind), sourceAlias: snapshot.source.alias, statsigType: 'flag', statsigId: flag.key, ...(version !== undefined ? { statsigVersion: version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
    return { ok: true, stepId };
  };

  // Prompts are project-level, like flag shells: one AI Config per key, no environment part (PLAN §6).
  const planPrompt = (prompt: Prompt): void => {
    const itemKey = `${prompt.uid}|`;
    if (items.has(itemKey)) return;
    const snapshot = snapshotOf.get(prompt.source.sourceId)!;
    const item: PlanItem = { uid: prompt.uid, kind: 'prompt', entityId: prompt.id, sourceId: prompt.source.sourceId, ldKey: prompt.id, ldEnv: '', status: 'ready', dependency: false, requiredBy: [], decisions: [], exists: false };
    items.set(itemKey, item);
    const r = (req.mappers?.mapPrompt ?? mapPrompt)({ canonical: { snapshot }, entity: prompt, profile: req.profile, resolutions: req.resolutions, capabilities: req.capabilities, env: { statsig: '', ld: '' }, now: req.now, ...dir });
    item.ldKey = r.key;
    item.fidelity = r.fidelity;
    addDecisions(item, r.unresolved, r.stale);
    if (r.skipped) return void finishItem(item, 'skipped', r.skipped);
    const existing = req.ld.aiConfigs?.get(r.key);
    item.exists = !!existing;
    let adopt = false;
    if (existing && !ownsSegment(existing, snapshot.source.alias)) {
      const c = collision(item, { sourceId: prompt.source.sourceId, kind: 'prompt', uid: prompt.uid, id: prompt.id }, r.key, 'AI Config', 'AI Config key');
      if (c === 'skip') return void finishItem(item, 'skipped', `LaunchDarkly AI Config “${r.key}” exists and was not adopted`);
      if (c === 'open') return void finishItem(item, 'blocked', `LaunchDarkly AI Config “${r.key}” already exists`);
      adopt = true;
    }
    if (r.unresolved.length) return void finishItem(item, 'blocked', `${r.unresolved.length} open decision${r.unresolved.length === 1 ? '' : 's'}`);
    const stepId = `ai_config:${r.key}`;
    steps.set(stepId, {
      id: stepId,
      deps: [],
      op: 'upsert_ai_config',
      key: r.key,
      exists: !!existing,
      adopt,
      desired: r.desired,
      provenance: { sourceKind: 'statsig', sourceAlias: snapshot.source.alias, statsigType: 'prompt', statsigId: prompt.id, ...(prompt.version !== undefined ? { statsigVersion: prompt.version } : {}), statsigFingerprint: r.statsigFingerprint, decisionSetHash: r.decisionSetHash },
    });
  };

  const configsByUid = new Map(req.snapshots.flatMap((s) => s.configs.map((c) => [c.uid, c] as const)));
  const autotunesByUid = new Map(req.snapshots.flatMap((s) => s.autotunes.map((a) => [a.uid, a] as const)));
  const promptsByUid = new Map(req.snapshots.flatMap((s) => (s.prompts ?? []).map((p) => [p.uid, p] as const)));
  for (const uid of req.prompts ?? []) {
    const p = promptsByUid.get(uid);
    if (!p) {
      errors.push(`Prompt ${uid} is not in the current snapshots.`);
      continue;
    }
    planPrompt(p);
  }
  /** "gate new_checkout_flow" for an error about the other item owning a key: uids are `<sourceId>/<kind>/<id>`. */
  const describeOwner = (uid: string): string => {
    const [, kind, ...rest] = uid.split('/');
    return `${kind ?? 'item'} “${rest.join('/') || uid}”`;
  };
  for (const ldEnv of req.ldEnvs) {
    for (const uid of req.gates) {
      const gate = gatesByUid.get(uid);
      if (!gate) {
        errors.push(`Gate ${uid} is not in the current snapshots.`);
        continue;
      }
      planGate(gate, ldEnv, null, []);
    }
    for (const uid of req.configs ?? []) {
      const config = configsByUid.get(uid);
      if (!config) {
        errors.push(`Dynamic config ${uid} is not in the current snapshots.`);
        continue;
      }
      planConfig(config, ldEnv);
    }
    for (const uid of req.autotunes ?? []) {
      const a = autotunesByUid.get(uid);
      if (!a) {
        errors.push(`Autotune ${uid} is not in the current snapshots.`);
        continue;
      }
      planAutotune(a, ldEnv);
    }
    for (const uid of req.flags ?? []) {
      const f = neutralFlagsByUid.get(uid);
      if (!f) {
        errors.push(`Flag ${uid} is not in the current snapshots.`);
        continue;
      }
      // One PostHog project per stage (PLAN §22.1): a source mapped to another environment of this plan is planned there.
      if (plannedElsewhere(f.snapshot, ldEnv)) continue;
      planNeutralFlag(f.flag, f.snapshot, ldEnv, null, []);
    }
    for (const uid of req.segments ?? []) {
      const n = neutralSegmentsByUid.get(uid);
      const st = segmentsByUid.get(uid);
      const snapshot = n?.snapshot ?? st?.snapshot;
      if (!snapshot) {
        errors.push(`Segment ${uid} is not in the current snapshots.`);
        continue;
      }
      if (n && plannedElsewhere(snapshot, ldEnv)) continue;
      const sourceEnv = envFor(snapshot.source.sourceId, ldEnv);
      if (!sourceEnv) {
        errors.push(`No environment of ${snapshot.source.alias} is mapped to LaunchDarkly “${ldEnv}”, so segment ${uid} cannot be planned there.`);
        continue;
      }
      if (n) planNeutralSegment(snapshot, n.segment.key, sourceEnv, ldEnv, null);
      else if (st) planSegment(snapshot, st.segment.id, sourceEnv, ldEnv, null);
    }
  }

  // A step whose dependency was dropped (blocked item) can't run either. Dropping one step can
  // orphan its dependents, so the removal follows the reverse edges (each step is visited once).
  const dependents = new Map<string, string[]>();
  for (const s of steps.values()) {
    for (const d of s.deps) {
      const xs = dependents.get(d);
      if (xs) xs.push(s.id);
      else dependents.set(d, [s.id]);
    }
  }
  const orphaned = [...steps.values()].filter((s) => s.deps.some((d) => !steps.has(d))).map((s) => s.id);
  while (orphaned.length) {
    const id = orphaned.pop()!;
    if (!steps.delete(id)) continue;
    orphaned.push(...(dependents.get(id) ?? []));
  }
  // Drop dependencies nothing needs any more: shells whose environment steps were removed, and
  // segments / context kinds whose only dependents are blocked (they'd be written for nothing).
  // A step is kept while something still depends on it; dropping it may free its own dependencies.
  const requestedSegmentSteps = new Set([...items.values()].filter((i) => i.kind === 'segment' && !i.dependency && i.status === 'ready').map((i) => `segment:${i.ldEnv}:${i.ldKey}`));
  // Context kinds asked for on their own (guide step 3) are wanted even with nothing depending on them.
  const requestedKindSteps = new Set((req.contextKinds ?? []).flatMap((k) => [`context_kind:${k.key}`, ...(k.availableForExperiments ? [`randomization_unit:${k.key}`] : [])]));
  const wanted = (s: PlanStep) => s.op === 'update_flag_env' || s.op === 'create_bandit' || s.op === 'upsert_ai_config' || requestedSegmentSteps.has(s.id) || requestedKindSteps.has(s.id);
  const dependentCount = new Map<string, number>();
  for (const s of steps.values()) for (const d of new Set(s.deps)) dependentCount.set(d, (dependentCount.get(d) ?? 0) + 1);
  const unneeded = [...steps.values()].filter((s) => !wanted(s) && !(dependentCount.get(s.id) ?? 0)).map((s) => s.id);
  while (unneeded.length) {
    const s = steps.get(unneeded.pop()!);
    if (!s) continue;
    steps.delete(s.id);
    for (const d of new Set(s.deps)) {
      const n = (dependentCount.get(d) ?? 1) - 1;
      dependentCount.set(d, n);
      const dep = steps.get(d);
      if (n === 0 && dep && !wanted(dep)) unneeded.push(d);
    }
  }

  const ordered = topoSort([...steps.values()], errors, req.ldEnvs);
  const all = [...items.values()];
  const requested = all.filter((i) => !i.dependency);
  return {
    items: all,
    flags: rollUpFlags(all, ordered, req.ldEnvs),
    steps: ordered,
    decisions: [...decisions.values()],
    stale: [...stale.values()],
    errors,
    confirmEnvs: req.ldEnvs.filter((e) => req.ld.criticalEnvs.includes(e) && ordered.some((s) => 'ldEnv' in s && s.ldEnv === e)),
    ready: errors.length === 0 && requested.every((i) => i.status === 'ready' || i.status === 'skipped') && all.every((i) => i.status !== 'blocked' && i.status !== 'error'),
    requests: ordered.reduce((n, s) => n + requestsFor(s), 0),
  };
}

/** One row per LD flag key from the per-environment items; `ready` when its shell step survived. */
function rollUpFlags(items: PlanItem[], steps: PlanStep[], envOrder: string[]): PlanFlag[] {
  const shells = new Map(steps.flatMap((s) => (s.op === 'upsert_flag_shell' ? [[s.key, s] as const] : [])));
  const byKey = new Map<string, PlanItem[]>();
  for (const i of items) {
    if (i.kind !== 'gate' && i.kind !== 'config' && i.kind !== 'autotune' && i.kind !== 'flag') continue;
    byKey.set(i.ldKey, [...(byKey.get(i.ldKey) ?? []), i]);
  }
  const rank: Record<ItemStatus, number> = { ready: 0, blocked: 1, error: 2, skipped: 3 };
  const envIndex = (e: string) => (envOrder.indexOf(e) < 0 ? envOrder.length : envOrder.indexOf(e));
  const out: PlanFlag[] = [];
  for (const [ldKey, xs] of byKey) {
    const shell = shells.get(ldKey);
    const first = xs[0]!;
    const envs = [...xs].sort((a, b) => envIndex(a.ldEnv) - envIndex(b.ldEnv)).map((i) => ({ ldEnv: i.ldEnv, ...(i.statsigEnv ? { statsigEnv: i.statsigEnv } : {}), status: i.status, ...(i.reason ? { reason: i.reason } : {}) }));
    // Without a shell step nothing is written: report the least-bad environment outcome as the reason.
    const worst = [...xs].sort((a, b) => rank[a.status] - rank[b.status])[0]!;
    const variations = shell?.desired.variations.map((v) => ({ value: v.value, name: v.name })) ?? [];
    out.push({
      uid: first.uid,
      kind: first.kind as PlanFlag['kind'],
      entityId: first.entityId,
      sourceId: first.sourceId,
      ldKey,
      flagKind: shell ? (variations.every((v) => typeof v.value === 'boolean') ? 'boolean' : 'multivariate') : first.kind === 'gate' ? 'boolean' : 'multivariate',
      variations,
      exists: xs.some((i) => i.exists),
      adopt: shell?.adopt ?? false,
      owned: xs.some((i) => i.owned),
      inSync: xs.every((i) => i.sync === 'in_sync'),
      status: shell ? 'ready' : worst.status === 'ready' ? 'blocked' : worst.status,
      ...(shell ? {} : worst.reason ? { reason: worst.reason } : {}),
      envs,
    });
  }
  return out;
}

/** Writes per step, including the read that captures the pre-image of an item that exists. */
const REQUESTS: Record<PlanStep['op'], number> = { ensure_context_kind: 1, upsert_segment: 3, upsert_flag_shell: 2, update_flag_env: 2, ensure_randomization_unit: 2, upsert_metric: 2, create_bandit: 3, upsert_ai_config: 2 };

/**
 * A new item is created without reading it first (the plan's listing already said it is absent);
 * a big segment adds the CSV import and its status polls; scheduled changes add a list, a delete
 * each and a create each.
 */
export function requestsFor(s: PlanStep): number {
  let n = REQUESTS[s.op];
  if ('exists' in s && !s.exists) n -= 1;
  if (s.op === 'upsert_segment' && s.desired.unbounded) n += 4;
  if (s.op === 'update_flag_env' && s.desired.scheduledChanges?.length) n += 1 + 2 * s.desired.scheduledChanges.length;
  return n;
}

/**
 * Kahn's algorithm, stable by step id. Project-level steps come first (context kinds,
 * randomization units, metrics, every flag shell, AI Configs): a flag is created once and exists
 * in every environment. Then each environment in `envOrder` with its segments, targeting and
 * bandits, so a run reads "create the flags, then configure development, then staging". Steps in
 * a cycle are reported and left out.
 */
export function topoSort(steps: PlanStep[], errors: string[], envOrder: string[] = []): PlanStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  // Duplicate dependency ids count once, so a step is freed exactly when its last distinct dependency ran.
  const indegree = new Map(steps.map((s) => [s.id, new Set(s.deps.filter((d) => byId.has(d))).size]));
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const d of new Set(s.deps)) {
      if (!byId.has(d)) continue;
      const xs = dependents.get(d);
      if (xs) xs.push(s.id);
      else dependents.set(d, [s.id]);
    }
  }
  const PROJECT = ['context_kind', 'randomization_unit', 'metric', 'shell', 'ai_config'];
  const PER_ENV = ['segment', 'env', 'bandit'];
  const order = (id: string) => {
    const [op, env] = id.split(':') as [string, string?];
    const p = PROJECT.indexOf(op);
    if (p >= 0) return `0:${p}:${id}`;
    const e = envOrder.indexOf(env ?? '');
    return `1:${String(e < 0 ? envOrder.length : e).padStart(3, '0')}:${PER_ENV.indexOf(op)}:${id}`;
  };
  const keys = new Map(steps.map((s) => [s.id, order(s.id)]));
  const before = (a: string, b: string) => keys.get(a)!.localeCompare(keys.get(b)!);
  // The ready queue stays sorted: a freed step is inserted at its place (binary search), so the
  // whole queue is never re-sorted per step. Plans run to thousands of steps.
  const queue = steps.filter((s) => indegree.get(s.id) === 0).map((s) => s.id).sort(before);
  let head = 0;
  const insert = (id: string) => {
    let lo = head;
    let hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(queue[mid]!, id) <= 0) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, id);
  };
  const out: PlanStep[] = [];
  while (head < queue.length) {
    const id = queue[head++]!;
    out.push(byId.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) insert(next);
    }
  }
  if (out.length < steps.length) {
    const done = new Set(out.map((s) => s.id));
    const stuck = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
    errors.push(`Dependency cycle between: ${stuck.join(', ')}.`);
  }
  return out;
}

/** The provenance a flag carries (current or legacy keys, PLAN §3.3), or null when the console didn't create it. */
export function flagOwner(f: LdFlagState): { id: string; source: string; type?: string } | null {
  const p = readFlagProvenance(f);
  return p ? { id: p.id, source: p.source, ...(p.type ? { type: p.type } : {}) } : null;
}

/** Segments, metrics and experiments have no custom properties: ownership is the pair of tags. */
export function ownsSegment(s: { key?: string; tags: string[] }, alias: string): boolean {
  return hasMigratedTag(s.tags) && hasSourceTag(s.tags, alias);
}

export type MigrationStatus = 'not_in_ld' | 'not_migrated' | 'in_sync' | 'statsig_changed' | 'decisions_changed' | 'foreign' | 'other_source';

/**
 * Per-(flag, environment) status from LD provenance alone (PLAN §3.3, §14), so it's right on any
 * machine: compares the fingerprint recorded at sync with the current one. `expected` is the
 * StatSig entity asking; a flag migrated from another source or entity is `other_source`.
 */
export function migrationStatus(
  ldFlag: LdFlagState | undefined,
  ldEnv: string,
  current: { statsigFingerprint: string; decisionSetHash: string },
  expected?: { id: string; source: string },
): { status: MigrationStatus; syncedAt?: string } {
  if (!ldFlag) return { status: 'not_in_ld' };
  const owner = flagOwner(ldFlag);
  if (!owner) return { status: 'foreign' };
  if (expected && (owner.id !== expected.id || owner.source !== expected.source)) return { status: 'other_source' };
  const sync = readSync(ldFlag.customProperties, ldEnv);
  if (!sync) return { status: 'not_migrated' };
  const [fp, , syncedAt, dsh] = sync;
  const base = syncedAt ? { syncedAt } : {};
  if (fp !== current.statsigFingerprint) return { status: 'statsig_changed', ...base };
  if (dsh !== current.decisionSetHash) return { status: 'decisions_changed', ...base };
  return { status: 'in_sync', ...base };
}

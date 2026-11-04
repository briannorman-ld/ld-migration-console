/**
 * Migration orchestration for the UI (PLAN §9 "Migrate flow"): profile → mapping → plan → dry
 * run → execute → undo. Domain logic lives in @sslm/mapper, @sslm/planner and @sslm/executor;
 * this module wires them to the store, the LD session and the StatSig source.
 */
import { useSyncExternalStore } from "react";
import type { Autotune, CanonicalSnapshot, Config, Gate, NeutralFlag, NeutralSegment, Prompt, Segment } from "@sslm/canonical";
import { Executor, newRun, type ResourceChange, type RunRecord } from "@sslm/executor";
import type { CapabilityMatrix, LdFlagSummary } from "@sslm/ld-client";
import {
  mapAutotune,
  mapConfig,
  mapGate,
  mapNeutralFlag,
  mapNeutralSegment,
  mapPrompt,
  mapSegment,
  reconcileProfile,
  type AutotuneMapResult,
  type ConfigMapResult,
  type DecisionPoint,
  type EnvTarget,
  type GateMapResult,
  type IdListCoverages,
  type IdLists,
  type LdDirectory,
  type MapperCapabilities,
  type MappingProfile,
  type NeutralFlagMapResult,
  type NeutralSegmentMapResult,
  type PromptMapResult,
  type Resolution,
  type SegmentMapResult,
  optionLabel,
} from "@sslm/mapper";
import {
  planMigration,
  type LdFlagState,
  type LdProjectState,
  type Plan,
  type PlanMappers,
} from "@sslm/planner";
import { STATSIG_CONSOLE_BASE_URL, StatsigConsoleClient } from "@sslm/statsig-client";
import type { SourceRecord, RunJournalRecord } from "@sslm/store";
import { demoKey, startDemoMock } from "./demo.ts";
import { coalescedJournal } from "./journal.ts";
import { readsHold, trackReads, type ProfileRead } from "./profileReads.ts";
import { learnCapability, ldClient, ldSessionSnapshot, mergeLdFlags, mergeLdSegments, refreshLdLists, type LdSession } from "./ld.ts";
import { latestChanges, listsTouchedByRun, staleAfterRun } from "./reconcile.ts";
import { secrets } from "./secrets.ts";
import { store } from "./store.ts";

// ---------------------------------------------------------------------------------------------
// Profile and inputs
// ---------------------------------------------------------------------------------------------

/** Load the stored profile and fold in new environments / LD environments (never overwriting). */
export async function ensureProfile(
  workspaceId: string,
  snapshots: CanonicalSnapshot[],
  ldEnvs: { key: string; name: string }[],
  hints?: Record<string, string>,
): Promise<MappingProfile> {
  const stored = await store.getProfile(workspaceId);
  // `maintainers` and `teams` are kept present: the mapping memo tracks the profile entries a
  // mapping read (lib/profileReads.ts), and the first People-step choice must be a new entry in
  // an object every mapping saw, not an object where every mapping saw nothing.
  const base: MappingProfile = {
    maintainers: {},
    teams: {},
    ...(stored ?? { version: 1, sources: {}, attributes: {}, policies: {} }),
  };
  const next = ldEnvs.length
    ? reconcileProfile(base, snapshots, ldEnvs, hints)
    : base;
  if (!stored || JSON.stringify(next) !== JSON.stringify(stored))
    await store.saveProfile(workspaceId, next);
  return next;
}

export function mapperCapabilities(
  matrix: CapabilityMatrix | undefined,
  contextKinds: string[] | undefined,
): MapperCapabilities {
  const cap = (k: string) =>
    matrix?.capabilities.find((c) => c.key === k)?.status ?? "unknown";
  return {
    prerequisites: cap("prerequisites"),
    contextKinds: cap("context_kinds"),
    bigSegments: cap("big_segments"),
    scheduledChanges: cap("scheduled_changes"),
    existingContextKinds: contextKinds ?? ["user"],
  };
}

export function ldFlagState(f: LdFlagSummary): LdFlagState {
  return {
    key: f.key,
    tags: f.tags ?? [],
    customProperties: (f.customProperties ??
      {}) as LdFlagState["customProperties"],
    kind: f.kind ?? null,
    archived: f.archived ?? null,
    ...(f.variations ? { variations: f.variations.map((v) => ({ value: v.value, name: v.name ?? null })) } : {}),
  };
}

export function ldProjectState(ld: LdSession): LdProjectState {
  const segments: Record<string, Map<string, { key: string; tags: string[] }>> = {};
  for (const [env, list] of Object.entries(ld.segments ?? {})) segments[env] = new Map(list.map((s) => [s.key, { key: s.key, tags: s.tags ?? [] }]));
  const experiments: Record<string, Map<string, { key: string; tags: string[]; type: string | null; archived: boolean; iterationStatus: string | null }>> = {};
  for (const [env, list] of Object.entries(ld.experiments ?? {})) {
    experiments[env] = new Map(
      list.map((e) => [e.key, { key: e.key, tags: e.tags ?? [], type: e.type ?? null, archived: e.archivedDate != null, iterationStatus: e.draftIteration?.status ?? e.currentIteration?.status ?? null }]),
    );
  }
  return {
    flags: new Map((ld.flags?.items ?? []).map((f) => [f.key, ldFlagState(f)])),
    segments,
    contextKinds: ld.contextKinds ?? ["user"],
    criticalEnvs: (ld.matrix?.environments ?? []).filter((e) => e.critical || /prod/i.test(e.key)).map((e) => e.key),
    ...(ld.metrics ? { metrics: new Map(ld.metrics.map((m) => [m.key, { key: m.key, tags: m.tags ?? [], eventKey: m.eventKey ?? null, kind: m.kind ?? null }])) } : {}),
    experiments,
    ...(ld.randomizationUnits ? { randomizationUnits: ld.randomizationUnits } : {}),
    ...(ld.aiConfigs ? { aiConfigs: new Map(ld.aiConfigs.map((a) => [a.key, { key: a.key, tags: a.tags ?? [] }])) } : {}),
  };
}

export function statsigEnvFor(
  profile: MappingProfile | undefined,
  sourceId: string,
  ldEnv: string,
): string | undefined {
  const m = profile?.sources[sourceId]?.envMapping ?? {};
  return Object.keys(m).find((k) => m[k] === ldEnv);
}

/** Every (StatSig env → LD env) pair a source can migrate. Without LD, StatSig envs map to themselves. */
export function envTargets(
  profile: MappingProfile | undefined,
  snapshot: CanonicalSnapshot,
  connected: boolean,
): EnvTarget[] {
  if (!connected)
    return snapshot.environments.map((e) => ({ statsig: e.name, ld: e.name }));
  const m = profile?.sources[snapshot.source.sourceId]?.envMapping ?? {};
  return snapshot.environments
    .filter((e) => m[e.name])
    .map((e) => ({ statsig: e.name, ld: m[e.name]! }));
}

export interface MappingInputs {
  profile: MappingProfile;
  resolutions: ReadonlyMap<string, Resolution>;
  capabilities: MapperCapabilities;
  /** LD members and teams, for owner → maintainer matching (PLAN §8.3). */
  directory: LdDirectory;
  idLists: IdLists;
  /** Reconciliation results for uploaded raw-ID lists (PLAN §4.2), by segment uid. */
  coverage: IdListCoverages;
  now: string;
}

/** The mapper's view of the LD account's people: what the session read, and whether it could. Reads only `members`, `teams` and `matrix`. */
export function ldDirectory(ld: Pick<LdSession, 'members' | 'teams' | 'matrix'>): LdDirectory {
  const cap = (k: string) => ld.matrix?.capabilities.find((c) => c.key === k)?.status;
  return {
    members: (ld.members ?? []).map((m) => ({ id: m._id, email: m.email })),
    teams: (ld.teams ?? []).map((t) => ({ key: t.key, ...(t.name ? { name: t.name } : {}) })),
    membersReadable: !!ld.members && cap("members") !== "not_permitted" && cap("members") !== "unavailable",
    teamsReadable: !!ld.teams && cap("teams") !== "not_permitted" && cap("teams") !== "unavailable",
  };
}

/*
 * Mapping memo. The explorers, the Decisions view, the readiness line and collectDecisions all map
 * the same entities with the same inputs, and React re-renders on every click, so without this the
 * whole project was re-mapped (0.15 ms per gate per environment: half a second on a real project)
 * for each selection, filter keystroke or nav change. Results are keyed on the identity of what the
 * mapper reads: the ID lists' coverage, the capabilities and the LD directory (each a new object
 * only when it changed; useMigration keeps them stable), then the snapshot (a new object after a
 * sync), then entity, environment and `now`. The MigrationContext that carries them changes
 * identity on every LD session patch (a probe step, a flag refresh, a monitoring check), which
 * must not throw the whole project's mapping away.
 *
 * Resolutions, ID lists and the profile are not keys: each is one object rebuilt whenever one
 * part of it changes (a decision saved, a list fetched, a policy or maintainer chosen), and
 * remapping every entity of a large project then froze the page for seconds. The mapper consults a
 * resolution only by the id of a decision it raised (`lookupResolution`), a list only by the uid
 * of a segment it uses, and the profile only at a handful of paths (lib/profileReads.ts), so each
 * result remembers what it read and stays valid while those entries are unchanged in the new
 * object. Results are treated as immutable by callers.
 */
interface MemoEntry {
  value: unknown;
  /** The profile the value was computed (or last validated) against, and the paths it read in it (undefined: only the same object is a hit). */
  profile: MappingProfile;
  profileReads: ProfileRead[] | undefined;
  /** The resolutions map the value was computed (or last validated) against. */
  resolutions: ReadonlyMap<string, Resolution>;
  /** Decision ids the mapping looked up; undefined when the value does not say (then only the same map is a hit). */
  consulted: string[] | undefined;
  /**
   * The ID lists the value was computed (or last validated) against, and the segment uids it
   * looked up in them (undefined when it enumerated them, then only the same object is a hit).
   * Like resolutions, ID lists are not a key: each list fetched after a sync is a new object, and
   * a gate is affected only by the lists of the segments it uses.
   */
  idLists: IdLists;
  consultedLists: string[] | undefined;
}
type MemoLeaf = Map<string, MemoEntry>;
const mapMemo = new WeakMap<object, WeakMap<object, WeakMap<object, WeakMap<CanonicalSnapshot, MemoLeaf>>>>();

/** The decision ids a mapping result looked up, from its applied, unresolved and stale decisions. */
function consultedDecisionIds(value: unknown): string[] | undefined {
  const v = value as { applied?: { decision: { id: string } }[]; unresolved?: { id: string }[]; stale?: { decision: { id: string } }[] } | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.applied) || !Array.isArray(v.unresolved)) return undefined;
  return [...new Set([...v.applied.map((a) => a.decision.id), ...v.unresolved.map((d) => d.id), ...(v.stale ?? []).map((x) => x.decision.id)])];
}

/** What `lookupResolution` reads of a resolution; `decidedAt` and notes do not change a mapping. */
const sameResolution = (a: Resolution | undefined, b: Resolution | undefined): boolean => a === b || (!!a && !!b && a.optionKey === b.optionKey && a.scope === b.scope && a.fingerprint === b.fingerprint);

function stillValid(e: MemoEntry, i: MappingInputs): boolean {
  const profile = e.profile === i.profile || (!!e.profileReads && isObject(i.profile) && readsHold(e.profileReads, i.profile));
  if (!profile) return false;
  const resolutions = e.resolutions === i.resolutions || (!!e.consulted && e.consulted.every((id) => sameResolution(e.resolutions.get(id), i.resolutions.get(id))));
  if (!resolutions) return false;
  const idLists = i.idLists ?? NO_LISTS;
  if (e.idLists === idLists) return true;
  if (!e.consultedLists) return false;
  return e.consultedLists.every((uid) => e.idLists[uid] === idLists[uid]);
}

const NO_LISTS: IdLists = {};

/**
 * `idLists` wrapped so the lookups a mapping makes are recorded. Enumerating the lists (keys,
 * spread) records "every list", and the result is then valid only for the same object.
 */
function trackedIdLists(idLists: IdLists): { lists: IdLists; consulted: () => string[] | undefined } {
  const seen = new Set<string>();
  let all = false;
  const lists = new Proxy(idLists, {
    get(t, p, r) {
      if (typeof p === 'string') seen.add(p);
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (typeof p === 'string') seen.add(p);
      return Reflect.has(t, p);
    },
    ownKeys(t) {
      all = true;
      return Reflect.ownKeys(t);
    },
  });
  return { lists, consulted: () => (all ? undefined : [...seen]) };
}

function nested<K extends object, V extends object>(map: WeakMap<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (!v) map.set(key, (v = make()));
  return v;
}

/** Stands in for an input a caller left out (tests build partial contexts), so it still keys the memo. */
const MISSING = {};
const isObject = (v: unknown): v is object => v !== null && typeof v === 'object';
const part = (v: unknown): object => (isObject(v) ? v : MISSING);

/**
 * `compute` receives the ID lists and the profile to hand the mapper: tracked views, so the entry
 * knows which lists and which profile entries it depends on.
 */
function memoized<T>(i: MappingInputs, snapshot: CanonicalSnapshot, key: string, compute: (idLists: IdLists, profile: MappingProfile) => T): T {
  const byCapabilities = nested(mapMemo, part(i.coverage), () => new WeakMap());
  const byDirectory = nested(byCapabilities, part(i.capabilities), () => new WeakMap());
  const bySnapshot = nested(byDirectory, part(i.directory), () => new WeakMap());
  const byKey = nested(bySnapshot, snapshot, () => new Map<string, MemoEntry>());
  const full = `${key}|${i.now}`;
  const idLists = i.idLists ?? NO_LISTS;
  const hit = byKey.get(full);
  if (hit && stillValid(hit, i)) {
    hit.profile = i.profile;
    hit.resolutions = i.resolutions;
    hit.idLists = idLists;
    return hit.value as T;
  }
  const lists = trackedIdLists(idLists);
  const profile = isObject(i.profile) ? trackReads(i.profile) : undefined;
  const value = compute(lists.lists, profile ? profile.value : i.profile);
  byKey.set(full, { value, profile: i.profile, profileReads: profile?.reads(), resolutions: i.resolutions, consulted: consultedDecisionIds(value), idLists, consultedLists: lists.consulted() });
  return value;
}

const memoKey = (kind: string, uid: string, env: EnvTarget) => `${kind}|${uid}|${env.statsig}|${env.ld}`;

export function mapGateFor(
  snapshot: CanonicalSnapshot,
  gate: Gate,
  env: EnvTarget,
  i: MappingInputs,
): GateMapResult {
  return memoized(i, snapshot, memoKey("gate", gate.uid, env), (idLists, profile) =>
    mapGate({
      canonical: { snapshot, idLists, coverage: i.coverage },
      entity: gate,
      profile,
      resolutions: i.resolutions,
      capabilities: i.capabilities,
      env,
      now: i.now,
      directory: i.directory,
    }),
  );
}

export function mapSegmentFor(
  snapshot: CanonicalSnapshot,
  segment: Segment,
  env: EnvTarget,
  i: MappingInputs,
): SegmentMapResult {
  return memoized(i, snapshot, memoKey("segment", segment.uid, env), (idLists, profile) =>
    mapSegment({
      canonical: { snapshot, idLists, coverage: i.coverage },
      entity: segment,
      profile,
      resolutions: i.resolutions,
      capabilities: i.capabilities,
      env,
      now: i.now,
      directory: i.directory,
    }),
  );
}

export function mapConfigFor(snapshot: CanonicalSnapshot, config: Config, env: EnvTarget, i: MappingInputs): ConfigMapResult {
  return memoized(i, snapshot, memoKey("config", config.uid, env), (idLists, profile) =>
    mapConfig({ canonical: { snapshot, idLists, coverage: i.coverage }, entity: config, profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now, directory: i.directory }),
  );
}

export function mapAutotuneFor(snapshot: CanonicalSnapshot, autotune: Autotune, env: EnvTarget, i: MappingInputs): AutotuneMapResult {
  return memoized(i, snapshot, memoKey("autotune", autotune.uid, env), (idLists, profile) =>
    mapAutotune({ canonical: { snapshot, idLists, coverage: i.coverage }, entity: autotune, profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now, directory: i.directory }),
  );
}

/** Neutral (LD-source) flag → desired LD flag (PLAN §20), memoized like the StatSig mappers. */
export function mapNeutralFlagFor(snapshot: CanonicalSnapshot, flag: NeutralFlag, env: EnvTarget, i: MappingInputs): NeutralFlagMapResult {
  return memoized(i, snapshot, memoKey("flag", flag.uid, env), (_lists, profile) => mapNeutralFlag({ canonical: { snapshot }, entity: flag, profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now, directory: i.directory }));
}

/** StatSig prompt → LD AI Config shell (PLAN §6). Project-level: the environment only keys the memo. */
export function mapPromptFor(snapshot: CanonicalSnapshot, prompt: Prompt, i: MappingInputs): PromptMapResult {
  const env = { statsig: "", ld: "" };
  return memoized(i, snapshot, memoKey("prompt", prompt.uid, env), (_lists, profile) => mapPrompt({ canonical: { snapshot }, entity: prompt, profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now, directory: i.directory }));
}

export function mapNeutralSegmentFor(snapshot: CanonicalSnapshot, segment: NeutralSegment, env: EnvTarget, i: MappingInputs): NeutralSegmentMapResult {
  return memoized(i, snapshot, memoKey("nsegment", segment.uid, env), (_lists, profile) => mapNeutralSegment({ canonical: { snapshot }, entity: segment, profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now, directory: i.directory }));
}

export interface DecisionInstance {
  decision: DecisionPoint;
  /** Where it was raised: which entity and environments. */
  entityId: string;
  envs: string[];
  resolvedWith?: { optionKey: string; via: "resource" | "policy" };
  stale?: Resolution;
}

/**
 * Every decision across the workspace: all live gates, configs, segments and autotunes, in every mapped environment.
 * Open ones come with the environments they apply to; resolved ones with their answer (decision log).
 */
export function collectDecisions(
  snapshots: CanonicalSnapshot[],
  profile: MappingProfile,
  connected: boolean,
  i: MappingInputs,
): DecisionInstance[] {
  const byId = new Map<string, DecisionInstance>();
  const add = (
    d: DecisionPoint,
    entityId: string,
    env: string,
    resolved?: DecisionInstance["resolvedWith"],
    stale?: Resolution,
  ) => {
    const x = byId.get(d.id) ?? {
      decision: d,
      entityId,
      envs: [],
      ...(resolved ? { resolvedWith: resolved } : {}),
      ...(stale ? { stale } : {}),
    };
    if (!x.envs.includes(env)) x.envs.push(env);
    byId.set(d.id, x);
  };
  for (const snap of snapshots) {
    for (const env of envTargets(profile, snap, connected)) {
      const results = [
        ...snap.gates.filter((g) => !g.archived).map((g) => mapGateFor(snap, g, env, i)),
        ...snap.configs.filter((c) => !c.archived).map((c) => mapConfigFor(snap, c, env, i)),
        ...snap.segments.filter((s) => !s.archived).map((s) => mapSegmentFor(snap, s, env, i)),
        ...snap.autotunes.filter((a) => !a.archived).map((a) => mapAutotuneFor(snap, a, env, i)),
        ...(snap.neutral?.flags ?? []).filter((f) => !f.archived).map((f) => mapNeutralFlagFor(snap, f, env, i)),
        ...(snap.neutral?.segments ?? []).filter((s) => !s.archived).map((s) => mapNeutralSegmentFor(snap, s, env, i)),
        ...(snap.prompts ?? []).filter((p) => !p.archived).map((p) => mapPromptFor(snap, p, i)),
      ];
      for (const r of results) {
        const staleById = new Map(
          r.stale.map((s) => [s.decision.id, s.previous]),
        );
        for (const d of r.unresolved)
          add(d, r.entityId, env.ld, undefined, staleById.get(d.id));
        for (const a of r.applied)
          add(a.decision, r.entityId, env.ld, {
            optionKey: a.optionKey,
            via: a.via,
          });
      }
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------------------------
// ID lists (PLAN §4.1: big lists are fetched on demand)
// ---------------------------------------------------------------------------------------------

export async function loadIdLists(workspaceId: string): Promise<IdLists> {
  return Object.fromEntries(
    (await store.listIdLists(workspaceId)).map((r) => [r.uid, r.ids]),
  );
}

/** Lists up to this size load automatically after a sync; bigger ones on request from Source warnings. */
export const ID_LIST_AUTO_MAX = 15_000;
/** Upper bound for an on-demand load: one Console API page per 100 IDs, within the 900-per-15-minutes budget. */
export const ID_LIST_FETCH_MAX = 250_000;

export interface IdListFetchReport {
  idLists: IdLists;
  /** Segments whose lists were loaded by this call. */
  loaded: string[];
  /** Segments above the requested limit, left deferred. */
  tooBig: string[];
  /** Sources whose lists couldn't be read, and why (no key in memory, not a Console API source). */
  blocked: { sourceId: string; reason: string }[];
}

/** A Console API client that can read a source's ID lists, and which source's key it uses. */
export interface ConsoleAccess {
  client: StatsigConsoleClient;
  /** The source whose Console API key is used: the source itself, or a Console API source of the same project for a config spec. */
  via: { sourceId: string; label: string; own: boolean };
}

/** Why a source's ID lists can't be read from StatSig right now. */
export interface ConsoleAccessBlocked {
  blocked: string;
  /** True when entering a read-only Console API key for this source would unblock it. */
  needsKey: boolean;
}

/**
 * How a source's ID-list members can be read from StatSig (PLAN §4.2). A Console API source uses
 * its own key. A config spec carries only hashed IDs, but the same project's members are one
 * Console API call away: use a read-only key entered for the spec source, or borrow the key of a
 * Console API source in the workspace, preferring one whose snapshot holds `segmentId`. The caller
 * then reconciles what StatSig returns with the spec's hashes, so nothing is taken on trust.
 */
export async function consoleAccessFor(source: SourceRecord, sources: SourceRecord[], snapshots: CanonicalSnapshot[], segmentId?: string): Promise<ConsoleAccess | ConsoleAccessBlocked> {
  const keyFor = async (s: SourceRecord): Promise<string | undefined> => {
    if (s.isDemo && s.kind === "console_api") {
      await startDemoMock();
      return demoKey();
    }
    return secrets.get("statsig", s.id);
  };
  const open = async (s: SourceRecord, own: boolean): Promise<ConsoleAccess | undefined> => {
    const apiKey = await keyFor(s);
    if (!apiKey) return undefined;
    return { client: new StatsigConsoleClient({ baseUrl: s.baseUrl ?? STATSIG_CONSOLE_BASE_URL, apiKey }), via: { sourceId: s.id, label: s.label, own } };
  };
  if (source.kind === "console_api") {
    return (await open(source, true)) ?? { blocked: `No Console API key for ${source.label} in memory. Enter it under Connections (or unlock the vault), then retry.`, needsKey: false };
  }
  if (source.kind !== "config_spec") return { blocked: "ID lists can only be read through the StatSig Console API.", needsKey: false };
  const own = await open(source, true);
  if (own) return own;
  const hasSegment = (s: SourceRecord) => !!segmentId && !!snapshots.find((snap) => snap.source.sourceId === s.id)?.segments.some((seg) => seg.id === segmentId && seg.segmentType !== "rule_based");
  const consoles = sources.filter((s) => s.kind === "console_api" && s.workspaceId === source.workspaceId && s.id !== source.id).sort((a, b) => Number(hasSegment(b)) - Number(hasSegment(a)));
  for (const s of consoles) {
    const access = await open(s, false);
    if (access) return access;
  }
  return {
    blocked: consoles.length
      ? `A config spec carries only hashed IDs. ${consoles.map((s) => s.label).join(", ")} could read them, but ${consoles.length === 1 ? "its" : "their"} Console API key is not in memory: unlock the vault or enter a read-only key here.`
      : "A config spec carries only hashed IDs. Enter a read-only Console API key for this StatSig project to read them from StatSig, or upload a raw-ID CSV.",
    needsKey: true,
  };
}

/** Fetch members of deferred ID-list segments up to `max` IDs (default: the automatic limit) from Console API sources. */
export async function fetchDeferredIdLists(workspaceId: string, sources: SourceRecord[], snapshots: CanonicalSnapshot[], have: IdLists, onProgress?: (m: string) => void, max = ID_LIST_AUTO_MAX): Promise<IdLists> {
  return (await fetchDeferredIdListsReport(workspaceId, sources, snapshots, have, onProgress, max)).idLists;
}

/** Like fetchDeferredIdLists, and says what it could not load, so the warnings page can offer a retry. */
export async function fetchDeferredIdListsReport(workspaceId: string, sources: SourceRecord[], snapshots: CanonicalSnapshot[], have: IdLists, onProgress?: (m: string) => void, max = ID_LIST_AUTO_MAX): Promise<IdListFetchReport> {
  const out: IdLists = { ...have };
  const report: IdListFetchReport = { idLists: out, loaded: [], tooBig: [], blocked: [] };
  for (const snap of snapshots) {
    const source = sources.find((s) => s.id === snap.source.sourceId);
    const deferred = snap.segments.filter((s) => s.segmentType === "id_list" && !s.archived && !s.idList?.ids && !s.idList?.hashed && !out[s.uid]);
    const pending = deferred.filter((s) => (s.idList?.count ?? 0) <= max);
    report.tooBig.push(...deferred.filter((s) => (s.idList?.count ?? 0) > max).map((s) => s.id));
    if (!pending.length) continue;
    if (source?.kind !== "console_api") {
      report.blocked.push({ sourceId: snap.source.sourceId, reason: "ID lists can only be read through the Console API; a config spec carries hashed IDs." });
      continue;
    }
    const access = await consoleAccessFor(source, sources, snapshots);
    if ("blocked" in access) {
      report.blocked.push({ sourceId: source.id, reason: access.blocked });
      continue;
    }
    for (const seg of pending) {
      onProgress?.(`Loading ${seg.idList?.count ?? ""} IDs for segment ${seg.id}…`);
      const list = await access.client.getIdList(seg.id);
      out[seg.uid] = list.ids;
      report.loaded.push(seg.id);
      await store.saveIdList({ uid: seg.uid, workspaceId, sourceId: source.id, fetchedAt: new Date().toISOString(), ids: list.ids, origin: "console" });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Plan and run
// ---------------------------------------------------------------------------------------------

/** What the user ticked to migrate: entity uids by kind. */
export interface MigrationSelection {
  gates: string[];
  configs?: string[];
  autotunes: string[];
  /** Neutral (LD-source) flag uids, PLAN §20. */
  flags?: string[];
  /** Segment uids chosen on their own (LD-source segments). */
  segments?: string[];
  /** Context kinds to create on their own (the guide's Context kinds step), or to enable for experiments. */
  contextKinds?: { key: string; unitType: string; availableForExperiments?: boolean }[];
  /** Prompt uids → LD AI Configs (project-level). */
  prompts?: string[];
}

/** Only project-level steps (context kinds, AI Configs): the run needs no target environment. */
export function isProjectOnlySelection(sel: MigrationSelection): boolean {
  return (!!sel.contextKinds?.length || !!sel.prompts?.length) && sel.gates.length === 0 && !sel.configs?.length && sel.autotunes.length === 0 && !sel.flags?.length && !sel.segments?.length;
}

export function describeSelection(sel: MigrationSelection): string {
  const configs = sel.configs ?? [];
  const flags = sel.flags ?? [];
  const segments = sel.segments ?? [];
  const kinds = sel.contextKinds ?? [];
  const prompts = sel.prompts ?? [];
  const parts = [
    kinds.length ? `${kinds.length} context kind${kinds.length === 1 ? "" : "s"}` : "",
    prompts.length ? `${prompts.length} AI Config${prompts.length === 1 ? "" : "s"}` : "",
    sel.gates.length ? `${sel.gates.length} gate${sel.gates.length === 1 ? "" : "s"}` : "",
    configs.length ? `${configs.length} dynamic config${configs.length === 1 ? "" : "s"}` : "",
    sel.autotunes.length ? `${sel.autotunes.length} autotune${sel.autotunes.length === 1 ? "" : "s"}` : "",
    flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"}` : "",
    segments.length ? `${segments.length} segment${segments.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" and ") || "nothing";
}

/**
 * The mapping memo as the planner's mappers: a plan maps each selected item in each environment
 * through the same cache the explorers, guide and Decisions view fill, so building it (and
 * rebuilding it when the user adds an environment in the plan modal) costs no mapping the screen
 * has already done. The planner hands over the same profile, resolutions, ID lists, coverage,
 * capabilities, directory and `now` it was given, so a cached result is the one it would compute.
 */
function planMappers(i: MappingInputs): PlanMappers {
  return {
    mapGate: (a) => mapGateFor(a.canonical.snapshot, a.entity, a.env, i),
    mapSegment: (a) => mapSegmentFor(a.canonical.snapshot, a.entity, a.env, i),
    mapConfig: (a) => mapConfigFor(a.canonical.snapshot, a.entity, a.env, i),
    mapAutotune: (a) => mapAutotuneFor(a.canonical.snapshot, a.entity, a.env, i),
    mapNeutralFlag: (a) => mapNeutralFlagFor(a.canonical.snapshot, a.entity, a.env, i),
    mapNeutralSegment: (a) => mapNeutralSegmentFor(a.canonical.snapshot, a.entity, a.env, i),
    mapPrompt: (a) => mapPromptFor(a.canonical.snapshot, a.entity, i),
  };
}

export function buildPlan(input: { selection: MigrationSelection; ldEnvs: string[]; snapshots: CanonicalSnapshot[]; ld: LdSession; skipInSync?: boolean } & MappingInputs): Plan {
  return planMigration({
    mappers: planMappers(input),
    ...(input.skipInSync ? { skipInSync: true } : {}),
    gates: input.selection.gates,
    configs: input.selection.configs ?? [],
    autotunes: input.selection.autotunes,
    flags: input.selection.flags ?? [],
    segments: input.selection.segments ?? [],
    contextKinds: input.selection.contextKinds ?? [],
    prompts: input.selection.prompts ?? [],
    ldEnvs: input.ldEnvs,
    snapshots: input.snapshots,
    idLists: input.idLists,
    coverage: input.coverage,
    profile: input.profile,
    resolutions: input.resolutions,
    capabilities: input.capabilities,
    directory: input.directory,
    ld: ldProjectState(input.ld),
    now: input.now,
  });
}

// Live progress of the run executing in this tab (one at a time per workspace).
const active = new Map<string, RunRecord>();
// The cancel controller of that run; aborting it stops the executor after the write in flight.
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useActiveRun(workspaceId: string): RunRecord | undefined {
  return useSyncExternalStore(subscribe, () => active.get(workspaceId));
}

/**
 * Cancel the run (execute, resume or undo) executing in this tab for the workspace. The executor
 * finishes journaling the step in flight and records the run as `stopped`; `useActiveRun`
 * keeps reporting until then. Returns false when nothing is running.
 */
export function cancelRun(workspaceId: string): boolean {
  const ctrl = controllers.get(workspaceId);
  if (!ctrl || ctrl.signal.aborted) return false;
  ctrl.abort(new DOMException("Cancelled by the user.", "AbortError"));
  notify();
  return true;
}

/** True between the user's cancel and the executor finishing the step in flight. */
export function useCancelling(workspaceId: string): boolean {
  return useSyncExternalStore(subscribe, () => controllers.get(workspaceId)?.signal.aborted ?? false);
}

/** `{ sourceId, takenAt }` per snapshot: stored on the run so those snapshots survive pruning. */
export type RunSnapshotRefs = { sourceId: string; takenAt: string }[];
export const snapshotRefs = (snapshots: CanonicalSnapshot[]): RunSnapshotRefs =>
  snapshots.map((s) => ({ sourceId: s.source.sourceId, takenAt: s.takenAt }));

function executor(
  workspaceId: string,
  ld: LdSession,
  snapshots: RunSnapshotRefs | undefined,
  changes: ResourceChange[],
): Executor {
  if (!ld.projectKey) throw new Error("Choose a LaunchDarkly project first.");
  return new Executor({
    client: ldClient(workspaceId),
    projectKey: ld.projectKey,
    journal: coalescedJournal((r) => store.saveRun(snapshots ? ({ ...r, snapshots } satisfies RunJournalRecord) : r)),
    // What the run wrote, as LD returned it: merged into the session when the run ends (applyRunResults).
    onResource: (c) => changes.push(c),
    ...(ld.identity?.tokenName ? { actor: ld.identity.tokenName } : {}),
    onProgress: (r) => {
      active.set(workspaceId, r);
      notify();
    },
    // PLAN §5.2: the first write a plan refuses (or allows) settles an "unknown" capability.
    onCapability: (c) => void learnCapability(workspaceId, c),
  });
}

/**
 * Re-read the approval requests a run is waiting on (PLAN §5.1). Steps whose request was applied
 * get their provenance written and complete; declined ones fail. The flags those writes returned
 * (with what approvers applied) go into the session, so the status strip follows.
 */
export async function checkRunApprovals(workspaceId: string, ld: LdSession, run: RunRecord): Promise<RunRecord> {
  const before = run.steps.filter((s) => s.status === "pending_approval").length;
  const changes: ResourceChange[] = [];
  const r = await executor(workspaceId, ld, (run as RunJournalRecord).snapshots, changes).checkApprovals(await journaled(run));
  const after = r.steps.filter((s) => s.status === "pending_approval").length;
  if (after !== before) await applyRunResults(workspaceId, r, changes);
  return r;
}

export const pendingApprovals = (run: RunRecord) => run.steps.filter((s) => s.status === "pending_approval").length;

/**
 * The run as journaled, pre-images included, as a fresh record the executor may mutate. The run
 * lists on screen come without pre-images (the store keeps those apart, so listing the runs does
 * not read every flag the runs ever touched); undo restores from them, and resume and the approval
 * check tell an item that existed from one the run created by them.
 */
async function journaled(run: RunRecord): Promise<RunRecord> {
  return (await store.getRun(run.id)) ?? structuredClone(run);
}

/**
 * Run with a Web Locks guard (one running tab per workspace) and a beforeunload warning
 * (PLAN §3.6). If the tab closes anyway, the journal lets the run resume on reopen.
 */
async function guarded<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const warn = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener("beforeunload", warn);
  try {
    if (!navigator.locks) return await fn();
    return (await navigator.locks.request(
      `sslm-run-${workspaceId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          throw new Error(
            "Another tab is running a migration for this workspace.",
          );
        return fn();
      },
    )) as T;
  } finally {
    window.removeEventListener("beforeunload", warn);
  }
}

export async function executePlan(
  workspaceId: string,
  ld: LdSession,
  plan: Plan,
  opts: { dryRun: boolean; label: string; snapshots?: RunSnapshotRefs },
): Promise<RunRecord> {
  const run = newRun({
    id: crypto.randomUUID(),
    workspaceId,
    projectKey: ld.projectKey!,
    label: opts.label,
    dryRun: opts.dryRun,
    ...(ld.identity?.tokenName ? { actor: ld.identity.tokenName } : {}),
    steps: plan.steps,
    now: new Date(),
  });
  const changes: ResourceChange[] = [];
  return finishRun(
    workspaceId,
    (signal) => executor(workspaceId, ld, opts.snapshots, changes).run(run, signal),
    !opts.dryRun,
    changes,
  );
}

export async function resumeRun(
  workspaceId: string,
  ld: LdSession,
  run: RunRecord,
): Promise<RunRecord> {
  const changes: ResourceChange[] = [];
  return finishRun(
    workspaceId,
    async (signal) =>
      executor(workspaceId, ld, (run as RunJournalRecord).snapshots, changes).run(
        await journaled(run),
        signal,
      ),
    true,
    changes,
  );
}

export async function undoRun(
  workspaceId: string,
  ld: LdSession,
  run: RunRecord,
): Promise<RunRecord> {
  const changes: ResourceChange[] = [];
  return finishRun(
    workspaceId,
    async (signal) =>
      executor(workspaceId, ld, (run as RunJournalRecord).snapshots, changes).undo(
        await journaled(run),
        signal,
      ),
    true,
    changes,
  );
}

async function finishRun(
  workspaceId: string,
  fn: (signal: AbortSignal) => Promise<RunRecord>,
  refresh: boolean,
  changes: ResourceChange[],
): Promise<RunRecord> {
  if (controllers.has(workspaceId))
    throw new Error("A run is already in progress for this workspace.");
  const ctrl = new AbortController();
  controllers.set(workspaceId, ctrl);
  try {
    const r = await guarded(workspaceId, () => fn(ctrl.signal));
    if (refresh) await applyRunResults(workspaceId, r, changes);
    return r;
  } finally {
    controllers.delete(workspaceId);
    active.delete(workspaceId);
    notify();
  }
}

/**
 * Bring the LD session up to date from the run itself (PLAN §9 "Migrate flow"): every flag and
 * segment the run wrote, as LD returned it, goes into the listings; the project and account lists
 * the run could have changed and does not report item by item (context kinds, metrics,
 * experiments, AI Configs, randomization units) are re-read, and only those. Re-listing the whole
 * project after each run read every flag page and every segment again. reconcileRun stays as the
 * safety net for anything the run did not report.
 */
async function applyRunResults(workspaceId: string, run: RunRecord, changes: ResourceChange[]): Promise<void> {
  const latest = latestChanges(changes);
  mergeLdFlags(workspaceId, latest.flags);
  mergeLdSegments(workspaceId, latest.segments);
  await refreshLdLists(workspaceId, listsTouchedByRun(run)).catch(() => undefined);
  await reconcileRun(workspaceId, run);
}

/**
 * Settle every disagreement between the listings and what the run wrote by reading those
 * resources directly (reconcile.ts). Best effort: a read that fails leaves that entry as listed,
 * and never fails the run.
 */
async function reconcileRun(workspaceId: string, run: RunRecord): Promise<void> {
  const s = ldSessionSnapshot(workspaceId);
  if (!s.projectKey) return;
  const p = s.projectKey;
  const stale = staleAfterRun(run, new Map((s.flags?.items ?? []).map((f) => [f.key, f])), s.segments);
  if (!stale.flagKeys.length && !stale.segments.length) return;
  const c = ldClient(workspaceId);
  const flags = await Promise.allSettled(stale.flagKeys.map(async (key) => ({ key, flag: await c.getFlag(p, key) })));
  mergeLdFlags(workspaceId, flags.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
  const segments = await Promise.allSettled(stale.segments.map(async ({ ldEnv, key }) => ({ ldEnv, key, segment: await c.getSegment(p, ldEnv, key) })));
  mergeLdSegments(workspaceId, segments.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
}

/** A run left `running` in the journal but not executing in this tab was interrupted. */
export function isInterrupted(run: RunRecord, workspaceId: string): boolean {
  return (
    (run.status === "running" || run.status === "undoing") &&
    active.get(workspaceId)?.id !== run.id
  );
}

// ---------------------------------------------------------------------------------------------
// Decision log export (PLAN §8.2)
// ---------------------------------------------------------------------------------------------

export function decisionLogMarkdown(
  workspaceName: string,
  items: DecisionInstance[],
  resolutions: ReadonlyMap<string, Resolution>,
  profile: MappingProfile,
): string {
  const resolved = items.filter((i) => i.resolvedWith);
  const open = items.filter((i) => !i.resolvedWith);
  const label = (i: DecisionInstance) =>
    i.resolvedWith ? optionLabel(i.decision, i.resolvedWith.optionKey) : "";
  const row = (i: DecisionInstance) => {
    const r = resolutions.get(i.decision.id);
    return `| ${i.decision.type} | ${i.decision.subject.id} | ${(i.decision.subject.location ?? "").replace(/\|/g, "/")} | ${i.envs.join(", ")} | ${label(i)} | ${i.resolvedWith?.via === "policy" ? "workspace policy" : (r?.decidedAt ?? "")} |`;
  };
  const policies = Object.entries(profile.policies);
  return [
    `# Decision log: ${workspaceName}`,
    "",
    `Exported ${new Date().toISOString()}. ${resolved.length} decided, ${open.length} open.`,
    "",
    ...(policies.length
      ? [
          "## Workspace policies",
          "",
          ...policies.map(([t, o]) => `- **${t}** → ${o}`),
          "",
        ]
      : []),
    "## Decided",
    "",
    "| Type | Item | Where | LaunchDarkly environments | Answer | Decided |",
    "|---|---|---|---|---|---|",
    ...resolved.map(row),
    "",
    "## Open",
    "",
    "| Type | Severity | Item | Where | LaunchDarkly environments |",
    "|---|---|---|---|---|",
    ...open.map(
      (i) =>
        `| ${i.decision.type} | ${i.decision.severity} | ${i.decision.subject.id} | ${(i.decision.subject.location ?? "").replace(/\|/g, "/")} | ${i.envs.join(", ")} |`,
    ),
    "",
  ].join("\n");
}

export function decisionLogCsv(items: DecisionInstance[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = [
    "type",
    "severity",
    "item",
    "location",
    "ld_environments",
    "status",
    "answer",
    "via",
  ];
  const lines = items.map((i) =>
    [
      i.decision.type,
      i.decision.severity,
      i.decision.subject.id,
      i.decision.subject.location ?? "",
      i.envs.join(" "),
      i.resolvedWith ? "decided" : "open",
      i.resolvedWith?.optionKey ?? "",
      i.resolvedWith?.via ?? "",
    ]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: filename,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

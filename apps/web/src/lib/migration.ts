/**
 * Migration orchestration for the UI (PLAN §9 "Migrate flow"): profile → mapping → plan → dry
 * run → execute → undo. Domain logic lives in @sslm/mapper, @sslm/planner and @sslm/executor;
 * this module wires them to the store, the LD session and the StatSig source.
 */
import { useSyncExternalStore } from "react";
import type { Autotune, CanonicalSnapshot, Config, Gate, NeutralFlag, NeutralSegment, Segment } from "@sslm/canonical";
import { Executor, newRun, type RunRecord } from "@sslm/executor";
import type { CapabilityMatrix, LdFlagSummary } from "@sslm/ld-client";
import {
  mapAutotune,
  mapConfig,
  mapGate,
  mapNeutralFlag,
  mapNeutralSegment,
  mapSegment,
  reconcileProfile,
  type AutotuneMapResult,
  type ConfigMapResult,
  type DecisionPoint,
  type EnvTarget,
  type GateMapResult,
  type IdListCoverages,
  type IdLists,
  type MapperCapabilities,
  type MappingProfile,
  type NeutralFlagMapResult,
  type NeutralSegmentMapResult,
  type Resolution,
  type SegmentMapResult,
} from "@sslm/mapper";
import {
  planMigration,
  type LdFlagState,
  type LdProjectState,
  type Plan,
} from "@sslm/planner";
import { StatsigConsoleClient } from "@sslm/statsig-client";
import type { SourceRecord, RunJournalRecord } from "@sslm/store";
import { demoKey, startDemoMock } from "./demo.ts";
import { learnCapability, ldClient, refreshLdState, type LdSession } from "./ld.ts";
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
  const base: MappingProfile = stored ?? {
    version: 1,
    sources: {},
    attributes: {},
    policies: {},
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
  idLists: IdLists;
  /** Reconciliation results for uploaded raw-ID lists (PLAN §4.2), by segment uid. */
  coverage: IdListCoverages;
  now: string;
}

/*
 * Mapping memo. The explorers, the Decisions view, the readiness line and collectDecisions all map
 * the same entities with the same inputs, and React re-renders on every click, so without this the
 * whole project was re-mapped (0.06 ms per gate per environment: half a second on a real project)
 * for each selection, filter keystroke or nav change. Results are keyed on the identity of the
 * inputs (a new MigrationContext after a decision or profile change) and of the snapshot (a new
 * object after a sync), then by entity and environment, and are treated as immutable by callers.
 */
const mapMemo = new WeakMap<MappingInputs, WeakMap<CanonicalSnapshot, Map<string, unknown>>>();

function memoized<T>(i: MappingInputs, snapshot: CanonicalSnapshot, key: string, compute: () => T): T {
  let bySnapshot = mapMemo.get(i);
  if (!bySnapshot) mapMemo.set(i, (bySnapshot = new WeakMap()));
  let byKey = bySnapshot.get(snapshot);
  if (!byKey) bySnapshot.set(snapshot, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key) as T;
  const value = compute();
  byKey.set(key, value);
  return value;
}

const memoKey = (kind: string, uid: string, env: EnvTarget) => `${kind}|${uid}|${env.statsig}|${env.ld}`;

export function mapGateFor(
  snapshot: CanonicalSnapshot,
  gate: Gate,
  env: EnvTarget,
  i: MappingInputs,
): GateMapResult {
  return memoized(i, snapshot, memoKey("gate", gate.uid, env), () =>
    mapGate({
      canonical: { snapshot, idLists: i.idLists, coverage: i.coverage },
      entity: gate,
      profile: i.profile,
      resolutions: i.resolutions,
      capabilities: i.capabilities,
      env,
      now: i.now,
    }),
  );
}

export function mapSegmentFor(
  snapshot: CanonicalSnapshot,
  segment: Segment,
  env: EnvTarget,
  i: MappingInputs,
): SegmentMapResult {
  return memoized(i, snapshot, memoKey("segment", segment.uid, env), () =>
    mapSegment({
      canonical: { snapshot, idLists: i.idLists, coverage: i.coverage },
      entity: segment,
      profile: i.profile,
      resolutions: i.resolutions,
      capabilities: i.capabilities,
      env,
      now: i.now,
    }),
  );
}

export function mapConfigFor(snapshot: CanonicalSnapshot, config: Config, env: EnvTarget, i: MappingInputs): ConfigMapResult {
  return memoized(i, snapshot, memoKey("config", config.uid, env), () =>
    mapConfig({ canonical: { snapshot, idLists: i.idLists, coverage: i.coverage }, entity: config, profile: i.profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now }),
  );
}

export function mapAutotuneFor(snapshot: CanonicalSnapshot, autotune: Autotune, env: EnvTarget, i: MappingInputs): AutotuneMapResult {
  return memoized(i, snapshot, memoKey("autotune", autotune.uid, env), () =>
    mapAutotune({ canonical: { snapshot, idLists: i.idLists, coverage: i.coverage }, entity: autotune, profile: i.profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now }),
  );
}

/** Neutral (LD-source) flag → desired LD flag (PLAN §20), memoized like the StatSig mappers. */
export function mapNeutralFlagFor(snapshot: CanonicalSnapshot, flag: NeutralFlag, env: EnvTarget, i: MappingInputs): NeutralFlagMapResult {
  return memoized(i, snapshot, memoKey("flag", flag.uid, env), () => mapNeutralFlag({ canonical: { snapshot }, entity: flag, profile: i.profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now }));
}

export function mapNeutralSegmentFor(snapshot: CanonicalSnapshot, segment: NeutralSegment, env: EnvTarget, i: MappingInputs): NeutralSegmentMapResult {
  return memoized(i, snapshot, memoKey("nsegment", segment.uid, env), () => mapNeutralSegment({ canonical: { snapshot }, entity: segment, profile: i.profile, resolutions: i.resolutions, capabilities: i.capabilities, env, now: i.now }));
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
    if (source?.kind !== "console_api" || !source.baseUrl) {
      report.blocked.push({ sourceId: snap.source.sourceId, reason: "ID lists can only be read through the Console API; a config spec carries hashed IDs." });
      continue;
    }
    let apiKey: string | undefined;
    if (source.isDemo) {
      await startDemoMock();
      apiKey = await demoKey();
    } else apiKey = secrets.get("statsig", source.id);
    if (!apiKey) {
      report.blocked.push({ sourceId: source.id, reason: "No Console API key in memory for this source (keys are forgotten on refresh). Enter it under Connections, then retry." });
      continue;
    }
    const client = new StatsigConsoleClient({ baseUrl: source.baseUrl, apiKey });
    for (const seg of pending) {
      onProgress?.(`Loading ${seg.idList?.count ?? ""} IDs for segment ${seg.id}…`);
      const list = await client.getIdList(seg.id);
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
}

export function describeSelection(sel: MigrationSelection): string {
  const configs = sel.configs ?? [];
  const flags = sel.flags ?? [];
  const segments = sel.segments ?? [];
  const parts = [
    sel.gates.length ? `${sel.gates.length} gate${sel.gates.length === 1 ? "" : "s"}` : "",
    configs.length ? `${configs.length} dynamic config${configs.length === 1 ? "" : "s"}` : "",
    sel.autotunes.length ? `${sel.autotunes.length} autotune${sel.autotunes.length === 1 ? "" : "s"}` : "",
    flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"}` : "",
    segments.length ? `${segments.length} segment${segments.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(" and ") || "nothing";
}

export function buildPlan(input: { selection: MigrationSelection; ldEnvs: string[]; snapshots: CanonicalSnapshot[]; ld: LdSession } & MappingInputs): Plan {
  return planMigration({
    gates: input.selection.gates,
    configs: input.selection.configs ?? [],
    autotunes: input.selection.autotunes,
    flags: input.selection.flags ?? [],
    segments: input.selection.segments ?? [],
    ldEnvs: input.ldEnvs,
    snapshots: input.snapshots,
    idLists: input.idLists,
    coverage: input.coverage,
    profile: input.profile,
    resolutions: input.resolutions,
    capabilities: input.capabilities,
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
  snapshots?: RunSnapshotRefs,
): Executor {
  if (!ld.projectKey) throw new Error("Choose an LD project first.");
  return new Executor({
    client: ldClient(workspaceId),
    projectKey: ld.projectKey,
    journal: {
      save: (r) =>
        store.saveRun(
          snapshots ? ({ ...r, snapshots } satisfies RunJournalRecord) : r,
        ),
    },
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
 * get their provenance written and complete; declined ones fail. Refreshes LD state afterwards so
 * the status strip reflects what approvers applied.
 */
export async function checkRunApprovals(workspaceId: string, ld: LdSession, run: RunRecord): Promise<RunRecord> {
  const before = run.steps.filter((s) => s.status === "pending_approval").length;
  const r = await executor(workspaceId, ld, (run as RunJournalRecord).snapshots).checkApprovals(structuredClone(run));
  const after = r.steps.filter((s) => s.status === "pending_approval").length;
  if (after !== before) await refreshLdState(workspaceId);
  return r;
}

export const pendingApprovals = (run: RunRecord) => run.steps.filter((s) => s.status === "pending_approval").length;

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
  return finishRun(
    workspaceId,
    ld,
    (signal) => executor(workspaceId, ld, opts.snapshots).run(run, signal),
    !opts.dryRun,
    plan,
  );
}

export async function resumeRun(
  workspaceId: string,
  ld: LdSession,
  run: RunRecord,
): Promise<RunRecord> {
  return finishRun(
    workspaceId,
    ld,
    (signal) =>
      executor(workspaceId, ld, (run as RunJournalRecord).snapshots).run(
        structuredClone(run),
        signal,
      ),
    true,
  );
}

export async function undoRun(
  workspaceId: string,
  ld: LdSession,
  run: RunRecord,
): Promise<RunRecord> {
  return finishRun(
    workspaceId,
    ld,
    (signal) =>
      executor(workspaceId, ld, (run as RunJournalRecord).snapshots).undo(
        structuredClone(run),
        signal,
      ),
    true,
  );
}

async function finishRun(
  workspaceId: string,
  ld: LdSession,
  fn: (signal: AbortSignal) => Promise<RunRecord>,
  refresh: boolean,
  plan?: Plan,
): Promise<RunRecord> {
  if (controllers.has(workspaceId))
    throw new Error("A run is already in progress for this workspace.");
  const ctrl = new AbortController();
  controllers.set(workspaceId, ctrl);
  try {
    const r = await guarded(workspaceId, () => fn(ctrl.signal));
    if (refresh) {
      const envs = [
        ...new Set(
          [...(plan?.steps ?? []), ...r.steps.map((s) => s.step)].flatMap(
            (s) => ("ldEnv" in s ? [s.ldEnv] : []),
          ),
        ),
      ];
      await refreshLdState(workspaceId, {
        segmentEnvs: envs.length ? envs : Object.keys(ld.segments ?? {}),
      });
    }
    return r;
  } finally {
    controllers.delete(workspaceId);
    active.delete(workspaceId);
    notify();
  }
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
    i.decision.options.find((o) => o.key === i.resolvedWith?.optionKey)
      ?.label ??
    i.resolvedWith?.optionKey ??
    "";
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
    "| Type | Item | Where | LD environments | Answer | Decided |",
    "|---|---|---|---|---|---|",
    ...resolved.map(row),
    "",
    "## Open",
    "",
    "| Type | Severity | Item | Where | LD environments |",
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

/**
 * The guided migration (the workspace's landing page). One environment at a time, in the order
 * the pieces depend on each other:
 *
 *   connect → environment → contexts → segments → flags → experiments → cut over
 *
 * Context kinds come first because every rule, rollout and target refers to them; segments before
 * flags because flags reference segments; experiments and bandits after the flags they wrap. The
 * model here is pure: it tallies what each step still needs from the mapping results and LD
 * state, and the view renders it. Nothing is written.
 */
import { parseFooter, type CanonicalSnapshot, type EntityKind } from '@sslm/canonical';
import type { DecisionPoint } from '@sslm/mapper';
import { migrationStatus, ownsSegment } from '@sslm/planner';
import type { SourceRecord } from '@sslm/store';
import type { LdSession } from './ld.ts';
import { ldFlagState, mapAutotuneFor, mapConfigFor, mapGateFor, mapSegmentFor, type DecisionInstance, type MappingInputs } from './migration.ts';

export type StepKey = 'connect' | 'environment' | 'contexts' | 'segments' | 'flags' | 'experiments' | 'cutover';
export const STEP_ORDER: StepKey[] = ['connect', 'environment', 'contexts', 'segments', 'flags', 'experiments', 'cutover'];

export const STEP_TITLE: Record<StepKey, string> = {
  connect: 'Connect',
  environment: 'Choose an environment',
  contexts: 'Context kinds',
  segments: 'Segments',
  flags: 'Flags',
  experiments: 'Experiments and bandits',
  cutover: 'Cut over',
};

/** One kind of item in the chosen environment: how many, and where each stands against LD. */
export interface Tally {
  kind: EntityKind;
  total: number;
  inSync: number;
  /** Migrated before, but StatSig or the decisions changed since. */
  changed: number;
  /** Not in LD yet (or in LD without our provenance). */
  notMigrated: number;
  /** Open blocking decisions stop these until answered. */
  blocked: number;
  skipped: number;
  /** Uids worth planning now: not in sync, not skipped (blocked ones included; the plan shows why). */
  toMigrate: string[];
  /** LD's list for this environment has not been read yet: in-sync counts are unknown. */
  ldUnknown: boolean;
}

export interface GuideInput {
  sources: SourceRecord[];
  snapshots: CanonicalSnapshot[];
  /** Null until the profile and resolutions have loaded. */
  m: (MappingInputs & { ld: LdSession; connected: boolean }) | null;
  /** The source environment chosen in the header. */
  env: string;
  /** Every decision in the workspace, open and decided. */
  decisions: DecisionInstance[];
  monitoring: { attention: number; rows: number; loaded: boolean };
  interruptedRuns: number;
}

export interface GuideModel {
  env: string;
  /** Source environments available to choose from. */
  envs: string[];
  /** LD environments the chosen source environment maps to, across sources (usually one). */
  ldEnvs: string[];
  /** Per source: the LD environment `env` maps to, if any. Sources without the environment are left out. */
  envBySource: { source: SourceRecord; snapshot: CanonicalSnapshot; isProduction: boolean; ldEnv?: string }[];
  connected: boolean;
  synced: number;
  contexts: {
    /** Unit types seen in sources that take part in this environment. */
    unitTypes: string[];
    open: DecisionInstance[];
    decided: DecisionInstance[];
  };
  segments: Tally;
  gates: Tally;
  configs: Tally;
  autotunes: Tally;
  /** StatSig constructs that end in StatSig and start new in LD (nothing to run here). */
  endInSource: { kind: EntityKind; count: number }[];
  done: Record<StepKey, boolean>;
  current: StepKey;
}

const emptyTally = (kind: EntityKind): Tally => ({ kind, total: 0, inSync: 0, changed: 0, notMigrated: 0, blocked: 0, skipped: 0, toMigrate: [], ldUnknown: false });

type Standing = 'in_sync' | 'changed' | 'not_migrated' | 'blocked' | 'skipped';

/** Where one item stands, from its mapping result and what LD holds. */
export function classify(r: { skipped?: string; unresolved: DecisionPoint[] }, inLd: { status: 'in_sync' | 'changed' | 'absent' }): Standing {
  if (r.skipped) return 'skipped';
  if (r.unresolved.some((d) => d.severity === 'blocking')) return 'blocked';
  if (inLd.status === 'in_sync') return 'in_sync';
  return inLd.status === 'changed' ? 'changed' : 'not_migrated';
}

function add(t: Tally, uid: string, standing: Standing): void {
  t.total++;
  if (standing === 'in_sync') t.inSync++;
  else if (standing === 'changed') t.changed++;
  else if (standing === 'not_migrated') t.notMigrated++;
  else if (standing === 'blocked') t.blocked++;
  else t.skipped++;
  if (standing !== 'in_sync' && standing !== 'skipped') t.toMigrate.push(uid);
}

/** A step is done when nothing in it waits: everything that can migrate is in sync. */
export const tallyDone = (t: Tally): boolean => !t.ldUnknown && t.toMigrate.length === 0;

/** The first step that is not done; cut over is "current" once everything before it is. */
export function currentStep(done: Record<StepKey, boolean>): StepKey {
  return STEP_ORDER.find((k) => !done[k]) ?? 'cutover';
}

export function computeGuide(input: GuideInput): GuideModel {
  const { sources, snapshots, m, env, decisions } = input;
  const connected = !!m?.connected;
  const envs = [...new Set(snapshots.flatMap((s) => s.environments.map((e) => e.name)))];
  const envBySource: GuideModel['envBySource'] = [];
  for (const snapshot of snapshots) {
    const e = snapshot.environments.find((x) => x.name === env);
    if (!e) continue;
    const source = sources.find((s) => s.id === snapshot.source.sourceId);
    if (!source) continue;
    const ldEnv = connected ? m!.profile.sources[source.id]?.envMapping[env] ?? undefined : undefined;
    envBySource.push({ source, snapshot, isProduction: !!e.isProduction, ...(ldEnv ? { ldEnv } : {}) });
  }
  const ldEnvs = [...new Set(envBySource.flatMap((x) => (x.ldEnv ? [x.ldEnv] : [])))];
  const taking = envBySource.filter((x) => x.ldEnv) as (GuideModel['envBySource'][number] & { ldEnv: string })[];
  const takingIds = new Set(taking.map((x) => x.source.id));

  // Contexts: the unit types of the sources that take part, and their kind decisions.
  const unitTypes = [...new Set(taking.flatMap((x) => x.snapshot.unitTypes.map((u) => u.name)))];
  const kindDecisions = decisions.filter((d) => d.decision.type === 'unit_type_kind' && (takingIds.size === 0 || takingIds.has(d.decision.subject.sourceId)));
  const contexts = { unitTypes, open: kindDecisions.filter((d) => !d.resolvedWith), decided: kindDecisions.filter((d) => d.resolvedWith) };

  const segments = emptyTally('segment');
  const gates = emptyTally('gate');
  const configs = emptyTally('config');
  const autotunes = emptyTally('autotune');
  const endInSource = new Map<EntityKind, number>();

  if (m && connected) {
    const ldFlags = new Map((m.ld.flags?.items ?? []).map((f) => [f.key, f]));
    for (const { source, snapshot, ldEnv } of taking) {
      const target = { statsig: env, ld: ldEnv };
      const ldSegments = m.ld.segments?.[ldEnv];
      if (!ldSegments) segments.ldUnknown = true;
      for (const seg of snapshot.segments) {
        if (seg.archived) continue;
        const r = mapSegmentFor(snapshot, seg, target, m);
        const existing = ldSegments?.find((s) => s.key === r.segmentKey && ownsSegment({ key: s.key, tags: s.tags ?? [] }, snapshot.source.alias));
        const fp = existing ? parseFooter(existing.description)?.fp : undefined;
        add(segments, seg.uid, classify(r, { status: !existing ? 'absent' : fp === r.statsigFingerprint ? 'in_sync' : 'changed' }));
      }
      const flagStanding = (r: { flagKey: string; statsigFingerprint: string; decisionSetHash: string; skipped?: string; unresolved: DecisionPoint[] }, id: string) => {
        const f = ldFlags.get(r.flagKey);
        const st = migrationStatus(f && ldFlagState(f), ldEnv, r, { id, source: snapshot.source.alias }).status;
        return classify(r, { status: st === 'in_sync' ? 'in_sync' : st === 'statsig_changed' || st === 'decisions_changed' ? 'changed' : 'absent' });
      };
      for (const g of snapshot.gates) if (!g.archived) add(gates, g.uid, flagStanding(mapGateFor(snapshot, g, target, m), g.id));
      for (const c of snapshot.configs) if (!c.archived) add(configs, c.uid, flagStanding(mapConfigFor(snapshot, c, target, m), c.id));
      for (const a of snapshot.autotunes) if (!a.archived) add(autotunes, a.uid, flagStanding(mapAutotuneFor(snapshot, a, target, m), a.id));
      for (const kind of ['experiment', 'layer', 'holdout'] as const) {
        const n = snapshot[`${kind}s` as 'experiments' | 'layers' | 'holdouts'].filter((x) => !x.archived).length;
        if (n) endInSource.set(kind, (endInSource.get(kind) ?? 0) + n);
      }
      void source;
    }
  }

  const done: Record<StepKey, boolean> = {
    connect: snapshots.length > 0 && connected,
    environment: ldEnvs.length > 0,
    contexts: ldEnvs.length > 0 && contexts.open.length === 0,
    segments: ldEnvs.length > 0 && tallyDone(segments),
    flags: ldEnvs.length > 0 && tallyDone(gates) && tallyDone(configs),
    experiments: ldEnvs.length > 0 && tallyDone(autotunes),
    cutover: false,
  };
  return {
    env,
    envs,
    ldEnvs,
    envBySource,
    connected,
    synced: snapshots.length,
    contexts,
    segments,
    gates,
    configs,
    autotunes,
    endInSource: [...endInSource.entries()].map(([kind, count]) => ({ kind, count })),
    done,
    current: currentStep(done),
  };
}

/** "3 of 12 in sync · 7 to migrate · 2 wait for decisions", for a step summary. */
export function describeTally(t: Tally, noun: string): string {
  if (t.total === 0) return `No ${noun}s in this environment.`;
  const parts = [
    t.ldUnknown ? 'reading LaunchDarkly…' : `${t.inSync} of ${t.total} in sync`,
    t.changed ? `${t.changed} changed since` : '',
    t.notMigrated ? `${t.notMigrated} not migrated` : '',
    t.blocked ? `${t.blocked} wait${t.blocked === 1 ? 's' : ''} for decisions` : '',
    t.skipped ? `${t.skipped} skipped` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

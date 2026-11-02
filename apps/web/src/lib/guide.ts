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
import { parseFooter, type Alert, type CanonicalSnapshot, type EntityKind } from '@sslm/canonical';
import { kindFor, teamKeyForName, type DecisionPoint } from '@sslm/mapper';
import { migrationStatus, ownsSegment } from '@sslm/planner';
import type { SourceRecord } from '@sslm/store';
import { ldConnecting, type LdSession } from './ld.ts';
import { ldFlagState, mapAutotuneFor, mapConfigFor, mapGateFor, mapPromptFor, mapSegmentFor, type DecisionInstance, type MappingInputs } from './migration.ts';

export type StepKey = 'connect' | 'environment' | 'people' | 'contexts' | 'segments' | 'flags' | 'experiments' | 'cutover';
export const STEP_ORDER: StepKey[] = ['connect', 'environment', 'people', 'contexts', 'segments', 'flags', 'experiments', 'cutover'];

export const STEP_TITLE: Record<StepKey, string> = {
  connect: 'Connect',
  environment: 'Choose an environment',
  people: 'People and teams',
  contexts: 'Context kinds',
  segments: 'Segments',
  flags: 'Flags and AI Configs',
  experiments: 'Experiments and bandits',
  cutover: 'Cut over',
};

/** A StatSig owner across the workspace's sources, and how they become an LD maintainer (PLAN §8.3). */
export interface OwnerRow {
  /** Lower-cased email. */
  email: string;
  name?: string;
  /** The StatSig team their items most often belong to. */
  team?: string;
  /** Gates, configs, autotunes and prompts they own. */
  items: number;
  /**
   * - member: matched an LD member by email (maintainer set automatically)
   * - chosen_member / chosen_team / unassigned: decided on this step (profile.maintainers)
   * - missing: no LD member, nothing decided: their items raise `maintainer_unknown`
   */
  status: 'member' | 'chosen_member' | 'chosen_team' | 'unassigned' | 'missing';
  memberId?: string;
  teamKey?: string;
  pendingInvite?: boolean;
}

/** A StatSig team and its LD counterpart. */
export interface TeamRow {
  name: string;
  description?: string;
  memberEmails: string[];
  /** Items (gates, configs, autotunes, prompts) in the team. */
  items: number;
  /** exists: an LD team is matched or mapped; skipped: the user chose no team; missing: nothing in LD yet. */
  status: 'exists' | 'skipped' | 'missing';
  ldKey?: string;
  /** LD member IDs of the StatSig members that exist in LD (what "Create in LD" adds). */
  ldMemberIds: string[];
}

/** One LD environment at cut over: does StatSig require reviews there, and does LD require approvals? */
export interface ApprovalRow {
  ldEnv: string;
  /** Source labels whose chosen environment maps here. */
  sources: string[];
  sourceRequires: boolean;
  /** Undefined when LD did not report approval settings (feature off, or not probed). */
  ldRequires?: boolean;
}

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
  /** LaunchDarkly is being reached (token check or first probe): show a spinner, not "not connected". */
  connecting: boolean;
  synced: number;
  /** Owners and teams across every source (account-level, not per environment). */
  people: {
    owners: OwnerRow[];
    teams: TeamRow[];
    /** The LD member list was read (capability `members`). False: owners cannot be matched. */
    membersReadable: boolean;
    teamsReadable: boolean;
    /** Capability `invite_members` is not known to be denied. */
    canInvite: boolean;
    /** Capability `teams` is available. */
    canCreateTeams: boolean;
  };
  contexts: {
    /** Unit types seen in sources that take part in this environment. */
    unitTypes: string[];
    open: DecisionInstance[];
    decided: DecisionInstance[];
    /** Context kinds the items in this environment need and LD does not have yet. */
    toCreate: { key: string; unitType: string }[];
    /** Whether this token may create them (capability matrix); false shows the admin instructions instead. */
    canCreate: boolean;
    /** StatSig's default unit type (project settings) and the LD context kind that should be the default randomization unit. */
    defaultUnit?: { unitType: string; kind: string; isDefault: boolean; readable: boolean };
  };
  segments: Tally;
  gates: Tally;
  configs: Tally;
  autotunes: Tally;
  /** StatSig prompts → LD AI Configs (project-level; counted once, not per environment). */
  prompts: Tally;
  /** False when the LD plan or token has no AI Configs: prompts are listed, not written. */
  aiConfigsAvailable: boolean;
  /** StatSig constructs that end in StatSig and start new in LD (nothing to run here). */
  endInSource: { kind: EntityKind; count: number }[];
  cutover: {
    approvals: ApprovalRow[];
    /** Capability `approval_settings` is not known to be denied. */
    canSetApprovals: boolean;
    /** Topline alerts in the sources taking part: no LD equivalent, recreated by hand. */
    alerts: { alias: string; alert: Alert }[];
  };
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
  const connecting = !connected && ldConnecting(m?.ld);
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
  const toCreate = new Map<string, string>();
  const noteDeps = (deps: { kind: string; key: string; entityId?: string }[]) => {
    for (const d of deps) if (d.kind === 'context_kind' && !toCreate.has(d.key) && !(m?.ld.contextKinds ?? []).includes(d.key)) toCreate.set(d.key, d.entityId ?? d.key);
  };
  const cap = (k: string) => m?.ld.matrix?.capabilities.find((c) => c.key === k)?.status;
  const denied = (k: string) => cap(k) === 'not_permitted' || cap(k) === 'unavailable';
  const contexts: GuideModel['contexts'] = {
    unitTypes,
    open: kindDecisions.filter((d) => !d.resolvedWith),
    decided: kindDecisions.filter((d) => d.resolvedWith),
    toCreate: [] as { key: string; unitType: string }[],
    canCreate: !!m && m.capabilities.contextKinds !== 'not_permitted' && m.capabilities.contextKinds !== 'unavailable',
  };
  // StatSig's default unit type → LD's default randomization unit (project settings; coverage `structure.project_settings`).
  const withDefault = taking.find((x) => x.snapshot.settings?.defaultUnitType);
  if (m && withDefault) {
    const unitType = withDefault.snapshot.settings!.defaultUnitType!;
    const kind = unitType === 'userID' ? 'user' : kindFor(m.profile, withDefault.source.id, unitType);
    contexts.defaultUnit = { unitType, kind, isDefault: m.ld.defaultRandomizationUnit === kind || (!m.ld.defaultRandomizationUnit && kind === 'user'), readable: !!m.ld.randomizationUnits };
  }

  const people = computePeople(snapshots, m, { membersReadable: !!m?.directory?.membersReadable, teamsReadable: !!m?.directory?.teamsReadable, canInvite: !!m && !denied('invite_members'), canCreateTeams: cap('teams') === 'available' });

  const segments = emptyTally('segment');
  const gates = emptyTally('gate');
  const configs = emptyTally('config');
  const autotunes = emptyTally('autotune');
  const prompts = emptyTally('prompt');
  const aiConfigsAvailable = !denied('ai_configs');
  const endInSource = new Map<EntityKind, number>();
  const alerts: GuideModel['cutover']['alerts'] = [];

  if (m && connected) {
    const ldFlags = new Map((m.ld.flags?.items ?? []).map((f) => [f.key, f]));
    const ldAiConfigs = m.ld.aiConfigs;
    if (!ldAiConfigs && aiConfigsAvailable) prompts.ldUnknown = true;
    for (const { source, snapshot, ldEnv } of taking) {
      for (const p of snapshot.prompts ?? []) {
        if (p.archived) continue;
        const r = mapPromptFor(snapshot, p, m);
        const existing = ldAiConfigs?.find((a) => a.key === r.key && ownsSegment({ key: a.key, tags: a.tags ?? [] }, snapshot.source.alias));
        const fp = existing ? parseFooter(existing.description)?.fp : undefined;
        add(prompts, p.uid, classify(r, { status: !existing ? 'absent' : fp === r.statsigFingerprint ? 'in_sync' : 'changed' }));
      }
      for (const alert of snapshot.alerts ?? []) alerts.push({ alias: snapshot.source.alias, alert });
      const target = { statsig: env, ld: ldEnv };
      const ldSegments = m.ld.segments?.[ldEnv];
      if (!ldSegments) segments.ldUnknown = true;
      for (const seg of snapshot.segments) {
        if (seg.archived) continue;
        const r = mapSegmentFor(snapshot, seg, target, m);
        noteDeps(r.dependencies);
        const existing = ldSegments?.find((s) => s.key === r.segmentKey && ownsSegment({ key: s.key, tags: s.tags ?? [] }, snapshot.source.alias));
        const fp = existing ? parseFooter(existing.description)?.fp : undefined;
        add(segments, seg.uid, classify(r, { status: !existing ? 'absent' : fp === r.statsigFingerprint ? 'in_sync' : 'changed' }));
      }
      const flagStanding = (r: { flagKey: string; statsigFingerprint: string; decisionSetHash: string; skipped?: string; unresolved: DecisionPoint[]; dependencies: { kind: string; key: string; entityId?: string }[] }, id: string) => {
        noteDeps(r.dependencies);
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

  contexts.toCreate = [...toCreate.entries()].map(([key, unitType]) => ({ key, unitType })).sort((a, b) => a.key.localeCompare(b.key));

  // Cut over: StatSig "requires review" (per environment, or project-wide for configs) → LD required approvals.
  const approvals: ApprovalRow[] = ldEnvs.map((ldEnv) => {
    const here = taking.filter((x) => x.ldEnv === ldEnv);
    const ldReq = m?.ld.matrix?.environments.find((e) => e.key === ldEnv)?.flagApprovalsRequired;
    return {
      ldEnv,
      sources: here.map((x) => x.source.label),
      sourceRequires: here.some((x) => !!x.snapshot.environments.find((e) => e.name === env)?.requiresReview || !!x.snapshot.reviews?.configReviewRequired),
      ...(ldReq !== undefined ? { ldRequires: ldReq } : {}),
    };
  });

  const done: Record<StepKey, boolean> = {
    connect: snapshots.length > 0 && connected,
    environment: ldEnvs.length > 0,
    people: connected && people.owners.every((o) => o.status !== 'missing') && people.teams.every((t) => t.status !== 'missing'),
    contexts: ldEnvs.length > 0 && contexts.open.length === 0 && contexts.toCreate.length === 0,
    segments: ldEnvs.length > 0 && tallyDone(segments),
    flags: ldEnvs.length > 0 && tallyDone(gates) && tallyDone(configs) && (tallyDone(prompts) || !aiConfigsAvailable),
    experiments: ldEnvs.length > 0 && tallyDone(autotunes),
    cutover: false,
  };
  return {
    env,
    envs,
    ldEnvs,
    envBySource,
    connected,
    connecting,
    synced: snapshots.length,
    people,
    contexts,
    segments,
    gates,
    configs,
    autotunes,
    prompts,
    aiConfigsAvailable,
    endInSource: [...endInSource.entries()].map(([kind, count]) => ({ kind, count })),
    cutover: { approvals, canSetApprovals: !!m && !denied('approval_settings'), alerts },
    done,
    current: currentStep(done),
  };
}

/**
 * Owners and teams across every source. An owner is one email, however many sources and items;
 * the status comes from the profile's choice first, then from the LD member directory.
 */
export function computePeople(snapshots: CanonicalSnapshot[], m: GuideInput['m'], caps: { membersReadable: boolean; teamsReadable: boolean; canInvite: boolean; canCreateTeams: boolean }): GuideModel['people'] {
  const owners = new Map<string, OwnerRow & { teams: Map<string, number> }>();
  const teamItems = new Map<string, number>();
  const teamNames = new Map<string, { description?: string; memberEmails: string[] }>();
  for (const s of snapshots) {
    for (const t of s.teams ?? []) if (!teamNames.has(t.name)) teamNames.set(t.name, { ...(t.description ? { description: t.description } : {}), memberEmails: t.memberEmails ?? [] });
    const entities = [...s.gates, ...s.configs, ...s.autotunes, ...(s.prompts ?? [])].filter((e) => !e.archived);
    for (const e of entities) {
      if (e.team) {
        teamItems.set(e.team, (teamItems.get(e.team) ?? 0) + 1);
        if (!teamNames.has(e.team)) teamNames.set(e.team, { memberEmails: [] });
      }
      const email = e.owner?.email?.trim().toLowerCase();
      if (!email) continue;
      const row = owners.get(email) ?? { email, items: 0, status: 'missing' as const, teams: new Map<string, number>() };
      row.items++;
      if (!row.name && e.owner?.name) row.name = e.owner.name;
      if (e.team) row.teams.set(e.team, (row.teams.get(e.team) ?? 0) + 1);
      owners.set(email, row);
    }
  }
  const members = new Map((m?.ld.members ?? []).map((x) => [x.email.toLowerCase(), x]));
  const ownerRows: OwnerRow[] = [...owners.values()]
    .map(({ teams, ...row }) => {
      const team = [...teams.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const out: OwnerRow = { ...row, ...(team ? { team } : {}) };
      const choice = m?.profile?.maintainers?.[row.email];
      const member = members.get(row.email);
      if (choice === 'unassigned') out.status = 'unassigned';
      else if (choice && 'memberId' in choice) Object.assign(out, { status: 'chosen_member', memberId: choice.memberId });
      else if (choice && 'teamKey' in choice) Object.assign(out, { status: 'chosen_team', teamKey: choice.teamKey });
      else if (member) Object.assign(out, { status: 'member', memberId: member._id, ...(member._pendingInvite ? { pendingInvite: true } : {}) });
      return out;
    })
    .sort((a, b) => b.items - a.items || a.email.localeCompare(b.email));
  const teamRows: TeamRow[] = [...teamNames.entries()]
    .map(([name, t]) => {
      const mapped = m?.profile?.teams?.[name];
      const ldKey = m?.profile ? teamKeyForName(m.profile, m.directory, name) : undefined;
      const row: TeamRow = { name, ...(t.description ? { description: t.description } : {}), memberEmails: t.memberEmails, items: teamItems.get(name) ?? 0, status: mapped === null ? 'skipped' : ldKey ? 'exists' : 'missing', ldMemberIds: t.memberEmails.flatMap((e) => (members.get(e)?._id ? [members.get(e)!._id] : [])) };
      if (ldKey) row.ldKey = ldKey;
      return row;
    })
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
  return { owners: ownerRows, teams: teamRows, ...caps };
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

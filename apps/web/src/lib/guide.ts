/**
 * The guided migration (the workspace's landing page). One environment at a time, in the order
 * the pieces depend on each other:
 *
 *   connect → teams → people → environment → contexts → segments → flags → experiments → cut over
 *
 * Teams and people are account-level and come first: a maintainer must be an LD member, a team
 * must exist to be one, and an invitation can place a person into teams only if the teams exist.
 * They are separate steps so teams can be created without inviting anyone yet, and both bow out
 * when an identity provider provisions the account (AccountAccess). Neither blocks the
 * environment steps: a flag whose owner is not in LD yet is created without a maintainer, and the
 * maintainer is part of the decision-set hash, so the flag shows as changed and takes the
 * maintainer on the next sync once the person (or team) exists. Everything from the environment
 * on repeats per environment. Context kinds come first in that loop because every rule, rollout and target refers to them: every unit type
 * must be given a LaunchDarkly context kind (the mapping profile) and the kinds LD lacks created before anything else; segments before
 * flags because flags reference segments; experiments and bandits after the flags they wrap. The
 * model here is pure: it tallies what each step still needs from the mapping results and LD
 * state, and the view renders it. Nothing is written.
 */
import { migrationKindOf, parseFooter, SOURCE_KIND_LABEL, type Alert, type CanonicalSnapshot, type EntityKind } from '@sslm/canonical';
import { defaultKindFor, kindFor, teamKeyForName, type DecisionPoint } from '@sslm/mapper';
import { migrationStatus, ownsSegment } from '@sslm/planner';
import type { AccountAccess, SourceRecord } from '@sslm/store';
import { indexByKey } from './indexByKey.ts';
import { ldConnecting, type LdSession } from './ld.ts';
import { ldFlagState, mapAutotuneFor, mapConfigFor, mapGateFor, mapPromptFor, mapSegmentFor, type DecisionInstance, type MappingInputs } from './migration.ts';
import { availableForExperiments, unitTypeStanding, unitTypeUsage, type UnitTypeStanding } from './unitTypes.ts';

export type StepKey = 'connect' | 'environment' | 'teams' | 'people' | 'contexts' | 'segments' | 'flags' | 'experiments' | 'cutover';
export const STEP_ORDER: StepKey[] = ['connect', 'teams', 'people', 'environment', 'contexts', 'segments', 'flags', 'experiments', 'cutover'];

/** The step the per-environment loop starts from. */
export const LOOP_STEP: StepKey = 'environment';

export const ACCESS_LABEL: Record<AccountAccess, { label: string; note: string }> = {
  launchdarkly: { label: 'In LaunchDarkly', note: 'The console creates teams and invites people from the Teams and People steps. LaunchDarkly emails each invitation.' },
  scim: {
    label: 'Identity provider with SCIM (members); teams in LaunchDarkly',
    note: 'Your identity provider creates and removes members, so nobody is invited from here: the People step lists the owners not provisioned yet and waits. Teams are still created from the Teams step, with the members that already exist.',
  },
  scim_team_sync: {
    label: 'Okta with SCIM and team sync (members and teams)',
    note: 'Okta provisions members and, through Group Push, teams. Nothing is created or invited from here: the Teams step lists the group names to push (team sync links an existing team of the same name) and the People step waits for provisioning. The environment steps do not wait for either.',
  },
};

/**
 * Who provisions what a step would otherwise create, under the workspace's AccountAccess:
 * undefined when the console does it from the step itself. The view shows such a step as
 * waiting for the provider, nothing being written from it.
 */
export function provisionedBy(step: StepKey, access: AccountAccess): string | undefined {
  if (step === 'teams') return access === 'scim_team_sync' ? 'Okta' : undefined;
  if (step === 'people') return access === 'scim_team_sync' ? 'Okta' : access === 'scim' ? 'SCIM' : undefined;
  return undefined;
}

/**
 * Steps whose writes land on the LaunchDarkly *account*, shared by every project in it, rather
 * than in the target project: members (invites) and teams. The view marks these loudly.
 */
export const ACCOUNT_WIDE_STEPS: ReadonlySet<StepKey> = new Set<StepKey>(['teams', 'people']);

export const STEP_TITLE: Record<StepKey, string> = {
  connect: 'Connect',
  environment: 'Choose an environment',
  teams: 'Teams',
  people: 'People',
  contexts: 'Context kinds',
  segments: 'Segments',
  flags: 'Flags and AI Configs',
  experiments: 'Experiments and bandits',
  cutover: 'Cut over',
};

/**
 * An owner across the workspace's sources, and how they become an LD maintainer (PLAN §8.3): a
 * StatSig entity's `owner`, or a neutral-model flag's `maintainer` (LaunchDarkly, PostHog).
 */
export interface OwnerRow {
  /** Lower-cased email. */
  email: string;
  name?: string;
  /** The source team their items most often belong to (a StatSig team name, or a neutral flag's maintainer team key). */
  team?: string;
  /** Gates, configs, autotunes, prompts and neutral-model flags they own. */
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

/**
 * LD team keys an invitation should carry for an owner: the teams they belong to in the source
 * (and the team their items sit in), restricted to teams that exist in LD. Sorted, for stable
 * requests.
 */
export function teamKeysFor(owner: Pick<OwnerRow, 'email' | 'team'>, teams: readonly TeamRow[]): string[] {
  const keys = teams.filter((t) => t.ldKey && (t.memberEmails.some((e) => e.toLowerCase() === owner.email) || t.name === owner.team)).map((t) => t.ldKey!);
  return [...new Set(keys)].sort();
}

/**
 * A source team and its LD counterpart: a StatSig team (by name) or the maintainer team of
 * neutral-model flags (by its key, which `teamKeyForName` resolves against LD by key as well).
 */
export interface TeamRow {
  name: string;
  description?: string;
  memberEmails: string[];
  /** Items (gates, configs, autotunes, prompts, neutral-model flags) in the team. */
  items: number;
  /** exists: an LD team is matched or mapped; skipped: the user chose no team; missing: nothing in LD yet. */
  status: 'exists' | 'skipped' | 'missing';
  ldKey?: string;
  /** LD member IDs of the StatSig members that exist in LD (what "Create in LD" adds). */
  ldMemberIds: string[];
}

/** A unit type of a source taking part in the environment, and where the profile sends it. */
export interface UnitTypeRow {
  sourceId: string;
  label: string;
  unitType: string;
  standing: UnitTypeStanding;
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
  /** Set aside by the user ("Don't migrate"): listed, not counted in `total`, never planned from here. */
  setAside: number;
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
  /** How members and teams are managed (workspace setting); undefined = not answered yet. */
  access?: AccountAccess;
  /** Uids the user set aside ("Don't migrate"): left out of every tally's work. */
  exclusions?: ReadonlySet<string>;
  /** Every decision in the workspace, open and decided (the Decisions page's list; the guide tallies items, not decisions). */
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
  /**
   * When the LD state tallied here was read (`at`: the saved copy's time, else the live listing's),
   * whether a re-read is in flight, and whether the latest read failed. The view shows the age with
   * a "Re-read" action: nothing re-reads on its own, the plan modal reads afresh before a run.
   */
  ldAsOf?: { at: string; refreshing: boolean; failed: boolean };
  synced: number;
  /** Owners and teams across every source (account-level, not per environment). */
  people: {
    owners: OwnerRow[];
    teams: TeamRow[];
    /** The LD member list was read (capability `members`). False: owners cannot be matched. */
    membersReadable: boolean;
    teamsReadable: boolean;
    /** Capability `invite_members` is not known to be denied, and members are managed in LD (not provisioned by an IdP). */
    canInvite: boolean;
    /** Capability `teams` is available, and teams are not synced from Okta. */
    canCreateTeams: boolean;
    /** The workspace's answer, `launchdarkly` while unanswered. */
    access: AccountAccess;
    /** The question on the Connect step has been answered. */
    accessAnswered: boolean;
    /** The provider every synced source reads from (“StatSig”, “PostHog”, …); undefined when the sources mix providers or there are none. */
    sourceLabel?: string;
  };
  contexts: {
    /** Unit types seen in sources that take part in this environment. */
    unitTypes: string[];
    /** One row per unit type of each source taking part: where it goes, from the profile (the step's table edits it). */
    rows: UnitTypeRow[];
    /** Rows with no choice yet. Every unit type but userID needs one before the step is done. */
    unmapped: number;
    /**
     * Context kinds the chosen mappings (and the environment's items) need and LD does not have
     * yet, with whether each is to be a randomization unit as well (profile.contextKinds).
     */
    toCreate: { key: string; unitType: string; availableForExperiments: boolean }[];
    /** Kinds LD already has that the profile marks "available for experiments" and the project's experimentation settings do not list yet. */
    toEnable: { key: string; unitTypes: string[] }[];
    /** The experimentation settings were readable (without them nothing is enabled from here). */
    experimentsReadable: boolean;
    /** Whether this token may create kinds (capability matrix); false shows the admin instructions instead. */
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

const emptyTally = (kind: EntityKind): Tally => ({ kind, total: 0, inSync: 0, changed: 0, notMigrated: 0, blocked: 0, skipped: 0, setAside: 0, toMigrate: [], ldUnknown: false });

type Standing = 'in_sync' | 'changed' | 'not_migrated' | 'blocked' | 'skipped';

/** Where one item stands, from its mapping result and what LD holds. */
export function classify(r: { skipped?: string; unresolved: DecisionPoint[] }, inLd: { status: 'in_sync' | 'changed' | 'absent' }): Standing {
  if (r.skipped) return 'skipped';
  if (r.unresolved.some((d) => d.severity === 'blocking')) return 'blocked';
  if (inLd.status === 'in_sync') return 'in_sync';
  return inLd.status === 'changed' ? 'changed' : 'not_migrated';
}

function add(t: Tally, uid: string, standing: Standing | 'set_aside'): void {
  if (standing === 'set_aside') {
    t.setAside++;
    return;
  }
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
/**
 * The step to expand: the first unfinished one, skipping Teams and People. Those can be finished
 * at any time (or never, when an identity provider is still provisioning): the environment steps
 * do not wait for them, and a later sync picks up the maintainers and teams that appeared.
 */
export function currentStep(done: Record<StepKey, boolean>): StepKey {
  return STEP_ORDER.find((k) => !done[k] && !ACCOUNT_WIDE_STEPS.has(k)) ?? 'cutover';
}

export function computeGuide(input: GuideInput): GuideModel {
  const { sources, snapshots, m, env } = input;
  const setAside = (uid: string) => input.exclusions?.has(uid) ?? false;
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

  // Contexts: the unit types of the sources that take part, and where each goes (the profile).
  // Every unit type but userID needs an explicit choice; the kinds chosen (or needed by the
  // environment's items) and missing in LD are created from the step, and kinds marked
  // "available for experiments" are enabled as randomization units with them.
  const existingKinds = m?.capabilities.existingContextKinds ?? ['user'];
  const rows: UnitTypeRow[] = [];
  for (const { source, snapshot } of taking) {
    for (const u of unitTypeUsage(snapshot)) rows.push({ sourceId: source.id, label: source.label, unitType: u.name, standing: m ? unitTypeStanding(m.profile, m.resolutions.values(), source.id, u.name, existingKinds) : { kind: 'unmapped', target: { contextKind: defaultKindFor(u.name), attribute: 'key' } } });
  }
  const unitTypes = [...new Set(rows.map((r) => r.unitType))];
  const toCreate = new Map<string, string>();
  const noteKind = (kind: string, unitType: string) => {
    if (kind !== 'user' && !toCreate.has(kind) && !existingKinds.includes(kind)) toCreate.set(kind, unitType);
  };
  for (const r of rows) {
    if (r.standing.kind === 'creates' || (r.standing.kind === 'attribute' && !r.standing.kindExists)) noteKind(r.standing.target.contextKind, r.unitType);
  }
  const noteDeps = (deps: { kind: string; key: string; entityId?: string }[]) => {
    for (const d of deps) if (d.kind === 'context_kind') noteKind(d.key, d.entityId ?? d.key);
  };
  const cap = (k: string) => m?.ld.matrix?.capabilities.find((c) => c.key === k)?.status;
  const denied = (k: string) => cap(k) === 'not_permitted' || cap(k) === 'unavailable';
  const ldUnits = m?.ld.randomizationUnits;
  const toEnable = new Map<string, string[]>();
  if (m && ldUnits) {
    for (const r of rows) {
      const kind = r.standing.target.contextKind;
      if (r.standing.kind !== 'exists' || kind === 'user' || !m.profile.contextKinds?.[kind]?.availableForExperiments || ldUnits.includes(kind)) continue;
      toEnable.set(kind, [...(toEnable.get(kind) ?? []), r.unitType]);
    }
  }
  const contexts: GuideModel['contexts'] = {
    unitTypes,
    rows,
    unmapped: rows.filter((r) => r.standing.kind === 'unmapped').length,
    toCreate: [],
    toEnable: [...toEnable.entries()].map(([key, uts]) => ({ key, unitTypes: [...new Set(uts)] })).sort((a, b) => a.key.localeCompare(b.key)),
    experimentsReadable: !!ldUnits,
    canCreate: !!m && m.capabilities.contextKinds !== 'not_permitted' && m.capabilities.contextKinds !== 'unavailable',
  };
  // StatSig's default unit type → LD's default randomization unit (project settings; coverage `structure.project_settings`).
  const withDefault = taking.find((x) => x.snapshot.settings?.defaultUnitType);
  if (m && withDefault) {
    const unitType = withDefault.snapshot.settings!.defaultUnitType!;
    const kind = unitType === 'userID' ? 'user' : kindFor(m.profile, withDefault.source.id, unitType);
    contexts.defaultUnit = { unitType, kind, isDefault: m.ld.defaultRandomizationUnit === kind || (!m.ld.defaultRandomizationUnit && kind === 'user'), readable: !!m.ld.randomizationUnits };
  }

  const people = computePeople(snapshots, m, { membersReadable: !!m?.directory?.membersReadable, teamsReadable: !!m?.directory?.teamsReadable, canInvite: !!m && !denied('invite_members'), canCreateTeams: cap('teams') === 'available', ...(input.access ? { access: input.access } : {}) });

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
        const hit = ldAiConfigs ? indexByKey(ldAiConfigs).get(r.key) : undefined;
        const existing = hit && ownsSegment({ key: hit.key, tags: hit.tags ?? [] }, snapshot.source.alias) ? hit : undefined;
        const fp = existing ? parseFooter(existing.description)?.fp : undefined;
        add(prompts, p.uid, setAside(p.uid) ? 'set_aside' : classify(r, { status: !existing ? 'absent' : fp === r.statsigFingerprint ? 'in_sync' : 'changed' }));
      }
      for (const alert of snapshot.alerts ?? []) alerts.push({ alias: snapshot.source.alias, alert });
      const target = { statsig: env, ld: ldEnv };
      const ldSegments = m.ld.segments?.[ldEnv];
      if (!ldSegments) segments.ldUnknown = true;
      for (const seg of snapshot.segments) {
        if (seg.archived) continue;
        const r = mapSegmentFor(snapshot, seg, target, m);
        noteDeps(r.dependencies);
        const hit = ldSegments ? indexByKey(ldSegments).get(r.segmentKey) : undefined;
        const existing = hit && ownsSegment({ key: hit.key, tags: hit.tags ?? [] }, snapshot.source.alias) ? hit : undefined;
        const fp = existing ? parseFooter(existing.description)?.fp : undefined;
        add(segments, seg.uid, setAside(seg.uid) ? 'set_aside' : classify(r, { status: !existing ? 'absent' : fp === r.statsigFingerprint ? 'in_sync' : 'changed' }));
      }
      const flagStanding = (r: { flagKey: string; statsigFingerprint: string; decisionSetHash: string; skipped?: string; unresolved: DecisionPoint[]; dependencies: { kind: string; key: string; entityId?: string }[] }, id: string) => {
        noteDeps(r.dependencies);
        const f = ldFlags.get(r.flagKey);
        const st = migrationStatus(f && ldFlagState(f), ldEnv, r, { id, source: snapshot.source.alias }).status;
        return classify(r, { status: st === 'in_sync' ? 'in_sync' : st === 'statsig_changed' || st === 'decisions_changed' ? 'changed' : 'absent' });
      };
      for (const g of snapshot.gates) if (!g.archived) add(gates, g.uid, setAside(g.uid) ? 'set_aside' : flagStanding(mapGateFor(snapshot, g, target, m), g.id));
      for (const c of snapshot.configs) if (!c.archived) add(configs, c.uid, setAside(c.uid) ? 'set_aside' : flagStanding(mapConfigFor(snapshot, c, target, m), c.id));
      for (const a of snapshot.autotunes) if (!a.archived) add(autotunes, a.uid, setAside(a.uid) ? 'set_aside' : flagStanding(mapAutotuneFor(snapshot, a, target, m), a.id));
      for (const kind of ['experiment', 'layer', 'holdout'] as const) {
        const n = snapshot[`${kind}s` as 'experiments' | 'layers' | 'holdouts'].filter((x) => !x.archived).length;
        if (n) endInSource.set(kind, (endInSource.get(kind) ?? 0) + n);
      }
      void source;
    }
  }

  contexts.toCreate = [...toCreate.entries()]
    .map(([key, unitType]) => ({ key, unitType, availableForExperiments: !!m && availableForExperiments(m.profile, key, ldUnits) }))
    .sort((a, b) => a.key.localeCompare(b.key));

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
    connect: snapshots.length > 0 && connected && people.accessAnswered,
    environment: ldEnvs.length > 0,
    teams: connected && people.teams.every((t) => t.status !== 'missing'),
    people: connected && people.owners.every((o) => o.status !== 'missing'),
    contexts: ldEnvs.length > 0 && contexts.unmapped === 0 && contexts.toCreate.length === 0 && contexts.toEnable.length === 0,
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
    ...(connected && (m.ld.stale ?? m.ld.flags?.loadedAt) ? { ldAsOf: { at: (m.ld.stale ?? m.ld.flags?.loadedAt)!, refreshing: !!m.ld.refreshing, failed: !!m.ld.error } } : {}),
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
 * the status comes from the profile's choice first, then from the LD member directory. StatSig
 * entities carry `owner` and `team`; flags read onto the neutral model (LaunchDarkly, PostHog)
 * carry `maintainer`, whose email is the owner and whose `teamKey` counts as a team named by that
 * key (the mapper hands the same key to `teamKeyForName`, which matches an LD team by key too).
 * A neutral flag names nobody, so the owner's display name comes from the snapshot's member list.
 */
export function computePeople(snapshots: CanonicalSnapshot[], m: GuideInput['m'], caps: { membersReadable: boolean; teamsReadable: boolean; canInvite: boolean; canCreateTeams: boolean; access?: AccountAccess }): GuideModel['people'] {
  const access: AccountAccess = caps.access ?? 'launchdarkly';
  const owners = new Map<string, OwnerRow & { teams: Map<string, number> }>();
  const teamItems = new Map<string, number>();
  const teamNames = new Map<string, { description?: string; memberEmails: string[] }>();
  /** One live item owned by `owner` (email, optional display name) and sitting in `team`, if any. */
  const tally = (owner: { email?: string; name?: string } | undefined, team: string | null | undefined) => {
    if (team) {
      teamItems.set(team, (teamItems.get(team) ?? 0) + 1);
      if (!teamNames.has(team)) teamNames.set(team, { memberEmails: [] });
    }
    const email = owner?.email?.trim().toLowerCase();
    if (!email) return;
    const row = owners.get(email) ?? { email, items: 0, status: 'missing' as const, teams: new Map<string, number>() };
    row.items++;
    if (!row.name && owner?.name) row.name = owner.name;
    if (team) row.teams.set(team, (row.teams.get(team) ?? 0) + 1);
    owners.set(email, row);
  };
  for (const s of snapshots) {
    for (const t of s.teams ?? []) if (!teamNames.has(t.name)) teamNames.set(t.name, { ...(t.description ? { description: t.description } : {}), memberEmails: t.memberEmails ?? [] });
    const entities = [...s.gates, ...s.configs, ...s.autotunes, ...(s.prompts ?? [])].filter((e) => !e.archived);
    for (const e of entities) tally(e.owner, e.team);
    const neutralFlags = (s.neutral?.flags ?? []).filter((f) => !f.archived && f.maintainer);
    if (neutralFlags.length === 0) continue;
    const memberNames = new Map<string, string>();
    for (const u of s.users ?? []) if (u.email && u.name && !memberNames.has(u.email.trim().toLowerCase())) memberNames.set(u.email.trim().toLowerCase(), u.name);
    for (const f of neutralFlags) {
      const email = f.maintainer!.email?.trim().toLowerCase();
      const name = email ? memberNames.get(email) : undefined;
      tally(email ? { email, ...(name ? { name } : {}) } : undefined, f.maintainer!.teamKey);
    }
  }
  const providers = new Set(snapshots.map((s) => migrationKindOf(s.source.sourceKind)));
  const sourceLabel = providers.size === 1 ? SOURCE_KIND_LABEL[[...providers][0]!] : undefined;
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
  return {
    owners: ownerRows,
    teams: teamRows,
    membersReadable: caps.membersReadable,
    teamsReadable: caps.teamsReadable,
    // An IdP that provisions members must not be bypassed by a console invite; Okta team sync owns the teams too.
    canInvite: caps.canInvite && access === 'launchdarkly',
    canCreateTeams: caps.canCreateTeams && access !== 'scim_team_sync',
    access,
    accessAnswered: caps.access !== undefined,
    ...(sourceLabel ? { sourceLabel } : {}),
  };
}

/** "3 of 12 in sync · 7 to migrate · 2 wait for decisions", for a step summary. */
export function describeTally(t: Tally, noun: string): string {
  if (t.total === 0) return t.setAside ? `No ${noun}s to migrate in this environment; ${t.setAside} set aside.` : `No ${noun}s in this environment.`;
  const parts = [
    t.ldUnknown ? 'reading LaunchDarkly…' : `${t.inSync} of ${t.total} in sync`,
    t.changed ? `${t.changed} changed since` : '',
    t.notMigrated ? `${t.notMigrated} not migrated` : '',
    t.blocked ? `${t.blocked} wait${t.blocked === 1 ? 's' : ''} for decisions` : '',
    t.skipped ? `${t.skipped} skipped` : '',
    t.setAside ? `${t.setAside} set aside` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

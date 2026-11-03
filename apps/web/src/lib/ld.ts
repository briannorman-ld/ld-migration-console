import { useSyncExternalStore } from 'react';
import type { CapabilityUpdate } from '@sslm/executor';
import { migratedFromTag } from '@sslm/canonical';
import { LdAuthError, LdClient, LdWriteError, probeCapabilities, type CapabilityMatrix, type LdAiConfig, type LdCallerIdentity, type LdExperiment, type LdFlag, type LdFlagSummary, type LdInstanceId, type LdMember, type LdMetric, type LdProject, type LdSegment, type LdTeam } from '@sslm/ld-client';
import { mergeByKey, needsNothing, type LdListNeeds } from './reconcile.ts';
import { secrets } from './secrets.ts';
import { store } from './store.ts';

/**
 * LD connection for a workspace. The token lives in the secrets vault (memory only); this state
 * holds only non-secret results. Everything here reads; writes go through the executor
 * (lib/migration.ts) after the user confirms a plan.
 */
export interface LdSession {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  instance?: LdInstanceId;
  identity?: LdCallerIdentity;
  projects?: LdProject[];
  projectKey?: string;
  matrix?: CapabilityMatrix;
  probing?: string;
  /** Every flag with all environments (on/off, provenance custom properties). */
  flags?: { items: LdFlagSummary[]; loadedAt: string };
  contextKinds?: string[];
  /** Segments per LD environment, loaded when a plan needs them. */
  segments?: Record<string, LdSegment[]>;
  /** Project metrics; undefined until read, or when the plan has no Experimentation. */
  metrics?: LdMetric[];
  /** Experiments (bandits included) per LD environment, loaded with the segments. */
  experiments?: Record<string, LdExperiment[]>;
  /** Context kinds enabled as randomization units; undefined when unreadable. */
  randomizationUnits?: string[];
  /** The randomization unit experiments default to, when the settings were readable and one is marked default. */
  defaultRandomizationUnit?: string;
  /** Account members (owner → maintainer matching, guide step "People"); undefined when not readable. */
  members?: LdMember[];
  /** Account teams (Enterprise); undefined when not readable. */
  teams?: LdTeam[];
  /** AI Configs in the project (StatSig prompts); undefined when not readable or not on the plan. */
  aiConfigs?: LdAiConfig[];
  /**
   * Set while the listing shown is the one saved on the last read (its time), restored on open so
   * the guide and explorers have LD state at once; cleared when the live refresh has landed.
   */
  stale?: string;
  /** A listing refresh is in flight (the guide shows a spinner next to the listing's age). */
  refreshing?: boolean;
  /** Where the refresh in flight stands ("Reading flags: 300 of 1,480…"), for the plan modal's footer. */
  refreshProgress?: string;
  error?: string;
}

/** The listing fields of a session: what a refresh reads, and what is kept for the next open. */
type LdListing = Pick<LdSession, 'flags' | 'contextKinds' | 'segments' | 'experiments' | 'metrics' | 'randomizationUnits' | 'defaultRandomizationUnit' | 'members' | 'teams' | 'aiConfigs'>;
const LISTING_KEYS = ['flags', 'contextKinds', 'segments', 'experiments', 'metrics', 'randomizationUnits', 'defaultRandomizationUnit', 'members', 'teams', 'aiConfigs'] as const satisfies readonly (keyof LdListing)[];

const sessions = new Map<string, LdSession>();
const clients = new Map<string, LdClient>();
const listeners = new Set<() => void>();
/** Workspaces whose device vault is being restored: "connecting" until the token comes back (or doesn't). */
const pendingRestore = new Set<string>();
const EMPTY: LdSession = { status: 'disconnected' };

function set(workspaceId: string, patch: Partial<LdSession>) {
  sessions.set(workspaceId, { ...(sessions.get(workspaceId) ?? EMPTY), ...patch });
  listeners.forEach((l) => l());
}

export function useLdSession(workspaceId: string): LdSession {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sessions.get(workspaceId) ?? EMPTY,
  );
}

/** The current session state outside React (the monitoring check reads freshly loaded flags). */
export function ldSessionSnapshot(workspaceId: string): LdSession {
  return sessions.get(workspaceId) ?? EMPTY;
}

/**
 * Whether LaunchDarkly is on its way: the token is being checked, or it is good and the chosen
 * project's first probe has not returned yet (`connected` in useMigration needs the matrix). Screens
 * show a spinner for this instead of "not connected", which on a reload would be wrong for seconds.
 */
export function ldConnecting(s: LdSession | undefined): boolean {
  if (!s) return false;
  return s.status === 'connecting' || (s.status === 'connected' && !s.matrix && !!s.probing);
}

/**
 * Before a device vault restore on workspace open (lib/deviceVault.ts): a workspace that was
 * connected before shows "connecting" while its tokens decrypt, so a reload never flashes "not
 * connected" first. `reconnectSkipped` takes it back when no LD token comes out of the vault.
 */
export function expectReconnect(workspaceId: string): void {
  if ((sessions.get(workspaceId) ?? EMPTY).status !== 'disconnected') return;
  pendingRestore.add(workspaceId);
  set(workspaceId, { status: 'connecting' });
}

export function reconnectSkipped(workspaceId: string): void {
  if (!pendingRestore.delete(workspaceId)) return;
  if (sessions.get(workspaceId)?.status === 'connecting') set(workspaceId, { status: 'disconnected' });
}

export function ldClient(workspaceId: string): LdClient {
  return client(workspaceId);
}

function client(workspaceId: string): LdClient {
  const c = clients.get(workspaceId);
  if (!c) throw new Error('Not connected to LaunchDarkly.');
  return c;
}

/** Validate the token (caller identity) and list projects. */
export async function connectLd(workspaceId: string, instance: LdInstanceId, token: string): Promise<void> {
  pendingRestore.delete(workspaceId);
  set(workspaceId, { status: 'connecting', instance, error: undefined, matrix: undefined, flags: undefined });
  const c = new LdClient({ instance, token });
  try {
    const identity = await c.callerIdentity();
    const projects = await c.listProjects();
    secrets.set('ld', workspaceId, token);
    clients.set(workspaceId, c);
    // Keep the workspace's chosen project (e.g. the demo's) and probe it straight away. The probe
    // starts in the same patch as "connected", so `ldConnecting` stays true without a gap.
    const saved = (await store.getWorkspace(workspaceId))?.ld;
    const keep = saved?.instance === instance && saved.projectKey && projects.some((p) => p.key === saved.projectKey) ? saved.projectKey : undefined;
    set(workspaceId, { status: 'connected', identity, projects, ...(keep ? probeStartPatch(sessions.get(workspaceId) ?? EMPTY, keep) : {}) });
    await store.updateWorkspace(workspaceId, { ld: { instance, ...(keep ? { projectKey: keep } : {}) } });
    if (keep) await chooseProject(workspaceId, keep);
    else if (saved?.projectKey) set(workspaceId, { error: `Project "${saved.projectKey}" isn't visible to this token on ${instance}; choose another.` });
  } catch (e) {
    set(workspaceId, { status: 'error', error: e instanceof LdAuthError ? e.message : `Could not reach LaunchDarkly: ${(e as Error).message}` });
  }
}

/**
 * The session patch that starts a probe. Switching projects drops the old project's state;
 * re-probing the *same* project (after creating an environment, or "Re-probe") keeps the matrix
 * and flags in place until the new ones arrive, so `connected` stays true and no screen flashes
 * its "Connect LaunchDarkly" banner while the probe runs.
 */
export function probeStartPatch(current: LdSession, projectKey: string): Partial<LdSession> {
  const sameProject = current.projectKey === projectKey && !!current.matrix;
  return { projectKey, probing: 'Starting', error: undefined, ...(sameProject ? {} : { matrix: undefined, flags: undefined, segments: undefined, experiments: undefined, stale: undefined }) };
}

export async function chooseProject(workspaceId: string, projectKey: string): Promise<void> {
  const c = client(workspaceId);
  set(workspaceId, probeStartPatch(sessions.get(workspaceId) ?? EMPTY, projectKey));
  // After a reload (token restored from the device vault), show the last probe's matrix and the
  // last listing at once, so the guide, mapping, decisions and monitoring screens render while
  // the fresh probe and refresh run. The listing is marked `stale` until the refresh has landed.
  if (!sessions.get(workspaceId)?.matrix) {
    const saved = (await store.getCapabilities(workspaceId))?.matrix as CapabilityMatrix | undefined;
    if (saved && saved.projectKey === projectKey && saved.instance === c.instance.id && !sessions.get(workspaceId)?.matrix) set(workspaceId, { matrix: saved });
  }
  let restored = false;
  if (!sessions.get(workspaceId)?.flags) {
    const saved = await store.getLdState(workspaceId).catch(() => undefined);
    if (saved && saved.projectKey === projectKey && saved.instance === c.instance.id && !sessions.get(workspaceId)?.flags) {
      set(workspaceId, { ...(saved.state as LdListing), stale: saved.loadedAt });
      restored = true;
    }
  }
  try {
    const matrix = await probeCapabilities(c, projectKey, { onProgress: (s) => set(workspaceId, { probing: s }) });
    set(workspaceId, { matrix, probing: undefined });
    await store.updateWorkspace(workspaceId, { ld: { instance: c.instance.id, projectKey } });
    await store.saveCapabilities(workspaceId, matrix);
    // A saved listing stands until the user asks for a re-read (the guide's "Re-read" next to its
    // age), or a plan opens: the plan modal always reads the project afresh before a run, and a
    // finished run merges what it wrote. Without a saved listing, read it now, with the segments
    // and experiments of the environments the profile maps to in the same refresh as the flags.
    if (restored) return;
    const mapped = await mappedLdEnvs(workspaceId, matrix);
    await refreshLdState(workspaceId, { segmentEnvs: [...new Set([...mapped, ...Object.keys(sessions.get(workspaceId)?.segments ?? {})])] });
  } catch (e) {
    set(workspaceId, { probing: undefined, error: `Capability probe failed: ${(e as Error).message}` });
  }
}

/**
 * Create an LD environment for a StatSig environment that has no counterpart (Mapping page). A
 * user-triggered write outside the executor: it is additive, idempotent on 409, and followed by a
 * re-probe so the new environment shows up in the capability matrix and the mapping lists.
 */
export async function createLdEnvironment(workspaceId: string, input: { key: string; name: string; critical?: boolean }): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey) throw new Error('Choose a LaunchDarkly project first.');
  const c = client(workspaceId);
  const color = ENV_COLORS[Math.abs([...input.key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0)) % ENV_COLORS.length]!;
  try {
    await c.createEnvironment(s.projectKey, { key: input.key, name: input.name, color, ...(input.critical ? { critical: true } : {}), tags: [migratedFromTag('statsig')] });
  } catch (e) {
    if (!(e instanceof LdWriteError && e.status === 409)) throw e;
  }
  await chooseProject(workspaceId, s.projectKey);
}

/** LD's own environment palette (hex without `#`), picked deterministically per key. */
const ENV_COLORS = ['417505', 'F5A623', '7B4DFF', '00A3BF', 'E8367D', '2B6CB0', 'D97706', '0F766E'];

/**
 * A write settled a plan-gated capability the probe could only mark "unknown" (PLAN §5.2
 * "the first failed write updates the matrix"). The mapper's options follow the matrix, so a
 * refused big segment or scheduled change stops being offered; an allowed one becomes recommended.
 */
export async function learnCapability(workspaceId: string, c: CapabilityUpdate): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.matrix) return;
  const cap = s.matrix.capabilities.find((x) => x.key === c.key);
  if (!cap || (cap.status === c.status && cap.evidence === c.evidence)) return;
  const matrix: CapabilityMatrix = { ...s.matrix, capabilities: s.matrix.capabilities.map((x) => (x.key === c.key ? { ...x, status: c.status, evidence: `${c.evidence} (learned from a write)` } : x)) };
  set(workspaceId, { matrix });
  await store.saveCapabilities(workspaceId, matrix);
}

export async function reprobe(workspaceId: string): Promise<void> {
  const s = sessions.get(workspaceId);
  if (s?.projectKey) await chooseProject(workspaceId, s.projectKey);
}

/** The LD environments the workspace's profile maps source environments to, among those the project has. */
async function mappedLdEnvs(workspaceId: string, matrix: CapabilityMatrix): Promise<string[]> {
  const profile = await store.getProfile(workspaceId).catch(() => undefined);
  const known = new Set(matrix.environments.map((e) => e.key));
  const out = new Set<string>();
  for (const src of Object.values(profile?.sources ?? {})) for (const ld of Object.values(src.envMapping ?? {})) if (ld && known.has(ld)) out.add(ld);
  return [...out];
}

/** Keep the session's listing for the next open (see `LdSession.stale`). Best effort: a failed write changes nothing shown. */
async function persistLdState(workspaceId: string): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey || !s.instance || !s.flags) return;
  const state: LdListing = {};
  for (const k of LISTING_KEYS) if (s[k] !== undefined) (state as Record<string, unknown>)[k] = s[k];
  await store.saveLdState(workspaceId, { instance: s.instance, projectKey: s.projectKey, loadedAt: s.flags.loadedAt, state }).catch(() => undefined);
}

/**
 * Refreshes and merges are ordered: a listing that started earlier than the newest applied state is
 * discarded when it finishes, so slow pages never overwrite what a run just wrote.
 */
let refreshSeq = 0;
let appliedSeq = 0;

/**
 * Put flags read one by one (GET /flags/{p}/{key}, authoritative) into the session's listing, in
 * place of the listed entry or appended; `null` removes a flag undo deleted. Used after a run for the
 * flags whose listed state disagrees with what the run did (see reconcile.ts).
 */
export function mergeLdFlags(workspaceId: string, updates: { key: string; flag: LdFlag | null }[]): void {
  const s = sessions.get(workspaceId);
  if (!s || !updates.length) return;
  appliedSeq = ++refreshSeq;
  const items = mergeByKey<LdFlagSummary>(
    s.flags?.items ?? [],
    updates.map((u) => ({ key: u.key, item: u.flag })),
  );
  set(workspaceId, { flags: { items, loadedAt: new Date().toISOString() } });
  void persistLdState(workspaceId);
}

/** Same for segments, per LD environment. */
export function mergeLdSegments(workspaceId: string, updates: { ldEnv: string; key: string; segment: LdSegment | null }[]): void {
  const s = sessions.get(workspaceId);
  if (!s || !updates.length) return;
  appliedSeq = ++refreshSeq;
  const segments = { ...(s.segments ?? {}) };
  for (const env of new Set(updates.map((u) => u.ldEnv))) {
    segments[env] = mergeByKey(
      segments[env] ?? [],
      updates.filter((u) => u.ldEnv === env).map((u) => ({ key: u.key, item: u.segment })),
    );
  }
  set(workspaceId, { segments });
  void persistLdState(workspaceId);
}

/**
 * Re-read flags (all environments) and context kinds: after connecting and after every run.
 * `segmentEnvs` also loads segments and experiments in those environments (what a plan and the
 * guide's segment step need); without it, the environments already loaded are re-read. Every
 * list is read in parallel and lands in the session as soon as it is in, so the segments step
 * does not wait for the flag pages. Experimentation reads (metrics, experiments, randomization
 * units) are optional: plans without the add-on answer 403, which must not hide the flags.
 */
export async function refreshLdState(workspaceId: string, opts: { segmentEnvs?: string[] } = {}): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey) return;
  const seq = ++refreshSeq;
  const c = client(workspaceId);
  const p = s.projectKey;
  inFlightRefreshes.set(workspaceId, (inFlightRefreshes.get(workspaceId) ?? 0) + 1);
  set(workspaceId, { refreshing: true });
  try {
    await readLdState(workspaceId, c, p, seq, opts);
  } finally {
    const left = (inFlightRefreshes.get(workspaceId) ?? 1) - 1;
    inFlightRefreshes.set(workspaceId, left);
    if (left <= 0) set(workspaceId, { refreshing: false, refreshProgress: undefined });
  }
}

/** Refreshes in flight per workspace, so `refreshing` clears only when the last one has landed. */
const inFlightRefreshes = new Map<string, number>();

async function readLdState(workspaceId: string, c: LdClient, p: string, seq: number, opts: { segmentEnvs?: string[] }): Promise<void> {
  const s = sessions.get(workspaceId)!;
  const optional = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  // A refresh that started before a later one (or a run's merge) finished would put older state back:
  // once something newer has been applied, this refresh applies nothing more.
  const apply = (patch: Partial<LdSession>): boolean => {
    if (seq < appliedSeq) return false;
    appliedSeq = seq;
    set(workspaceId, patch);
    return true;
  };
  const envs = opts.segmentEnvs ?? Object.keys(s.segments ?? {});
  try {
    const onPage = (read: number, total?: number) => set(workspaceId, { refreshProgress: `Reading flags: ${read.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ''}…` });
    const flags = Promise.all([c.listFlags(p, { onPage }), c.listContextKinds(p)]).then(([items, kinds]) =>
      apply({ flags: { items, loadedAt: new Date().toISOString() }, contextKinds: kinds.items.filter((k) => !k.archived).map((k) => k.key) }),
    );
    const perEnv = envs.map(async (env) => {
      const [segments, experiments] = await Promise.all([c.listSegments(p, env), optional(() => c.listExperiments(p, env))]);
      const cur = sessions.get(workspaceId);
      apply({
        segments: { ...(cur?.segments ?? {}), [env]: segments },
        ...(experiments ? { experiments: { ...(cur?.experiments ?? {}), [env]: experiments } } : {}),
      });
    });
    const account = Promise.all([optional(() => c.listMetrics(p)), optional(() => c.getExperimentationSettings(p)), optional(() => c.listMembers()), optional(() => c.listTeams()), optional(() => c.listAiConfigs(p))]).then(
      ([metrics, settings, members, teams, aiConfigs]) => {
        const defaultUnit = settings?.randomizationUnits?.find((u) => u.default)?.randomizationUnit;
        apply({
          ...(metrics ? { metrics } : {}),
          ...(settings ? { randomizationUnits: (settings.randomizationUnits ?? []).map((u) => u.randomizationUnit) } : {}),
          ...(defaultUnit ? { defaultRandomizationUnit: defaultUnit } : {}),
          ...(members ? { members } : {}),
          ...(teams ? { teams } : {}),
          ...(aiConfigs ? { aiConfigs } : {}),
        });
      },
    );
    await Promise.all([flags, account, ...perEnv]);
    if (!apply({ stale: undefined })) return;
    await persistLdState(workspaceId);
  } catch (e) {
    set(workspaceId, { error: `Could not read the LaunchDarkly project: ${(e as Error).message}` });
  }
}

/**
 * After a run: re-read only the listings it may have changed and does not report item by item
 * (context kinds, metrics, experiments in the environments it wrote bandits to, AI Configs,
 * randomization units). Flags and segments come from the run's own write responses
 * (mergeLdFlags, mergeLdSegments). A run that touched only those reads nothing here.
 */
export async function refreshLdLists(workspaceId: string, needs: LdListNeeds): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey || needsNothing(needs)) return;
  const c = client(workspaceId);
  const p = s.projectKey;
  const optional = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  const [kinds, metrics, settings, aiConfigs, ...experimentLists] = await Promise.all([
    needs.contextKinds ? optional(() => c.listContextKinds(p)) : undefined,
    needs.metrics ? optional(() => c.listMetrics(p)) : undefined,
    needs.settings ? optional(() => c.getExperimentationSettings(p)) : undefined,
    needs.aiConfigs ? optional(() => c.listAiConfigs(p)) : undefined,
    ...needs.experimentEnvs.map((env) => optional(() => c.listExperiments(p, env))),
  ]);
  const experiments = { ...(sessions.get(workspaceId)?.experiments ?? {}) };
  needs.experimentEnvs.forEach((env, i) => {
    const list = experimentLists[i];
    if (list) experiments[env] = list;
  });
  const defaultUnit = settings?.randomizationUnits?.find((u) => u.default)?.randomizationUnit;
  appliedSeq = ++refreshSeq;
  set(workspaceId, {
    ...(kinds ? { contextKinds: kinds.items.filter((k) => !k.archived).map((k) => k.key) } : {}),
    ...(metrics ? { metrics } : {}),
    ...(settings ? { randomizationUnits: (settings.randomizationUnits ?? []).map((u) => u.randomizationUnit) } : {}),
    ...(defaultUnit ? { defaultRandomizationUnit: defaultUnit } : {}),
    ...(aiConfigs ? { aiConfigs } : {}),
    ...(needs.experimentEnvs.length ? { experiments } : {}),
  });
  void persistLdState(workspaceId);
}

// ---------------------------------------------------------------------------------------------
// Guide actions outside the executor: account-level, user-triggered, idempotent (PLAN §8.3, §6)
// ---------------------------------------------------------------------------------------------

export type LdInviteRole = 'reader' | 'writer' | 'admin' | 'no_access';

/**
 * Invite StatSig owners who are not LD members yet (People step). LD emails each one an invitation;
 * the member exists (as `_pendingInvite`) at once, so the next mapping finds them as maintainers.
 * A member who already exists makes LD reject the whole request, so those are left out here.
 */
/**
 * Invite owners as LD members (People step). `teamKeys` puts each person into their teams at
 * invite time, which is why teams are created first; the keys must exist in LD already.
 */
export async function inviteLdMembers(workspaceId: string, people: { email: string; name?: string; teamKeys?: string[] }[], role: LdInviteRole): Promise<void> {
  const s = sessions.get(workspaceId);
  const c = client(workspaceId);
  const have = new Set((s?.members ?? []).map((m) => m.email.toLowerCase()));
  const members = people
    .filter((p) => !have.has(p.email.toLowerCase()))
    .map((p) => {
      const [firstName, ...rest] = (p.name ?? '').trim().split(/\s+/).filter(Boolean);
      return { email: p.email, role, ...(firstName ? { firstName } : {}), ...(rest.length ? { lastName: rest.join(' ') } : {}), ...(p.teamKeys?.length ? { teamKeys: [...p.teamKeys].sort() } : {}) };
    });
  if (!members.length) return;
  try {
    await c.invite(members);
    await learnCapability(workspaceId, { key: 'invite_members', status: 'available', evidence: `invited ${members.length} member${members.length === 1 ? '' : 's'}` });
  } catch (e) {
    if (e instanceof LdWriteError && e.status === 403) await learnCapability(workspaceId, { key: 'invite_members', status: 'not_permitted', evidence: 'POST /members → 403' });
    throw e;
  }
  await refreshLdPeople(workspaceId);
}

/** Create an LD team for a StatSig team, with the members that already exist in LD (People step). Idempotent on 409. */
export async function createLdTeam(workspaceId: string, team: { key: string; name: string; description?: string; memberIDs: string[] }): Promise<void> {
  const c = client(workspaceId);
  try {
    await c.createTeam({ key: team.key, name: team.name, ...(team.description ? { description: team.description } : {}), ...(team.memberIDs.length ? { memberIDs: team.memberIDs } : {}) });
  } catch (e) {
    if (!(e instanceof LdWriteError && e.status === 409)) throw e;
    if (team.memberIDs.length) await c.patchTeamSemantic(team.key, { instructions: [{ kind: 'addMembers', values: team.memberIDs }] });
  }
  await refreshLdPeople(workspaceId);
}

/** Re-read members and teams (after an invite or a team creation). */
export async function refreshLdPeople(workspaceId: string): Promise<void> {
  const c = client(workspaceId);
  const [members, teams] = await Promise.all([c.listMembers().catch(() => undefined), c.listTeams().catch(() => undefined)]);
  set(workspaceId, { ...(members ? { members } : {}), ...(teams ? { teams } : {}) });
}

/**
 * Turn on required approvals in an LD environment whose StatSig counterpart requires reviews (cut
 * over). Only `approvalSettings.required` changes; reviewers and the rest are set up in LD.
 */
export async function requireLdApprovals(workspaceId: string, envKey: string): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey) throw new Error('Choose a LaunchDarkly project first.');
  const c = client(workspaceId);
  try {
    await c.patchEnvironmentJson(s.projectKey, envKey, [{ op: 'replace', path: '/approvalSettings/required', value: true }]);
    await learnCapability(workspaceId, { key: 'approval_settings', status: 'available', evidence: `required approvals turned on in ${envKey}` });
  } catch (e) {
    if (e instanceof LdWriteError && (e.status === 403 || e.status === 404 || e.status === 405)) await learnCapability(workspaceId, { key: 'approval_settings', status: e.status === 403 ? 'not_permitted' : 'unavailable', evidence: `PATCH environment ${envKey} approvalSettings → ${e.status}` });
    throw e;
  }
  await chooseProject(workspaceId, s.projectKey);
}

/** Make `kind` the project's default randomization unit (StatSig's default unit type), enabling it first if needed. */
export async function setDefaultRandomizationUnit(workspaceId: string, kind: string): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey) throw new Error('Choose a LaunchDarkly project first.');
  const c = client(workspaceId);
  const settings = await c.getExperimentationSettings(s.projectKey);
  const units = (settings.randomizationUnits ?? []).map((u) => ({ randomizationUnit: u.randomizationUnit, default: u.randomizationUnit === kind }));
  if (!units.some((u) => u.randomizationUnit === kind)) units.push({ randomizationUnit: kind, default: true });
  await c.putExperimentationSettings(s.projectKey, { randomizationUnits: units });
  set(workspaceId, { randomizationUnits: units.map((u) => u.randomizationUnit), defaultRandomizationUnit: kind });
}

export function disconnectLd(workspaceId: string): void {
  secrets.forget('ld', workspaceId);
  clients.delete(workspaceId);
  sessions.delete(workspaceId);
  listeners.forEach((l) => l());
}

import { useSyncExternalStore } from 'react';
import type { CapabilityUpdate } from '@sslm/executor';
import { migratedFromTag } from '@sslm/canonical';
import { LdAuthError, LdClient, LdWriteError, probeCapabilities, type CapabilityMatrix, type LdCallerIdentity, type LdExperiment, type LdFlagSummary, type LdInstanceId, type LdMetric, type LdProject, type LdSegment } from '@sslm/ld-client';
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
  error?: string;
}

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
  return { projectKey, probing: 'Starting', error: undefined, ...(sameProject ? {} : { matrix: undefined, flags: undefined, segments: undefined, experiments: undefined }) };
}

export async function chooseProject(workspaceId: string, projectKey: string): Promise<void> {
  const c = client(workspaceId);
  set(workspaceId, probeStartPatch(sessions.get(workspaceId) ?? EMPTY, projectKey));
  // After a reload (token restored from the device vault), show the last probe's matrix at once so
  // the mapping, decisions and monitoring screens render while the fresh probe runs.
  if (!sessions.get(workspaceId)?.matrix) {
    const saved = (await store.getCapabilities(workspaceId))?.matrix as CapabilityMatrix | undefined;
    if (saved && saved.projectKey === projectKey && saved.instance === c.instance.id && !sessions.get(workspaceId)?.matrix) set(workspaceId, { matrix: saved });
  }
  try {
    const matrix = await probeCapabilities(c, projectKey, { onProgress: (s) => set(workspaceId, { probing: s }) });
    set(workspaceId, { matrix, probing: undefined });
    await store.updateWorkspace(workspaceId, { ld: { instance: c.instance.id, projectKey } });
    await store.saveCapabilities(workspaceId, matrix);
    await refreshLdState(workspaceId);
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
  if (!s?.projectKey) throw new Error('Choose an LD project first.');
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

/**
 * Re-read flags (all environments) and context kinds: after connecting and after every run.
 * `segmentEnvs` also loads segments and experiments in those environments (what a plan needs).
 * Experimentation reads (metrics, experiments, randomization units) are optional: plans without
 * the add-on answer 403, which must not hide the flags.
 */
export async function refreshLdState(workspaceId: string, opts: { segmentEnvs?: string[] } = {}): Promise<void> {
  const s = sessions.get(workspaceId);
  if (!s?.projectKey) return;
  const c = client(workspaceId);
  const p = s.projectKey;
  const optional = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };
  try {
    const [items, kinds, metrics, settings] = await Promise.all([c.listFlags(p), c.listContextKinds(p), optional(() => c.listMetrics(p)), optional(() => c.getExperimentationSettings(p))]);
    const segments = { ...(sessions.get(workspaceId)?.segments ?? {}) };
    const experiments = { ...(sessions.get(workspaceId)?.experiments ?? {}) };
    for (const env of opts.segmentEnvs ?? Object.keys(segments)) {
      segments[env] = await c.listSegments(p, env);
      const ex = await optional(() => c.listExperiments(p, env));
      if (ex) experiments[env] = ex;
    }
    set(workspaceId, {
      flags: { items, loadedAt: new Date().toISOString() },
      contextKinds: kinds.items.filter((k) => !k.archived).map((k) => k.key),
      segments,
      experiments,
      ...(metrics ? { metrics } : {}),
      ...(settings ? { randomizationUnits: (settings.randomizationUnits ?? []).map((u) => u.randomizationUnit) } : {}),
    });
  } catch (e) {
    set(workspaceId, { error: `Could not read the LD project: ${(e as Error).message}` });
  }
}

export function disconnectLd(workspaceId: string): void {
  secrets.forget('ld', workspaceId);
  clients.delete(workspaceId);
  sessions.delete(workspaceId);
  listeners.forEach((l) => l());
}

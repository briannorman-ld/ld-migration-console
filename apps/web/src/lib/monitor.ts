/**
 * Monitoring (PLAN §14), LD side. Read-only: the check re-reads the LD project (flags with their
 * provenance, flag statuses per environment), keeps a few samples per flag so a 7-day quiet period
 * can be proven later, and never writes to StatSig or LaunchDarkly. Drift itself is computed in
 * @sslm/monitoring from the mapping results the explorers already have.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { readSync, type CanonicalSnapshot } from '@sslm/canonical';
import { alertsSince, ldVersionsAtSync, latestSamples, monitorRows, pruneSamples, shouldSample, type MonitorAlert, type MonitorRow, type MonitoredItem } from '@sslm/monitoring';
import { flagOwner } from '@sslm/planner';
import type { MonitorSampleRecord, MonitorStateRecord, RunJournalRecord } from '@sslm/store';
import { ldClient, ldSessionSnapshot, refreshLdState, type LdSession } from './ld.ts';
import { envTargets, ldFlagState, mapAutotuneFor, mapConfigFor, mapGateFor, mapNeutralFlagFor, type MappingInputs } from './migration.ts';
import { store } from './store.ts';

/** How often the open tab re-checks LD (PLAN §14 "every N minutes, default 15"). */
export const MONITOR_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Every migratable entity in every mapped environment, with what monitoring needs from its mapping
 * result. Archived entities are included: an archive after migration is drift to report.
 */
export function monitoredItems(snapshots: CanonicalSnapshot[], i: MappingInputs, connected: boolean): MonitoredItem[] {
  const out: MonitoredItem[] = [];
  if (!connected) return out;
  for (const snap of snapshots) {
    for (const env of envTargets(i.profile, snap, connected)) {
      const push = (kind: MonitoredItem['kind'], e: { uid: string; id: string; name: string; archived: boolean; version?: number; checksPerHour?: number | null }, r: { flagKey: string; statsigFingerprint: string; decisionSetHash: string; fidelity: { overall: MonitoredItem['fidelity'] }; unresolved: unknown[] }) =>
        out.push({
          kind,
          uid: e.uid,
          id: e.id,
          name: e.name,
          sourceId: snap.source.sourceId,
          sourceAlias: snap.source.alias,
          flagKey: r.flagKey,
          ldEnv: env.ld,
          statsigEnv: env.statsig,
          archived: e.archived,
          statsigFingerprint: r.statsigFingerprint,
          decisionSetHash: r.decisionSetHash,
          ...(e.version !== undefined ? { statsigVersion: e.version } : {}),
          fidelity: r.fidelity.overall,
          openDecisions: r.unresolved.length,
          ...(e.checksPerHour !== undefined ? { checksPerHour: e.checksPerHour } : {}),
        });
      for (const g of snap.gates) push('gate', g, mapGateFor(snap, g, env, i));
      for (const c of snap.configs) push('config', c, mapConfigFor(snap, c, env, i));
      for (const a of snap.autotunes) push('autotune', a, mapAutotuneFor(snap, a, env, i));
      for (const f of snap.neutral?.flags ?? []) push('flag', { uid: f.uid, id: f.key, name: f.name, archived: f.archived, ...(f.version !== undefined ? { version: f.version } : {}) }, mapNeutralFlagFor(snap, f, env, i));
    }
  }
  return out;
}

// One check at a time per workspace; the UI shows a spinner while it runs.
const checking = new Map<string, true>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useMonitorChecking(workspaceId: string): boolean {
  return useSyncExternalStore(subscribe, () => checking.has(workspaceId));
}

export function useMonitorError(workspaceId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => errors.get(workspaceId));
}

/**
 * "Refresh now" and the 15-minute tick: re-read flags, read flag statuses for every LD environment,
 * record samples, save the check. StatSig is not re-crawled here (that is the sidebar's refresh,
 * within the Console API budget); spec sources refresh when a file is uploaded. With
 * `reuseListing`, the check runs against the listing the session holds (the one kept from the
 * last read, on open) and reads only the flag statuses: the check on open costs one request per
 * environment instead of every flag page again.
 */
export async function checkMonitor(workspaceId: string, ld: LdSession, snapshots: CanonicalSnapshot[], opts: { reuseListing?: boolean } = {}): Promise<void> {
  if (!ld.projectKey || ld.status !== 'connected' || checking.has(workspaceId)) return;
  checking.set(workspaceId, true);
  errors.delete(workspaceId);
  notify();
  try {
    if (!(opts.reuseListing && ldSessionSnapshot(workspaceId).flags)) await refreshLdState(workspaceId);
    const c = ldClient(workspaceId);
    const envs = (ld.matrix?.environments ?? []).map((e) => e.key);
    const statuses: MonitorStateRecord['statuses'] = {};
    const envErrors: Record<string, string> = {};
    await Promise.all(
      envs.map(async (env) => {
        try {
          statuses[env] = await c.listFlagStatuses(ld.projectKey!, env);
        } catch (e) {
          envErrors[env] = (e as Error).message;
        }
      }),
    );
    const now = new Date().toISOString();
    // StatSig checks per hour by (source alias, id): the Console API reports them per entity, all environments.
    const checks = new Map<string, number | null | undefined>();
    for (const snap of snapshots) for (const e of [...snap.gates, ...snap.configs]) checks.set(`${snap.source.alias}/${e.id}`, e.checksPerHour);
    const flags = ldSessionSnapshot(workspaceId).flags?.items ?? [];
    const existing = await store.listMonitorSamples(workspaceId);
    const latest = latestSamples(existing);
    const fresh: MonitorSampleRecord[] = [];
    for (const f of flags) {
      const owner = flagOwner(ldFlagState(f));
      if (!owner) continue;
      for (const env of Object.keys(statuses)) {
        if (!readSync(f.customProperties ?? {}, env)) continue;
        const st = statuses[env]?.[f.key];
        if (!st) continue;
        const next = { flagKey: f.key, ldEnv: env, ldStatus: st.name, lastRequested: st.lastRequested ?? null, statsigChecksPerHour: checks.get(`${owner.source}/${owner.id}`) ?? null };
        if (shouldSample(latest.get(`${f.key}|${env}`), next, now)) fresh.push({ id: crypto.randomUUID(), workspaceId, at: now, ...next });
      }
    }
    await store.addMonitorSamples(fresh);
    const keep = new Set(pruneSamples(existing, now).map((s) => s.id));
    await store.deleteMonitorSamples(existing.filter((s) => !keep.has(s.id)).map((s) => s.id));
    const prev = await store.getMonitorState(workspaceId);
    await store.saveMonitorState({ workspaceId, lastCheckedAt: now, statuses, ...(Object.keys(envErrors).length ? { errors: envErrors } : {}), alertKeys: prev?.alertKeys ?? [], ...(prev?.notify ? { notify: true } : {}) });
  } catch (e) {
    errors.set(workspaceId, (e as Error).message);
  } finally {
    checking.delete(workspaceId);
    notify();
  }
}

/**
 * Run a check when the LD connection is ready, then every 15 minutes while the tab is open. The
 * first check uses the listing the session holds (on open, the one kept from the last read); the
 * ticks re-read the project, so a change made in LaunchDarkly shows up within the interval.
 */
export function useMonitorSchedule(workspaceId: string, ld: LdSession, snapshots: CanonicalSnapshot[], enabled: boolean): void {
  const ready = enabled && ld.status === 'connected' && !!ld.matrix && snapshots.length > 0;
  const snapKey = snapshots.map((s) => `${s.source.sourceId}@${s.takenAt}`).join('|');
  useEffect(() => {
    if (!ready) return;
    void checkMonitor(workspaceId, ld, snapshots, { reuseListing: true });
    const t = window.setInterval(() => void checkMonitor(workspaceId, ld, snapshots), MONITOR_INTERVAL_MS);
    return () => window.clearInterval(t);
    // `ld` changes identity on every session patch; re-running on connection/project only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, ready, ld.projectKey, snapKey]);
}

export interface MonitoringData {
  rows: MonitorRow[];
  alerts: MonitorAlert[];
  alertKeys: string[];
  state?: MonitorStateRecord;
  /** Rows that need attention (drift, archives, deletions). */
  attention: number;
  loaded: boolean;
}

/**
 * Live monitoring rows from IndexedDB (last check, switches, samples, runs) and the mapping results.
 * `runs` is the workspace's run journal when the caller already has it live (WorkspaceScreen does;
 * each record carries pre-images, so it is read once per change, not once per subscriber).
 */
export function useMonitoring(workspaceId: string, items: MonitoredItem[], ld: LdSession, runs?: RunJournalRecord[]): MonitoringData {
  const state = useLiveQuery(() => store.getMonitorState(workspaceId), [workspaceId]);
  const settings = useLiveQuery(() => store.listMonitorItems(workspaceId), [workspaceId]);
  const samples = useLiveQuery(() => store.listMonitorSamples(workspaceId), [workspaceId]);
  const ownRuns = useLiveQuery(() => (runs ? undefined : store.listRuns(workspaceId)), [workspaceId, !!runs]);
  runs ??= ownRuns;
  const versions = useMemo(() => ldVersionsAtSync(runs ?? []), [runs]);
  return useMemo(() => {
    const loaded = settings !== undefined && samples !== undefined && runs !== undefined;
    const ldFlags = new Map((ld.flags?.items ?? []).map((f) => [f.key, { ...ldFlagState(f), environments: f.environments ?? null }]));
    const rows = loaded ? monitorRows({ items, ldFlags, statuses: state?.statuses ?? {}, settings: settings ?? [], samples: samples ?? [], ldVersionsAtSync: versions, now: new Date().toISOString() }) : [];
    const { alerts, keys } = alertsSince(state?.alertKeys ?? [], rows);
    const attention = rows.filter((r) => r.status === 'statsig_changed' || r.status === 'decisions_changed' || r.status === 'ld_changed' || r.status === 'conflict' || r.status === 'archived_in_statsig' || r.status === 'missing_in_statsig').length;
    return { rows, alerts, alertKeys: keys, ...(state ? { state } : {}), attention, loaded };
  }, [items, ld.flags, state, settings, samples, versions, runs]);
}

/** The alerts were shown (or notified): remember them so they fire once. */
export async function acknowledgeAlerts(workspaceId: string, keys: string[]): Promise<void> {
  const prev = await store.getMonitorState(workspaceId);
  if (!prev) return;
  await store.saveMonitorState({ ...prev, alertKeys: keys });
}

export async function setLdAuthoritative(workspaceId: string, flagKey: string, ldEnv: string, on: boolean): Promise<void> {
  await store.setMonitorItem({ workspaceId, flagKey, ldEnv, ldAuthoritative: on, setAt: new Date().toISOString() });
}

export async function setMonitorNotify(workspaceId: string, on: boolean): Promise<void> {
  const prev = (await store.getMonitorState(workspaceId)) ?? { workspaceId, lastCheckedAt: '', statuses: {}, alertKeys: [] };
  await store.saveMonitorState({ ...prev, notify: on });
}

/**
 * Browser notifications (PLAN §14 "in-app alerts, and browser notifications if allowed, while
 * the tab is open"): one per new alert, only when the user turned them on for this workspace.
 */
export function useMonitorNotifications(workspaceId: string, data: MonitoringData): void {
  const shown = useRef(new Set<string>());
  const keys = data.alertKeys.join('\n');
  useEffect(() => {
    if (!data.state?.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const fresh = data.alerts.filter((a) => {
      const k = `${a.row.flagKey}|${a.row.ldEnv}|${a.kind}|${a.row.syncedAt ?? ''}`;
      if (shown.current.has(k)) return false;
      shown.current.add(k);
      return true;
    });
    for (const a of fresh.slice(0, 5)) {
      try {
        new Notification('LaunchDarkly migration', { body: a.message, tag: `sslm-${workspaceId}-${a.row.flagKey}-${a.row.ldEnv}` });
      } catch {
        // Notifications may be unavailable in this context (e.g. an iframe); the in-app callout still shows.
      }
    }
  }, [workspaceId, keys, data.alerts, data.state?.notify]);
}

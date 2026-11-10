import { readSync, syncedEnvsOf } from '@sslm/canonical';
import { flagOwner, ldChange, migrationStatus } from '@sslm/planner';

// The detector moved to the planner (which asks before writing over an LD edit); re-exported for monitoring's callers.
export { LD_CHANGE_GRACE_MS, ldChange } from '@sslm/planner';
import type { AlertKind, FlagStatusInfo, LdFlagEnvInfo, LdFlagInfo, LdTraffic, Lifecycle, MonitorAlert, MonitorInput, MonitorRow, MonitorSample, MonitorStatus, MonitoredItem } from './types.ts';

/** Statuses that mean "under monitoring" (the flag carries a sync for this environment). */
export const MONITORED: ReadonlySet<MonitorStatus> = new Set<MonitorStatus>(['in_sync', 'statsig_changed', 'decisions_changed', 'ld_changed', 'conflict', 'archived_in_statsig', 'missing_in_statsig', 'ld_authoritative']);

/** Statuses that ask for a person's attention. */
export const DRIFTED: ReadonlySet<MonitorStatus> = new Set<MonitorStatus>(['statsig_changed', 'decisions_changed', 'ld_changed', 'conflict', 'archived_in_statsig', 'missing_in_statsig']);

/** StatSig must have been at zero checks this long, continuously, before a flag counts as cut over (PLAN §14). */
export const CUTOVER_QUIET_MS = 7 * 24 * 3600 * 1000;

export const itemKey = (flagKey: string, ldEnv: string) => `${flagKey}|${ldEnv}`;

export function trafficOf(status: FlagStatusInfo | undefined): LdTraffic {
  const n = status?.name;
  return n === 'new' || n === 'inactive' || n === 'active' || n === 'launched' ? n : 'unknown';
}

/**
 * How long StatSig has shown zero checks for this item, judged from the samples taken while the
 * app was open: the start of the latest unbroken run of zero-check samples that reaches the newest
 * sample. Undefined when the newest sample shows checks, or none says.
 */
export function statsigZeroSince(samples: readonly MonitorSample[]): string | undefined {
  const sorted = [...samples].sort((a, b) => a.at.localeCompare(b.at));
  let since: string | undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i]!;
    if (s.statsigChecksPerHour !== 0) break;
    since = s.at;
  }
  return since;
}

export function lifecycleOf(status: MonitorStatus, traffic: LdTraffic, ldAuthoritative: boolean, zeroSince: string | undefined, now: string): Lifecycle {
  if (!MONITORED.has(status)) return 'not_migrated';
  if (ldAuthoritative) return 'ld_authoritative';
  if (traffic !== 'active' && traffic !== 'launched') return 'migrated';
  if (zeroSince && Date.parse(now) - Date.parse(zeroSince) >= CUTOVER_QUIET_MS) return 'cut_over';
  return 'dual_running';
}

/**
 * Drift and lifecycle for every monitored item, plus LD flags that carry our provenance but no
 * longer have a StatSig entity behind them. Pure; the app feeds it mapping results and LD reads.
 */
export function monitorRows(input: MonitorInput): MonitorRow[] {
  const settings = new Map(input.settings.map((s) => [itemKey(s.flagKey, s.ldEnv), s]));
  const samplesByKey = new Map<string, MonitorSample[]>();
  for (const s of input.samples) {
    const k = itemKey(s.flagKey, s.ldEnv);
    const list = samplesByKey.get(k) ?? [];
    list.push(s);
    samplesByKey.set(k, list);
  }
  const rows: MonitorRow[] = [];
  const seen = new Set<string>();
  for (const item of input.items) {
    const flag = input.ldFlags.get(item.flagKey);
    const owner = flag ? flagOwner(flag) : null;
    if (owner) seen.add(`${owner.source}/${owner.id}`);
    const base = migrationStatus(flag, item.ldEnv, item, { id: item.id, source: item.sourceAlias });
    const k = itemKey(item.flagKey, item.ldEnv);
    const authoritative = settings.get(k)?.ldAuthoritative ?? false;
    let status: MonitorStatus = base.status;
    let ldChanged = false;
    let evidence: string | undefined;
    const statsigChanged = base.status === 'statsig_changed' || base.status === 'decisions_changed';
    if (MONITORED.has(base.status) && flag) {
      const change = ldChange(flag.environments?.[item.ldEnv], base.syncedAt, input.ldVersionsAtSync?.[k]);
      ldChanged = change.changed;
      evidence = change.evidence;
      if (item.archived) status = 'archived_in_statsig';
      else if (authoritative) status = 'ld_authoritative';
      else if (ldChanged && statsigChanged) status = 'conflict';
      else if (ldChanged) status = 'ld_changed';
    }
    const traffic = trafficOf(input.statuses[item.ldEnv]?.[item.flagKey]);
    const lastRequested = input.statuses[item.ldEnv]?.[item.flagKey]?.lastRequested ?? undefined;
    const zeroSince = statsigZeroSince(samplesByKey.get(k) ?? []);
    const ldOn = flag?.environments?.[item.ldEnv]?.on ?? undefined;
    rows.push({
      ...item,
      status,
      ...(base.syncedAt ? { syncedAt: base.syncedAt } : {}),
      statsigChanged,
      ldChanged,
      ...(evidence ? { ldChangeEvidence: evidence } : {}),
      ...(ldOn !== undefined && ldOn !== null ? { ldOn } : {}),
      traffic,
      ...(lastRequested ? { lastRequested } : {}),
      lifecycle: lifecycleOf(status, traffic, authoritative, zeroSince, input.now),
      ldAuthoritative: authoritative,
      ...(zeroSince ? { statsigZeroSince: zeroSince } : {}),
    });
  }
  // Flags we migrated whose StatSig entity is gone from every current snapshot (deleted, or the
  // source's key no longer reads it). Not "archived": an archive still shows up in the snapshot.
  const knownSources = new Set(input.items.map((i) => i.sourceAlias));
  for (const flag of input.ldFlags.values()) {
    const owner = flagOwner(flag);
    if (!owner || seen.has(`${owner.source}/${owner.id}`) || !knownSources.has(owner.source)) continue;
    const kind = owner.type === 'config' || owner.type === 'autotune' || owner.type === 'flag' ? owner.type : 'gate';
    for (const ldEnv of syncedEnvsOf(flag.customProperties)) {
      const sync = readSync(flag.customProperties, ldEnv)!;
      const k = itemKey(flag.key, ldEnv);
      const authoritative = settings.get(k)?.ldAuthoritative ?? false;
      const traffic = trafficOf(input.statuses[ldEnv]?.[flag.key]);
      const syncedAt = sync[2] ?? undefined;
      rows.push({
        kind,
        uid: `${owner.source}/${kind}/${owner.id}`,
        id: owner.id,
        name: owner.id,
        sourceId: '',
        sourceAlias: owner.source,
        flagKey: flag.key,
        ldEnv,
        statsigEnv: '',
        archived: false,
        statsigFingerprint: '',
        decisionSetHash: '',
        fidelity: 'skipped',
        openDecisions: 0,
        status: 'missing_in_statsig',
        ...(syncedAt ? { syncedAt } : {}),
        statsigChanged: true,
        ldChanged: false,
        traffic,
        lifecycle: lifecycleOf('missing_in_statsig', traffic, authoritative, undefined, input.now),
        ldAuthoritative: authoritative,
      });
    }
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.ldEnv.localeCompare(b.ldEnv));
}

/** Per LD environment: how many monitored items sit at each lifecycle stage (the §14 funnel). */
export function funnel(rows: readonly MonitorRow[]): { ldEnv: string; counts: Record<Lifecycle, number>; total: number }[] {
  const out = new Map<string, Record<Lifecycle, number>>();
  for (const r of rows) {
    const c = out.get(r.ldEnv) ?? { not_migrated: 0, migrated: 0, dual_running: 0, cut_over: 0, ld_authoritative: 0 };
    c[r.lifecycle]++;
    out.set(r.ldEnv, c);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ldEnv, counts]) => ({ ldEnv, counts, total: Object.values(counts).reduce((n, x) => n + x, 0) }));
}

export function countByStatus(rows: readonly MonitorRow[]): Partial<Record<MonitorStatus, number>> {
  const out: Partial<Record<MonitorStatus, number>> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

/** The alert key of a row: what the alert baseline remembers so an alert fires once per change. */
export function alertKey(row: MonitorRow): string | undefined {
  if (row.lifecycle === 'cut_over') return `${itemKey(row.flagKey, row.ldEnv)}:cut_over`;
  if (DRIFTED.has(row.status)) return `${itemKey(row.flagKey, row.ldEnv)}:${row.status}:${row.syncedAt ?? ''}`;
  return undefined;
}

/**
 * In-app alerts (PLAN §14): drift detected and waves cut over, each fired once. `previous` is the
 * set of alert keys already shown; the caller stores the returned `keys` as the next baseline.
 */
export function alertsSince(previous: ReadonlySet<string> | readonly string[], rows: readonly MonitorRow[]): { alerts: MonitorAlert[]; keys: string[] } {
  const prev = previous instanceof Set ? previous : new Set(previous);
  const alerts: MonitorAlert[] = [];
  const keys: string[] = [];
  for (const row of rows) {
    const key = alertKey(row);
    if (!key) continue;
    keys.push(key);
    if (prev.has(key)) continue;
    alerts.push({ kind: alertKindOf(row), row, message: describeAlert(row) });
  }
  return { alerts, keys };
}

function alertKindOf(row: MonitorRow): AlertKind {
  if (row.lifecycle === 'cut_over') return 'cut_over';
  if (row.status === 'archived_in_statsig') return 'archived';
  if (row.status === 'missing_in_statsig') return 'missing';
  return 'drift';
}

export function describeStatus(status: MonitorStatus): string {
  switch (status) {
    case 'in_sync':
      return 'in sync';
    case 'statsig_changed':
      return 'StatSig changed';
    case 'decisions_changed':
      return 'decisions changed';
    case 'ld_changed':
      return 'LaunchDarkly changed';
    case 'conflict':
      return 'conflict: both changed';
    case 'archived_in_statsig':
      return 'archived in StatSig';
    case 'missing_in_statsig':
      return 'gone from StatSig';
    case 'ld_authoritative':
      return 'LaunchDarkly authoritative';
    case 'not_in_ld':
    case 'not_migrated':
      return 'not migrated';
    case 'foreign':
      return 'existing LaunchDarkly key';
    case 'other_source':
      return 'migrated from another source';
  }
}

export function describeLifecycle(l: Lifecycle): string {
  switch (l) {
    case 'not_migrated':
      return 'not migrated';
    case 'migrated':
      return 'migrated, no LaunchDarkly traffic yet';
    case 'dual_running':
      return 'dual-running';
    case 'cut_over':
      return 'cut over: safe to archive in StatSig';
    case 'ld_authoritative':
      return 'LaunchDarkly authoritative';
  }
}

export function describeAlert(row: MonitorRow): string {
  const where = `${row.id} in ${row.ldEnv}`;
  switch (alertKindOf(row)) {
    case 'cut_over':
      return `${where} has had LaunchDarkly traffic and no StatSig checks for 7 days: safe to archive in StatSig.`;
    case 'archived':
      return `${where} was archived in StatSig after migration: retire the LaunchDarkly flag rather than syncing it.`;
    case 'missing':
      return `${where} carries migration provenance in LaunchDarkly but no current StatSig snapshot has it.`;
    case 'drift':
      return `${where}: ${describeStatus(row.status)}${row.ldChangeEvidence ? ` (${row.ldChangeEvidence})` : ''}.`;
  }
}

/**
 * `<flagKey>|<ldEnv>` → the LD environment version after the latest completed sync, from the run
 * journal (PLAN §7 "local part: ld_version_at_sync"). Runs newest first; undone steps don't count.
 */
export function ldVersionsAtSync(runs: readonly { steps: readonly { status: string; ldVersion?: number; step: { op: string; key: string; ldEnv?: string } }[] }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const run of runs) {
    for (const s of run.steps) {
      if (s.step.op !== 'update_flag_env' || s.status !== 'done' || s.ldVersion === undefined || !s.step.ldEnv) continue;
      const k = itemKey(s.step.key, s.step.ldEnv);
      if (!(k in out)) out[k] = s.ldVersion;
    }
  }
  return out;
}

export type { MonitoredItem };

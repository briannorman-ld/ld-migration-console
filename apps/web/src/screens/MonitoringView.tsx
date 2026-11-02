import { useMemo, useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { LD_INSTANCES } from '@sslm/ld-client';
import { countByStatus, describeLifecycle, describeStatus, DRIFTED, funnel, statusCsv, statusMarkdown, type Lifecycle, type MonitorAlert, type MonitorRow, type MonitorStatus } from '@sslm/monitoring';
import type { SourceRecord, WorkspaceRecord } from '@sslm/store';
import { Badge, Button, Callout, Card, cx, Input, PageTitle, Select, Spinner, type Tone } from '../components/ui.tsx';
import { demoTimeline, demoTimelineSteps, setDemoTimeline } from '../lib/demo.ts';
import type { LdSession } from '../lib/ld.ts';
import { collectDecisions, decisionLogCsv, decisionLogMarkdown, download, type MigrationSelection } from '../lib/migration.ts';
import { acknowledgeAlerts, checkMonitor, setLdAuthoritative, setMonitorNotify, useMonitorChecking, useMonitorError, type MonitoringData } from '../lib/monitor.ts';
import { timeAgo } from '../lib/time.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

export const MONITOR_TONE: Record<MonitorStatus, Tone> = {
  not_in_ld: 'slate',
  not_migrated: 'slate',
  foreign: 'red',
  other_source: 'violet',
  in_sync: 'green',
  statsig_changed: 'amber',
  decisions_changed: 'amber',
  ld_changed: 'amber',
  conflict: 'red',
  archived_in_statsig: 'violet',
  missing_in_statsig: 'violet',
  ld_authoritative: 'blue',
};

const LIFECYCLE_TONE: Record<Lifecycle, Tone> = { not_migrated: 'slate', migrated: 'blue', dual_running: 'amber', cut_over: 'green', ld_authoritative: 'blue' };
const STAGES: Lifecycle[] = ['migrated', 'dual_running', 'cut_over', 'ld_authoritative'];
const TILES: MonitorStatus[] = ['in_sync', 'statsig_changed', 'decisions_changed', 'ld_changed', 'conflict', 'archived_in_statsig', 'missing_in_statsig', 'ld_authoritative'];

/**
 * Monitoring (PLAN §14): drift per (item, LD environment) read from LD provenance, LD traffic from
 * flag statuses, the cutover funnel, in-app alerts and the reports. Read-only: every "Sync" goes
 * through the normal plan → confirm → run flow.
 */
export function MonitoringView({
  workspaceId,
  workspace,
  sources,
  snapshots,
  m,
  data,
  onMigrate,
  onResyncSource,
}: {
  workspaceId: string;
  workspace: WorkspaceRecord;
  sources: SourceRecord[];
  snapshots: CanonicalSnapshot[];
  m: MigrationContext;
  data: MonitoringData;
  onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void;
  onResyncSource: (source: SourceRecord) => void;
}) {
  const checking = useMonitorChecking(workspaceId);
  const error = useMonitorError(workspaceId);
  const consoleSources = sources.filter((s) => s.kind === 'console_api');
  const decisionLog = () => collectDecisions(snapshots, m.profile, m.connected, m);
  const [demoStep, setDemoStep] = useState(demoTimeline);
  const demo = workspace.isDemo
    ? {
        step: demoStep,
        steps: demoTimelineSteps(),
        onAdvance: () => {
          setDemoTimeline(demoStep + 1);
          setDemoStep(demoTimeline());
          consoleSources.forEach(onResyncSource);
        },
      }
    : undefined;
  return (
    <MonitoringPanel
      workspaceName={workspace.name}
      ld={m.ld}
      rows={data.rows}
      alerts={data.alerts}
      loaded={data.loaded}
      lastCheckedAt={data.state?.lastCheckedAt}
      envErrors={data.state?.errors}
      notify={data.state?.notify ?? false}
      checking={checking}
      error={error}
      hasConsoleSources={consoleSources.length > 0}
      onRefresh={() => void checkMonitor(workspaceId, m.ld, snapshots)}
      onResyncStatsig={() => consoleSources.forEach(onResyncSource)}
      onDismissAlerts={() => void acknowledgeAlerts(workspaceId, data.alertKeys)}
      onToggleNotify={async (on) => {
        if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
        await setMonitorNotify(workspaceId, on);
      }}
      onToggleAuthoritative={(row, on) => void setLdAuthoritative(workspaceId, row.flagKey, row.ldEnv, on)}
      onSync={(row) => onMigrate(row.kind === 'config' ? { gates: [], configs: [row.uid], autotunes: [] } : row.kind === 'autotune' ? { gates: [], autotunes: [row.uid] } : row.kind === 'flag' ? { gates: [], autotunes: [], flags: [row.uid] } : { gates: [row.uid], autotunes: [] }, [row.ldEnv])}
      exportDecisionLog={{ markdown: () => decisionLogMarkdown(workspace.name, decisionLog(), m.resolutions, m.profile), csv: () => decisionLogCsv(decisionLog()) }}
      demo={demo}
    />
  );
}

export interface MonitoringPanelProps {
  workspaceName: string;
  ld: LdSession;
  rows: MonitorRow[];
  alerts: MonitorAlert[];
  loaded: boolean;
  lastCheckedAt?: string;
  envErrors?: Record<string, string>;
  notify: boolean;
  checking: boolean;
  error?: string;
  hasConsoleSources: boolean;
  onRefresh: () => void;
  onResyncStatsig: () => void;
  onDismissAlerts: () => void;
  onToggleNotify: (on: boolean) => void;
  onToggleAuthoritative: (row: MonitorRow, on: boolean) => void;
  onSync: (row: MonitorRow) => void;
  exportDecisionLog: { markdown: () => string; csv: () => string };
  demo?: { step: number; steps: number; onAdvance: () => void };
}

/** Presentational half, so it renders from plain rows in tests. */
export function MonitoringPanel(p: MonitoringPanelProps) {
  const [env, setEnv] = useState<string>('all');
  const [status, setStatus] = useState<MonitorStatus | 'all' | 'attention'>('attention');
  const [q, setQ] = useState('');
  const connected = p.ld.status === 'connected' && !!p.ld.matrix;
  const monitored = useMemo(() => p.rows.filter((r) => r.status !== 'not_in_ld' && r.status !== 'not_migrated'), [p.rows]);
  const counts = useMemo(() => countByStatus(monitored), [monitored]);
  const envs = useMemo(() => [...new Set(p.rows.map((r) => r.ldEnv))].sort(), [p.rows]);
  const attention = monitored.filter((r) => DRIFTED.has(r.status));
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return monitored.filter((r) => (env === 'all' || r.ldEnv === env) && (status === 'all' || (status === 'attention' ? DRIFTED.has(r.status) : r.status === status)) && (!needle || r.id.toLowerCase().includes(needle) || r.flagKey.toLowerCase().includes(needle)));
  }, [monitored, env, status, q]);
  const ldBase = p.ld.projectKey ? `${LD_INSTANCES[p.ld.instance ?? 'us'].origin}/projects/${p.ld.projectKey}/flags` : undefined;
  const now = new Date().toISOString();
  const spec = (r: MonitorRow) => r.checksPerHour === undefined;

  return (
    <div className="max-w-6xl space-y-5">
      <PageTitle
        eyebrow="Monitoring"
        after={
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {p.checking ? (
              <span className="flex items-center gap-1.5">
                <Spinner /> Checking LaunchDarkly…
              </span>
            ) : p.lastCheckedAt ? (
              <span title={p.lastCheckedAt}>Last checked {timeAgo(p.lastCheckedAt)}</span>
            ) : (
              <span>Not checked yet</span>
            )}
            <Button variant="secondary" className="py-1 text-xs" disabled={!connected || p.checking} onClick={p.onRefresh}>
              Refresh now
            </Button>
            {p.hasConsoleSources && (
              <Button variant="ghost" className="py-1 text-xs" onClick={p.onResyncStatsig} title="Re-crawl the Console API sources, within their rate budget">
                Re-sync StatSig
              </Button>
            )}
          </div>
        }
      >
        Drift and cutover
      </PageTitle>
      <p className="max-w-3xl text-sm text-fg-muted">
        Read-only. Drift compares the StatSig fingerprint recorded in each flag’s LaunchDarkly provenance with the current snapshot, and the flag’s LaunchDarkly modification time with the sync. LaunchDarkly traffic
        comes from flag statuses; StatSig checks come from the Console API (all environments). Re-checks every 15 minutes while this tab is open; nothing is ever written from here.
      </p>

      {!connected && <Callout tone="blue">Connect LaunchDarkly and choose a project to monitor migrated flags.</Callout>}
      {p.error && <Callout tone="red">Last check failed: {p.error}</Callout>}
      {p.envErrors && Object.keys(p.envErrors).length > 0 && (
        <Callout>
          Flag statuses could not be read in {Object.keys(p.envErrors).join(', ')}: {Object.values(p.envErrors)[0]}. Drift still works; LaunchDarkly traffic shows as unknown there.
        </Callout>
      )}

      {p.alerts.length > 0 && (
        <Callout tone={p.alerts.some((a) => a.kind === 'drift' || a.kind === 'archived' || a.kind === 'missing') ? 'amber' : 'green'}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">Since your last look</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {p.alerts.slice(0, 8).map((a) => (
                  <li key={`${a.row.flagKey}|${a.row.ldEnv}|${a.kind}`}>{a.message}</li>
                ))}
                {p.alerts.length > 8 && <li>…and {p.alerts.length - 8} more.</li>}
              </ul>
            </div>
            <Button variant="secondary" className="shrink-0 py-1 text-xs" onClick={p.onDismissAlerts}>
              Dismiss
            </Button>
          </div>
        </Callout>
      )}

      <div className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {TILES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(status === s ? 'all' : s)}
            aria-pressed={status === s}
            className={cx('rounded-md border p-2.5 text-left transition-colors', status === s ? 'border-line-strong bg-selected' : 'border-line bg-surface hover:bg-surface-hover')}
          >
            <div className="text-lg font-semibold tabular-nums">{counts[s] ?? 0}</div>
            <div className="text-xs text-fg-muted">{describeStatus(s)}</div>
          </button>
        ))}
      </div>

      <Card className="p-4">
        <h3 className="text-sm font-semibold">Cutover funnel</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          Migrated (no LaunchDarkly traffic) → dual-running (LaunchDarkly serving) → cut over (LaunchDarkly serving, StatSig at zero checks for 7 days) → safe to archive in StatSig. A person archives it in StatSig.
        </p>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">LaunchDarkly environment</th>
              {STAGES.map((s) => (
                <th key={s} className="py-1 pr-3 text-right font-medium">
                  {describeLifecycle(s).split(':')[0]}
                </th>
              ))}
              <th className="py-1 text-right font-medium">Monitored</th>
            </tr>
          </thead>
          <tbody>
            {funnel(monitored).map((f) => (
              <tr key={f.ldEnv} className="border-t border-line">
                <td className="py-1.5 pr-3 font-medium">{f.ldEnv}</td>
                {STAGES.map((s) => (
                  <td key={s} className="py-1.5 pr-3 text-right tabular-nums">
                    {f.counts[s]}
                  </td>
                ))}
                <td className="py-1.5 text-right tabular-nums">{f.total}</td>
              </tr>
            ))}
            {monitored.length === 0 && (
              <tr className="border-t border-line">
                <td colSpan={STAGES.length + 2} className="py-2 text-fg-muted">
                  {p.loaded ? 'Nothing migrated yet. Items appear here once a run has synced them.' : 'Loading…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by StatSig ID or flag key" aria-label="Filter items" className="w-64 py-1" />
        <Select value={env} onChange={(e) => setEnv(e.target.value)} aria-label="LaunchDarkly environment" className="py-1">
          <option value="all">All environments</option>
          {envs.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as MonitorStatus | 'all' | 'attention')} aria-label="Status" className="py-1">
          <option value="attention">Needs attention ({attention.length})</option>
          <option value="all">All monitored ({monitored.length})</option>
          {TILES.map((s) => (
            <option key={s} value={s}>
              {describeStatus(s)}
            </option>
          ))}
        </Select>
        <span className="ml-auto text-xs text-fg-muted">
          {visible.length} of {monitored.length}
        </span>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm" aria-label="Monitored items">
          <thead className="bg-surface-2 text-left text-xs text-fg-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">LaunchDarkly env</th>
              <th className="px-3 py-2 font-medium">Drift</th>
              <th className="px-3 py-2 font-medium">LaunchDarkly traffic</th>
              <th className="px-3 py-2 font-medium">StatSig checks/h</th>
              <th className="px-3 py-2 font-medium">Lifecycle</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={`${r.flagKey}|${r.ldEnv}`} className="border-t border-line align-top">
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{r.id}</span>
                    <Badge>{r.kind}</Badge>
                    <Badge tone="slate">{r.sourceAlias}</Badge>
                    {r.openDecisions > 0 && <Badge tone="amber">{r.openDecisions} open</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-fg-muted">
                    {ldBase ? (
                      <a className="text-link hover:underline" href={`${ldBase}/${encodeURIComponent(r.flagKey)}/targeting?env=${encodeURIComponent(r.ldEnv)}`} target="_blank" rel="noreferrer">
                        {r.flagKey}
                      </a>
                    ) : (
                      r.flagKey
                    )}
                    {r.syncedAt && <span title={r.syncedAt}> · synced {timeAgo(r.syncedAt)}</span>}
                    {r.fidelity !== 'full' && <span> · {r.fidelity} fidelity</span>}
                  </div>
                </td>
                <td className="px-3 py-2">{r.ldEnv}</td>
                <td className="px-3 py-2">
                  <Badge tone={MONITOR_TONE[r.status]} title={r.ldChangeEvidence}>
                    {describeStatus(r.status)}
                  </Badge>
                  {r.ldChangeEvidence && <div className="mt-0.5 max-w-xs text-xs text-fg-muted">{r.ldChangeEvidence}</div>}
                  {r.status === 'ld_authoritative' && r.statsigChanged && <div className="mt-0.5 text-xs text-fg-muted">StatSig has changed since the sync (muted).</div>}
                </td>
                <td className="px-3 py-2">
                  <span className={cx(r.traffic === 'active' || r.traffic === 'launched' ? 'text-success' : 'text-fg-muted')}>{r.traffic}</span>
                  {r.ldOn !== undefined && <span className="text-xs text-fg-muted"> · {r.ldOn ? 'on' : 'off'}</span>}
                  {r.lastRequested && (
                    <div className="text-xs text-fg-muted" title={r.lastRequested}>
                      last requested {timeAgo(r.lastRequested)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {spec(r) ? <span className="text-fg-muted" title="Config-spec sources carry no check counts; attach a Console API key to see StatSig traffic.">needs Console key</span> : (r.checksPerHour ?? <span className="text-fg-muted">unknown</span>)}
                  {r.statsigZeroSince && (
                    <div className="text-xs text-fg-muted" title={r.statsigZeroSince}>
                      zero since {timeAgo(r.statsigZeroSince)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={LIFECYCLE_TONE[r.lifecycle]}>{describeLifecycle(r.lifecycle).split(':')[0]}</Badge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1.5">
                    {(r.status === 'statsig_changed' || r.status === 'decisions_changed' || r.status === 'conflict') && (
                      <Button variant="secondary" className="py-0.5 text-xs" onClick={() => p.onSync(r)} title="Plan a re-sync of this item in this environment (mirrors StatSig as of the latest snapshot)">
                        Sync
                      </Button>
                    )}
                    {r.status === 'ld_changed' && (
                      <Button variant="secondary" className="py-0.5 text-xs" onClick={() => p.onSync(r)} title="Overwrite the LaunchDarkly edit with StatSig's current state">
                        Re-sync (overwrite)
                      </Button>
                    )}
                    {(r.status === 'archived_in_statsig' || r.status === 'missing_in_statsig') && ldBase && (
                      <a className="rounded-md border border-line px-2 py-0.5 text-xs text-fg hover:bg-surface-hover" href={`${ldBase}/${encodeURIComponent(r.flagKey)}/settings`} target="_blank" rel="noreferrer">
                        Retire in LaunchDarkly
                      </a>
                    )}
                    {r.status !== 'archived_in_statsig' && r.status !== 'missing_in_statsig' && (
                      <label className="flex items-center gap-1 text-xs text-fg-muted" title="After cutover: StatSig changes stop alerting and a sync needs an explicit confirmation">
                        <input type="checkbox" checked={r.ldAuthoritative} onChange={(e) => p.onToggleAuthoritative(r, e.target.checked)} aria-label={`LaunchDarkly authoritative for ${r.id} in ${r.ldEnv}`} />
                        LaunchDarkly authoritative
                      </label>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr className="border-t border-line">
                <td colSpan={7} className="px-3 py-3 text-fg-muted">
                  {monitored.length === 0 ? 'No migrated items yet.' : status === 'attention' ? 'Nothing needs attention.' : 'No items match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="text-sm font-semibold">Reports</h3>
          <p className="mt-0.5 text-xs text-fg-muted">Inventory with fidelity and migration status per environment, the cutover funnel, and the decision log.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" className="py-1 text-xs" onClick={() => download('migration-status.md', statusMarkdown(p.workspaceName, p.rows, { now, ...(p.lastCheckedAt ? { lastCheckedAt: p.lastCheckedAt } : {}), ...(p.ld.projectKey ? { ldProject: p.ld.projectKey } : {}) }), 'text/markdown')}>
              Migration status (.md)
            </Button>
            <Button variant="secondary" className="py-1 text-xs" onClick={() => download('migration-status.csv', statusCsv(p.rows), 'text/csv')}>
              Inventory with fidelity (.csv)
            </Button>
            <Button variant="secondary" className="py-1 text-xs" onClick={() => download('decision-log.md', p.exportDecisionLog.markdown(), 'text/markdown')}>
              Decision log (.md)
            </Button>
            <Button variant="secondary" className="py-1 text-xs" onClick={() => download('decision-log.csv', p.exportDecisionLog.csv(), 'text/csv')}>
              Decision log (.csv)
            </Button>
          </div>
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold">Alerts</h3>
          <p className="mt-0.5 text-xs text-fg-muted">Drift, archives and cut-overs show above when found. Browser notifications fire too while this tab is open; there is no email or Slack, since that would need a server.</p>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.notify} onChange={(e) => p.onToggleNotify(e.target.checked)} />
            Browser notifications for this workspace
          </label>
          {p.demo && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="violet">demo</Badge>
                <span className="text-sm">
                  StatSig timeline: step {p.demo.step} of {p.demo.steps}
                </span>
                <Button variant="secondary" className="ml-auto py-1 text-xs" disabled={p.demo.step >= p.demo.steps} onClick={p.demo.onAdvance}>
                  Advance StatSig timeline
                </Button>
              </div>
              <p className="mt-1 text-xs text-fg-muted">Simulates changes in StatSig after migration (a widened rollout, a config value, an archived gate, a disabled gate, a new gate) and re-syncs the demo sources, so drift shows here.</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorRows, alertsSince, type LdFlagInfo, type MonitoredItem } from '@sslm/monitoring';
import type { LdSession } from '../lib/ld.ts';
import { MonitoringPanel, type MonitoringPanelProps } from './MonitoringView.tsx';

const SYNCED = '2026-10-15T09:00:00.000Z';
const NOW = '2026-10-23T12:00:00.000Z';

const item = (over: Partial<MonitoredItem>): MonitoredItem => ({
  kind: 'gate',
  uid: 'src-web/gate/x',
  id: 'x',
  name: 'x',
  sourceId: 'src-web',
  sourceAlias: 'web',
  flagKey: 'x',
  ldEnv: 'test',
  statsigEnv: 'staging',
  archived: false,
  statsigFingerprint: 'fp1',
  decisionSetHash: 'dh1',
  fidelity: 'full',
  openDecisions: 0,
  checksPerHour: 300,
  ...over,
});
const flag = (key: string, over: Partial<LdFlagInfo> = {}): LdFlagInfo => ({
  key,
  tags: ['migrated-from-statsig', 'migration-src-web'],
  customProperties: { 'migration.id': { value: [key] }, 'migration.source': { value: ['web'] }, 'migration.sync.test': { value: ['fp1', '3', SYNCED, 'dh1'] } },
  environments: { test: { on: true, lastModified: Date.parse(SYNCED) } },
  ...over,
});

const items = [
  item({ id: 'new_checkout_flow', uid: 'src-web/gate/new_checkout_flow', flagKey: 'new_checkout_flow', statsigFingerprint: 'fp2' }),
  item({ id: 'dark_mode', uid: 'src-web/gate/dark_mode', flagKey: 'dark_mode' }),
  item({ id: 'legacy_browser_banner', uid: 'src-web/gate/legacy_browser_banner', flagKey: 'legacy_browser_banner', archived: true }),
  item({ id: 'not_yet', uid: 'src-web/gate/not_yet', flagKey: 'not_yet' }),
];
const ldFlags = new Map([flag('new_checkout_flow'), flag('dark_mode'), flag('legacy_browser_banner')].map((f) => [f.key, f]));
const rows = monitorRows({ items, ldFlags, statuses: { test: { dark_mode: { name: 'active', lastRequested: '2026-10-23T11:00:00Z' } } }, settings: [], samples: [], now: NOW });
const ld: LdSession = { status: 'connected', instance: 'us', projectKey: 'statsig-migration', matrix: { environments: [] } as unknown as LdSession['matrix'] };

function setup(over: Partial<MonitoringPanelProps> = {}) {
  const h = { onRefresh: vi.fn(), onResyncStatsig: vi.fn(), onDismissAlerts: vi.fn(), onToggleNotify: vi.fn(), onToggleAuthoritative: vi.fn(), onSync: vi.fn() };
  render(
    <MonitoringPanel
      workspaceName="Acme"
      ld={ld}
      rows={rows}
      alerts={alertsSince([], rows).alerts}
      loaded
      lastCheckedAt={NOW}
      notify={false}
      checking={false}
      hasConsoleSources
      exportDecisionLog={{ markdown: () => '', csv: () => '' }}
      {...h}
      {...over}
    />,
  );
  return h;
}

describe('MonitoringPanel', () => {
  afterEach(cleanup);

  it('shows drift and lifecycle per monitored item, defaulting to what needs attention', () => {
    setup();
    const table = screen.getByRole('table', { name: 'Monitored items' });
    const body = within(table).getAllByRole('row').slice(1);
    expect(body.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([expect.stringContaining('legacy_browser_banner'), expect.stringContaining('new_checkout_flow')]);
    expect(within(table).getByText('StatSig changed')).toBeTruthy();
    expect(within(table).getByText('archived in StatSig')).toBeTruthy();
    // The never-migrated gate is not under monitoring at all.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).queryByText('not_yet')).toBeNull();
    expect(within(table).getByText('dual-running')).toBeTruthy();
  });

  it('lists alerts once and lets the user dismiss them', () => {
    const h = setup();
    expect(screen.getByText('Since your last look')).toBeTruthy();
    expect(screen.getByText(/new_checkout_flow in test: StatSig changed/)).toBeTruthy();
    expect(screen.getByText(/legacy_browser_banner in test was archived in StatSig after migration/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(h.onDismissAlerts).toHaveBeenCalledTimes(1);
  });

  it('offers a sync for drifted items, a retire link for archived ones, and the LaunchDarkly-authoritative switch', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Sync' }));
    expect(h.onSync).toHaveBeenCalledWith(expect.objectContaining({ id: 'new_checkout_flow', ldEnv: 'test' }));
    const retire = screen.getByRole('link', { name: 'Retire in LaunchDarkly' });
    expect(retire.getAttribute('href')).toContain('/projects/statsig-migration/flags/legacy_browser_banner/settings');
    fireEvent.click(screen.getByLabelText('LaunchDarkly authoritative for new_checkout_flow in test'));
    expect(h.onToggleAuthoritative).toHaveBeenCalledWith(expect.objectContaining({ id: 'new_checkout_flow' }), true);
  });

  it('counts the cutover funnel per environment and runs the checks on demand', () => {
    const h = setup();
    expect(screen.getByText('Last checked', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-sync StatSig' }));
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
    expect(h.onResyncStatsig).toHaveBeenCalledTimes(1);
    // 3 monitored in `test`: migrated ×2 (no LD traffic), dual-running ×1.
    const funnelRow = screen.getAllByRole('row').find((r) => within(r).queryByText('test') && within(r).getAllByRole('cell').length === 6)!;
    expect(within(funnelRow).getAllByRole('cell').map((c) => c.textContent)).toEqual(['test', '2', '1', '0', '0', '3']);
  });

  it('explains when LaunchDarkly is not connected and when a check failed', () => {
    setup({ ld: { status: 'disconnected' }, error: 'LaunchDarkly rejected the token (401).', rows: [], alerts: [] });
    expect(screen.getByText(/Connect LaunchDarkly and choose a project/)).toBeTruthy();
    expect(screen.getByText(/Last check failed: LaunchDarkly rejected the token/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Refresh now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the demo timeline control only for demo workspaces', () => {
    const onAdvance = vi.fn();
    setup({ demo: { step: 1, steps: 2, onAdvance } });
    fireEvent.click(screen.getByRole('button', { name: 'Advance StatSig timeline' }));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    cleanup();
    setup();
    expect(screen.queryByRole('button', { name: 'Advance StatSig timeline' })).toBeNull();
  });
});

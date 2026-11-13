import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalSnapshot, Experiment, Holdout, Metric, NeutralFlag } from '@sslm/canonical';
import { AREAS, COVERAGE } from '@sslm/coverage';
import type { SourceRecord } from '@sslm/store';
import { setFlagOverride } from '../lib/flags.ts';
import { CoverageView } from './CoverageView.tsx';
import { EntityList } from './EntityList.tsx';

const source: SourceRecord = { id: 's1', workspaceId: 'w1', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-10-22T10:01:00Z' };
const base = { source: { sourceId: 's1', sourceKind: 'console_api' as const }, completeness: { missing: [] }, tags: [], archived: false, targetApps: [] };
const experiment = (id: string, status: Experiment['status']): Experiment => ({
  ...base,
  kind: 'experiment',
  uid: `s1/experiment/${id}`,
  id,
  name: id,
  status,
  idType: 'userID',
  groups: [
    { name: 'Control', size: 50, parameterValues: {}, isControl: true },
    { name: 'Treatment', size: 50, parameterValues: {} },
  ],
  allocation: 100,
  layerId: null,
  targetingGateId: null,
  launchedGroupId: status === 'decision_made' ? 'Treatment' : null,
  primaryMetrics: [],
  secondaryMetrics: [],
  overrides: [],
  targetingRules: [],
  holdoutIds: [],
});
const holdout: Holdout = { ...base, kind: 'holdout', uid: 's1/holdout/global', id: 'global', name: 'global', enabled: true, idType: 'userID', passPercentage: 5, isGlobal: true, gateIds: [], experimentIds: [], layerIds: [], targetingGateId: null };
const metric: Metric = { ...base, kind: 'metric', uid: 's1/metric/engagement', id: 'engagement', name: 'engagement', metricType: 'composite', definition: {}, isWarehouseNative: false };

const snapshot = {
  schemaVersion: 1,
  source: { sourceId: 's1', sourceKind: 'console_api', alias: 'web' },
  takenAt: '2026-10-22T10:05:00Z',
  environments: [],
  unitTypes: [],
  tags: [],
  targetApps: [],
  users: [],
  gates: [],
  configs: [],
  segments: [],
  experiments: [experiment('search_ranking_v3', 'active'), experiment('checkout_button_color', 'setup'), experiment('homepage_layout_test', 'decision_made')],
  layers: [],
  holdouts: [holdout],
  autotunes: [],
  metrics: [metric],
  paramStores: [],
  warnings: [],
} as unknown as CanonicalSnapshot;

describe('CoverageView', () => {
  afterEach(() => {
    cleanup();
    setFlagOverride('posthogSource', undefined);
  });

  it('keeps the PostHog area out of the matrix while the posthog-source flag is off', () => {
    render(<CoverageView sources={[]} snapshots={{}} onOpenResource={vi.fn()} />);
    const posthog = AREAS.find((a) => a.area === 'posthog')!;
    expect(screen.queryByRole('heading', { name: posthog.title })).toBeNull();
    const shown = COVERAGE.filter((e) => e.area !== 'posthog').length;
    expect(screen.getByText(`${shown} of ${shown} rows`)).toBeTruthy();
  });

  it('lists every area of the matrix and filters by status', () => {
    setFlagOverride('posthogSource', true);
    render(<CoverageView sources={[]} snapshots={{}} onOpenResource={vi.fn()} />);
    for (const a of AREAS) expect(screen.getByRole('heading', { name: a.title })).toBeTruthy();
    expect(screen.getByText(`${COVERAGE.length} of ${COVERAGE.length} rows`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /No LaunchDarkly equivalent/ }));
    const none = COVERAGE.filter((e) => e.status === 'none').length;
    expect(screen.getByText(`${none} of ${COVERAGE.length} rows`)).toBeTruthy();
    // Every visible row is a real limitation.
    expect(screen.getByText('Contextual bandits (Autotune AI)')).toBeTruthy();
    expect(screen.queryByText('Feature gate (rules, pass percentages, on/off)')).toBeNull();
  });

  it('expands a row to show its decisions and documentation', () => {
    render(<CoverageView sources={[]} snapshots={{}} onOpenResource={vi.fn()} />);
    fireEvent.click(screen.getByText('Feature gate (rules, pass percentages, on/off)'));
    expect(screen.getByText('Partial rollout re-bucketing')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'LaunchDarkly ↗' })).toBeTruthy();
    expect(screen.getByText(/rows 4\.1, 4\.2/)).toBeTruthy();
  });

  it('counts the flags and segments of a PostHog or LaunchDarkly source apart and opens their explorer', () => {
    const onOpenNeutral = vi.fn();
    const env = { env: 'Acme Hog', on: true, offVariation: 1, fallthrough: { variation: 1 }, rules: [], targets: [], prerequisites: [] };
    const flag = (key: string, caveats?: NeutralFlag['caveats']): NeutralFlag => ({ kind: 'flag', uid: `s2/flag/${key}`, key, name: key, description: '', flagKind: 'boolean', variations: [{ value: true }, { value: false }], tags: [], temporary: false, archived: false, customProperties: {}, experiments: [], environments: [env], ...(caveats ? { caveats } : {}) });
    const hog = {
      ...snapshot,
      source: { sourceId: 's2', sourceKind: 'posthog', alias: 'hog' },
      gates: [], configs: [], segments: [], experiments: [], layers: [], holdouts: [], autotunes: [], metrics: [], paramStores: [],
      neutral: { flags: [flag('hog-a'), flag('hog-b', [{ kind: 'remote_config' }]), { ...flag('hog-old'), archived: true }], segments: [{ kind: 'segment', uid: 's2/segment/vips', key: 'vips', name: 'VIPs', description: '', tags: [], archived: false, environments: [{ env: 'Acme Hog', rules: [], included: [{ contextKind: 'user', values: ['u-1'] }], excluded: [] }] }], contextKinds: [] },
    } as unknown as CanonicalSnapshot;
    const hogSource: SourceRecord = { ...source, id: 's2', alias: 'hog', label: 'acme-hog (PostHog)', kind: 'posthog' };
    render(<CoverageView sources={[hogSource]} snapshots={{ s2: hog }} onOpenResource={vi.fn()} onOpenNeutral={onOpenNeutral} />);
    // 2 live flags + 1 segment; the archived flag is skipped and said so.
    expect(screen.getByText(/1 archived item skipped/)).toBeTruthy();
    const flags = screen.getByRole('button', { name: /Source flags\s*2/ });
    expect(flags.textContent).toMatch(/Source flags\s*2\s*1\s*1/);
    fireEvent.click(flags);
    expect(onOpenNeutral).toHaveBeenCalledWith('flag');
    fireEvent.click(screen.getByRole('button', { name: /Source segments\s*1/ }));
    expect(onOpenNeutral).toHaveBeenCalledWith('segment');
    expect(screen.getByRole('button', { name: /^Migrates(?! with)/ }).textContent).toMatch(/2\s*of your 3 items/);
  });

  it('counts the workspace inventory against the matrix and opens a kind', () => {
    const onOpenResource = vi.fn();
    render(<CoverageView sources={[source]} snapshots={{ s1: snapshot }} onOpenResource={onOpenResource} />);
    // 3 experiments + 1 holdout + 1 metric are live: the running experiment is guided, the composite metric has no equivalent.
    expect(screen.getByText('Your inventory against the matrix')).toBeTruthy();
    const guided = screen.getByRole('button', { name: /Guided \/ manual/ });
    expect(guided.textContent).toMatch(/1\s*of your 5 items/);
    fireEvent.click(screen.getByRole('button', { name: /Experiments\s*3/ }));
    expect(onOpenResource).toHaveBeenCalledWith('experiment');
    // Rows for kinds present in the workspace say how many there are.
    expect(screen.getAllByText('1 in your sources').length).toBeGreaterThan(0);
    expect(screen.getByText('3 in your sources')).toBeTruthy();
  });
});

describe('EntityList with guidance', () => {
  afterEach(cleanup);

  it('gives every experiment a verdict and links it to the coverage row', () => {
    const onOpenCoverage = vi.fn();
    render(<EntityList kind="experiment" label="Experiments" sources={[source]} snapshots={{ s1: snapshot }} onOpenCoverage={onOpenCoverage} />);
    expect(screen.getByText('running in StatSig')).toBeTruthy();
    expect(screen.getByText('draft (planned)')).toBeTruthy();
    expect(screen.getByText('concluded (planned)')).toBeTruthy();
    expect(screen.getByText(/serving “Treatment” at 100%/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'why?' })[0]!);
    expect(onOpenCoverage).toHaveBeenCalledWith('experiments.running');
    // The mapping panel: headline row visible, caveats behind the toggle, each linking to its coverage row.
    const panel = screen.getByTestId('mapping-explainer');
    expect(within(panel).getByText('Experiment not started (setup)')).toBeTruthy();
    fireEvent.click(within(panel).getByText(/Show \d+ caveats/));
    fireEvent.click(within(panel).getByRole('button', { name: 'Full row on What migrates' }));
    expect(onOpenCoverage).toHaveBeenCalledWith('experiments.setup');
  });

  it('hides archived items behind a toggle and counts only the live ones, since archived resources are never migrated', () => {
    const withArchived = { ...snapshot, experiments: [...snapshot.experiments, { ...experiment('old_pricing_test', 'archived'), archived: true }] } as CanonicalSnapshot;
    render(<EntityList kind="experiment" label="Experiments" sources={[source]} snapshots={{ s1: withArchived }} />);
    expect(screen.getByRole('heading', { name: 'Experiments' }).nextElementSibling?.textContent).toBe('3');
    expect(screen.queryByText('old_pricing_test')).toBeNull();
    fireEvent.click(screen.getByLabelText(/archived \(1\)/));
    expect(screen.getByText('old_pricing_test')).toBeTruthy();
    expect(screen.getByText(/Archived in StatSig: not migrated/)).toBeTruthy();
  });

  it('filters by what happens to the items', () => {
    render(<EntityList kind="experiment" label="Experiments" sources={[source]} snapshots={{ s1: snapshot }} />);
    fireEvent.change(screen.getByLabelText('Filter by what happens'), { target: { value: 'guided' } });
    expect(screen.getByText('search_ranking_v3')).toBeTruthy();
    expect(screen.queryByText('checkout_button_color')).toBeNull();
  });
});

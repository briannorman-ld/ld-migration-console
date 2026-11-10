import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Experiment, type Layer } from '@sslm/canonical';
import type { SourceRecord } from '@sslm/store';
import { LayersReport } from './LayersReport.tsx';

const download = vi.fn();
vi.mock('../lib/migration.ts', () => ({ download: (...args: unknown[]) => download(...args) }));

const SRC = { sourceId: 's-web', sourceKind: 'console_api' as const, alias: 'web' };
const source: SourceRecord = { id: 's-web', workspaceId: 'w', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-11-10T10:00:00Z' };
const base = { source: SRC, completeness: { missing: [] }, tags: [], targetApps: [], archived: false };

const experiment = (id: string, over: Partial<Experiment>): Experiment =>
  ({ kind: 'experiment', uid: `s-web/experiment/${id}`, id, name: id, ...base, status: 'setup', idType: 'userID', groups: [{ name: 'Control', size: 50, parameterValues: {} }, { name: 'Test', size: 50, parameterValues: {} }], allocation: 100, layerId: null, targetingGateId: null, launchedGroupId: null, primaryMetrics: [], secondaryMetrics: [], overrides: [], targetingRules: [], holdoutIds: [], ...over }) as Experiment;
const layer = (id: string, experimentIds: string[], over: Partial<Layer> = {}): Layer =>
  ({ kind: 'layer', uid: `s-web/layer/${id}`, id, name: id, ...base, idType: 'userID', isImplicit: false, parameters: [{ name: 'cta_text', type: 'string', defaultValue: 'Place order' }], experimentIds, holdoutIds: [], ...over }) as Layer;

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-10T00:00:00Z');
  s.gates = [{ kind: 'gate', uid: 's-web/gate/us_only', id: 'us_only', name: 'us_only', ...base, enabled: true, idType: 'userID', overrides: [], holdoutIds: [], rules: [{ id: 'r', name: 'US', passPercentage: 100, conditions: [{ type: 'country', operator: 'any', targetValue: ['US'], raw: {} }], environments: null, idType: 'userID' }] }];
  s.layers = [
    layer('pricing_layer', ['anchor', 'bundle'], { parameters: [{ name: 'show_anchor', type: 'boolean', defaultValue: false }, { name: 'tiers', type: 'number', defaultValue: 2 }] }),
    layer('checkout_layer', ['cta_copy', 'trust_badges'], { parameters: [{ name: 'cta_text', type: 'string', defaultValue: 'Place order' }, { name: 'show_badges', type: 'boolean', defaultValue: false }] }),
    layer('button_color_layer', ['button_color'], { isImplicit: true }),
    layer('retired_layer', [], { archived: true }),
  ];
  s.experiments = [
    experiment('cta_copy', { status: 'active', allocation: 40, layerId: 'checkout_layer', groups: [{ name: 'Control', size: 50, parameterValues: { cta_text: 'Place order' } }, { name: 'Urgent', size: 50, parameterValues: { cta_text: 'Complete purchase now' } }] }),
    experiment('trust_badges', { status: 'setup', allocation: 30, layerId: 'checkout_layer' }),
    experiment('anchor', { status: 'decision_made', layerId: 'pricing_layer', launchedGroupId: 'Test' }),
    experiment('bundle', { status: 'abandoned', layerId: 'pricing_layer' }),
    experiment('button_color', { status: 'setup', layerId: 'button_color_layer' }),
    experiment('search_v3', { status: 'active', allocation: 50, targetingGateId: 'us_only' }),
    experiment('old_banner', { status: 'archived' }),
  ];
  return s;
}

const layerIds = () => screen.getAllByRole('listitem').map((li) => within(li).queryByText(/^[a-z_]+_layer$/)?.textContent ?? within(li).queryByText('Not in a layer')?.textContent ?? '');

describe('LayersReport', () => {
  afterEach(() => {
    cleanup();
    download.mockReset();
  });

  it('sorts layers by live experiments, hides archived layers, and ends with the unlayered group', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    expect(layerIds()).toEqual(['checkout_layer', 'button_color_layer', 'pricing_layer', 'Not in a layer']);
    expect(screen.getByText('2 live')).toBeTruthy();
    expect(screen.getByText('0 live · 2 ended')).toBeTruthy();
    expect(screen.getByText('Create LD layer')).toBeTruthy();
    expect(screen.getByText('Skip · nothing left to reserve')).toBeTruthy();
    expect(screen.getByText('Skip layer · experiment still migrates')).toBeTruthy();
    expect(screen.queryByText('retired_layer')).toBeNull();
    fireEvent.click(screen.getByLabelText(/archived \(2\)/));
    expect(screen.getByText('retired_layer')).toBeTruthy();
  });

  it('shows the totals, and the skippable card filters to the layers that can be left behind', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    const running = screen.getByRole('button', { name: /Running in StatSig/ });
    const skippable = screen.getByRole('button', { name: /Could be skipped/ });
    expect(running.textContent).toContain('2');
    expect(skippable.textContent).toContain('2 layers');
    fireEvent.click(skippable);
    expect(layerIds()).toEqual(['button_color_layer', 'pricing_layer']);
    fireEvent.click(running);
    expect(layerIds()).toEqual(['checkout_layer', 'Not in a layer']);
  });

  it('expands a layer to its default parameters and experiments with status, allocation, targeting and fate', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    fireEvent.click(screen.getByLabelText('Expand checkout_layer'));
    const params = screen.getByLabelText('Default parameters of checkout_layer');
    expect(within(params).getByText('show_badges')).toBeTruthy();
    expect(within(params).getByText('Place order')).toBeTruthy();
    const exps = screen.getByLabelText('Experiments in checkout_layer');
    const cta = within(exps).getByText('cta_copy').closest('tr')!;
    expect(within(cta).getByText('active')).toBeTruthy();
    expect(within(cta).getByText('40%')).toBeTruthy();
    expect(within(cta).getByText('Wait until it ends')).toBeTruthy();
    expect(within(cta).getByText('cta_text')).toBeTruthy();
    expect(within(cta).getByText('Complete purchase now')).toBeTruthy();
    expect(within(within(exps).getByText('trust_badges').closest('tr')!).getByText('none', { selector: 'td:nth-child(4) *' })).toBeTruthy();
    const ctaRow = within(params).getByText('cta_text').closest('tr')!;
    const use = within(ctaRow).getByText('1 of 2 experiments (1 keeps the default)');
    expect(use.getAttribute('title')).toBe('cta_copy');
    expect(within(within(params).getByText('show_badges').closest('tr')!).getByText('no experiment (default everywhere)')).toBeTruthy();
    expect(within(within(exps).getByText('trust_badges').closest('tr')!).getByText('Draft experiment')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Expand experiments not in a layer'));
    const loose = screen.getByLabelText('Experiments in no layer');
    const search = within(loose).getByText('search_v3').closest('tr')!;
    expect(within(search).getByText('us_only')).toBeTruthy();
    expect(within(search).getByText('country any [US]')).toBeTruthy();
    expect(within(loose).queryByText('old_banner')).toBeNull();
  });

  it('sorts by name and by parameter count, and searches experiments inside layers', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    fireEvent.change(screen.getByLabelText('Sort layers'), { target: { value: 'name:asc' } });
    expect(layerIds().slice(0, 3)).toEqual(['button_color_layer', 'checkout_layer', 'pricing_layer']);
    fireEvent.change(screen.getByLabelText('Sort layers'), { target: { value: 'parameters:desc' } });
    expect(layerIds()[0]).toBe('checkout_layer');
    fireEvent.change(screen.getByLabelText('Search layers and experiments'), { target: { value: 'anchor' } });
    expect(layerIds()).toEqual(['pricing_layer']);
  });

  it('explains a targeting gate outside the crawl scope and offers to include gates', () => {
    const onIncludeGates = vi.fn();
    const scoped: SourceRecord = { ...source, resources: ['experiment', 'layer'] };
    render(<LayersReport sources={[scoped]} snapshots={{ 's-web': { ...snapshot(), gates: [] } }} onIncludeGates={onIncludeGates} />);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('experiment targets a gate not in this snapshot: gates are outside this source’s crawl scope');
    fireEvent.click(within(note).getByText('Include gates and sync'));
    expect(onIncludeGates).toHaveBeenCalledWith(scoped);
  });

  it('shows no gate banner when every targeting gate resolved', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('exports the report as CSV', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    fireEvent.click(screen.getByText('Export CSV'));
    expect(download).toHaveBeenCalledTimes(1);
    const [name, csv, type] = download.mock.calls[0] as [string, string, string];
    expect(name).toBe('layers-report.csv');
    expect(type).toBe('text/csv');
    expect(csv.split('\n')[0]).toMatch(/^layer,layer_fate/);
    expect(csv).toContain('pricing_layer,Skip · nothing left to reserve');
    expect(csv).toContain(',search_v3,active,');
  });

  it('exports the report as Markdown, one section per layer', () => {
    render(<LayersReport sources={[source]} snapshots={{ 's-web': snapshot() }} />);
    fireEvent.click(screen.getByText('Export Markdown'));
    expect(download).toHaveBeenCalledTimes(1);
    const [name, md, type] = download.mock.calls[0] as [string, string, string];
    expect(name).toBe('layers-report.md');
    expect(type).toBe('text/markdown');
    expect(md).toContain('# Layers and experiments — web');
    expect(md).toContain('Snapshot taken 2026-11-10T00:00:00Z.');
    expect(md).toContain('## `checkout_layer` — Create LD layer');
    expect(md).toContain('| `cta_copy` | active | 40% | userID | 1 of 2: `cta_text` | none | Wait until it ends |');
    expect(md).toContain('## Skipped layers (2)');
    expect(md).toContain('- `retired_layer` — no experiments in this snapshot · 1 parameter');
  });
});

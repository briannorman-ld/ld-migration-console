import { describe, expect, it } from 'vitest';
import { emptySnapshot, entityUid, experimentKitMarkdown, experimentMigrationKit, layerDefaultsFlagKey, type Experiment, type Gate, type Holdout, type Layer, type Metric, type Rule } from '../src/index.ts';

/**
 * The experiment migration kit on a snapshot shaped like the Acme demo: the checkout layer with a
 * running and a not-started experiment, a US-only targeting gate that names another gate and a
 * segment, a concluded and an abandoned experiment, an archived one, and an experiment whose gate
 * is not in the snapshot. The same dataset read through the Console adapter is covered in
 * packages/adapters/test/experiment-kit.acme.test.ts.
 */

const SRC = { sourceId: 's-web', sourceKind: 'console_api' as const, alias: 'web' };
const base = { source: SRC, completeness: { missing: [] }, tags: [], targetApps: [], archived: false };

const rule = (name: string, conditions: Rule['conditions'], passPercentage = 100): Rule => ({ id: name, name, passPercentage, conditions, environments: null, idType: 'userID' });
const cond = (type: Rule['conditions'][number]['type'], operator: string | null, targetValue: unknown) => ({ type, operator, targetValue, raw: {} });

const experiment = (id: string, over: Partial<Experiment>): Experiment => ({
  kind: 'experiment',
  uid: entityUid('s-web', 'experiment', id),
  id,
  name: id,
  ...base,
  status: 'setup',
  idType: 'userID',
  groups: [
    { name: 'Control', size: 50, parameterValues: {} },
    { name: 'Test', size: 50, parameterValues: {} },
  ],
  allocation: 100,
  layerId: null,
  targetingGateId: null,
  launchedGroupId: null,
  primaryMetrics: [{ name: 'checkout_conversion', type: 'ratio' }],
  secondaryMetrics: [],
  overrides: [],
  targetingRules: [],
  holdoutIds: [],
  ...over,
});
const layer = (id: string, experimentIds: string[], over: Partial<Layer> = {}): Layer => ({ kind: 'layer', uid: entityUid('s-web', 'layer', id), id, name: id, ...base, idType: 'userID', isImplicit: false, parameters: [{ name: 'cta_text', type: 'string', defaultValue: 'Place order' }, { name: 'show_badges', type: 'boolean', defaultValue: false }], experimentIds, holdoutIds: [], ...over });
const gate = (id: string, rules: Rule[], over: Partial<Gate> = {}): Gate => ({ kind: 'gate', uid: entityUid('s-web', 'gate', id), id, name: id, ...base, enabled: true, idType: 'userID', rules, overrides: [], holdoutIds: [], ...over });
const metric = (name: string, metricType: string, over: Partial<Metric> = {}): Metric => ({ kind: 'metric', uid: entityUid('s-web', 'metric', `${name}::${metricType}`), id: `${name}::${metricType}`, name, ...base, metricType, definition: {}, isWarehouseNative: false, ...over });
const holdout = (id: string, over: Partial<Holdout> = {}): Holdout => ({ kind: 'holdout', uid: entityUid('s-web', 'holdout', id), id, name: id, ...base, enabled: true, idType: 'userID', passPercentage: 5, isGlobal: false, gateIds: [], experimentIds: [], layerIds: [], targetingGateId: null, ...over });

function snapshot() {
  const s = emptySnapshot(SRC, '2026-11-10T00:00:00Z');
  s.gates = [
    // The targeting gate names another gate and a segment; that gate names the first one back (a cycle).
    gate('checkout_targeting_gate', [rule('US', [cond('country', 'any', ['US']), cond('passes_gate', null, 'web_platform')]), rule('Beta', [cond('passes_segment', null, 'beta_testers')])]),
    gate('web_platform', [rule('Web', [cond('browser_name', 'any', ['Chrome']), cond('fails_gate', null, 'checkout_targeting_gate')])]),
    gate('old_gate', [], { archived: true }),
  ];
  s.segments = [{ kind: 'segment', uid: entityUid('s-web', 'segment', 'beta_testers'), id: 'beta_testers', name: 'beta_testers', ...base, segmentType: 'id_list', idType: 'userID', rules: [] } as never];
  s.metrics = [metric('checkout_conversion', 'ratio'), metric('revenue', 'sum', { archived: true })];
  s.holdouts = [holdout('global_holdout', { passPercentage: 2, isGlobal: true }), holdout('checkout_holdout', { layerIds: ['checkout_layer'] }), holdout('company_holdout', { isGlobal: true, idType: 'companyID' })];
  s.layers = [layer('checkout_layer', ['checkout_cta_copy', 'checkout_trust_badges']), layer('retired_layer', [], { archived: true })];
  s.experiments = [
    experiment('checkout_cta_copy', { status: 'active', allocation: 40, layerId: 'checkout_layer', targetingGateId: 'checkout_targeting_gate', secondaryMetrics: [{ name: 'revenue', type: 'sum' }] }),
    experiment('checkout_trust_badges', { status: 'setup', allocation: 30, layerId: 'checkout_layer', targetingGateId: 'checkout_targeting_gate', primaryMetrics: [{ name: 'checkout_conversion', type: 'ratio' }, { name: 'cart_abandonment', type: 'event_count_custom' }] }),
    experiment('search_ranking_v3', { status: 'active', allocation: 50, targetingGateId: 'checkout_targeting_gate', holdoutIds: ['checkout_holdout'] }),
    experiment('homepage_layout_test', { status: 'decision_made', launchedGroupId: 'Test', layerId: 'checkout_layer' }),
    experiment('free_shipping_banner', { status: 'abandoned' }),
    experiment('old_banner_test', { status: 'archived' }),
    experiment('orphan', { status: 'setup', targetingGateId: 'gate_not_synced', layerId: 'layer_not_synced', primaryMetrics: [] }),
    experiment('old_gate_test', { status: 'setup', targetingGateId: 'old_gate' }),
  ];
  return s;
}

const byId = (kit: ReturnType<typeof experimentMigrationKit>, kind: string, id: string) => kit.items.find((i) => i.kind === kind && i.id === id);

describe('experimentMigrationKit', () => {
  it('lists, for a not-started experiment with a gate, its flag, layer, defaults flag, segments, metrics and holdouts', () => {
    const kit = experimentMigrationKit(snapshot(), ['checkout_trust_badges']);
    expect(kit.excluded).toEqual([]);
    expect(kit.selected.map((s) => [s.id, s.fate, s.flag.state])).toEqual([['checkout_trust_badges', 'draft', 'in_snapshot']]);
    expect(kit.items.map((i) => `${i.kind}/${i.id}:${i.state}`)).toEqual([
      'layer/checkout_layer:in_snapshot',
      'flag/checkout_layer_defaults:in_snapshot',
      'flag/checkout_trust_badges:in_snapshot',
      'segment/beta_testers:in_snapshot',
      'segment/checkout_targeting_gate:in_snapshot',
      'segment/web_platform:in_snapshot',
      'metric/cart_abandonment:missing_from_snapshot',
      'metric/checkout_conversion:in_snapshot',
      'holdout/checkout_holdout:in_snapshot',
      'holdout/global_holdout:in_snapshot',
    ]);
    expect(byId(kit, 'flag', 'checkout_trust_badges')!.target).toBe('JSON flag · 2 variations + draft experiment');
    expect(byId(kit, 'flag', layerDefaultsFlagKey('checkout_layer'))!.target).toBe('JSON flag · 2 layer defaults');
    expect(byId(kit, 'flag', 'checkout_layer_defaults')!.reason).toContain('cta_text, show_badges');
    expect(byId(kit, 'segment', 'checkout_targeting_gate')).toMatchObject({ via: 'targeting_gate', target: 'segment (from gate, 2 rules)' });
    // The gate cycle (checkout_targeting_gate ↔ web_platform) ends after each gate is seen once.
    expect(byId(kit, 'segment', 'web_platform')).toMatchObject({ via: 'gate_reference' });
    expect(byId(kit, 'segment', 'web_platform')!.reason).toContain('Named by gate checkout_targeting_gate');
    expect(byId(kit, 'segment', 'beta_testers')).toMatchObject({ via: 'segment_reference', target: 'segment' });
    expect(byId(kit, 'metric', 'cart_abandonment')).toMatchObject({ missing: 'not_found', target: 'event_count_custom metric' });
    expect(byId(kit, 'metric', 'cart_abandonment')!.reason).toContain('not found in StatSig');
    expect(byId(kit, 'holdout', 'checkout_holdout')!.reason).toContain('Attached to the experiment’s layer checkout_layer');
    expect(byId(kit, 'holdout', 'global_holdout')!.reason).toContain('Global holdout on userID');
    // A global holdout on another unit type does not cover a userID experiment.
    expect(byId(kit, 'holdout', 'company_holdout')).toBeUndefined();
    expect(kit.counts).toEqual({ in_snapshot: 9, already_in_ld: 0, blocked_running: 0, missing_from_snapshot: 1, archived: 0 });
    expect(kit.notes).toEqual([]);
  });

  it('blocks a running experiment’s own flag but still lists its dependencies, and marks an archived metric', () => {
    const kit = experimentMigrationKit(snapshot(), ['checkout_cta_copy']);
    const flag = byId(kit, 'flag', 'checkout_cta_copy')!;
    expect(flag.state).toBe('blocked_running');
    expect(flag.reason).toContain('Everything else in the kit can go first');
    expect(byId(kit, 'layer', 'checkout_layer')!.state).toBe('in_snapshot');
    expect(byId(kit, 'metric', 'revenue')).toMatchObject({ state: 'archived', target: 'sum metric' });
    expect(kit.counts.blocked_running).toBe(1);
    expect(kit.counts.archived).toBe(1);
  });

  it('deduplicates the layer, defaults flag, segments and metrics across two experiments of one layer', () => {
    const kit = experimentMigrationKit(snapshot(), ['checkout_cta_copy', 'checkout_trust_badges', 'checkout_cta_copy']);
    expect(kit.selected.map((s) => s.id)).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    expect(kit.items.filter((i) => i.kind === 'layer')).toHaveLength(1);
    expect(byId(kit, 'layer', 'checkout_layer')!.neededBy).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    expect(byId(kit, 'flag', 'checkout_layer_defaults')!.neededBy).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    expect(byId(kit, 'segment', 'checkout_targeting_gate')!.neededBy).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    expect(byId(kit, 'metric', 'checkout_conversion')!.neededBy).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    expect(kit.items.filter((i) => i.kind === 'flag').map((i) => i.id)).toEqual(['checkout_cta_copy', 'checkout_layer_defaults', 'checkout_trust_badges']);
  });

  it('excludes archived and abandoned experiments and ids not in the snapshot, with the report’s reason', () => {
    const kit = experimentMigrationKit(snapshot(), ['old_banner_test', 'free_shipping_banner', 'ghost']);
    expect(kit.items).toEqual([]);
    expect(kit.selected).toEqual([]);
    expect(kit.excluded).toEqual([
      { id: 'old_banner_test', reason: 'Archived in StatSig: never migrated.' },
      { id: 'free_shipping_banner', reason: 'Abandoned in StatSig: never migrated.' },
      { id: 'ghost', reason: 'Not in this snapshot.' },
    ]);
  });

  it('marks a gate and a layer missing from the snapshot with the report’s reasons, and notes an experiment without metrics', () => {
    const kit = experimentMigrationKit(snapshot(), ['orphan']);
    expect(byId(kit, 'segment', 'gate_not_synced')).toMatchObject({ state: 'missing_from_snapshot', missing: 'not_found', via: 'targeting_gate' });
    expect(byId(kit, 'segment', 'gate_not_synced')!.reason).toContain('not found in StatSig: deleted or renamed');
    expect(byId(kit, 'layer', 'layer_not_synced')).toMatchObject({ state: 'missing_from_snapshot' });
    expect(kit.items.find((i) => i.id === layerDefaultsFlagKey('layer_not_synced'))).toBeUndefined();
    expect(kit.notes).toEqual(['orphan names no metrics; a LaunchDarkly experiment needs at least one before it can start.']);
    const scoped = experimentMigrationKit(snapshot(), ['orphan'], { scope: ['experiment', 'layer'] });
    expect(byId(scoped, 'segment', 'gate_not_synced')).toMatchObject({ missing: 'out_of_scope' });
    expect(byId(scoped, 'segment', 'gate_not_synced')!.reason).toContain('outside this source’s crawl scope');
    const s = snapshot();
    s.warnings.push({ code: 'fetch_skipped', path: '/gates', message: 'HTTP 500' });
    expect(byId(experimentMigrationKit(s, ['orphan']), 'segment', 'gate_not_synced')).toMatchObject({ missing: 'not_read' });
  });

  it('says when a source kind carries no metrics instead of inventing them', () => {
    const s = snapshot();
    const e = s.experiments.find((x) => x.id === 'checkout_trust_badges')!;
    e.completeness = { missing: ['metrics'] };
    e.primaryMetrics = [];
    const kit = experimentMigrationKit(s, ['checkout_trust_badges']);
    expect(kit.items.filter((i) => i.kind === 'metric')).toEqual([]);
    expect(kit.notes[0]).toContain('Metrics are not in this snapshot for checkout_trust_badges');
  });

  it('marks an archived targeting gate, and lists only the flag and its audience for a concluded experiment', () => {
    const kit = experimentMigrationKit(snapshot(), ['old_gate_test', 'homepage_layout_test']);
    expect(byId(kit, 'segment', 'old_gate')).toMatchObject({ state: 'archived' });
    const shipped = byId(kit, 'flag', 'homepage_layout_test')!;
    expect(shipped.target).toBe('JSON flag · 2 variations · serves the shipped group');
    expect(shipped.reason).toContain('No draft experiment, so no layer reservation, metrics or holdout are needed.');
    expect(byId(kit, 'layer', 'checkout_layer')).toBeUndefined();
    expect(kit.items.filter((i) => i.neededBy.includes('homepage_layout_test')).map((i) => `${i.kind}/${i.id}`)).toEqual(['flag/homepage_layout_test']);
    expect(kit.items.filter((i) => i.kind === 'metric' || i.kind === 'holdout').every((i) => i.neededBy.includes('old_gate_test') && !i.neededBy.includes('homepage_layout_test'))).toBe(true);
  });

  it('marks items the LD project already has, the experiment flag included, from the workspace’s LD listing', () => {
    const kit = experimentMigrationKit(snapshot(), ['checkout_trust_badges', 'search_ranking_v3'], {
      ld: { flags: ['checkout_trust_badges', 'checkout_layer_defaults', 'search_ranking_v3'], segments: new Set(['checkout_targeting_gate']), metrics: ['checkout_conversion'], layers: ['checkout_layer'], holdouts: ['global_holdout'] },
    });
    expect(byId(kit, 'flag', 'checkout_trust_badges')).toMatchObject({ state: 'already_in_ld' });
    expect(byId(kit, 'flag', 'checkout_trust_badges')!.reason).toContain('key_collision');
    expect(byId(kit, 'flag', 'checkout_layer_defaults')).toMatchObject({ state: 'already_in_ld' });
    expect(byId(kit, 'layer', 'checkout_layer')).toMatchObject({ state: 'already_in_ld' });
    expect(byId(kit, 'segment', 'checkout_targeting_gate')).toMatchObject({ state: 'already_in_ld' });
    expect(byId(kit, 'segment', 'web_platform')).toMatchObject({ state: 'in_snapshot' });
    expect(byId(kit, 'metric', 'checkout_conversion')).toMatchObject({ state: 'already_in_ld' });
    expect(byId(kit, 'holdout', 'global_holdout')).toMatchObject({ state: 'already_in_ld' });
    // Running wins over present in LD for the experiment's own flag, but the reason says both.
    const running = byId(kit, 'flag', 'search_ranking_v3')!;
    expect(running.state).toBe('blocked_running');
    expect(running.reason).toContain('already has a flag “search_ranking_v3”');
    // The holdout is attached to trust_badges through its layer and to search_ranking_v3 directly; the first reason stands, both need it.
    expect(byId(kit, 'holdout', 'checkout_holdout')!.neededBy).toEqual(['checkout_trust_badges', 'search_ranking_v3']);
    expect(byId(experimentMigrationKit(snapshot(), ['search_ranking_v3']), 'holdout', 'checkout_holdout')!.reason).toContain('Attached to the experiment.');
  });
});

describe('experimentKitMarkdown', () => {
  const kit = experimentMigrationKit(snapshot(), ['checkout_cta_copy', 'checkout_trust_badges'], { ld: { metrics: ['checkout_conversion'] } });
  const doc = experimentKitMarkdown(kit, { source: 'web', project: 'Acme Web', takenAt: '2026-11-10T00:00:00Z' });

  it('opens with the selection and the state counts, then one table per kind', () => {
    expect(doc.startsWith('# Experiment migration kit — web · Acme Web\n\nSnapshot taken 2026-11-10T00:00:00Z.\n')).toBe(true);
    expect(doc).toContain('2 experiments selected · 12 items to have in LaunchDarkly first (8 to create, 1 already in LD, 1 running in StatSig, 1 not in snapshot, 1 archived).');
    expect(doc.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Selected experiments', '## Layers (1)', '## Flags (besides the experiments’ own) (1)', '## Segments (3)', '## Metrics (3)', '## Holdouts (2)']);
    expect(doc).toContain('| `checkout_cta_copy` | `checkout_layer` | JSON flag · 2 variations + draft experiment | running in StatSig | Running in StatSig:');
    expect(doc).toContain('| `checkout_layer` | `checkout_layer` | LaunchDarkly layer (unit type userID) | to create | `checkout_cta_copy`, `checkout_trust_badges` |');
    expect(doc).toContain('| `checkout_layer_defaults` | `checkout_layer_defaults` | JSON flag · 2 layer defaults | to create |');
    expect(doc).toContain('| `checkout_conversion` | `checkout_conversion` | ratio metric | already in LD |');
    expect(doc).toContain('| `revenue` | `revenue` | sum metric | archived | `checkout_cta_copy` |');
    expect(doc).toContain('| `cart_abandonment` | `cart_abandonment` | event_count_custom metric | not in snapshot | `checkout_trust_badges` |');
    expect(doc).not.toContain('**Left out');
  });

  it('lists what was left out and the notes', () => {
    const k = experimentMigrationKit(snapshot(), ['orphan', 'old_banner_test']);
    const d = experimentKitMarkdown(k);
    expect(d).toContain('**Note:** orphan names no metrics;');
    expect(d).toContain('**Left out (1):** `old_banner_test` (Archived in StatSig: never migrated).');
    expect(d).toContain('## Flags (besides the experiments’ own) (0)\n\nNone.');
  });
});

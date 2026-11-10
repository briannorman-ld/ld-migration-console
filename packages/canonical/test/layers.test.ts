import { describe, expect, it } from 'vitest';
import { describeCondition, describeOverride, describeRule, emptySnapshot, entityUid, layerReport, layerReportCsv, layerReportMarkdown, sortLayerRows, type Experiment, type Gate, type Layer, type Rule } from '../src/index.ts';

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
  primaryMetrics: [],
  secondaryMetrics: [],
  overrides: [],
  targetingRules: [],
  holdoutIds: [],
  ...over,
});

const layer = (id: string, experimentIds: string[], over: Partial<Layer> = {}): Layer => ({
  kind: 'layer',
  uid: entityUid('s-web', 'layer', id),
  id,
  name: id,
  ...base,
  idType: 'userID',
  isImplicit: false,
  parameters: [{ name: 'cta_text', type: 'string', defaultValue: 'Place order' }],
  experimentIds,
  holdoutIds: [],
  ...over,
});

const gate = (id: string, rules: Rule[], over: Partial<Gate> = {}): Gate => ({ kind: 'gate', uid: entityUid('s-web', 'gate', id), id, name: id, ...base, enabled: true, idType: 'userID', rules, overrides: [], holdoutIds: [], ...over });

function snapshot() {
  const s = emptySnapshot(SRC, '2026-11-10T00:00:00Z');
  s.gates = [gate('us_only', [rule('US', [cond('country', 'any', ['US'])])])];
  s.layers = [
    layer('checkout_layer', ['cta_copy', 'trust_badges', 'old_cta'], { parameters: [{ name: 'cta_text', type: 'string', defaultValue: 'Place order' }, { name: 'show_badges', type: 'boolean', defaultValue: false }] }),
    layer('pricing_layer', ['anchor', 'bundle'], { parameters: [{ name: 'anchor', type: 'number', defaultValue: 0 }, { name: 'bundle', type: 'boolean', defaultValue: false }, { name: 'tier', type: 'string', defaultValue: 'a' }] }),
    layer('button_color_layer', ['button_color'], { isImplicit: true }),
    layer('retired_layer', ['ghost_experiment'], { archived: true }),
  ];
  s.experiments = [
    experiment('cta_copy', { status: 'active', allocation: 40, layerId: 'checkout_layer', groups: [{ name: 'Control', size: 50, parameterValues: { cta_text: 'Place order' } }, { name: 'Urgent', size: 50, parameterValues: { cta_text: 'Complete purchase now', urgency_banner: true } }] }),
    experiment('trust_badges', { status: 'setup', allocation: 30, layerId: 'checkout_layer', groups: [{ name: 'Control', size: 50, parameterValues: { show_badges: false } }, { name: 'Badges', size: 50, parameterValues: { show_badges: true } }] }),
    experiment('old_cta', { status: 'archived', layerId: 'checkout_layer', groups: [{ name: 'Control', size: 50, parameterValues: { cta_text: 'Buy' } }, { name: 'Test', size: 50, parameterValues: { cta_text: 'Buy now' } }] }),
    experiment('anchor', { status: 'decision_made', layerId: 'pricing_layer', launchedGroupId: 'Test' }),
    experiment('bundle', { status: 'abandoned', layerId: 'pricing_layer' }),
    experiment('button_color', { status: 'setup', layerId: 'button_color_layer' }),
    experiment('search_v3', { status: 'active', allocation: 50, targetingGateId: 'us_only', targetingRules: [rule('Beta', [cond('email', 'str_contains_any', ['@acme.com'])], 50)], overrides: [{ unitType: 'userID', ids: ['u1', 'u2'], value: { kind: 'group', groupName: 'Test' }, environment: null }] }),
    experiment('orphan', { status: 'setup', layerId: 'layer_not_synced', targetingGateId: 'gate_not_synced' }),
  ];
  return s;
}

describe('layerReport', () => {
  const report = layerReport(snapshot());
  const row = (id: string) => report.rows.find((r) => r.layer?.id === id)!;

  it('groups experiments by layer and counts live, ended and archived apart', () => {
    expect(row('checkout_layer').experiments.map((x) => x.experiment.id)).toEqual(['cta_copy', 'trust_badges', 'old_cta']);
    expect(row('checkout_layer').counts).toEqual({ live: 2, ended: 0, archived: 1 });
    expect(row('pricing_layer').counts).toEqual({ live: 0, ended: 2, archived: 0 });
  });

  it('gives every layer a fate: create, skip implicit, skip empty, never (archived)', () => {
    expect(row('checkout_layer').fate).toBe('create');
    expect(row('button_color_layer').fate).toBe('skip_implicit');
    expect(row('pricing_layer').fate).toBe('skip_empty');
    expect(row('pricing_layer').reason).toContain('2 ended');
    expect(row('retired_layer').fate).toBe('never');
  });

  it('gives every experiment a fate matching PLAN §11', () => {
    const fates = Object.fromEntries([...report.rows, report.unlayered].flatMap((r) => r.experiments).map((x) => [x.experiment.id, x.fate]));
    expect(fates).toEqual({ cta_copy: 'wait', trust_badges: 'draft', old_cta: 'never', anchor: 'serve_shipped', bundle: 'never', button_color: 'draft', search_v3: 'wait', orphan: 'draft' });
    expect(report.rows.flatMap((r) => r.experiments).find((x) => x.experiment.id === 'anchor')!.reason).toContain('“Test”');
  });

  it('shows which layer parameters each experiment overrides, per group, and which experiments set each parameter', () => {
    const checkout = row('checkout_layer');
    const cta = checkout.experiments.find((x) => x.experiment.id === 'cta_copy')!;
    expect(cta.parameters).toEqual([
      { name: 'cta_text', declared: true, defaultValue: 'Place order', byGroup: { Control: 'Place order', Urgent: 'Complete purchase now' } },
      { name: 'urgency_banner', declared: false, defaultValue: undefined, byGroup: { Urgent: true } },
    ]);
    expect(cta.parameters!.map(describeOverride)).toEqual(['cta_text: Control="Place order", Urgent="Complete purchase now"', 'urgency_banner (not on the layer): Urgent=true']);
    expect(checkout.experiments.find((x) => x.experiment.id === 'trust_badges')!.parameters!.map((o) => o.name)).toEqual(['show_badges']);
    // Archived experiments keep their overrides for the record but do not count as users of a parameter.
    expect(checkout.parameterUse).toEqual({ cta_text: ['cta_copy'], show_badges: ['trust_badges'] });
    expect(row('pricing_layer').parameterUse).toEqual({ anchor: [], bundle: [], tier: [] });
    expect(report.unlayered.experiments[0]!.parameters).toBeUndefined();
  });

  it('summarizes targeting: the gate resolved to its rules, inline rules, forced IDs', () => {
    const search = report.unlayered.experiments.find((x) => x.experiment.id === 'search_v3')!;
    expect(search.targeting.gate).toMatchObject({ id: 'us_only', found: true, rules: ['country any [US]'] });
    expect(search.targeting.inlineRules).toEqual(['email str_contains_any [@acme.com] (50% pass)']);
    expect(search.targeting.overrideIds).toBe(2);
    expect(search.targeting.text).toBe('gate us_only: country any [US] · rule: email str_contains_any [@acme.com] (50% pass) · 2 forced IDs');
    expect(search.reason).toContain('us_only migrates first');
    expect(report.unlayered.experiments.find((x) => x.experiment.id === 'cta_copy')).toBeUndefined();
    expect(row('checkout_layer').experiments[0]!.targeting.text).toBe('none');
  });

  it('keeps experiments whose layer or gate is missing from the snapshot, and names the gap', () => {
    const orphan = report.unlayered.experiments.find((x) => x.experiment.id === 'orphan')!;
    expect(orphan.missingLayerId).toBe('layer_not_synced');
    expect(orphan.targeting.gate).toMatchObject({ id: 'gate_not_synced', found: false });
    expect(orphan.targeting.text).toBe('gate gate_not_synced (not in this snapshot)');
    expect(row('retired_layer').unknownExperimentIds).toEqual(['ghost_experiment']);
  });

  it('totals count archived items apart and skippable ones together', () => {
    expect(report.totals).toEqual({
      layers: 3,
      archivedLayers: 1,
      implicitLayers: 1,
      skippableLayers: 2,
      experiments: 7,
      archivedExperiments: 1,
      runningExperiments: 2,
      skippableExperiments: 1,
    });
  });

  it('sorts by live experiments (default), running, parameters or name, ties by name', () => {
    const ids = (rows: typeof report.rows) => rows.map((r) => r.layer!.id);
    expect(ids(sortLayerRows(report.rows, 'experiments'))).toEqual(['checkout_layer', 'button_color_layer', 'pricing_layer', 'retired_layer']);
    expect(ids(sortLayerRows(report.rows, 'experiments', 'asc'))).toEqual(['pricing_layer', 'retired_layer', 'button_color_layer', 'checkout_layer']);
    expect(ids(sortLayerRows(report.rows, 'parameters'))).toEqual(['pricing_layer', 'checkout_layer', 'button_color_layer', 'retired_layer']);
    expect(ids(sortLayerRows(report.rows, 'running'))[0]).toBe('checkout_layer');
    expect(ids(sortLayerRows(report.rows, 'name', 'asc'))).toEqual(['button_color_layer', 'checkout_layer', 'pricing_layer', 'retired_layer']);
  });

  it('exports one CSV row per experiment plus one per empty layer, with layer defaults', () => {
    const csv = layerReportCsv(report);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('layer,layer_fate,layer_implicit,layer_archived,layer_parameters,layer_defaults,experiment,status,experiment_archived,allocation_pct,groups,unit_type,parameters_overridden,targeting,experiment_fate,reason');
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines.find((l) => l.startsWith('checkout_layer,') && l.includes(',cta_copy,'))).toContain('"cta_text=""Place order""; show_badges=false"');
    expect(lines.find((l) => l.includes(',search_v3,'))).toContain('(not in a layer)');
    expect(lines.find((l) => l.startsWith('retired_layer,'))).toContain('Never migrated');
  });
});

describe('describeCondition / describeRule', () => {
  it('reads like the gates explorer', () => {
    expect(describeCondition(cond('public', null, null))).toBe('everyone');
    expect(describeCondition(cond('country', 'any', ['US', 'CA']))).toBe('country any [US, CA]');
    expect(describeCondition({ ...cond('custom_field', 'gt', 3), field: 'plan_tier' })).toBe('plan_tier gt 3');
    expect(describeCondition({ ...cond('unit_id', 'any', ['c1']), customID: 'companyID' })).toBe('companyID any [c1]');
    expect(describeRule(rule('r', [], 20))).toBe('everyone (20% pass)');
    expect(describeRule(rule('r', [cond('country', 'any', ['US']), cond('app_version', 'version_gte', '2.0')]))).toBe('country any [US] and app_version version_gte 2.0');
  });
});

describe('layerReportMarkdown', () => {
  const report = layerReport(snapshot());
  const doc = layerReportMarkdown(report, { source: 'web', project: 'Acme Web', takenAt: '2026-11-10T00:00:00Z' });
  const sections = doc.split('\n').filter((l) => /^#{2,3} /.test(l));

  it('gives a section only to layers that will be created, then the unlayered group, then lists the skipped and archived layers by name', () => {
    expect(doc.startsWith('# Layers and experiments — web · Acme Web\n\nSnapshot taken 2026-11-10T00:00:00Z.\n')).toBe(true);
    expect(sections).toEqual(['## `checkout_layer` — Create LD layer', '## Not in a layer', '## Skipped layers (2)', '## Archived layers (1)']);
    expect(doc).toContain('3 live layers (1 implicit, 1 archived) · 7 live experiments (2 running, 1 abandoned, 1 archived) · 2 layers could be skipped.');
    const skipped = doc.slice(doc.indexOf('## Skipped layers'), doc.indexOf('## Archived layers'));
    expect(skipped).toContain('**Implicit layers (1):**');
    expect(skipped).toContain('- `button_color_layer` — `button_color` (setup) · 1 parameter');
    expect(skipped).toContain('**Nothing left to keep exclusive (1):**');
    expect(skipped).toContain('- `pricing_layer` — `anchor` (decision made), `bundle` (abandoned) · 3 parameters');
    expect(skipped).not.toContain('Default parameters');
    expect(doc.slice(doc.indexOf('## Archived layers'))).toContain('- `retired_layer` — `ghost_experiment` (not in this snapshot) · 1 parameter');
  });

  it('keeps each layer with its defaults table and its experiments table', () => {
    const checkout = doc.slice(doc.indexOf('## `checkout_layer`'), doc.indexOf('## `button_color_layer`'));
    expect(checkout).toContain('unit type: userID');
    expect(checkout).toContain('| `cta_text` | string | `"Place order"` | `cta_copy` |');
    expect(checkout).toContain('| `show_badges` | boolean | `false` | `trust_badges` |');
    expect(checkout).toContain('| `cta_copy` | active | 40% | userID | cta_text: Control="Place order", Urgent="Complete purchase now"<br>urgency_banner (not on the layer): Urgent=true | none | Wait until it ends |');
    expect(checkout).toContain('| `old_cta` | archived | 100% | userID | cta_text: Control="Buy", Test="Buy now" | none | Never migrated |');
    const s = snapshot();
    s.layers[0]!.parameters.push({ name: 'unused', type: 'string', defaultValue: 'x' });
    expect(layerReportMarkdown(layerReport(s))).toContain('| `unused` | string | `"x"` | no experiment (default everywhere) |');
    expect(checkout).toContain('> Becomes a LaunchDarkly layer reserving traffic for 2 experiments');
    expect(checkout).toContain('(2 live, 1 archived)');
    const loose = doc.slice(doc.indexOf('## Not in a layer'), doc.indexOf('## Archived layers'));
    expect(loose).toContain('| `search_v3` | active | 50% | userID | gate us_only: country any [US] · rule: email str_contains_any [@acme.com] (50% pass) · 2 forced IDs | Wait until it ends |');
    expect(loose).toContain('`orphan` (layer `layer_not_synced` not synced)');
    expect(doc).not.toContain('**Default parameters**\n\n**Experiments**');
  });

  it('escapes pipes so table cells stay intact', () => {
    const s = snapshot();
    s.layers[0]!.parameters.push({ name: 'label', type: 'string', defaultValue: 'a|b' });
    expect(layerReportMarkdown(layerReport(s))).toContain('| `label` | string | `"a\\|b"` |');
  });
});

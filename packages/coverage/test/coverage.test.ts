import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENTITY_KINDS, type NeutralFlag, type NeutralSegment } from '@sslm/canonical';
import { AREAS, BLOCK_END, BLOCK_START, COVERAGE, coverageFor, guidanceFor, neutralFlagStatus, neutralSegmentStatus, renderCoverageMarkdown, spliceCoverageBlock, summarizeInventory } from '../src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('coverage matrix', () => {
  it('has unique ids in the <area>.<slug> form, each in a known area', () => {
    const ids = new Set<string>();
    const areas = new Set(AREAS.map((a) => a.area));
    for (const e of COVERAGE) {
      expect(ids.has(e.id), `duplicate id ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(e.id.startsWith(`${e.area}.`), `${e.id} must start with its area`).toBe(true);
      expect(areas.has(e.area)).toBe(true);
      expect(e.how.length).toBeGreaterThan(20);
    }
  });

  it('covers every canonical entity kind at least once', () => {
    for (const k of ENTITY_KINDS) expect(coverageFor(k).length, `no coverage row for ${k}`).toBeGreaterThan(0);
  });

  it('references edge-case rows that exist in docs/KNOWN-EDGE-CASES.md', () => {
    const doc = readFileSync(join(root, 'docs', 'KNOWN-EDGE-CASES.md'), 'utf8');
    const rows = new Set([...doc.matchAll(/^\| (\d+\.\d+) \|/gm)].map((m) => m[1]));
    for (const e of COVERAGE) for (const r of e.edgeCases ?? []) expect(rows.has(r), `${e.id} cites edge case ${r}, which is not in the doc`).toBe(true);
  });

  it('only cites decision types the mapper defines', async () => {
    const types = readFileSync(join(root, 'packages', 'mapper', 'src', 'types.ts'), 'utf8');
    const union = /export type DecisionType =([\s\S]*?);/.exec(types)?.[1] ?? '';
    const known = new Set([...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    for (const e of COVERAGE) for (const d of e.decisions ?? []) expect(known.has(d), `${e.id} cites decision ${d}, which the mapper doesn't define`).toBe(true);
  });

  it('renders a markdown block with one table per area and a legend', () => {
    const md = renderCoverageMarkdown();
    expect(md.startsWith(BLOCK_START)).toBe(true);
    expect(md.endsWith(BLOCK_END)).toBe(true);
    for (const a of AREAS) expect(md).toContain(`### ${a.title}`);
    expect(md).toContain('| Mark | Status | Meaning | Rows |');
  });

  it('splices into a document, replacing only the block', () => {
    const doc = `# Title\n\nintro\n\n${BLOCK_START}\nold\n${BLOCK_END}\n\nafter\n`;
    const out = spliceCoverageBlock(doc, `${BLOCK_START}\nnew\n${BLOCK_END}`);
    expect(out).toBe(`# Title\n\nintro\n\n${BLOCK_START}\nnew\n${BLOCK_END}\n\nafter\n`);
    expect(spliceCoverageBlock('# No block\n')).toContain(BLOCK_START);
  });

  it('docs/LIMITATIONS.md carries the current generated block (run pnpm coverage:generate)', () => {
    const doc = readFileSync(join(root, 'docs', 'LIMITATIONS.md'), 'utf8');
    expect(spliceCoverageBlock(doc)).toBe(doc);
  });
});

describe('inventory summary with neutral-model sources (PLAN §20, §22)', () => {
  const env = (rules: NeutralFlag['environments'][number]['rules'] = []) => ({ env: 'Acme Hog', on: true, offVariation: 1, fallthrough: { variation: 1 }, rules, targets: [], prerequisites: [] });
  const flag = (key: string, over: Partial<NeutralFlag> = {}): NeutralFlag => ({ kind: 'flag', uid: `src/flag/${key}`, key, name: key, description: '', flagKind: 'boolean', variations: [{ value: true }, { value: false }], tags: [], temporary: false, archived: false, customProperties: {}, experiments: [], environments: [env()], ...over });
  const segment = (key: string, over: Partial<NeutralSegment> = {}): NeutralSegment => ({ kind: 'segment', uid: `src/segment/${key}`, key, name: key, description: '', tags: [], archived: false, environments: [{ env: 'Acme Hog', rules: [], included: [{ contextKind: 'user', values: ['u-1'] }], excluded: [] }], ...over });
  const empty = { gates: [], configs: [], segments: [], experiments: [], layers: [], holdouts: [], autotunes: [], metrics: [], paramStores: [] };

  it('a plain flag migrates, a caveat or an experiment allocation needs decisions, a survey flag has no equivalent', () => {
    expect(neutralFlagStatus(flag('plain'))).toBe('migrates');
    expect(neutralFlagStatus(flag('continuity', { caveats: [{ kind: 'experience_continuity' }] }))).toBe('decisions');
    expect(neutralFlagStatus(flag('exp', { experiments: ['checkout-exp'] }))).toBe('decisions');
    expect(neutralFlagStatus(flag('covered', { environments: [env([{ description: 'set 1', clauses: [], variation: 0, coverage: 0.3 }])] }))).toBe('decisions');
    expect(neutralFlagStatus(flag('dep', { environments: [env([{ description: 'set 1', clauses: [], variation: 0, prerequisites: [{ key: 'parent', variation: 0 }] }])] }))).toBe('decisions');
    expect(neutralFlagStatus(flag('survey', { purpose: 'survey' }))).toBe('none');
  });

  it('a list segment migrates, an unreadable or frozen membership needs a decision', () => {
    expect(neutralSegmentStatus(segment('static'))).toBe('migrates');
    expect(neutralSegmentStatus(segment('big', { environments: [{ env: 'Acme Hog', rules: [], included: [], excluded: [], unbounded: { contextKind: 'user' } }] }))).toBe('decisions');
    expect(neutralSegmentStatus(segment('frozen', { caveats: [{ kind: 'frozen_membership', detail: { cohortType: 'behavioral', count: 2 } }] }))).toBe('decisions');
  });

  it('counts neutral flags and segments into the totals, archived ones apart, and leaves the StatSig kinds alone', () => {
    const snap = { ...empty, neutral: { flags: [flag('a'), flag('b', { caveats: [{ kind: 'remote_config' }] }), flag('old', { archived: true }), flag('nps', { purpose: 'survey' })], segments: [segment('s1'), segment('s2', { archived: true })] } };
    const inv = summarizeInventory([snap]);
    expect(inv.total).toBe(4);
    expect(inv.archived).toBe(2);
    expect(inv.byStatus).toEqual({ migrates: 2, decisions: 1, guided: 0, planned: 0, none: 1 });
    expect(inv.byKind).toEqual({});
    expect(inv.neutral).toEqual({ flags: { migrates: 1, decisions: 1, guided: 0, planned: 0, none: 1 }, segments: { migrates: 1, decisions: 0, guided: 0, planned: 0, none: 0 } });
    // A workspace without a neutral source has no neutral block at all.
    expect(summarizeInventory([empty]).neutral).toBeUndefined();
    expect(summarizeInventory([{ ...empty, neutral: { flags: [], segments: [] } }]).neutral).toBeUndefined();
  });
});

describe('per-item guidance', () => {
  const base = { uid: 'x', id: 'x', name: 'x', source: { sourceId: 's', sourceKind: 'console_api' as const }, completeness: { missing: [] }, tags: [], archived: false, targetApps: [] };

  it('tells a running experiment to end in StatSig and a setup one that it becomes a draft', () => {
    const exp = { ...base, kind: 'experiment' as const, status: 'active' as const, idType: 'userID', groups: [{ name: 'a', size: 50, parameterValues: {} }, { name: 'b', size: 50, parameterValues: {} }], allocation: 100, layerId: null, targetingGateId: null, launchedGroupId: null, primaryMetrics: [], secondaryMetrics: [], overrides: [], targetingRules: [], holdoutIds: [] };
    expect(guidanceFor(exp).verdict).toBe('running in StatSig');
    expect(guidanceFor({ ...exp, status: 'setup' }).detail).toContain('2 variations');
    expect(guidanceFor({ ...exp, status: 'decision_made', launchedGroupId: 'b' }).detail).toContain('“b”');
    expect(guidanceFor({ ...exp, archived: true }).verdict).toBe('archived');
  });

  it('separates implicit layers, disabled holdouts, composite and warehouse-native metrics', () => {
    expect(guidanceFor({ ...base, kind: 'layer', idType: 'userID', isImplicit: true, parameters: [], experimentIds: [], holdoutIds: [] }).status).toBe('none');
    expect(guidanceFor({ ...base, kind: 'holdout', enabled: false, idType: 'userID', passPercentage: 5, isGlobal: true, gateIds: [], experimentIds: [], layerIds: [], targetingGateId: null }).verdict).toBe('disabled');
    expect(guidanceFor({ ...base, kind: 'metric', metricType: 'composite', definition: {}, isWarehouseNative: false }).status).toBe('none');
    expect(guidanceFor({ ...base, kind: 'metric', metricType: 'sum', definition: {}, isWarehouseNative: true }).coverageId).toBe('metrics.warehouse_native');
    expect(guidanceFor({ ...base, kind: 'metric', metricType: 'event_count_custom', definition: {}, isWarehouseNative: false }).detail).toContain('conversion');
  });
});

describe('mapping explainer (resource pages)', () => {
  it('has a headline and caveats for every entity kind and both LaunchDarkly-source resources', async () => {
    const { EXPLAINER_KEYS, explainMapping } = await import('../src/explainer.ts');
    for (const k of ENTITY_KINDS) expect(EXPLAINER_KEYS).toContain(k);
    for (const k of EXPLAINER_KEYS) {
      const x = explainMapping(k);
      expect(x.headline.id).toBeTruthy();
      if (!k.startsWith('ld_') && !k.startsWith('ph_')) expect(x.headline.kind, `${k}: headline row should count that kind`).toBe(k);
      expect(x.caveats.length, `${k}: a page with no caveats hides something`).toBeGreaterThan(0);
      const all = [...x.clean, ...x.caveats.flatMap((c) => c.rows)];
      expect(all.map((e) => e.id)).not.toContain(x.headline.id);
      expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
      for (const e of x.caveats.flatMap((c) => c.rows)) expect(e.status).not.toBe('migrates');
    }
  });

  it('brings rule conditions and operators onto every page whose resource has rules', async () => {
    const { explainMapping } = await import('../src/explainer.ts');
    for (const k of ['gate', 'config', 'segment'] as const) {
      const areas = explainMapping(k).caveats.map((c) => c.area.area);
      expect(areas).toContain('conditions');
      expect(areas).toContain('operators');
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allEntities, effectiveTargeting } from '@sslm/canonical';
import { classifySpec, normalizeSpec, parseSpecBytes, SpecRejectedError } from '../src/index.ts';

const DIR = fileURLToPath(new URL('../../../reference/statsig/dcs-fixtures/', import.meta.url));
const DEMO = fileURLToPath(new URL('../../demo-fixtures/generated/acme-web/', import.meta.url));
const SOURCE = { sourceId: 'spec', sourceKind: 'config_spec' as const, alias: 'spec' };
const load = (rel: string) => parseSpecBytes(new Uint8Array(readFileSync(DIR + rel)), rel);
const normalize = async (rel: string) => normalizeSpec(await load(rel), { source: SOURCE, takenAt: '2026-10-01T00:00:00Z' });

const REJECTED: Record<string, string> = {
  'v1/initialize_response.json': 'client_initialize_response',
  'v2/dcs_error.json': 'not_a_spec',
  'v2/demo_proj_dcs.pb.br': 'protobuf',
  // Not specs: the ID-list manifest and a hashed ID-list file.
  'v2/get_id_lists.json': 'not_a_spec',
  'v2/company_id_list': 'protobuf',
};
// Shared-dictionary transport artifacts, not config specs.
// Shared-dictionary transport artifacts and a user-agent parsing table: not config specs.
const SKIP = new Set([
  'v2/shared_dict_dict_only.json',
  'v2/shared_dict_response_with_dict.json',
  'v2/shared_dict_response_without_dict.json',
  'v2/shared_dict_response_uncompressed.json',
  'v2/ua_string_cases.json',
]);

const all = ['v1', 'v2'].flatMap((v) => readdirSync(DIR + v).map((f) => `${v}/${f}`)).filter((f) => !SKIP.has(f));

describe('config-spec adapter against real StatSig SDK fixtures', () => {
  it.each(all.filter((f) => !(f in REJECTED)))('parses and normalizes %s', async (rel) => {
    const parsed = await load(rel);
    expect(parsed.version).toBe(rel.startsWith('v2') ? 2 : 1);
    const snap = normalizeSpec(parsed, { source: SOURCE, takenAt: 'x' });
    expect(snap.warnings.filter((w) => w.code === 'unresolved_reference')).toEqual([]);
    for (const e of allEntities(snap)) expect(e.uid).toMatch(/^spec\//);
  });

  it.each(Object.entries(REJECTED))('rejects %s (%s)', async (rel, reason) => {
    const err = await load(rel).catch((e) => e);
    expect(err).toBeInstanceOf(SpecRejectedError);
    expect(err.reason).toBe(reason);
  });

  it('reconstructs entities from the richest v2 fixture (eval_proj_dcs.json)', async () => {
    const snap = await normalize('v2/eval_proj_dcs.json');
    // No condition is left unrecognized.
    expect(snap.warnings.filter((w) => w.code === 'unknown_condition')).toEqual([]);

    const ul = snap.segments.find((s) => s.id === 'user_id_list')!;
    expect(ul.segmentType).toBe('id_list');
    expect(ul.idList?.ids).toContain('marcos_1');
    const cl = snap.segments.find((s) => s.id === 'company_id_list')!;
    expect(cl.idList).toEqual({ hashed: { listName: 'company_id_list' } });
    expect(cl.completeness.missing).toContain('idListMembers');
    expect(snap.segments.some((s) => s.id.startsWith('inline_targeting'))).toBe(false);

    expect(snap.holdouts.map((h) => [h.id, h.passPercentage]).sort()).toEqual([['exp_holdout', 0], ['global_holdout', 0.5], ['layer_holdout', 10], ['test_holdout', 10]]);

    const ua = snap.gates.find((g) => g.id === 'test_ua')!;
    expect(ua.overrides).toContainEqual({ unitType: 'userID', ids: ['pass-user'], value: { kind: 'gate', pass: false }, environment: null });

    const byId = (id: string) => snap.experiments.find((e) => e.id === id)!;
    expect(byId('running_exp_in_layer_with_holdout')).toMatchObject({ status: 'active', layerId: 'test_layer_in_holdout' });
    expect(byId('running_exp_in_layer_with_holdout').groups.map((g) => [g.name, g.size])).toEqual([['Control', 50], ['Test', 50]]);
    expect(byId('running_exp_in_layer_with_holdout').allocation).toBeGreaterThan(0);
    expect(byId('running_exp_in_layer_with_holdout').allocation).toBeLessThan(100);
    expect(byId('not_started_exp_in_layer_with_holdout').status).toBe('setup');
    expect(byId('shipped_exp_in_layer_with_holdout')).toMatchObject({ status: 'decision_made', launchedGroupId: 'Test' });
    expect(byId('abandoned_exp_in_layer_with_holdout').status).toBe('abandoned');
    expect(byId('running_exp_in_layer_with_holdout').holdoutIds).toEqual(['global_holdout', 'layer_holdout']);
    expect(byId('test_exp_with_layers_targeting_and_holdout').targetingGateId).toBe('test_public');
    expect(byId('inline_targeting_rules_exp').targetingRules[0]!.conditions[0]).toMatchObject({ type: 'user_id', targetValue: ['123'] });

    const layer = snap.layers.find((l) => l.id === 'test_layer_in_holdout')!;
    expect(layer.experimentIds).toEqual(expect.arrayContaining(['running_exp_in_layer_with_holdout', 'not_started_exp_in_layer_with_holdout']));
    expect(snap.paramStores[0]!.parameters[0]).toMatchObject({ name: 'bool_param', refType: 'static', value: false });
    expect(snap.environments.map((e) => e.name)).toEqual(expect.arrayContaining(['development', 'production', 'staging']));
    expect(snap.environments.every((e) => e.inferred)).toBe(true);
    expect(snap.unitTypes.map((u) => u.name)).toEqual(expect.arrayContaining(['userID', 'stableID', 'companyID']));
    expect(snap.companyId).toBe('5NprLGRxV3W28hreG51Z7n');
  });

  it('normalizes the DCS condition vocabulary per PLAN §4.2', async () => {
    const snap = await normalize('v2/eval_proj_dcs.json');
    const types = new Set(snap.gates.flatMap((g) => g.rules.flatMap((r) => r.conditions.map((c) => c.type))));
    for (const t of ['public', 'user_id', 'email', 'country', 'environment_tier', 'passes_gate', 'fails_gate', 'passes_segment', 'time', 'unit_id', 'os_name', 'browser_name', 'custom_field', 'app_version', 'ip_address', 'locale']) {
      expect(types, t).toContain(t);
    }
    const ops = new Set(snap.gates.flatMap((g) => g.rules.flatMap((r) => r.conditions.map((c) => c.operator))));
    expect(ops).toContain('is_null');
    expect(ops).toContain('is_not_null');
    expect(ops).not.toContain('eq'.repeat(0) + 'xx');
  });

  it('resolves environment tiers statically (environment_tier → per-env rules)', async () => {
    const snap = await normalize('v2/eval_proj_dcs.json');
    const candidates = [...snap.gates, ...snap.configs, ...snap.segments];
    const tiered = candidates.filter((x) => x.rules.some((r) => r.conditions.some((c) => c.type === 'environment_tier' && c.operator === 'any')));
    expect(tiered.length).toBeGreaterThan(0);
    for (const e of tiered) {
      for (const env of ['production', 'staging', 'development']) {
        expect(JSON.stringify(effectiveTargeting(e, env).rules)).not.toContain('environment_tier');
      }
    }
  });

  it('reads the v1 rulesets fixture, including layers and autotunes', async () => {
    const snap = await normalize('v1/rulesets_e2e_full_dcs.json');
    expect(snap.warnings.filter((w) => w.code === 'unknown_condition')).toEqual([]);
    expect(snap.autotunes.find((a) => a.id === 'test_autotune')!.variants.map((v) => v.name)).toEqual(expect.arrayContaining(['black', 'blue', 'red', 'green']));
    expect(snap.layers.length).toBeGreaterThan(5);
    expect(snap.experiments.find((e) => e.id === 'exp_with_obj_and_array')!).toMatchObject({ status: 'active', allocation: 100 });
  });

  it('decompresses the gzipped large-project fixture', async () => {
    const snap = await normalize('v2/perf_proj_dcs.json.gz');
    expect(allEntities(snap).length).toBeGreaterThanOrEqual(90);
    expect(snap.experiments.length).toBeGreaterThan(10);
  });

  it('unwraps a data-adapter value (spec stored as a JSON string)', async () => {
    const raw = readFileSync(DIR + 'v2/demo_proj_dcs.json', 'utf8');
    const parsed = await parseSpecBytes(new TextEncoder().encode(JSON.stringify(raw)), 'redis-value.json');
    expect(parsed.unwrapped).toBe('data_adapter_string');
    expect(parsed.version).toBe(2);
  });

  it('drops the project’s client SDK keys from the parsed spec, so they never reach IndexedDB', async () => {
    const raw = JSON.parse(readFileSync(DIR + 'v2/dcs_target_app_filtering.json', 'utf8')) as Record<string, unknown>;
    expect(raw.sdk_keys_to_app_ids).toBeDefined();
    const spec = await load('v2/dcs_target_app_filtering.json');
    expect(spec.json.sdk_keys_to_app_ids).toBeUndefined();
    expect(spec.json.hashed_sdk_keys_to_app_ids).toBeUndefined();
    expect(classifySpec({ feature_gates: [], sdk_keys_to_app_ids: { 'client-abc': 'app' }, hashed_sdk_keys_to_app_ids: { x: 'app' } }).json).toEqual({ feature_gates: [] });
  });

  it('warns when the key was scoped to a target app', async () => {
    const snap = await normalize('v2/dcs_target_app_filtering.json');
    expect(snap.warnings.some((w) => w.code === 'partial_spec')).toBe(true);
  });

  it('rejects a has_updates:false response with instructions', async () => {
    const err = await parseSpecBytes(new TextEncoder().encode('{"has_updates": false}')).catch((e) => e);
    expect(err.reason).toBe('no_updates');
    expect(err.message).toMatch(/download_config_specs/);
  });
});

describe('config-spec schema validation (lenient, like the Console API path)', () => {
  const demo = (v: 1 | 2, mutate?: (json: Record<string, any>) => void) => {
    const json = JSON.parse(readFileSync(`${DEMO}download_config_specs.v${v}.json`, 'utf8'));
    mutate?.(json);
    return normalizeSpec(classifySpec(json), { source: SOURCE, takenAt: 'x' });
  };
  const mismatches = (snap: ReturnType<typeof demo>) => snap.warnings.filter((w) => w.code === 'schema_mismatch');

  it.each([1, 2] as const)('the demo v%i spec validates without a single schema_mismatch warning', (v) => {
    const snap = demo(v);
    expect(mismatches(snap)).toEqual([]);
    expect(snap.gates.length).toBeGreaterThan(10);
    expect(snap.configs.length + snap.experiments.length + snap.autotunes.length).toBeGreaterThan(10);
  });

  it.each(all.filter((f) => !(f in REJECTED)))('%s validates without schema_mismatch warnings', async (rel) => {
    const snap = normalizeSpec(await load(rel), { source: SOURCE, takenAt: 'x' });
    expect(snap.warnings.filter((w) => w.code === 'schema_mismatch')).toEqual([]);
  });

  it('a v2 entity with a malformed rule is skipped with a warning naming it; every other entity survives', () => {
    const clean = demo(2);
    const snap = demo(2, (j) => {
      j.feature_gates.dark_mode.rules[0].passPercentage = 'all of them';
      j.feature_gates.dark_mode.rules.push('not a rule');
    });
    expect(mismatches(snap)).toEqual([{ code: 'schema_mismatch', path: 'feature_gates[dark_mode]', message: 'Skipped: rules[0]: passPercentage: Invalid input: expected number, received string' }]);
    expect(snap.gates.some((g) => g.id === 'dark_mode')).toBe(false);
    expect(snap.gates.length).toBe(clean.gates.length - 1);
    expect(snap.configs.length).toBe(clean.configs.length);
    // The warning never carries the offending value (it may be PII).
    expect(JSON.stringify(snap.warnings)).not.toContain('all of them');
  });

  it('a condition without a type (inline, or via condition_map) skips its entity rather than dropping the condition', () => {
    const v2 = demo(2, (j) => {
      const id = j.feature_gates.new_checkout_flow.rules[0].conditions[0];
      delete j.condition_map[id].type;
    });
    expect(mismatches(v2).map((w) => w.path)).toEqual(['feature_gates[new_checkout_flow]']);
    expect(mismatches(v2)[0]!.message).toMatch(/^Skipped: rules\[0\]\.conditions\[0\] \(condition_map\[\d+\]\): type: /);
    expect(v2.gates.some((g) => g.id === 'new_checkout_flow')).toBe(false);

    const v1 = demo(1, (j) => {
      j.feature_gates[0].rules[0].conditions[0] = { targetValue: ['x'], operator: 'any' };
    });
    expect(mismatches(v1)).toHaveLength(1);
    expect(mismatches(v1)[0]!.path).toBe('feature_gates[new_checkout_flow]');
    expect(v1.gates.some((g) => g.id === 'new_checkout_flow')).toBe(false);
  });

  it('an entity that is not an object, or lacks `enabled` / `rules`, is skipped by name or index', () => {
    const v2 = demo(2, (j) => {
      j.dynamic_configs.shipping_thresholds = 'oops';
      delete j.feature_gates.dark_mode.enabled;
    });
    expect(mismatches(v2).map((w) => [w.path, w.message])).toEqual([
      ['feature_gates[dark_mode]', 'Skipped: enabled: Invalid input: expected boolean, received undefined'],
      ['dynamic_configs[shipping_thresholds]', 'Skipped: (root): Invalid input: expected object, received string'],
    ]);
    expect(v2.configs.some((c) => c.id === 'shipping_thresholds')).toBe(false);

    const v1 = demo(1, (j) => {
      j.feature_gates[3] = 42;
    });
    expect(mismatches(v1).map((w) => w.path)).toEqual(['feature_gates[3]']);
  });

  it('a whole section of the wrong shape is ignored with one warning, and the rest of the file still normalizes', () => {
    const snap = demo(2, (j) => {
      j.param_stores = ['not', 'a', 'map'];
      j.experiment_to_layer = { search_ranking_v3: ['layer'] };
      j.layer_configs = 'nope';
    });
    expect(mismatches(snap).map((w) => [w.path, w.message.split(':')[0]])).toEqual([
      ['layer_configs', 'Section ignored'],
      ['experiment_to_layer', 'Section ignored'],
      ['param_stores', 'Section ignored'],
    ]);
    expect(snap.layers).toEqual([]);
    expect(snap.paramStores).toEqual([]);
    expect(snap.gates.length).toBeGreaterThan(10);
    expect(snap.experiments.length).toBeGreaterThan(0);
  });

  it('one malformed param store skips only itself', () => {
    const snap = demo(2, (j) => {
      const name = Object.keys(j.param_stores)[0]!;
      j.param_stores.broken = { parameters: { p: { ref_type: 'static' } } };
      j.param_stores.fine = j.param_stores[name];
    });
    expect(mismatches(snap).map((w) => w.path)).toEqual(['param_stores[broken]']);
    expect(snap.paramStores.map((p) => p.id).sort()).toEqual(expect.arrayContaining(['fine']));
    expect(snap.paramStores.some((p) => p.id === 'broken')).toBe(false);
  });

  it('a malformed v1 `layers` map never throws out of the normalizer', () => {
    expect(() => demo(1, (j) => (j.layers = { l: 'not-an-array' }))).not.toThrow();
    expect(() => demo(1, (j) => (j.id_lists = 7))).not.toThrow();
    expect(() => demo(2, (j) => (j.condition_map = null))).not.toThrow();
  });
});

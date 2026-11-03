import { describe, expect, it } from 'vitest';
import {
  effectiveTargeting,
  emptySnapshot,
  entityUid,
  fingerprint,
  matchAcrossSources,
  resolveRulesForEnvironment,
  stableStringify,
  type Condition,
  type Gate,
  type Rule,
} from '../src/index.ts';

const cond = (c: Partial<Condition> & Pick<Condition, 'type'>): Condition => ({ operator: null, targetValue: null, raw: c, ...c });
const rule = (id: string, conditions: Condition[], extra: Partial<Rule> = {}): Rule => ({
  id,
  name: id,
  passPercentage: 100,
  conditions,
  environments: null,
  idType: 'userID',
  ...extra,
});

function gate(id: string, sourceId: string, rules: Rule[]): Gate {
  return {
    kind: 'gate',
    uid: entityUid(sourceId, 'gate', id),
    id,
    name: id,
    source: { sourceId, sourceKind: 'console_api' },
    completeness: { missing: [] },
    tags: [],
    archived: false,
    targetApps: [],
    enabled: true,
    idType: 'userID',
    rules,
    overrides: [],
    holdoutIds: [],
  };
}

describe('stableStringify / fingerprint', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    expect(fingerprint({ x: [1, 2] })).not.toBe(fingerprint({ x: [2, 1] }));
    expect(fingerprint('a')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('resolveRulesForEnvironment (PLAN §10.2 step 1)', () => {
  const rules = [
    rule('prod-only', [cond({ type: 'email', operator: 'any', targetValue: ['a@x.com'] })], { environments: ['production'] }),
    rule('tier-staging', [cond({ type: 'environment_tier', operator: 'any', targetValue: ['Staging'] }), cond({ type: 'public' })]),
    rule('tier-not-dev', [cond({ type: 'environment_tier', operator: 'none', targetValue: ['development'] })]),
    rule('weird-op', [cond({ type: 'environment_tier', operator: 'version_gt', targetValue: '1' })]),
  ];

  it('drops rules not enabled in the environment and statically resolves tiers', () => {
    const dev = resolveRulesForEnvironment(rules, 'development');
    expect(dev.rules.map((r) => r.id)).toEqual(['weird-op']);
    expect(dev.dropped).toEqual([
      { ruleId: 'prod-only', reason: 'not_enabled_in_environment' },
      { ruleId: 'tier-staging', reason: 'environment_tier_false' },
      { ruleId: 'tier-not-dev', reason: 'environment_tier_false' },
    ]);
    expect(dev.unresolved).toHaveLength(1);

    const staging = resolveRulesForEnvironment(rules, 'staging');
    expect(staging.rules.map((r) => r.id)).toEqual(['tier-staging', 'tier-not-dev', 'weird-op']);
    // True tier conditions are removed, others kept.
    expect(staging.rules[0]!.conditions.map((c) => c.type)).toEqual(['public']);
    expect(staging.rules[1]!.conditions).toEqual([]);

    const prod = resolveRulesForEnvironment(rules, 'PRODUCTION');
    expect(prod.rules.map((r) => r.id)).toEqual(['prod-only', 'tier-not-dev', 'weird-op']);
  });
});

describe('effectiveTargeting', () => {
  it('treats Console `environments` and spec `environment_tier` encodings as equivalent', () => {
    const emailCond = cond({ type: 'email', operator: 'any', targetValue: ['b@x.com', 'a@x.com'] });
    const consoleGate = gate('g', 'web', [rule('r1', [emailCond], { environments: ['staging'], name: 'Beta testers' })]);
    const specGate = gate('g', 'web-spec', [
      rule('7xYz:100.00:1', [cond({ type: 'environment_tier', operator: 'any', targetValue: ['staging'] }), { ...emailCond, targetValue: ['a@x.com', 'b@x.com'] }]),
    ]);
    for (const env of ['development', 'staging', 'production']) {
      expect(effectiveTargeting(specGate, env)).toEqual(effectiveTargeting(consoleGate, env));
    }
    expect(effectiveTargeting(consoleGate, 'production').rules).toEqual([]);
  });

  it('unwraps single-element arrays for scalar operators', () => {
    const a = gate('g', 's', [rule('r', [cond({ type: 'app_version', operator: 'version_gte', targetValue: ['1.2.0'] })])]);
    const b = gate('g', 's', [rule('r', [cond({ type: 'app_version', operator: 'version_gte', targetValue: '1.2.0' })])]);
    expect(effectiveTargeting(a, 'production')).toEqual(effectiveTargeting(b, 'production'));
  });
});

describe('matchAcrossSources (N-source)', () => {
  it('groups entities by kind and id across sources', () => {
    const web = emptySnapshot({ sourceId: 'web', sourceKind: 'console_api', alias: 'web' }, '2026-01-01T00:00:00Z');
    const mobile = emptySnapshot({ sourceId: 'mobile', sourceKind: 'console_api', alias: 'mobile' }, '2026-01-01T00:00:00Z');
    web.gates.push(gate('shared', 'web', []), gate('web_only', 'web', []));
    mobile.gates.push(gate('shared', 'mobile', []));
    const m = matchAcrossSources([web, mobile], 'gate');
    expect(m.map((x) => [x.id, Object.keys(x.bySource)])).toEqual([
      ['shared', ['web', 'mobile']],
      ['web_only', ['web']],
    ]);
  });
});

describe('segmentReferences (who uses a segment)', () => {
  it('lists the gates, configs and segments whose rules pass or fail a segment, once each, and describes them', async () => {
    const { segmentReferences, describeSegmentUsers } = await import('../src/inventory.ts');
    const snap = emptySnapshot({ sourceId: 'web', sourceKind: 'console_api', alias: 'web' }, '2026-01-01T00:00:00Z');
    const seg = (type: 'passes_segment' | 'fails_segment', target: unknown): Condition => ({ type, operator: null, targetValue: target, raw: {} });
    const rule = (name: string, conditions: Condition[]): Rule => ({ id: name, name, passPercentage: 100, conditions, environments: null, idType: 'userID' });
    snap.gates.push(gate('checkout', 'web', [rule('beta', [seg('passes_segment', 'beta_testers')]), rule('beta again', [seg('passes_segment', ['beta_testers', 'vip'])])]));
    snap.gates.push({ ...gate('old_gate', 'web', [rule('x', [seg('fails_segment', 'fraud')])]), archived: true });
    snap.configs.push({ kind: 'config', uid: 'web/config/banner', id: 'banner', name: 'banner', source: snap.source, completeness: { missing: [] }, tags: [], targetApps: [], archived: false, defaultValue: {}, rules: [rule('vip', [seg('passes_segment', 'vip')])], overrides: [] } as never);
    snap.segments.push({ kind: 'segment', uid: 'web/segment/staff_or_beta', id: 'staff_or_beta', name: 'staff_or_beta', source: snap.source, completeness: { missing: [] }, tags: [], targetApps: [], archived: false, segmentType: 'rule_based', enabled: true, idType: 'userID', rules: [rule('beta', [seg('passes_segment', 'beta_testers')])] } as never);
    const refs = segmentReferences(snap);
    expect([...refs.keys()].sort()).toEqual(['beta_testers', 'fraud', 'vip']);
    expect(refs.get('beta_testers')!.map((r) => `${r.kind}:${r.id}`)).toEqual(['gate:checkout', 'segment:staff_or_beta']);
    expect(describeSegmentUsers(refs.get('beta_testers'))).toBe('used by 1 gate, 1 segment');
    expect(describeSegmentUsers(refs.get('vip'))).toBe('used by 1 gate, 1 config');
    expect(describeSegmentUsers(refs.get('fraud'))).toBe('not used (1 archived user)');
    expect(describeSegmentUsers(refs.get('nobody'))).toBe('not used');
  });
});

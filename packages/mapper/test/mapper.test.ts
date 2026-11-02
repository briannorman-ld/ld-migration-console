import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot, Condition, Config, Gate } from '@sslm/canonical';
import { caseFoldedPattern, createKindOption, isValidContextKindKey, mapAutotune, mapConfig, mapGate, mapSegment, optionLabel, type MapArgs, type Resolution } from '../src/index.ts';
import { acmeSnapshot, CAPS, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

const MAPPING = { development: null, staging: 'test', production: 'production', qa: null };
let web: CanonicalSnapshot;
beforeAll(async () => {
  web = await acmeSnapshot('web');
});

function args(gateId: string, over: Partial<MapArgs<Gate>> = {}): MapArgs<Gate> {
  const entity = web.gates.find((g) => g.id === gateId)!;
  return { canonical: { snapshot: web }, entity, profile: profileFor(web, MAPPING), resolutions: new Map(), capabilities: CAPS, env: { statsig: 'production', ld: 'production' }, now: NOW, ...over };
}

const types = (r: { unresolved: { type: string }[] }) => r.unresolved.map((d) => d.type).sort();

describe('operator pitfalls (CLAUDE.md, PLAN §10.3)', () => {
  it('version_gte → NOT semVerLessThan', () => {
    const r = mapGate(args('windows_download_cta'));
    expect(r.env.rules[0]!.clauses[1]).toEqual({ contextKind: 'user', attribute: 'osVersion', op: 'semVerLessThan', values: ['10.0.0'], negate: true });
  });

  it('`any` is case-insensitive in StatSig, so it needs a decision; the recommended regex is exact', () => {
    const r = mapGate(args('search_v2'));
    // unit_type_kind: search_v2 has a custom-ID override on a userID gate (see edge cases below).
    expect(types(r)).toEqual(['case_insensitive_match', 'case_insensitive_match', 'client_side_availability', 'unit_type_kind']);
    const re = new RegExp(r.env.rules[0]!.clauses[0]!.values[0] as string);
    expect(['Pro', 'pro', 'PRO', 'pRo'].every((v) => re.test(v))).toBe(true);
    expect(re.test('Proton')).toBe(false);
  });

  it('str_contains_any is case-insensitive too (StatSig Evaluator stringCompare(true, …))', () => {
    expect(types(mapGate(args('employees_only')))).toContain('case_insensitive_match');
  });

  it('values without cased letters need no decision', () => {
    const r = mapGate(args('maintenance_mode'));
    expect(types(r)).toEqual(['client_side_availability']);
    expect(r.env.rules[0]!.clauses[0]).toMatchObject({ attribute: 'ip', op: 'in', values: ['10.0.0.1', '10.0.0.2'] });
  });

  it('environment_tier is resolved statically per environment', () => {
    expect(mapGate(args('staff_debug_tools')).env.rules).toEqual([]);
    const staging = mapGate(args('staff_debug_tools', { env: { statsig: 'staging', ld: 'test' } }));
    expect(staging.env.fallthrough).toEqual({ variation: 0 });
  });

  it('custom unit IDs map to their own context kind, not user', () => {
    const r = mapGate(args('b2b_bulk_ordering'));
    expect(r.env.rules[0]!.clauses[0]!.contextKind).toBe('company');
    expect(r.env.targets.map((t) => t.contextKind)).toEqual(['company', 'company']);
    expect(r.dependencies).toContainEqual({ kind: 'context_kind', key: 'company', entityId: 'companyID' });
    expect(types(r)).toContain('unit_type_kind');
  });

  it('a typed `create:<key>` answer creates a kind the user named; an invalid key falls back to the proposal', () => {
    const first = mapGate(args('b2b_bulk_ordering'));
    const d = first.unresolved.find((x) => x.type === 'unit_type_kind')!;
    expect(d.options.map((o) => o.key)).toContain('create:company');
    const answer = (optionKey: string) => new Map([[d.id, { id: d.id, type: d.type, optionKey, scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt: NOW }]]);

    const custom = mapGate(args('b2b_bulk_ordering', { resolutions: answer(createKindOption('account')) }));
    expect(types(custom)).not.toContain('unit_type_kind');
    expect(custom.applied.map((a) => a.optionKey)).toContain('create:account');
    expect(custom.env.rules[0]!.clauses[0]!.contextKind).toBe('account');
    expect(custom.dependencies).toContainEqual({ kind: 'context_kind', key: 'account', entityId: 'companyID' });
    expect(custom.dependencies.find((x) => x.key === 'company')).toBeUndefined();
    expect(optionLabel(d, createKindOption('account'))).toBe('Create context kind “account”');

    const bad = mapGate(args('b2b_bulk_ordering', { resolutions: answer(createKindOption('not a key!')) }));
    expect(bad.env.rules[0]!.clauses[0]!.contextKind).toBe('company');
    expect(isValidContextKindKey('plan')).toBe(true);
    expect(isValidContextKindKey('Plan_v2.x')).toBe(true);
    for (const k of ['', 'kind', 'multi', 'plan key', 'plan/key']) expect(isValidContextKindKey(k)).toBe(false);
  });

  it('a configured unit type → kind mapping needs no decision', () => {
    const profile = profileFor(web, MAPPING);
    profile.sources[web.source.sourceId]!.unitTypeKinds.companyID = 'account';
    const r = mapGate(args('b2b_bulk_ordering', { profile }));
    expect(types(r)).not.toContain('unit_type_kind');
    expect(r.env.rules[0]!.clauses[0]!.contextKind).toBe('account');
  });

  it('case-folded patterns escape regex metacharacters', () => {
    expect(caseFoldedPattern('a.b+', 'full')).toBe('^[aA]\\.[bB]\\+$');
    expect(new RegExp(caseFoldedPattern('@Acme.example', 'none')).test('x@ACME.EXAMPLE')).toBe(true);
  });
});

describe('gate references (PLAN §10.4)', () => {
  it('inlines a referenced gate without partial rollouts', () => {
    const r = mapGate(args('checkout_promo_banner'));
    expect(r.env.rules).toHaveLength(1);
    expect(r.env.rules[0]!.clauses[0]).toMatchObject({ attribute: 'email', op: 'matches' });
    expect(r.env.prerequisites).toEqual([]);
  });

  it('offers a prerequisite when the referenced gate has a partial rollout', () => {
    const r = mapGate(args('checkout_express_pay'));
    const d = r.unresolved.find((x) => x.type === 'gate_reference')!;
    expect(d.recommended).toBe('prerequisite');
    expect(r.env.prerequisites).toEqual([{ key: 'new_checkout_flow', variation: 0 }]);
    expect(r.dependencies).toContainEqual({ kind: 'flag', key: 'new_checkout_flow', entityId: 'new_checkout_flow' });
  });

  it('makes the gate reference blocking when prerequisites are unavailable', () => {
    const r = mapGate(args('checkout_express_pay', { capabilities: { ...CAPS, prerequisites: 'unavailable' } }));
    const d = r.unresolved.find((x) => x.type === 'gate_reference')!;
    expect(d.severity).toBe('blocking');
    expect(d.options.map((o) => o.key)).toEqual(['drop_condition', 'drop_rule', 'skip']);
  });

  it('inlined gates feed the fingerprint, so a change in the referenced gate is drift', () => {
    const before = mapGate(args('checkout_promo_banner')).statsigFingerprint;
    const changed: CanonicalSnapshot = { ...web, gates: web.gates.map((g) => (g.id === 'employees_only' ? { ...g, enabled: false } : g)) };
    expect(mapGate(args('checkout_promo_banner', { canonical: { snapshot: changed }, entity: changed.gates.find((g) => g.id === 'checkout_promo_banner')! })).statsigFingerprint).not.toBe(before);
  });
});

describe('time, null and unsupported conditions', () => {
  it('resolves a time window entirely in the past statically', () => {
    const r = mapGate(args('holiday_sale_2025'));
    expect(types(r)).toEqual(['client_side_availability']);
    expect(r.env.rules).toEqual([]);
  });

  it('asks about a time condition in the future', () => {
    expect(types(mapGate(args('black_friday_2027')))).toContain('time_condition');
    const later = mapGate(args('black_friday_2027', { now: '2028-01-01T00:00:00.000Z' }));
    expect(types(later)).not.toContain('time_condition');
    expect(later.env.fallthrough).toEqual({ variation: 0 });
  });

  it('is_null has no safe default', () => {
    const d = mapGate(args('missing_email_prompt')).unresolved.find((x) => x.type === 'null_check')!;
    expect(d.severity).toBe('blocking');
    expect(d.recommended).toBeUndefined();
  });

  it('url and target_app conditions are blocking decisions, never dropped silently', () => {
    for (const id of ['storefront_url_banner', 'storefront_app_only']) {
      const d = mapGate(args(id)).unresolved.find((x) => x.type === 'unsupported_condition')!;
      expect(d.severity).toBe('blocking');
    }
  });

  it('an unloaded ID list blocks the gate until it is fetched', () => {
    expect(mapGate(args('block_fraudulent_checkout')).unresolved.map((d) => [d.type, d.severity])).toContainEqual(['id_list_unavailable', 'blocking']);
    expect(mapGate(args('wholesale_portal')).unresolved.map((d) => d.type)).toContain('id_list_unavailable');
  });

  it('a fetched ID list unblocks the segment and the gate', () => {
    const seg = web.segments.find((s) => s.id === 'wholesale_partners')!;
    const ids = Array.from({ length: 2500 }, (_, i) => `partner-${String(i + 1).padStart(5, '0')}`);
    const canonical = { snapshot: web, idLists: { [seg.uid]: ids } };
    expect(mapGate(args('wholesale_portal', { canonical })).unresolved.map((d) => d.type)).toEqual(['client_side_availability']);
    const s = mapSegment({ ...args('wholesale_portal', { canonical }), entity: seg });
    expect(s.desired?.included).toHaveLength(2500);
  });
});

describe('big segments (PLAN §8.3 big_segment; edge case 9.3)', () => {
  const fraud = () => web.segments.find((s) => s.id === 'fraud_blocklist')!;
  const ids = Array.from({ length: 20_000 }, (_, i) => `fraud-user-${String(i + 1).padStart(6, '0')}`);
  const loaded = () => ({ snapshot: web, idLists: { [fraud().uid]: ids } });

  it('a loaded list above 15,000 IDs is a choice shared by the gate and the segment, recommending a CSV import', () => {
    const g = mapGate(args('block_fraudulent_checkout', { canonical: loaded() }));
    const d = g.unresolved.find((x) => x.type === 'big_segment')!;
    expect(d.severity).toBe('choice');
    expect(d.recommended).toBe('import');
    expect(d.subject.uid).toBe(fraud().uid);
    // Preview with the recommended option: the rule targets the (big) segment.
    expect(g.env.rules[0]!.clauses).toEqual([{ contextKind: 'user', attribute: 'segmentMatch', op: 'segmentMatch', values: ['fraud_blocklist'], negate: true }]);
    expect(g.dependencies).toContainEqual({ kind: 'segment', key: 'fraud_blocklist', entityId: 'fraud_blocklist' });
    const s = mapSegment({ ...args('block_fraudulent_checkout', { canonical: loaded() }), entity: fraud() });
    expect(s.unresolved.map((x) => x.id)).toEqual([d.id]);
    expect(s.desired?.unbounded).toEqual({ contextKind: 'user', ids });
    expect(s.desired?.included).toEqual([]);
  });

  it('is blocking without an import option when the LD plan has no big segments', () => {
    const capabilities = { ...CAPS, bigSegments: 'unavailable' as const };
    const d = mapGate(args('block_fraudulent_checkout', { canonical: loaded(), capabilities })).unresolved.find((x) => x.type === 'big_segment')!;
    expect(d.severity).toBe('blocking');
    expect(d.options.map((o) => o.key)).toEqual(['drop_condition', 'drop_rule', 'skip']);
  });

  it('one answer covers the gate rule and the segment', () => {
    const g = mapGate(args('block_fraudulent_checkout', { canonical: loaded() }));
    const d = g.unresolved.find((x) => x.type === 'big_segment')!;
    const res = { id: d.id, type: d.type, optionKey: 'drop_rule', scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt: NOW };
    const resolutions = new Map([[res.id, res]]);
    const g2 = mapGate(args('block_fraudulent_checkout', { canonical: loaded(), resolutions }));
    expect(g2.env.rules).toEqual([]);
    expect(g2.dependencies.filter((x) => x.kind === 'segment')).toEqual([]);
    const s = mapSegment({ ...args('block_fraudulent_checkout', { canonical: loaded(), resolutions }), entity: fraud() });
    expect(s.desired).toBeNull();
    expect(s.skipped).toMatch(/rules referencing it were changed/);
  });
});

describe('hashed ID lists and reconciliation (PLAN §4.2; edge case 9.4)', () => {
  const hashed = (): CanonicalSnapshot => {
    const seg = web.segments.find((s) => s.id === 'wholesale_partners')!;
    return { ...web, segments: web.segments.map((s) => (s === seg ? { ...s, idList: { count: 2500, hashed: { listName: 'wholesale_partners' } } } : s)) };
  };
  const seg = () => hashed().segments.find((s) => s.id === 'wholesale_partners')!;
  const ids = Array.from({ length: 2490 }, (_, i) => `partner-${String(i + 1).padStart(5, '0')}`);

  it('without raw IDs the segment blocks every rule that needs it, and the segment is skipped', () => {
    const snapshot = hashed();
    const g = mapGate(args('wholesale_portal', { canonical: { snapshot } }));
    const d = g.unresolved.find((x) => x.type === 'hashed_id_list')!;
    expect(d.severity).toBe('blocking');
    expect(d.subject.uid).toBe(seg().uid);
    expect(d.explanation).toMatch(/Upload the raw IDs/);
    const s = mapSegment({ ...args('wholesale_portal', { canonical: { snapshot } }), entity: seg() });
    expect(s.skipped).toMatch(/upload the raw IDs/);
  });

  it('a reconciled upload short of 100% is an acknowledgement; accepting it migrates the matched IDs', () => {
    const snapshot = hashed();
    const canonical = { snapshot, idLists: { [seg().uid]: ids }, coverage: { [seg().uid]: { total: 2500, matched: 2490, missing: 10, extra: 0, verified: true } } };
    const g = mapGate(args('wholesale_portal', { canonical }));
    const d = g.unresolved.find((x) => x.type === 'hashed_id_list')!;
    expect(d.severity).toBe('acknowledge');
    expect(d.title).toMatch(/99\.6%/);
    expect(g.env.rules[0]!.clauses[0]!.op).toBe('segmentMatch');
    const s = mapSegment({ ...args('wholesale_portal', { canonical }), entity: seg() });
    expect(s.desired?.included).toHaveLength(2490);
    expect(s.fidelity.overall).toBe('partial');
    expect(s.unresolved.map((x) => x.id)).toEqual([d.id]);
  });

  it('a complete, verified upload needs no decision', () => {
    const snapshot = hashed();
    const canonical = { snapshot, idLists: { [seg().uid]: ids }, coverage: { [seg().uid]: { total: 2490, matched: 2490, missing: 0, extra: 3, verified: true } } };
    expect(types(mapGate(args('wholesale_portal', { canonical })))).toEqual(['client_side_availability']);
    const s = mapSegment({ ...args('wholesale_portal', { canonical }), entity: seg() });
    expect(s.fidelity.overall).toBe('full');
    expect(s.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/3 uploaded IDs not in the list left out/));
  });
});

describe('scheduled changes for time conditions (PLAN §5.1; edge case 5.3)', () => {
  const schedule = (over: Partial<MapArgs<Gate>> = {}) => {
    const first = mapGate(args('black_friday_2027'));
    const d = first.unresolved.find((x) => x.type === 'time_condition')!;
    const res = { id: d.id, type: d.type, optionKey: 'schedule', scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt: NOW };
    return { d, r: mapGate(args('black_friday_2027', { resolutions: new Map([[res.id, res]]), ...over })) };
  };

  it('offers a scheduled change, recommended once the probe shows the plan allows it', () => {
    const unknown = mapGate(args('black_friday_2027')).unresolved.find((x) => x.type === 'time_condition')!;
    expect(unknown.options.map((o) => o.key)).toEqual(['schedule', 'resolve_now', 'skip']);
    expect(unknown.recommended).toBe('resolve_now');
    const available = mapGate(args('black_friday_2027', { capabilities: { ...CAPS, scheduledChanges: 'available' } })).unresolved.find((x) => x.type === 'time_condition')!;
    expect(available.recommended).toBe('schedule');
    const none = mapGate(args('black_friday_2027', { capabilities: { ...CAPS, scheduledChanges: 'unavailable' } })).unresolved.find((x) => x.type === 'time_condition')!;
    expect(none.options.map((o) => o.key)).toEqual(['resolve_now', 'skip']);
  });

  it('"schedule" mirrors StatSig now and carries the targeting as of the flip in a scheduled change', () => {
    const { r } = schedule();
    expect(r.unresolved.map((d) => d.type)).toEqual(['client_side_availability']);
    expect(r.fidelity.overall).toBe('full');
    // Before Black Friday the rule can't match: off-state targeting, nothing served.
    expect(r.env.rules).toEqual([]);
    expect(r.env.fallthrough).toEqual({ variation: 1 });
    expect(r.env.scheduledChanges).toHaveLength(1);
    const sc = r.env.scheduledChanges![0]!;
    expect(sc.executionDate).toBe('2027-11-26T05:00:00Z');
    // As of the flip the rule matches everyone, so the scheduled state serves true by default.
    expect(sc.state.fallthrough).toEqual({ variation: 0 });
    expect(sc.state.rules).toEqual([]);
  });

  it('once the flip has passed nothing is scheduled and the condition resolves statically', () => {
    const { r } = schedule({ now: '2028-01-01T00:00:00.000Z' });
    expect(r.env.scheduledChanges).toBeUndefined();
    expect(r.env.fallthrough).toEqual({ variation: 0 });
  });

  it('is deterministic', () => {
    const a = schedule().r;
    const b = schedule().r;
    expect(a).toEqual(b);
  });
});

describe('overrides and rollouts', () => {
  it('environment-specific overrides apply only in their environment', () => {
    const prod = mapGate(args('new_checkout_flow'));
    const staging = mapGate(args('new_checkout_flow', { env: { statsig: 'staging', ld: 'test' } }));
    const pass = (r: typeof prod) => r.env.targets.find((t) => t.variation === 0)!.values;
    expect(pass(prod)).toEqual(['user-qa-1', 'user-qa-2']);
    // user-vip-complainer fails in every environment but passes in staging: the environment-specific
    // override wins there, and the conflict is reported.
    expect(pass(staging)).toEqual(['user-staging-tester', 'user-vip-complainer', 'user-qa-1', 'user-qa-2']);
    expect(staging.env.targets.find((t) => t.variation === 1)).toBeUndefined();
    expect(staging.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/1 ID is overridden both to pass and to fail/));
    expect(prod.env.targets.find((t) => t.variation === 1)!.values).toEqual(['user-vip-complainer']);
  });

  it('a public partial rollout becomes the fallthrough rollout and needs an acknowledgement', () => {
    const r = mapGate(args('new_checkout_flow'));
    expect(r.env.fallthrough.rollout?.variations).toEqual([
      { variation: 0, weight: 20_000 },
      { variation: 1, weight: 80_000 },
    ]);
    expect(r.unresolved.find((d) => d.type === 'partial_rollout_rebucket')?.severity).toBe('acknowledge');
  });

  it('a disabled gate is off in LD and serves false', () => {
    const r = mapGate(args('old_cart_drawer'));
    expect(r.env.on).toBe(false);
    expect(r.env.offVariation).toBe(1);
  });

  it('archived gates are skipped', () => {
    expect(mapGate(args('legacy_wishlist')).skipped).toBe('archived in StatSig');
  });
});

describe('resolutions (PLAN §8.1)', () => {
  const resolve = (r: ReturnType<typeof mapGate>, type: string, optionKey: string): Resolution => {
    const d = r.unresolved.find((x) => x.type === type)!;
    return { id: d.id, type: d.type, optionKey, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW };
  };

  it('applies a resource resolution in every environment', () => {
    const first = mapGate(args('search_autocomplete'));
    const res = resolve(first, 'client_side_availability', 'server');
    const resolutions = new Map([[res.id, res]]);
    for (const env of [{ statsig: 'production', ld: 'production' }, { statsig: 'staging', ld: 'test' }]) {
      const r = mapGate(args('search_autocomplete', { resolutions, env }));
      expect(r.unresolved).toEqual([]);
      expect(r.shell.clientSideAvailability).toEqual({ usingEnvironmentId: false, usingMobileKey: false });
      expect(r.applied.map((a) => a.via)).toEqual(['resource']);
    }
  });

  it('a workspace policy answers every decision of its type', () => {
    const profile = { ...profileFor(web, MAPPING), policies: { client_side_availability: 'both', case_insensitive_match: 'variants', unit_type_kind: 'create:custom' } };
    const r = mapGate(args('search_v2', { profile }));
    expect(r.unresolved).toEqual([]);
    expect(r.env.rules[0]!.clauses[0]).toMatchObject({ op: 'in', values: ['Pro', 'pro', 'PRO', 'Enterprise', 'enterprise', 'ENTERPRISE'] });
  });

  it('goes stale when the StatSig fragment changes, and shows the old answer', () => {
    const first = mapGate(args('search_v2'));
    const res = resolve(first, 'case_insensitive_match', 'exact');
    const changed: CanonicalSnapshot = {
      ...web,
      gates: web.gates.map((g) => (g.id !== 'search_v2' ? g : { ...g, rules: g.rules.map((r) => ({ ...r, conditions: r.conditions.map((c, i) => (i === 0 ? { ...c, targetValue: ['Pro', 'Enterprise', 'Team'] } : c)) })) })),
    };
    const entity = changed.gates.find((g) => g.id === 'search_v2')!;
    const r = mapGate(args('search_v2', { canonical: { snapshot: changed }, entity, resolutions: new Map([[res.id, res]]) }));
    expect(r.stale.map((s) => s.previous.optionKey)).toEqual(['exact']);
    expect(r.unresolved.map((d) => d.id)).toContain(res.id);
  });

  it('a "skip" answer skips the item', () => {
    const first = mapGate(args('black_friday_2027'));
    const res = resolve(first, 'time_condition', 'skip');
    expect(mapGate(args('black_friday_2027', { resolutions: new Map([[res.id, res]]) })).skipped).toMatch(/skipped by decision/);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(mapGate(args('new_checkout_flow')))).toBe(JSON.stringify(mapGate(args('new_checkout_flow'))));
  });
});

describe('flag shell and provenance (PLAN §3.3, §10.1)', () => {
  it('keeps the StatSig name as the key, tags provenance, and serves false in unmigrated environments', () => {
    const r = mapGate(args('kill_switch_payments'));
    expect(r.shell).toMatchObject({
      key: 'kill_switch_payments',
      temporary: false,
      tags: ['migrated-from-statsig', 'migration-src-web', 'platform'],
      defaults: { onVariation: 1, offVariation: 1 },
      variations: [{ value: true }, { value: false }],
    });
    expect(r.shell.customProperties['migration.id']).toEqual({ name: 'StatSig ID', value: ['kill_switch_payments'] });
  });
});

describe('profile', () => {
  it('maps environments by key, then by hint, never overwriting a choice', async () => {
    const { reconcileProfile } = await import('../src/index.ts');
    const ld = [
      { key: 'test', name: 'Test' },
      { key: 'production', name: 'Production' },
    ];
    const p = reconcileProfile({ version: 1, sources: {}, attributes: {}, policies: {} }, [web], ld, { staging: 'test' });
    expect(p.sources[web.source.sourceId]!.envMapping).toEqual({ development: null, staging: 'test', production: 'production', qa: null });
    p.sources[web.source.sourceId]!.envMapping.staging = null;
    expect(reconcileProfile(p, [web], ld, { staging: 'test' }).sources[web.source.sourceId]!.envMapping.staging).toBeNull();
  });
});

/**
 * One test per row of docs/KNOWN-EDGE-CASES.md that the mapper handles (or knowingly doesn't).
 * Keep the two in sync: a new row there gets a demo example in packages/demo-fixtures and a
 * test here.
 */
describe('known edge cases (docs/KNOWN-EDGE-CASES.md)', () => {
  const clause = (r: ReturnType<typeof mapGate>, rule = 0, cond = 0) => r.env.rules[rule]!.clauses[cond]!;
  /** A copy of `gift_card_upsell` whose single rule has the given conditions (for spec-only operators). */
  const withConditions = (conds: Partial<Condition>[]): Gate => {
    const g = web.gates.find((x) => x.id === 'gift_card_upsell')!;
    return { ...g, rules: [{ ...g.rules[0]!, conditions: conds.map((c) => ({ type: 'custom_field', field: 'plan', operator: null, targetValue: null, raw: c, ...c }) as Condition) }] };
  };

  describe('gate references', () => {
    it('fails_gate on an inlinable gate is inlined as a negation', () => {
      const r = mapGate(args('non_staff_survey'));
      expect(r.fidelity.overall).toBe('full');
      expect(clause(r)).toMatchObject({ attribute: 'email', op: 'matches', negate: true });
    });

    it('fails_gate on a gate with a partial rollout is blocking: no prerequisite can express a negation', () => {
      const r = mapGate(args('express_pay_fallback'));
      const d = r.unresolved.find((x) => x.type === 'gate_reference')!;
      expect(d.severity).toBe('blocking');
      expect(d.options.map((o) => o.key)).toEqual(['drop_condition', 'drop_rule', 'skip']);
    });

    it('fails_gate on a gate with overrides cannot be inlined exactly', () => {
      const d = mapGate(args('consumer_pricing')).unresolved.find((x) => x.type === 'gate_reference')!;
      expect(d.explanation).toMatch(/has overrides/);
    });

    it('passes_gate in only some rules offers no prerequisite', () => {
      const d = mapGate(args('checkout_upsell_v2')).unresolved.find((x) => x.type === 'gate_reference')!;
      expect(d.severity).toBe('blocking');
      expect(d.options.some((o) => o.key === 'prerequisite')).toBe(false);
    });

    it('gate references that form a cycle cannot be inlined; the planner refuses the prerequisite', () => {
      const tmpl = web.gates.find((g) => g.id === 'checkout_promo_banner')!;
      const ref = (id: string, to: string): Gate => ({
        ...tmpl,
        id,
        uid: `${tmpl.source.sourceId}/gate/${id}`,
        rules: [{ ...tmpl.rules[0]!, conditions: [{ type: 'passes_gate', operator: null, targetValue: to, raw: {} }] }],
      });
      const snapshot: CanonicalSnapshot = { ...web, gates: [...web.gates, ref('cyc_a', 'cyc_b'), ref('cyc_b', 'cyc_a')] };
      const entity = snapshot.gates.find((g) => g.id === 'cyc_a')!;
      const d = mapGate(args('checkout_promo_banner', { canonical: { snapshot }, entity })).unresolved.find((x) => x.type === 'gate_reference')!;
      expect(d.explanation).toMatch(/cycle/);
      // Known gap: the mapper still offers "prerequisite" (every rule requires the gate). LD forbids
      // prerequisite cycles; the planner reports "Prerequisites form a cycle" and refuses the plan.
      expect(d.recommended).toBe('prerequisite');
    });

    it('a rule that would expand into more than 10 LD rules is blocking', () => {
      const r = mapGate(args('cross_sell_matrix'));
      expect(r.unresolved.find((x) => x.type === 'rule_expansion')).toMatchObject({ severity: 'blocking', title: expect.stringMatching(/12 LD rules/) });
      expect(r.env.rules).toEqual([]);
    });
  });

  describe('rules and rollouts', () => {
    it('4.13: a Launched gate serves true to everyone, even when the API says isEnabled false with no rules', () => {
      const r = mapGate(args('launched_dark_mode_v1'));
      expect(r.env).toMatchObject({ on: true, fallthrough: { variation: 0 }, rules: [], targets: [] });
      expect(r.fidelity.overall).toBe('full');
      expect(r.fidelity.notes.some((n) => /Launched in StatSig/.test(n.message))).toBe(true);
      // A launched gate with leftover rules ignores them too, and says so.
      const f = mapGate(args('stale_promo_ribbon'));
      expect(f.env).toMatchObject({ on: true, fallthrough: { variation: 0 }, rules: [] });
      expect(f.fidelity.notes.some((n) => /1 rule is not evaluated/.test(n.message))).toBe(true);
    });
    it('a 0% rule is an exclusion: it serves false and stops evaluation', () => {
      const r = mapGate(args('reviews_v2'));
      expect(r.env.rules[0]).toMatchObject({ description: 'Exclude load tests', variation: 1 });
      expect(r.env.fallthrough).toEqual({ variation: 0 });
    });

    it('rules after a public 100% rule are unreachable and dropped', () => {
      const r = mapGate(args('free_returns'));
      expect(r.env.rules).toEqual([]);
      expect(r.env.fallthrough).toEqual({ variation: 0 });
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/can never match/));
    });

    it('a gate without rules is on and serves false', () => {
      const r = mapGate(args('payments_v3_scaffold'));
      expect(r.env).toMatchObject({ on: true, rules: [], fallthrough: { variation: 1 } });
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/STALE_NO_RULES/));
    });

    it('stableID rollouts bucket by the device context kind', () => {
      const r = mapGate(args('anon_homepage_variant'));
      expect(r.env.fallthrough.rollout?.contextKind).toBe('device');
      expect(types(r)).toContain('unit_type_kind');
    });

    it('4.8: an attached holdout is an acknowledgement with its share, and a partial note', () => {
      const gate = web.gates.find((g) => g.id === 'new_checkout_flow')!;
      expect(gate.holdoutIds).toEqual(['checkout_holdout']);
      const r = mapGate(args('new_checkout_flow'));
      const d = r.unresolved.find((x) => x.type === 'holdout_attached')!;
      expect(d.severity).toBe('acknowledge');
      expect(d.id).toBe(`holdout_attached:${gate.uid}:holdout:checkout_holdout`);
      expect(d.title).toMatch(/5% of users/);
      expect(d.options.map((o) => o.key)).toEqual(['acknowledge', 'skip']);
      expect(r.fidelity.overall).toBe('partial');
      expect(r.fidelity.notes.some((n) => n.fidelity === 'partial' && /Holdout “checkout_holdout” \(5%\) is not carried over/.test(n.message))).toBe(true);
      // The flag itself is unchanged: the holdout has no LD equivalent on a flag.
      expect(r.env.rules.map((x) => x.description)).toEqual(['Acme staff', 'Beta testers']);
    });

    it('4.8: "skip" keeps the gate in StatSig until the holdout ends; the holdout share feeds the fingerprint', () => {
      const gate = web.gates.find((g) => g.id === 'new_checkout_flow')!;
      const id = `holdout_attached:${gate.uid}:holdout:checkout_holdout`;
      const base = mapGate(args('new_checkout_flow'));
      const fp = base.unresolved.find((x) => x.id === id)!.fingerprint;
      const resolutions = new Map<string, Resolution>([[id, { id, type: 'holdout_attached', optionKey: 'skip', scope: 'resource', fingerprint: fp, decidedAt: NOW }]]);
      const skipped = mapGate(args('new_checkout_flow', { resolutions }));
      expect(skipped.skipped).toMatch(/holdout “checkout_holdout” \(5%\)/);

      const changed: CanonicalSnapshot = { ...web, holdouts: web.holdouts.map((h) => (h.id === 'checkout_holdout' ? { ...h, passPercentage: 10 } : h)) };
      const r = mapGate(args('new_checkout_flow', { canonical: { snapshot: changed }, resolutions }));
      expect(r.statsigFingerprint).not.toBe(base.statsigFingerprint);
      expect(r.stale.map((s) => s.decision.id)).toEqual([id]); // the 5% answer no longer applies to a 10% holdout
    });

    it('4.8: a holdout id the snapshot lacks is a partial note; a disabled holdout holds nobody out', () => {
      const gate = web.gates.find((g) => g.id === 'new_checkout_flow')!;
      const missing = mapGate(args('new_checkout_flow', { entity: { ...gate, holdoutIds: ['gone_holdout'] } }));
      expect(types(missing)).not.toContain('holdout_attached');
      expect(missing.fidelity.notes.some((n) => n.fidelity === 'partial' && /“gone_holdout” is attached but isn't in this StatSig snapshot/.test(n.message))).toBe(true);

      const disabled: CanonicalSnapshot = { ...web, holdouts: web.holdouts.map((h) => (h.id === 'checkout_holdout' ? { ...h, enabled: false } : h)) };
      const r = mapGate(args('new_checkout_flow', { canonical: { snapshot: disabled } }));
      expect(types(r)).not.toContain('holdout_attached');
      expect(r.fidelity.notes.some((n) => n.fidelity === 'full' && /is disabled in StatSig/.test(n.message))).toBe(true);
    });
  });

  describe('operators', () => {
    /** Resolutions answering every unresolved decision of `type` on `r` with `optionKey`. */
    const decide = (r: ReturnType<typeof mapGate>, type: string, optionKey: string): Map<string, Resolution> =>
      new Map(r.unresolved.filter((d) => d.type === type).map((d) => [d.id, { id: d.id, type: d.type, optionKey, scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt: NOW }]));

    it('6.2: numeric `any` targets raise value_type; "both" (recommended) emits the number and the string', () => {
      const r = mapGate(args('loyalty_tier_perks'));
      const d = r.unresolved.find((x) => x.type === 'value_type')!;
      expect(d.severity).toBe('choice');
      expect(d.recommended).toBe('both');
      expect(d.options.map((o) => `${o.key}:${o.resultingFidelity}`)).toEqual(['both:full', 'number:partial', 'string:partial', 'skip:skipped']);
      expect(clause(r)).toMatchObject({ op: 'in', values: [2, '2', 3, '3'], negate: false });
      expect(r.fidelity.overall).toBe('full');
      // No case decision: numbers have no cased letters.
      expect(types(r)).not.toContain('case_insensitive_match');

      expect(clause(mapGate(args('loyalty_tier_perks', { resolutions: decide(r, 'value_type', 'number') })))).toMatchObject({ values: [2, 3] });
      const asStrings = mapGate(args('loyalty_tier_perks', { resolutions: decide(r, 'value_type', 'string') }));
      expect(clause(asStrings)).toMatchObject({ values: ['2', '3'] });
      expect(asStrings.fidelity.notes.some((n) => n.fidelity === 'partial' && /must be sent as a string/.test(n.message))).toBe(true);
      expect(mapGate(args('loyalty_tier_perks', { resolutions: decide(r, 'value_type', 'skip') })).skipped).toBeDefined();
    });

    it('6.5 / 6.2: eq, neq and the case-sensitive variants on numbers or booleans raise value_type; string targets do not', () => {
      const r = mapGate(
        args('gift_card_upsell', {
          entity: withConditions([
            { operator: 'eq', targetValue: 5 },
            { operator: 'neq', targetValue: 'trial' },
            { field: 'opted_in', operator: 'any_case_sensitive', targetValue: [true] },
            { operator: 'none_case_sensitive', targetValue: ['free'] },
          ]),
        }),
      );
      expect(r.unresolved.filter((d) => d.type === 'value_type').map((d) => d.subject.location)).toEqual(['rule “Low balance” › condition 1', 'rule “Low balance” › condition 3']);
      const cs = r.env.rules[0]!.clauses;
      expect(cs[0]).toMatchObject({ op: 'in', values: [5, '5'], negate: false });
      expect(cs[1]).toMatchObject({ op: 'in', values: ['trial'], negate: true });
      expect(cs[2]).toMatchObject({ op: 'in', values: [true, 'true'] });
      expect(cs[3]).toMatchObject({ op: 'in', values: ['free'], negate: true });
    });

    it('6.6: numeric operators note that the app must send a number (once per attribute)', () => {
      const r = mapGate(args('gift_card_upsell'));
      expect(types(r)).toEqual(['client_side_availability']);
      const notes = r.fidelity.notes.filter((n) => /must be sent as a number/.test(n.message));
      expect(notes.map((n) => n.fidelity)).toEqual(['full', 'full']);
      expect(notes.map((n) => n.message)).toEqual([expect.stringContaining('“gift_card_balance”'), expect.stringContaining('“loyalty_points”')]);
      expect(r.fidelity.overall).toBe('full');
    });

    it('6.10: array operators with number targets match numbers only in StatSig, so "number" is exact; integer strings match both', () => {
      const r = mapGate(args('clearance_category_badge'));
      const d = r.unresolved.find((x) => x.type === 'value_type')!;
      expect(d.recommended).toBe('number');
      expect(d.options.map((o) => `${o.key}:${o.resultingFidelity}`)).toEqual(['both:partial', 'number:full', 'string:partial', 'skip:skipped']);
      expect(clause(r)).toMatchObject({ op: 'in', values: [12, 48] });
      const both = mapGate(args('clearance_category_badge', { resolutions: decide(r, 'value_type', 'both') }));
      expect(clause(both)).toMatchObject({ values: [12, '12', 48, '48'] });
      expect(both.fidelity.overall).toBe('partial');

      // array_contains_all keeps one clause per target, each accepting both forms.
      const all = mapGate(args('gift_card_upsell', { entity: withConditions([{ field: 'category_ids', operator: 'array_contains_all', targetValue: ['12', 48] }]) }));
      expect(all.unresolved.find((x) => x.type === 'value_type')!.recommended).toBe('both');
      expect(all.env.rules[0]!.clauses.map((c) => c.values)).toEqual([
        ['12', 12],
        [48, '48'],
      ]);
      // not_array_contains_all: one rule per target, each clause negated over both forms.
      const notAll = mapGate(args('gift_card_upsell', { entity: withConditions([{ field: 'category_ids', operator: 'not_array_contains_all', targetValue: ['1', '2'] }]) }));
      expect(notAll.env.rules.map((x) => x.clauses[0])).toEqual([expect.objectContaining({ values: ['1', 1], negate: true }), expect.objectContaining({ values: ['2', 2], negate: true })]);
      // Plain string arrays need no decision.
      expect(types(mapGate(args('wishlist_sharing')))).toEqual(['client_side_availability']);
    });

    it('encoded_any has no equivalent anywhere and is a blocking decision', () => {
      const d = mapGate(args('legacy_partner_allowlist')).unresolved.find((x) => x.type === 'unsupported_condition')!;
      expect(d.title).toMatch(/encoded_any/);
    });

    it('spec-only operators: eq / neq / version_neq / str_starts_with_any / str_ends_with_any', () => {
      const r = mapGate(
        args('gift_card_upsell', {
          entity: withConditions([
            { operator: 'eq', targetValue: 'pro' },
            { operator: 'neq', targetValue: 'trial' },
            { field: 'appVersion', operator: 'version_neq', targetValue: '2.0.0' },
            { operator: 'str_starts_with_any', targetValue: ['Pro'] },
            { operator: 'str_ends_with_any', targetValue: ['Plus'] },
          ]),
        }),
      );
      const cs = r.env.rules[0]!.clauses;
      expect(cs[0]).toMatchObject({ op: 'in', values: ['pro'], negate: false });
      expect(cs[1]).toMatchObject({ op: 'in', values: ['trial'], negate: true });
      expect(cs[2]).toMatchObject({ op: 'semVerEqual', values: ['2.0.0'], negate: true });
      expect(cs[3]).toMatchObject({ op: 'matches', values: ['^[pP][rR][oO]'] });
      expect(cs[4]).toMatchObject({ op: 'matches', values: ['[pP][lL][uU][sS]$'] });
      // neq passes users without the attribute in StatSig; LD never matches them.
      expect(r.unresolved.filter((d) => d.type === 'negated_missing_attribute')).toHaveLength(1);
    });

    it('6.7: a two-part version is padded to semver with a note (exact: StatSig pads too)', () => {
      const r = mapGate(args('pwa_offline_mode'));
      expect(clause(r)).toMatchObject({ attribute: 'appVersion', op: 'semVerLessThan', values: ['1.2.0'], negate: true });
      expect(types(r)).toEqual(['client_side_availability']);
      expect(r.fidelity.overall).toBe('full');
      expect(r.fidelity.notes.map((n) => n.message)).toEqual([expect.stringContaining('“1.2” → “1.2.0”')]);
      // Three-part targets are untouched and silent.
      expect(mapGate(args('windows_download_cta')).fidelity.notes.some((n) => /semver/i.test(n.message))).toBe(false);
    });

    it('6.7: a four-part version raises version_format; "truncate" (recommended) compares against three parts', () => {
      const r = mapGate(args('pos_firmware_sync'));
      const d = r.unresolved.find((x) => x.type === 'version_format')!;
      expect(d.severity).toBe('choice');
      expect(d.title).toBe('Version “2.1.0.450” isn\'t semver');
      expect(d.options.map((o) => o.key)).toEqual(['truncate', 'drop_condition', 'drop_rule', 'skip']);
      expect(clause(r)).toMatchObject({ attribute: 'firmware_version', op: 'semVerLessThan', values: ['2.1.0'], negate: true });
      expect(r.fidelity.overall).toBe('partial');
      expect(r.fidelity.notes.some((n) => /“2\.1\.0\.450” → “2\.1\.0”/.test(n.message) && /three-part/.test(n.message))).toBe(true);

      // Dropping the only condition leaves a rule that matches everyone: it becomes the fallthrough.
      const dropped = mapGate(args('pos_firmware_sync', { resolutions: decide(r, 'version_format', 'drop_condition') }));
      expect(dropped.env).toMatchObject({ rules: [], fallthrough: { variation: 0 } });
      expect(mapGate(args('pos_firmware_sync', { resolutions: decide(r, 'version_format', 'drop_rule') })).env).toMatchObject({ rules: [], fallthrough: { variation: 1 } });
      expect(mapGate(args('pos_firmware_sync', { resolutions: decide(r, 'version_format', 'skip') })).skipped).toBeDefined();
    });

    it('6.7: a prerelease suffix raises version_format too; StatSig strips it, LD sorts it below the release', () => {
      const r = mapGate(args('gift_card_upsell', { entity: withConditions([{ type: 'app_version', operator: 'version_gte', targetValue: '5.3.0-beta' }]) }));
      const d = r.unresolved.find((x) => x.type === 'version_format')!;
      expect(d.explanation).toMatch(/has the suffix “-beta”/);
      expect(clause(r)).toMatchObject({ op: 'semVerLessThan', values: ['5.3.0'], negate: true });
      expect(r.fidelity.notes.some((n) => /prerelease builds sort below the release/.test(n.message))).toBe(true);
      // A single-part target is only padded; a non-numeric one is left alone (StatSig can't compare it either).
      const odd = mapGate(args('gift_card_upsell', { entity: withConditions([{ type: 'app_version', operator: 'version_eq', targetValue: ['7', 'latest'] }]) }));
      expect(clause(odd)).toMatchObject({ op: 'semVerEqual', values: ['7.0.0', 'latest'] });
      expect(types(odd)).not.toContain('version_format');
    });
  });

  describe('names, keys and overrides', () => {
    it('a StatSig name with spaces becomes a sanitized LD key, with a note', () => {
      const r = mapGate(args('Holiday Banner 2026'));
      expect(r.flagKey).toBe('Holiday_Banner_2026');
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/differs from the StatSig name/));
    });

    it('a tag LD cannot spell is renamed, with a note', () => {
      const r = mapGate(args('eu_cookie_banner'));
      expect(r.shell.tags).toContain('core');
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/renamed to fit LD's tag format/));
    });

    it('custom-ID overrides on a userID gate ask for a context kind named after the unknown unit type', () => {
      const r = mapGate(args('search_v2'));
      expect(r.env.targets).toContainEqual({ contextKind: 'custom', variation: 0, values: ['acct_3001'] });
      expect(r.unresolved.find((d) => d.type === 'unit_type_kind')?.subject.id).toBe('customID');
    });
  });

  describe('segments', () => {
    const seg = (id: string, env = { statsig: 'production', ld: 'production' }) =>
      mapSegment({ canonical: { snapshot: web }, entity: web.segments.find((s) => s.id === id)!, profile: profileFor(web, MAPPING), resolutions: new Map(), capabilities: CAPS, env, now: NOW });

    it('a segment rule with a pass percentage becomes a weighted rule and needs an acknowledgement', () => {
      const r = seg('churn_risk');
      expect(r.desired?.rules[0]).toMatchObject({ weight: 10_000, rolloutContextKind: 'user' });
      expect(r.unresolved.map((d) => d.type)).toEqual(['partial_rollout_rebucket']);
    });

    it('a disabled segment has no rules, so nobody matches', () => {
      const r = seg('legacy_partners');
      expect(r.desired?.rules).toEqual([]);
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/Disabled in StatSig/));
    });

    it('a gate reference inside a segment is inlined when exact, and skips the segment otherwise', () => {
      expect(seg('staff_or_beta').desired?.rules.map((x) => x.description)).toEqual(['Staff', 'Opted in']);
      expect(seg('early_adopters').skipped).toMatch(/can't be inlined/);
      // The referencing gate maps as "full": only the planner sees the skipped dependency.
      expect(mapGate(args('early_adopter_badge')).fidelity.overall).toBe('full');
    });

    it('an empty ID list is an empty LD segment', () => {
      expect(seg('beta_waitlist').desired?.included).toEqual([]);
    });
  });

  describe('autotunes → multi-armed bandits (PLAN §11; edge cases 11.8–11.15)', () => {
    const at = (id: string, resolutions = new Map<string, Resolution>()) =>
      mapAutotune({ canonical: { snapshot: web }, entity: web.autotunes.find((a) => a.id === id)!, profile: profileFor(web, MAPPING), resolutions, capabilities: CAPS, env: { statsig: 'production', ld: 'production' }, now: NOW });
    const decide = (r: { unresolved: { id: string; type: string; fingerprint: string }[] }, type: string, optionKey: string): Map<string, Resolution> => {
      const d = r.unresolved.find((x) => x.type === type)!;
      return new Map([[d.id, { id: d.id, type: d.type as Resolution['type'], optionKey, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW }]]);
    };

    it('11.8: a not-started autotune becomes an off JSON flag, a success metric and a drafted bandit', () => {
      const r = at('hero_image_autotune');
      expect(r.state).toBe('not_started');
      expect(r.skipped).toBeUndefined();
      expect(r.shell.variations.map((v) => v.name)).toEqual(['Lifestyle', 'Product']);
      expect(r.shell.variations[0]!.value).toEqual({ image: 'hero-lifestyle.jpg' });
      expect(r.shell.customProperties['migration.type']!.value).toEqual(['autotune']);
      expect(r.env).toMatchObject({ on: false, offVariation: 0, fallthrough: { rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }] } } });
      expect(r.metric).toMatchObject({ key: 'hero_click', kind: 'custom', eventKey: 'hero_click', isNumeric: false, successCriteria: 'HigherThanBaseline' });
      expect(r.bandit).toMatchObject({ key: 'hero_image_autotune', flagKey: 'hero_image_autotune', ruleId: 'fallthrough', metricKey: 'hero_click', randomizationUnit: 'user' });
      expect(r.bandit!.treatments).toEqual([
        { name: 'Lifestyle', baseline: true, allocationPercent: '50', variation: 0 },
        { name: 'Product', baseline: false, allocationPercent: '50', variation: 1 },
      ]);
      expect(r.dependencies).toEqual([{ kind: 'metric', key: 'hero_click', entityId: 'hero_click' }]);
      expect(types(r)).toEqual(['client_side_availability']);
    });

    it('11.8: a running autotune waits by default (autotune_running), or is pre-staged', () => {
      const waiting = at('promo_banner_autotune');
      expect(waiting.state).toBe('running');
      expect(types(waiting)).toContain('autotune_running');
      expect(waiting.skipped).toMatch(/running in StatSig/);
      const staged = at('promo_banner_autotune', decide(waiting, 'autotune_running', 'prestage'));
      expect(staged.skipped).toBeUndefined();
      expect(staged.fidelity.overall).toBe('partial');
      expect(staged.bandit!.treatments).toHaveLength(3);
    });

    it('11.9: arm sizes that sum to 99 are normalized to thousandths summing to 100 000', () => {
      const r = at('promo_banner_autotune', decide(at('promo_banner_autotune'), 'autotune_running', 'prestage'));
      const weights = r.env.fallthrough.rollout!.variations.map((v) => v.weight);
      expect(weights.reduce((n, w) => n + w, 0)).toBe(100_000);
      expect(weights).toEqual([33_334, 33_333, 33_333]);
      expect(r.bandit!.treatments.map((t) => t.allocationPercent)).toEqual(['33.33', '33.33', '33.33']);
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringMatching(/add up to 99%/));
    });

    it('11.10: a concluded autotune serves the winner at 100% with no bandit', () => {
      const r = at('pricing_page_autotune');
      expect(r.state).toBe('concluded');
      expect(r.env).toMatchObject({ on: true, fallthrough: { variation: 1 } });
      expect(r.bandit).toBeNull();
      expect(r.metric).toBeNull();
      expect(r.fidelity.overall).toBe('full');
    });

    it('11.11: no success event is a blocking missing_metric decision; "flag only" is manual fidelity', () => {
      const r = at('cart_upsell_autotune');
      expect(r.unresolved.map((d) => [d.type, d.severity])).toContainEqual(['missing_metric', 'blocking']);
      expect(r.bandit).toBeNull();
      const flagOnly = at('cart_upsell_autotune', decide(r, 'missing_metric', 'flag_only'));
      expect(flagOnly.fidelity.overall).toBe('manual');
      expect(flagOnly.env.fallthrough.rollout!.variations).toHaveLength(2);
      expect(at('cart_upsell_autotune', decide(r, 'missing_metric', 'skip')).skipped).toMatch(/no success event/);
    });

    it('11.12: variants with identical JSON are merged into one arm (or the item is skipped)', () => {
      const r = at('free_shipping_copy_autotune');
      expect(types(r)).toContain('duplicate_variant_value');
      expect(r.shell.variations.map((v) => v.name)).toEqual(['Short / Short again', 'Long']);
      expect(r.env.fallthrough.rollout!.variations.map((v) => v.weight)).toEqual([66_667, 33_333]);
      expect(r.fidelity.overall).toBe('partial');
      expect(at('free_shipping_copy_autotune', decide(r, 'duplicate_variant_value', 'skip')).skipped).toMatch(/identical values/);
    });

    it('11.13: a companyID autotune randomizes by the company kind and needs a randomization unit', () => {
      const r = at('b2b_pricing_autotune');
      expect(r.bandit!.randomizationUnit).toBe('company');
      expect(r.metric!.analysisUnits).toEqual(['company']);
      expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toEqual(['context_kind:company', 'metric:quote_requested', 'randomization_unit:company']);
      expect(types(r)).toContain('unit_type_kind');
    });

    it('is deterministic and fingerprints the arms, event and state', () => {
      const a = at('hero_image_autotune');
      const b = at('hero_image_autotune');
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const changed = mapAutotune({ canonical: { snapshot: web }, entity: { ...web.autotunes.find((x) => x.id === 'hero_image_autotune')!, isStarted: true }, profile: profileFor(web, MAPPING), resolutions: new Map(), capabilities: CAPS, env: { statsig: 'production', ld: 'production' }, now: NOW });
      expect(changed.statsigFingerprint).not.toBe(a.statsigFingerprint);
    });
  });
});

describe('dynamic configs → JSON flags (PLAN §10.1; edge cases 10.1–10.9)', () => {
  function cargs(configId: string, over: Partial<MapArgs<Config>> = {}): MapArgs<Config> {
    const entity = web.configs.find((c) => c.id === configId)!;
    return { canonical: { snapshot: web }, entity, profile: profileFor(web, MAPPING), resolutions: new Map(), capabilities: CAPS, env: { statsig: 'production', ld: 'production' }, now: NOW, ...over };
  }
  const names = (r: ReturnType<typeof mapConfig>) => r.shell.variations.map((v) => v.name);

  it('variation 0 is the default value; each distinct rule value is appended and named after its rule', () => {
    const r = mapConfig(cargs('shipping_thresholds'));
    expect(names(r)).toEqual(['Default', 'UK', 'Canada']);
    expect(r.shell.variations[0]!.value).toEqual({ free_shipping_min: 50, currency: 'USD' });
    expect(r.shell.defaults).toEqual({ onVariation: 0, offVariation: 0 });
    expect(r.env.offVariation).toBe(0);
    expect(r.env.fallthrough).toEqual({ variation: 0 });
    expect(r.env.rules.map((x) => [x.description, x.variation])).toEqual([
      ['UK', 1],
      ['Canada', 2],
    ]);
    expect(r.shell.customProperties['migration.type']!.value).toEqual(['config']);
    // Fixed variations, no rollout: nothing to acknowledge (the remaining decisions are the condition ones gates raise too).
    expect(types(r)).not.toContain('partial_rollout_rebucket');
    expect(r.unresolved.every((d) => d.severity === 'choice')).toBe(true);
  });

  it('10.1: the variation list covers every environment, so the project-level shell does not depend on which environment migrates first', () => {
    const prod = mapConfig(cargs('search_ranking_weights'));
    const staging = mapConfig(cargs('search_ranking_weights', { env: { statsig: 'staging', ld: 'test' } }));
    expect(names(prod)).toEqual(['Default', 'Staging mix']);
    expect(names(staging)).toEqual(names(prod));
    expect(prod.env.rules).toEqual([]);
    expect(prod.env.fallthrough).toEqual({ variation: 0 });
    expect(prod.fidelity.notes.some((n) => /doesn't apply in production/.test(n.message))).toBe(true);
    // A public rule that matches everyone becomes the fallthrough.
    expect(staging.env.fallthrough).toEqual({ variation: 1 });
  });

  it('10.2: a rule whose value equals the default adds no variation and serves the default', () => {
    const r = mapConfig(cargs('legacy_pricing_rules'));
    expect(names(r)).toEqual(['Default']);
    expect(r.env.rules[0]).toMatchObject({ description: 'Same as default', variation: 0 });
    // 10.6: disabled → off, serving the default.
    expect(r.env.on).toBe(false);
    expect(r.fidelity.notes.some((n) => /Disabled in StatSig/.test(n.message))).toBe(true);
  });

  it('10.3: variants become a rollout across their variations, weighted by their cumulative shares, with a re-bucketing acknowledgement', () => {
    const r = mapConfig(cargs('homepage_hero'));
    expect(names(r)).toEqual(['Default', 'Autumn', 'Minimal', 'Video']);
    expect(r.env.fallthrough.rollout).toEqual({
      contextKind: 'user',
      variations: [
        { variation: 1, weight: 50_000 },
        { variation: 2, weight: 30_000 },
        { variation: 3, weight: 20_000 },
      ],
    });
    expect(types(r)).toEqual(['client_side_availability', 'partial_rollout_rebucket']);
    expect(r.fidelity.overall).toBe('partial');
  });

  it('10.3: variants that do not add up to 100% leave the rest to the rule value, and a partial pass percentage to the default', () => {
    const base = web.configs.find((c) => c.id === 'homepage_hero')!;
    const rule = base.rules[0]!;
    const entity: Config = { ...base, rules: [{ ...rule, passPercentage: 80, returnValue: { headline: 'Rule value' }, variants: [rule.variants![0]!, { ...rule.variants![1]!, passPercentage: 25 }] }] };
    const r = mapConfig(cargs('homepage_hero', { entity }));
    // The rule's own value is named after the rule, the variants after themselves.
    expect(names(r)).toEqual(['Default', 'Everyone (variants)', 'Autumn', 'Minimal']);
    const weights = Object.fromEntries(r.env.fallthrough.rollout!.variations.map((w) => [w.variation, w.weight]));
    expect(weights).toEqual({ 2: 40_000, 3: 20_000, 1: 20_000, 0: 20_000 });
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(r.fidelity.notes.some((n) => /Variants cover 75%/.test(n.message))).toBe(true);
  });

  it('10.4: outside a partial rollout the default is served and evaluation stops; no later rule is reached', () => {
    const r = mapConfig(cargs('api_rate_limits'));
    expect(r.env.fallthrough.rollout).toEqual({
      contextKind: 'user',
      variations: [
        { variation: 1, weight: 50_000 },
        { variation: 0, weight: 50_000 },
      ],
    });
    const perks = mapConfig(cargs('loyalty_checkout_perks'));
    expect(perks.env.rules[0]).toMatchObject({ description: 'Accounts older than 30 days', rollout: { variations: [{ variation: 1, weight: 25_000 }, { variation: 0, weight: 75_000 }] } });
    expect(perks.env.rules[0]!.clauses[0]).toMatchObject({ attribute: 'account_age_days', op: 'greaterThanOrEqual', values: [30], negate: false });
    expect(perks.env.rules[1]).toMatchObject({ description: 'Gold tier', variation: 2 });
    expect(types(perks)).toContain('partial_rollout_rebucket');
  });

  it('the re-bucketing acknowledgement shares its type and path with gates, so one policy covers both', () => {
    const open = mapConfig(cargs('api_rate_limits'));
    const d = open.unresolved.find((x) => x.type === 'partial_rollout_rebucket')!;
    expect(d.id).toMatch(/^partial_rollout_rebucket:src-web\/config\/api_rate_limits:rule:.*:rollout$/);
    const policy = profileFor(web, MAPPING);
    policy.policies.partial_rollout_rebucket = 'skip';
    const r = mapConfig(cargs('api_rate_limits', { profile: policy }));
    expect(r.skipped).toMatch(/50% rollout/);
    expect(r.env.on).toBe(false);
  });

  it('10.5: a JSON schema is a note only; 10.9: custom unit types roll out by their own context kind', () => {
    const r = mapConfig(cargs('checkout_config'));
    expect(r.fidelity.notes.some((n) => /not schema-validated/.test(n.message))).toBe(true);
    expect(names(r)).toEqual(['Default', 'Staff', 'US']);
    const b2b = mapConfig(cargs('b2b_order_limits'));
    expect(b2b.dependencies).toEqual([
      { kind: 'context_kind', key: 'company', entityId: 'companyID' },
      { kind: 'segment', key: 'enterprise_accounts', entityId: 'enterprise_accounts' },
    ]);
    expect(b2b.env.rules[0]!.clauses[0]!.op).toBe('segmentMatch');
  });

  it('a config without rules serves the default everywhere; archived configs are skipped', () => {
    const r = mapConfig(cargs('maintenance_mode'));
    expect(names(r)).toEqual(['Default']);
    expect(r.env).toMatchObject({ on: true, rules: [], fallthrough: { variation: 0 } });
    const archived = mapConfig(cargs('maintenance_mode', { entity: { ...web.configs.find((c) => c.id === 'maintenance_mode')!, archived: true } }));
    expect(archived.skipped).toBe('archived in StatSig');
  });

  it('overrides (spec sources) target the forced value; pass/fail overrides without a value can only serve the default', () => {
    const base = web.configs.find((c) => c.id === 'shipping_thresholds')!;
    const entity: Config = {
      ...base,
      overrides: [
        { unitType: 'userID', ids: ['vip-1', 'vip-2'], value: { kind: 'value', returnValue: { free_shipping_min: 0, currency: 'USD' } }, environment: null },
        { unitType: 'userID', ids: ['vip-1'], value: { kind: 'value', returnValue: { free_shipping_min: 40, currency: 'GBP' } }, environment: 'production' },
        { unitType: 'userID', ids: ['blocked-1'], value: { kind: 'gate', pass: false }, environment: null },
      ],
    };
    const r = mapConfig(cargs('shipping_thresholds', { entity }));
    expect(names(r)).toEqual(['Default', 'UK', 'Canada', 'Override']);
    // The environment-specific override wins for vip-1.
    expect(r.env.targets).toEqual([
      { contextKind: 'user', variation: 0, values: ['blocked-1'] },
      { contextKind: 'user', variation: 1, values: ['vip-1'] },
      { contextKind: 'user', variation: 3, values: ['vip-2'] },
    ]);
    expect(r.fidelity.notes.some((n) => /overridden to two values/.test(n.message))).toBe(true);
  });

  it('holdouts attached to a config are a partial-fidelity note (LD holdouts are not created yet)', () => {
    const base = web.configs.find((c) => c.id === 'shipping_thresholds')!;
    const r = mapConfig(cargs('shipping_thresholds', { entity: { ...base, holdoutIds: ['checkout_holdout'] } }));
    expect(r.fidelity.overall).toBe('partial');
    expect(r.fidelity.notes.some((n) => n.fidelity === 'partial' && /held out by “checkout_holdout”/.test(n.message))).toBe(true);
  });

  it('is deterministic and fingerprints the rules and the default value', () => {
    const a = mapConfig(cargs('checkout_config'));
    const b = mapConfig(cargs('checkout_config'));
    expect(b).toEqual(a);
    const base = web.configs.find((c) => c.id === 'checkout_config')!;
    const changed = mapConfig(cargs('checkout_config', { entity: { ...base, defaultValue: { max_items: 51 } } }));
    expect(changed.statsigFingerprint).not.toBe(a.statsigFingerprint);
  });
});

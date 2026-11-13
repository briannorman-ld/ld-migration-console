import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot, NeutralFlag, NeutralSegment } from '@sslm/canonical';
import { mapNeutralFlag, mapNeutralSegment, type MapArgs, type MapperCapabilities, type Resolution } from '../src/index.ts';
import { CAPS, DIRECTORY, hogSnapshot, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

/** The PostHog project has one environment, named after it, mapped to the target's production. */
const MAPPING = { 'Acme Hog': 'production' };
const ENV = { statsig: 'Acme Hog', ld: 'production' };
let hog: CanonicalSnapshot;
beforeAll(async () => {
  hog = await hogSnapshot();
});

const caps: MapperCapabilities = { ...CAPS, existingContextKinds: ['user'] };
function flagArgs(key: string, over: Partial<MapArgs<NeutralFlag>> = {}): MapArgs<NeutralFlag> {
  const entity = hog.neutral!.flags.find((f) => f.key === key);
  if (!entity) throw new Error(`no flag ${key}`);
  return { canonical: { snapshot: hog }, entity, profile: profileFor(hog, MAPPING), resolutions: new Map(), capabilities: caps, env: ENV, now: NOW, directory: DIRECTORY, ...over };
}
function segArgs(key: string, over: Partial<MapArgs<NeutralSegment>> = {}): MapArgs<NeutralSegment> {
  const entity = hog.neutral!.segments.find((s) => s.key === key);
  if (!entity) throw new Error(`no segment ${key}`);
  return { canonical: { snapshot: hog }, entity, profile: profileFor(hog, MAPPING), resolutions: new Map(), capabilities: caps, env: ENV, now: NOW, ...over };
}
const types = (r: { unresolved: { type: string }[] }) => r.unresolved.map((d) => d.type).sort();
const resolve = (r: { unresolved: { id: string; type: string; fingerprint: string }[] }, picks: Record<string, string>): Map<string, Resolution> =>
  new Map(r.unresolved.filter((d) => picks[d.type]).map((d) => [d.id, { id: d.id, type: d.type as Resolution['type'], optionKey: picks[d.type]!, scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt: NOW }]));

describe('PostHog → LaunchDarkly (PLAN §22.3)', () => {
  it('an "everyone" set becomes the default rule; the shell carries PostHog provenance and the creator as maintainer', () => {
    const r = mapNeutralFlag(flagArgs('hog-kill-switch'));
    expect(r.skipped).toBeUndefined();
    expect(types(r)).toEqual([]);
    expect(r.shell.tags).toEqual(['migrated-from-posthog', 'migration-src-hog', 'ops']);
    expect(r.shell.customProperties['migration.kind']).toEqual({ name: 'Migrated from', value: ['posthog'] });
    expect(r.shell.customProperties['migration.id']).toEqual({ name: 'PostHog ID', value: ['hog-kill-switch'] });
    expect(r.shell.name).toBe('hog-kill-switch');
    expect(r.shell.description).toBe('Turns the storefront off entirely.');
    expect(r.shell.maintainerId).toBe('mem-alice');
    expect(r.env).toEqual({ ldEnv: 'production', statsigEnv: 'Acme Hog', on: true, offVariation: 1, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] });
    expect(r.fidelity.overall).toBe('full');
  });

  it('a last-set rollout is lossless; icontains and a cohort reference raise their decisions', () => {
    const r = mapNeutralFlag(flagArgs('hog-checkout-redesign'));
    expect(types(r)).toEqual(['case_insensitive_match', 'partial_rollout_rebucket']);
    // Set 3 (25% of everyone, last) → the default rule serves 25% true / 75% false. No rollout_coverage asked.
    expect(r.env.fallthrough).toEqual({ rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 25_000 }, { variation: 1, weight: 75_000 }] } });
    expect(r.env.rules.map((x) => x.clauses[0]!.op)).toEqual(['matches', 'segmentMatch']);
    expect(r.env.rules[0]!.clauses[0]!.values).toEqual(['@[aA][cC][mM][eE]\\.[eE][xX][aA][mM][pP][lL][eE]']);
    expect(r.dependencies).toEqual([{ kind: 'segment', key: 'design-partners', entityId: 'design-partners' }]);
    expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('without a per-flag salt'));
  });

  it('a rollout that is not last asks rollout_coverage; a relative date asks to be frozen', () => {
    const r = mapNeutralFlag(flagArgs('hog-new-onboarding'));
    expect(types(r)).toEqual(['partial_rollout_rebucket', 'relative_date', 'rollout_coverage']);
    const date = r.unresolved.find((d) => d.type === 'relative_date')!;
    expect(date.options[0]!.label).toContain('2026-09-22');
    // Preview: frozen to now-30d, uncovered contexts get the default (false).
    expect(r.env.rules[0]!.clauses[0]).toEqual({ contextKind: 'user', attribute: 'signup_date', op: 'after', values: ['2026-09-22T12:00:00.000Z'], negate: false });
    expect(r.env.rules[0]!.rollout).toEqual({ contextKind: 'user', variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }] });
    expect(r.env.rules[1]!.clauses[0]).toEqual({ contextKind: 'user', attribute: 'beta_tester', op: 'in', values: [true], negate: false });
    const dropped = mapNeutralFlag(flagArgs('hog-new-onboarding', { resolutions: resolve(r, { rollout_coverage: 'drop_rule', relative_date: 'freeze', partial_rollout_rebucket: 'acknowledge' }) }));
    expect(dropped.unresolved).toEqual([]);
    expect(dropped.env.rules).toHaveLength(1);
  });

  it('early exit is a lossless two-way rollout', () => {
    const r = mapNeutralFlag(flagArgs('hog-staff-tools'));
    expect(types(r)).toEqual(['case_insensitive_match', 'case_insensitive_match', 'partial_rollout_rebucket', 'scheduled_rule']);
    expect(r.env.rules[0]!.rollout).toEqual({ contextKind: 'user', variations: [{ variation: 0, weight: 40_000 }, { variation: 1, weight: 60_000 }] });
    expect(r.env.rules[1]!.clauses[0]!.op).toBe('matches');
  });

  it('multivariate: payloads block until chosen, the "no match" variation is added by default, and the variant split is a rollout', () => {
    const r = mapNeutralFlag(flagArgs('hog-pricing-page'));
    expect(types(r)).toEqual(['case_insensitive_match', 'multivariate_no_match', 'partial_rollout_rebucket', 'variant_payloads']);
    expect(r.unresolved.find((d) => d.type === 'variant_payloads')!.severity).toBe('blocking');
    // Preview with keys: string variations plus "Not served".
    expect(r.shell.variations).toEqual([
      { value: 'control', name: 'Control' },
      { value: 'plus', name: 'Plus' },
      { value: 'enterprise', name: 'Enterprise' },
      { value: '', name: 'Not served' },
    ]);
    expect(r.env.offVariation).toBe(3);
    expect(r.env.rules[0]!.variation).toBe(2);
    expect(r.env.fallthrough.rollout!.variations).toEqual([{ variation: 0, weight: 50_000 }, { variation: 1, weight: 25_000 }, { variation: 2, weight: 25_000 }]);

    const payloads = mapNeutralFlag(flagArgs('hog-pricing-page', { resolutions: resolve(r, { variant_payloads: 'payloads', multivariate_no_match: 'variant:0', case_insensitive_match: 'exact', partial_rollout_rebucket: 'acknowledge' }) }));
    expect(payloads.unresolved).toEqual([]);
    expect(payloads.shell.variations).toEqual([
      { value: { layout: 'classic' }, name: 'Control' },
      { value: { layout: 'plus' }, name: 'Plus' },
      { value: { layout: 'enterprise', salesCta: true }, name: 'Enterprise' },
    ]);
    // "No match" now serves control: the off variation and the default rule's remainder point at it.
    expect(payloads.env.offVariation).toBe(0);
    expect(payloads.env.fallthrough.rollout!.variations).toEqual([{ variation: 0, weight: 50_000 }, { variation: 1, weight: 25_000 }, { variation: 2, weight: 25_000 }]);
    const both = mapNeutralFlag(flagArgs('hog-pricing-page', { resolutions: resolve(r, { variant_payloads: 'both' }) }));
    expect(both.shell.variations[0]).toEqual({ value: { variant: 'control', payload: { layout: 'classic' } }, name: 'Control' });
  });

  it('negated and semver clauses: is_not asks about missing attributes and case; semver_gte is a negated semVerLessThan', () => {
    const r = mapNeutralFlag(flagArgs('hog-ios-min-version'));
    expect(types(r)).toEqual(['case_insensitive_match', 'negated_missing_attribute']);
    expect(r.env.rules[0]!.clauses[0]).toEqual({ contextKind: 'user', attribute: 'app_version', op: 'semVerLessThan', values: ['4.2.0'], negate: true });
    expect(r.env.rules[0]!.clauses[1]).toMatchObject({ op: 'matches', negate: true });
  });

  it('group targeting: the company kind is missing in the target and raises unit_type_kind; mixed targeting keeps the rule kind', () => {
    const r = mapNeutralFlag(flagArgs('hog-company-tier'));
    expect(types(r)).toEqual(['case_insensitive_match', 'partial_rollout_rebucket', 'unit_type_kind']);
    expect(r.env.rules[0]!.clauses[0]!.contextKind).toBe('company');
    expect(r.env.fallthrough.rollout).toEqual({ contextKind: 'company', variations: [{ variation: 0, weight: 10_000 }, { variation: 1, weight: 90_000 }] });
    expect(r.dependencies).toEqual([{ kind: 'context_kind', key: 'company', entityId: 'company' }]);
    const mixed = mapNeutralFlag(flagArgs('hog-cross-group'));
    expect(mixed.env.rules.map((x) => x.clauses[0]!.contextKind)).toEqual(['company', 'user']);
  });

  it('a flag dependency on every rule is hoisted losslessly to a prerequisite', () => {
    const r = mapNeutralFlag(flagArgs('hog-depends-on-checkout'));
    expect(types(r)).toEqual([]);
    expect(r.env.prerequisites).toEqual([{ key: 'hog-checkout-redesign', variation: 0 }]);
    expect(r.dependencies).toEqual([{ kind: 'flag', key: 'hog-checkout-redesign', entityId: 'hog-checkout-redesign' }]);
    expect(r.fidelity.overall).toBe('full');
  });

  it('remote config is a JSON flag with no rules; the synthetic variation asks multivariate_no_match', () => {
    const r = mapNeutralFlag(flagArgs('hog-remote-config'));
    expect(types(r)).toEqual(['multivariate_no_match']);
    expect(r.shell.variations).toEqual([
      { value: { maxItems: 20, theme: 'dark' }, name: 'Remote config' },
      { value: null, name: 'Not served' },
    ]);
    expect(r.env.fallthrough).toEqual({ variation: 0 });
    expect(r.env.rules).toEqual([]);
  });

  it('early access, holdout + experiment, device bucketing + continuity, scheduled change and encrypted payload each raise their decision', () => {
    const early = mapNeutralFlag(flagArgs('hog-early-access'));
    expect(types(early)).toEqual(['early_access_enrollment']);
    expect(early.env.rules.map((x) => [x.clauses[0]!.attribute, x.variation])).toEqual([
      ['$feature_enrollment/hog-early-access', 0],
      ['$feature_enrollment/hog-early-access', 1],
    ]);
    // The 0% "everyone" set at the end serves nobody: default rule off.
    expect(early.env.fallthrough).toEqual({ variation: 1 });

    const holdout = mapNeutralFlag(flagArgs('hog-holdout-experiment'));
    expect(types(holdout)).toEqual(['experiment_rule', 'holdout_attached', 'multivariate_no_match', 'partial_rollout_rebucket']);
    expect(holdout.env.fallthrough.rollout!.variations).toEqual([{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }]);
    const control = mapNeutralFlag(flagArgs('hog-holdout-experiment', { resolutions: resolve(holdout, { experiment_rule: 'control' }) }));
    expect(control.env.fallthrough).toEqual({ variation: 0 });
    const wait = mapNeutralFlag(flagArgs('hog-holdout-experiment', { resolutions: resolve(holdout, { holdout_attached: 'skip' }) }));
    expect(wait.skipped).toContain('holdout');

    const device = mapNeutralFlag(flagArgs('hog-device-rollout'));
    expect(types(device)).toEqual(['device_bucketing', 'experience_continuity', 'partial_rollout_rebucket', 'unit_type_kind']);
    expect(device.env.fallthrough.rollout!.contextKind).toBe('device');
    const attr = mapNeutralFlag(flagArgs('hog-device-rollout', { resolutions: resolve(device, { device_bucketing: 'user_attribute' }) }));
    expect(attr.env.fallthrough.rollout).toMatchObject({ contextKind: 'user', bucketBy: '$device_id' });

    const scheduled = mapNeutralFlag(flagArgs('hog-scheduled-launch'));
    expect(types(scheduled)).toEqual(['scheduled_rule']);
    expect(scheduled.env.on).toBe(false);

    const encrypted = mapNeutralFlag(flagArgs('hog-encrypted-config'));
    expect(types(encrypted)).toEqual(['encrypted_payload', 'multivariate_no_match']);
    expect(encrypted.unresolved.find((d) => d.type === 'encrypted_payload')!.severity).toBe('acknowledge');
  });

  it('skips archived flags, inactive flags migrate off, survey backing flags are skipped with a reason', () => {
    expect(mapNeutralFlag(flagArgs('hog-archived-promo')).skipped).toBe('archived in PostHog');
    expect(mapNeutralFlag(flagArgs('hog-disabled-legacy')).env.on).toBe(false);
    expect(mapNeutralFlag(flagArgs('survey-targeting-checkout-nps')).skipped).toContain('survey');
  });

  it('operators: between is two clauses, not_between two rules, regex with lookahead asks regex_dialect, is_set asks null_check', () => {
    const eu = mapNeutralFlag(flagArgs('hog-eu-rollout'));
    expect(types(eu)).toEqual(['regex_dialect']);
    expect(eu.env.rules[0]!.clauses.map((c) => c.op)).toEqual(['segmentMatch', 'greaterThanOrEqual', 'lessThanOrEqual', 'matches']);
    const nb = mapNeutralFlag(flagArgs('hog-not-between'));
    expect(nb.env.rules.map((x) => [x.clauses[0]!.op, x.clauses[0]!.values[0]])).toEqual([
      ['lessThan', 5],
      ['greaterThan', 50],
    ]);
    const power = mapNeutralFlag(flagArgs('hog-power-users'));
    expect(types(power)).toEqual(['null_check']);
    expect(power.env.rules[0]!.clauses[1]).toEqual({ contextKind: 'user', attribute: 'email', op: 'matches', values: ['.*'], negate: false });
    expect(power.dependencies.map((d) => d.key).sort()).toEqual(['enterprise-admins', 'power-users']);
  });

  it('cohorts: a static list includes every distinct id; a behavioral cohort is frozen; a nested cohort is unsupported in a segment rule', () => {
    const partners = mapNeutralSegment(segArgs('design-partners'));
    expect(types(partners)).toEqual(['cohort_person_ids']);
    expect(partners.desired!.included).toEqual(['u-1', 'u-2', 'u-2-legacy', 'u-3']);
    expect(partners.desired!.tags).toEqual(['migrated-from-posthog', 'migration-src-hog']);
    const power = mapNeutralSegment(segArgs('power-users'));
    expect(types(power)).toEqual(['cohort_snapshot']);
    expect(power.desired!.included).toEqual(['u-4', 'u-5']);
    expect(mapNeutralSegment(segArgs('power-users', { resolutions: resolve(power, { cohort_snapshot: 'skip' }) })).skipped).toContain('behavioral');
    const euUk = mapNeutralSegment(segArgs('eu-or-uk'));
    expect(types(euUk)).toEqual(['case_insensitive_match', 'case_insensitive_match']);
    expect(euUk.desired!.rules).toHaveLength(2);
    const nested = mapNeutralSegment(segArgs('enterprise-admins-in-eu'));
    // The nested-cohort clause drops the rule (preview), so the clause after it is never asked about.
    expect(types(nested)).toEqual(['unsupported_condition']);
    expect(nested.unresolved.find((d) => d.type === 'unsupported_condition')!.title).toBe('Segment rule references another segment');
  });
});

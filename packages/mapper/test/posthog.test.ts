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
  const entity = over.entity ?? hog.neutral!.segments.find((s) => s.key === key);
  if (!entity) throw new Error(`no segment ${key}`);
  return { canonical: { snapshot: hog }, entity, profile: profileFor(hog, MAPPING), resolutions: new Map(), capabilities: caps, env: ENV, now: NOW, ...over };
}
/** A copy of a fixture flag with its caveats replaced (synthetic scheduled-change shapes the demo has no example of). */
function withCaveats(key: string, caveats: NeutralFlag['caveats']): NeutralFlag {
  const entity = hog.neutral!.flags.find((f) => f.key === key);
  if (!entity) throw new Error(`no flag ${key}`);
  return { ...entity, caveats };
}
const ids = (k: number) => Array.from({ length: k }, (_, i) => `u-${i + 1}`);
function listSegment(key: string, values: string[]): NeutralSegment {
  return { kind: 'segment', uid: `src-hog/segment/${key}`, key, name: key, description: '', tags: [], archived: false, environments: [{ env: ENV.statsig, rules: [], included: [{ contextKind: 'user', values }], excluded: [] }] };
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
    // The third case_insensitive_match belongs to the condition set a scheduled change adds (see "scheduled changes" below).
    expect(types(r)).toEqual(['case_insensitive_match', 'case_insensitive_match', 'case_insensitive_match', 'partial_rollout_rebucket', 'scheduled_rule']);
    expect(r.env.rules).toHaveLength(2);
    expect(r.env.rules[0]!.rollout).toEqual({ contextKind: 'user', variations: [{ variation: 0, weight: 40_000 }, { variation: 1, weight: 60_000 }] });
    expect(r.env.rules[1]!.clauses[0]!.op).toBe('matches');
  });

  it('multivariate: payloads block until chosen, the "no match" variation is added by default, and the variant split is a rollout', () => {
    const r = mapNeutralFlag(flagArgs('hog-pricing-page'));
    // scheduled_rule: a pending update_variants change, which is noted, not scheduled (see "scheduled changes" below).
    expect(types(r)).toEqual(['case_insensitive_match', 'multivariate_no_match', 'partial_rollout_rebucket', 'scheduled_rule', 'variant_payloads']);
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

    const payloads = mapNeutralFlag(flagArgs('hog-pricing-page', { resolutions: resolve(r, { variant_payloads: 'payloads', multivariate_no_match: 'variant:0', case_insensitive_match: 'exact', partial_rollout_rebucket: 'acknowledge', scheduled_rule: 'acknowledge' }) }));
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
    // The flag mirrors PostHog now (off); the pending flip is a scheduled change (below).
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

  describe('scheduled changes (19.24)', () => {
    it('a pending status flip becomes one LaunchDarkly scheduled change carrying the whole targeting; acknowledging keeps the old behaviour', () => {
      const r = mapNeutralFlag(flagArgs('hog-scheduled-launch'));
      const d = r.unresolved.find((x) => x.type === 'scheduled_rule')!;
      expect(d.severity).toBe('choice');
      expect(d.recommended).toBe('schedule');
      expect(d.options.map((o) => o.key)).toEqual(['schedule', 'acknowledge', 'skip']);
      expect(d.options[0]!.explanation).toContain('checked on the first write');
      // Preview = recommended: the flag is off now, on at the scheduled instant, same default rule.
      expect(r.env.on).toBe(false);
      expect(r.env.scheduledChanges).toEqual([
        {
          executionDate: '2027-01-04T09:00:00Z',
          description: 'PostHog scheduled change: turn on at 2027-01-04T09:00:00Z',
          state: { on: true, offVariation: 1, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] },
        },
      ]);
      expect(r.fidelity.overall).toBe('full');
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('1 LaunchDarkly scheduled change (2027-01-04T09:00:00Z)'));

      const ack = mapNeutralFlag(flagArgs('hog-scheduled-launch', { resolutions: resolve(r, { scheduled_rule: 'acknowledge' }) }));
      expect(ack.unresolved).toEqual([]);
      expect(ack.env.scheduledChanges).toBeUndefined();
      expect(ack.env.on).toBe(false);
      expect(ack.fidelity.overall).toBe('partial');
      expect(ack.fidelity.notes.map((n) => n.message)).toContainEqual('Pending scheduled change not carried: update_status at 2027-01-04T09:00:00Z.');
    });

    it('an added condition set is translated like the flag’s own sets (its clause raises its decision); the recurring change is noted, not scheduled', () => {
      const r = mapNeutralFlag(flagArgs('hog-staff-tools'));
      const sc = r.env.scheduledChanges!;
      expect(sc).toHaveLength(1);
      expect(sc[0]!.executionDate).toBe('2027-02-01T09:00:00Z');
      expect(sc[0]!.description).toBe('PostHog scheduled change: add 1 rule at 2027-02-01T09:00:00Z');
      // Cumulative: the flag's two sets (early-exit rollout, UK) then the scheduled one, serving true to everyone it matches.
      expect(sc[0]!.state.on).toBe(true);
      expect(sc[0]!.state.rules).toHaveLength(3);
      expect(sc[0]!.state.rules.slice(0, 2)).toEqual(r.env.rules);
      const added = sc[0]!.state.rules[2]!;
      expect(added.description).toBe('Scheduled condition set 1 (2027-02-01T09:00:00Z)');
      expect(added.variation).toBe(0);
      // ends_with is case-insensitive in PostHog: the recommended case-folded regex, from a decision raised for the scheduled rule itself.
      expect(added.clauses).toEqual([{ contextKind: 'user', attribute: 'email', op: 'matches', values: [expect.stringMatching(/^@\[aA\]\[cC\]\[mM\]\[eE\]\[rR\].*\$$/)], negate: false }]);
      const own = r.unresolved.filter((d) => d.type === 'case_insensitive_match' && d.subject.ruleId === 'scheduled-9003-set-0');
      expect(own).toHaveLength(1);
      // The cron'd status change stays in PostHog.
      expect(r.fidelity.overall).toBe('partial');
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual('Pending scheduled change not carried: update_status at 2027-01-05T17:00:00Z (recurring): recurring schedules are not LaunchDarkly scheduled changes.');
      // Answering the scheduled rule's own decision changes only the scheduled state.
      const exact = mapNeutralFlag(flagArgs('hog-staff-tools', { resolutions: resolve(r, { case_insensitive_match: 'exact' }) }));
      expect(exact.env.scheduledChanges![0]!.state.rules[2]!.clauses[0]).toEqual({ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@acmeretail.example'], negate: false });
      expect(exact.fidelity.notes.map((n) => n.location)).toContain('rule “Scheduled condition set 1 (2027-02-01T09:00:00Z)” › clause 1 (scheduled 2027-02-01T09:00:00Z)');
    });

    it('several changes are sorted by time and cumulative; past, recurring and variant changes are noted', () => {
      const rule = { id: 'later', description: 'Scheduled UK set', clauses: [{ contextKind: 'user', attribute: 'country', op: 'in', values: ['GB'], negate: false }], variation: 0 };
      // hog-ios-min-version is on, with one real rule; the flip turns it off, the later change adds a rule while it stays off.
      const entity = withCaveats('hog-ios-min-version', [
        {
          kind: 'scheduled_changes',
          detail: {
            changes: [
              { at: '2027-03-01T00:00:00Z', operation: 'add_release_condition', recurring: false, rules: [rule] },
              { at: '2027-01-04T09:00:00Z', operation: 'update_status', recurring: false, on: false },
              { at: '2026-01-01T00:00:00Z', operation: 'update_status', recurring: false, on: true },
              { at: '2027-06-01T00:00:00Z', operation: 'update_status', recurring: true, on: false },
              { at: '2027-07-01T00:00:00Z', operation: 'update_variants', recurring: false, variants: [{ key: 'a', weight: 100_000 }] },
            ],
          },
        },
      ]);
      const r = mapNeutralFlag(flagArgs('hog-ios-min-version', { entity }));
      expect(r.env.on).toBe(true);
      const sc = r.env.scheduledChanges!;
      expect(sc.map((c) => c.executionDate)).toEqual(['2027-01-04T09:00:00Z', '2027-03-01T00:00:00Z']);
      expect(sc[0]!.state.on).toBe(false);
      expect(sc[0]!.state.rules).toEqual(r.env.rules);
      // The later change keeps the earlier flip and appends its rule after the flag's own.
      expect(sc[1]!.state.on).toBe(false);
      expect(sc[1]!.state.rules).toEqual([...r.env.rules, { description: 'Scheduled UK set', clauses: [{ contextKind: 'user', attribute: 'country', op: 'in', values: ['GB'], negate: false }], variation: 0 }]);
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(
        'Pending 3 scheduled changes not carried: update_status at 2026-01-01T00:00:00Z: it is already due; update_status at 2027-06-01T00:00:00Z (recurring): recurring schedules are not LaunchDarkly scheduled changes; update_variants at 2027-07-01T00:00:00Z: variant changes are not carried.',
      );
      expect(r.fidelity.overall).toBe('partial');
      const d = r.unresolved.find((x) => x.type === 'scheduled_rule')!;
      expect(d.options[0]!.explanation).toContain('2 changes (update_status at 2027-01-04T09:00:00Z; add_release_condition at 2027-03-01T00:00:00Z)');
    });

    it('without scheduled changes in the target the option is gone and the decision is an acknowledgement', () => {
      for (const state of ['unavailable', 'not_permitted'] as const) {
        const r = mapNeutralFlag(flagArgs('hog-scheduled-launch', { capabilities: { ...caps, scheduledChanges: state } }));
        const d = r.unresolved.find((x) => x.type === 'scheduled_rule')!;
        expect(d.severity).toBe('acknowledge');
        expect(d.recommended).toBe('acknowledge');
        expect(d.options.map((o) => o.key)).toEqual(['acknowledge', 'skip']);
        expect(d.explanation).toContain(state === 'unavailable' ? 'the target plan has no scheduled changes' : 'the target token may not create scheduled changes');
        expect(r.env.scheduledChanges).toBeUndefined();
        expect(r.fidelity.overall).toBe('partial');
      }
      // Only a variant change pending: nothing to schedule, so no option either.
      const pricing = mapNeutralFlag(flagArgs('hog-pricing-page'));
      const d = pricing.unresolved.find((x) => x.type === 'scheduled_rule')!;
      expect(d.options.map((o) => o.key)).toEqual(['acknowledge', 'skip']);
      expect(pricing.env.scheduledChanges).toBeUndefined();
      expect(pricing.fidelity.notes.map((n) => n.message)).toContainEqual('Pending scheduled change not carried: update_variants at 2027-03-01T09:00:00Z.');
    });
  });

  describe('big list segments (19.16)', () => {
    it('15,001 included keys raise big_segment: import fills the unbounded segment’s ids, skip drops the segment', () => {
      const r = mapNeutralSegment(segArgs('huge', { entity: listSegment('huge', ids(15_001)) }));
      expect(types(r)).toEqual(['big_segment']);
      const d = r.unresolved[0]!;
      expect(d.severity).toBe('choice');
      expect(d.recommended).toBe('import');
      expect(d.title).toBe('15,001 user keys in “huge” need a big segment');
      expect(d.options.map((o) => o.key)).toEqual(['import', 'skip']);
      // Preview = import: the executor's CSV import fills the membership; nothing in `included`.
      expect(r.desired!.unbounded!.contextKind).toBe('user');
      expect(r.desired!.unbounded!.ids).toHaveLength(15_001);
      expect(r.desired!.unbounded!.ids[15_000]).toBe('u-15001');
      expect(r.desired!.included).toEqual([]);
      expect(r.desired!.rules).toEqual([]);
      expect(r.fidelity.overall).toBe('full');
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual('15,001 user keys, more than a list segment holds (15,000): imported into a big segment (Enterprise; checked on the first write).');

      const imported = mapNeutralSegment(segArgs('huge', { entity: listSegment('huge', ids(15_001)), resolutions: resolve(r, { big_segment: 'import' }) }));
      expect(imported.unresolved).toEqual([]);
      expect(imported.desired!.unbounded!.ids).toHaveLength(15_001);
      const skipped = mapNeutralSegment(segArgs('huge', { entity: listSegment('huge', ids(15_001)), resolutions: resolve(r, { big_segment: 'skip' }) }));
      expect(skipped.desired).toBeNull();
      expect(skipped.skipped).toBe("15,001 included user keys exceed LaunchDarkly's 15,000-key limit for list segments");
    });

    it('is blocking without big segments in the target, and exactly 15,000 keys stay a plain list segment', () => {
      const r = mapNeutralSegment(segArgs('huge', { entity: listSegment('huge', ids(15_001)), capabilities: { ...caps, bigSegments: 'unavailable' } }));
      expect(types(r)).toEqual(['big_segment']);
      expect(r.unresolved[0]!.severity).toBe('blocking');
      expect(r.unresolved[0]!.options.map((o) => o.key)).toEqual(['skip']);
      expect(r.unresolved[0]!.explanation).toContain('Your LaunchDarkly plan does not include big segments.');
      expect(r.desired).toBeNull();

      const exact = mapNeutralSegment(segArgs('max', { entity: listSegment('max', ids(15_000)) }));
      expect(exact.unresolved).toEqual([]);
      expect(exact.desired!.unbounded).toBeUndefined();
      expect(exact.desired!.included).toHaveLength(15_000);
      expect(exact.fidelity.overall).toBe('full');
    });
  });

  describe('early access feature definitions (19.19)', () => {
    it('the feature’s name and stage travel as a custom property, and the decision names the feature', () => {
      const r = mapNeutralFlag(flagArgs('hog-early-access'));
      expect(r.shell.customProperties['posthog.earlyAccess']).toEqual({ name: 'PostHog early access feature', value: ['Hog early access', 'beta'] });
      // Not asked about as a copied custom property: it is the console's own.
      expect(types(r)).toEqual(['early_access_enrollment']);
      const d = r.unresolved[0]!;
      expect(d.title).toBe('Early-access feature “Hog early access”: opt-in through “$feature_enrollment/hog-early-access”');
      expect(d.explanation).toContain('early-access feature “Hog early access” (beta)');
      expect(d.explanation).toContain('“Try the new storefront before everyone else.”; docs: https://acmeretail.example/docs/early-access');
      expect(d.explanation).toContain('custom property “posthog.earlyAccess”');
      expect(r.fidelity.notes.map((n) => n.message)).toContainEqual('Early-access enrollment in “Hog early access” relies on the application sending “$feature_enrollment/hog-early-access”.');

      // Without a definition (a payload upload with no `features` list) the property is not written and the wording is generic.
      const bare = mapNeutralFlag(flagArgs('hog-early-access', { entity: withCaveats('hog-early-access', [{ kind: 'early_access_enrollment', detail: { attribute: '$feature_enrollment/hog-early-access' } }]) }));
      expect(bare.shell.customProperties['posthog.earlyAccess']).toBeUndefined();
      expect(bare.unresolved[0]!.title).toBe('Early-access opt-in through “$feature_enrollment/hog-early-access”');
    });
  });
});

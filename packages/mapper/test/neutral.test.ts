import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot, NeutralExperiment, NeutralFlag, NeutralMetric, NeutralSegment } from '@sslm/canonical';
import { mapNeutralExperiment, mapNeutralFlag, mapNeutralHoldout, mapNeutralLayer, mapNeutralMetric, mapNeutralMetricGroup, mapNeutralSegment, type MapArgs, type MapperCapabilities, type Resolution } from '../src/index.ts';
import { CAPS, DIRECTORY, legacySnapshot, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

const MAPPING = { test: 'test', production: 'production' };
let legacy: CanonicalSnapshot;
beforeAll(async () => {
  legacy = await legacySnapshot();
});

const caps: MapperCapabilities = { ...CAPS, existingContextKinds: ['user', 'organization'] };
function flagArgs(key: string, over: Partial<MapArgs<NeutralFlag>> = {}): MapArgs<NeutralFlag> {
  const entity = legacy.neutral!.flags.find((f) => f.key === key)!;
  return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: 'production', ld: 'production' }, now: NOW, directory: DIRECTORY, ...over };
}
function segArgs(key: string, over: Partial<MapArgs<NeutralSegment>> = {}): MapArgs<NeutralSegment> {
  const entity = legacy.neutral!.segments.find((s) => s.key === key)!;
  return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: 'production', ld: 'production' }, now: NOW, ...over };
}
const types = (r: { unresolved: { type: string }[] }) => r.unresolved.map((d) => d.type).sort();
const notes = (r: { fidelity: { notes: { message: string }[] } }) => r.fidelity.notes.map((n) => n.message);
/** A target that can take nothing optional and knows nobody: the LD path must still ask nothing. */
const BARE: MapperCapabilities = { prerequisites: 'unavailable', contextKinds: 'not_permitted', bigSegments: 'unavailable', scheduledChanges: 'unavailable', experimentation: 'unavailable', metrics: 'unavailable', metricGroups: 'unavailable', holdouts: 'unavailable', layers: 'unavailable', existingContextKinds: ['user'] };

describe('LaunchDarkly project → LaunchDarkly project (PLAN §20.3)', () => {
  it('raises no decision for any item of the source, whatever the target can take (LD → LD is one to one)', () => {
    const n = legacy.neutral!;
    for (const capabilities of [caps, BARE]) {
      for (const directory of [DIRECTORY, { ...DIRECTORY, members: [], teams: [] }]) {
        for (const env of ['test', 'production']) {
          const base = { canonical: { snapshot: legacy }, profile: profileFor(legacy, MAPPING), resolutions: new Map<string, Resolution>(), capabilities, env: { statsig: env, ld: env }, now: NOW, directory };
          const results = [
            ...n.flags.map((f) => mapNeutralFlag({ ...base, entity: f })),
            ...n.segments.map((x) => mapNeutralSegment({ ...base, entity: x })),
            ...(n.metrics ?? []).map((m) => mapNeutralMetric({ ...base, entity: m })),
            ...(n.metricGroups ?? []).map((g) => mapNeutralMetricGroup({ ...base, entity: g })),
            ...(n.experiments ?? []).map((x) => mapNeutralExperiment({ ...base, entity: x })),
            ...(n.holdouts ?? []).map((h) => mapNeutralHoldout({ ...base, entity: h })),
            ...(n.layers ?? []).map((l) => mapNeutralLayer({ ...base, entity: l })),
          ];
          expect(results.length).toBeGreaterThan(20);
          for (const r of results) expect(r.unresolved, `${r.uid} in ${env}`).toEqual([]);
        }
      }
    }
  });

  it('copies an exact flag verbatim with LaunchDarkly provenance and notes what cannot follow', () => {
    const r = mapNeutralFlag(flagArgs('legacy-kill-switch'));
    expect(r.skipped).toBeUndefined();
    expect(types(r)).toEqual([]);
    expect(r.shell.tags).toEqual(['migrated-from-launchdarkly', 'migration-src-legacy', 'ops']);
    expect(r.shell.customProperties['migration.kind']).toEqual({ name: 'Migrated from', value: ['launchdarkly'] });
    expect(r.shell.customProperties['migration.id']).toEqual({ name: 'LaunchDarkly ID', value: ['legacy-kill-switch'] });
    expect(r.shell.customProperties['migration.type']?.value).toEqual(['flag']);
    expect(r.shell.temporary).toBe(false);
    expect(r.shell.variations).toEqual([
      { value: true, name: 'On' },
      { value: false, name: 'Off' },
    ]);
    expect(r.env).toEqual({ ldEnv: 'production', statsigEnv: 'production', on: true, offVariation: 1, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] });
    expect(r.fidelity.overall).toBe('full');
    // The source maintainer (ops@acme-legacy.example) is an LD member of the target account: matched by email.
    expect(r.shell.maintainerId).toBe('mem-legacy-ops');
    expect(r.fidelity.notes).toEqual([]);
  });

  it('notes, instead of asking, when the source maintainer is not a member of the target account', () => {
    const r = mapNeutralFlag(flagArgs('legacy-kill-switch', { directory: { ...DIRECTORY, members: [] } }));
    expect(types(r)).toEqual([]);
    expect(r.shell.maintainerId).toBeUndefined();
    expect(notes(r)).toContainEqual(expect.stringContaining('ops@acme-legacy.example is not a member of the target account'));
    expect(r.fidelity.overall).toBe('partial');
  });

  it('keeps clauses, negation and semVer operators as they are', () => {
    const r = mapNeutralFlag(flagArgs('legacy-ios-min-version', { env: { statsig: 'test', ld: 'test' } }));
    // `device` is missing in the target: created with the same key, no question asked.
    expect(types(r)).toEqual([]);
    expect(r.fidelity.overall).toBe('full');
    expect(r.env.rules[0]!.clauses).toEqual([
      { contextKind: 'device', attribute: 'appVersion', op: 'semVerGreaterThan', values: ['4.2.0'], negate: false },
      { contextKind: 'device', attribute: 'os', op: 'in', values: ['ipados'], negate: true },
    ]);
    expect(r.dependencies).toEqual([{ kind: 'context_kind', key: 'device', entityId: 'device' }]);
    expect(r.shell.clientSideAvailability).toEqual({ usingEnvironmentId: false, usingMobileKey: true });
    // A token that cannot create kinds still gets the dependency, and a manual note instead of a decision.
    const cannot = mapNeutralFlag(flagArgs('legacy-ios-min-version', { env: { statsig: 'test', ld: 'test' }, capabilities: { ...caps, contextKinds: 'not_permitted' } }));
    expect(types(cannot)).toEqual([]);
    expect(cannot.fidelity.overall).toBe('manual');
    expect(notes(cannot)).toContainEqual(expect.stringContaining('cannot create it'));
  });

  it('a rollout is noted as re-bucketing; segment references become dependencies; own custom properties are copied', () => {
    const r = mapNeutralFlag(flagArgs('legacy-checkout-redesign'));
    expect(types(r)).toEqual([]);
    expect(r.env.fallthrough).toEqual({ rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 30_000 }, { variation: 1, weight: 70_000 }] } });
    expect(r.dependencies).toEqual([{ kind: 'segment', key: 'legacy-beta-orgs', entityId: 'legacy-beta-orgs' }]);
    expect(r.shell.customProperties['jira.issue']).toEqual({ name: 'Jira issue', value: ['ACME-412'] });
    expect(r.fidelity.overall).toBe('partial');
    expect(notes(r)).toEqual([expect.stringContaining('30% / 70% rollout re-buckets contexts')]);
  });

  it('individual targets keep their context kinds and variations', () => {
    const r = mapNeutralFlag(flagArgs('legacy-checkout-redesign', { env: { statsig: 'test', ld: 'test' } }));
    expect(r.env.targets).toEqual([
      { contextKind: 'organization', variation: 0, values: ['org-pilot'] },
      { contextKind: 'user', variation: 0, values: ['u-qa-1', 'u-qa-2'] },
    ]);
    expect(r.env.rules.map((x) => x.description)).toEqual(['Beta organizations', 'Acme staff']);
  });

  it('prerequisites become dependencies when the target allows them, and a decision when it does not', () => {
    const r = mapNeutralFlag(flagArgs('legacy-pricing-tiers'));
    expect(r.env.prerequisites).toEqual([{ key: 'legacy-checkout-redesign', variation: 0 }]);
    expect(r.dependencies).toContainEqual({ kind: 'flag', key: 'legacy-checkout-redesign', entityId: 'legacy-checkout-redesign' });
    expect(r.env.fallthrough.rollout).toMatchObject({ contextKind: 'organization', bucketBy: 'plan' });
    expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('tracks evaluation events'));

    // A target without prerequisites cannot take the flag one to one: skipped with a reason, nothing dropped.
    const none = mapNeutralFlag(flagArgs('legacy-pricing-tiers', { capabilities: { ...caps, prerequisites: 'unavailable' } }));
    expect(types(none)).toEqual([]);
    expect(none.skipped).toMatch(/prerequisites “legacy-checkout-redesign” can't be written: the target plan has no flag prerequisites/);
    expect(none.dependencies.find((d) => d.kind === 'flag')).toBeUndefined();
  });

  it('a prerequisite on a flag that is not in the source skips the flag with a reason', () => {
    const r = mapNeutralFlag(flagArgs('legacy-receipt-emails'));
    expect(types(r)).toEqual([]);
    expect(r.skipped).toMatch(/prerequisite “legacy-retired-gate” is not in the source snapshot/);
    expect(r.env.prerequisites).toEqual([]);
  });

  it('a segmentMatch on a segment that does not exist in that environment skips the flag there, with a reason', () => {
    const test = mapNeutralFlag(flagArgs('legacy-fraud-shield', { env: { statsig: 'test', ld: 'test' } }));
    expect(types(test)).toEqual([]);
    expect(test.skipped).toMatch(/segment “legacy-fraud-blocklist” matched by rule “Blocklisted users” › clause 1 is not in the source snapshot for environment “test”/);
    expect(test.env.rules).toEqual([]);
    const prod = mapNeutralFlag(flagArgs('legacy-fraud-shield'));
    expect(types(prod)).toEqual([]);
    expect(prod.dependencies).toEqual([{ kind: 'segment', key: 'legacy-fraud-blocklist', entityId: 'legacy-fraud-blocklist' }]);
  });

  it('never copies provenance from an earlier migration into the source project', () => {
    const r = mapNeutralFlag(flagArgs('legacy-theme'));
    expect(types(r)).toEqual([]);
    expect(r.shell.tags).toEqual(['migrated-from-launchdarkly', 'migration-src-legacy', 'ui']);
    expect(r.shell.customProperties['migration.id']?.value).toEqual(['legacy-theme']);
    expect(r.shell.customProperties['migration.kind']?.value).toEqual(['launchdarkly']);
    expect(r.shell.variations.map((v) => v.name)).toEqual(['Light', 'Dark']);
    expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('provenance tag'));
  });

  it('skips archived flags and notes experiments and deprecation', () => {
    expect(mapNeutralFlag(flagArgs('legacy-archived-promo')).skipped).toMatch(/archived/);
    const r = mapNeutralFlag(flagArgs('legacy-cta-copy'));
    expect(r.fidelity.overall).toBe('partial');
    expect(r.fidelity.notes.map((n) => n.message)).toEqual(expect.arrayContaining([expect.stringContaining('Deprecated'), expect.stringContaining('experiment')]));
  });

  it('is deterministic: same inputs, same fingerprint and decision-set hash', () => {
    const a = mapNeutralFlag(flagArgs('legacy-checkout-redesign'));
    const b = mapNeutralFlag(flagArgs('legacy-checkout-redesign'));
    expect(a.statsigFingerprint).toBe(b.statsigFingerprint);
    expect(a.decisionSetHash).toBe(b.decisionSetHash);
    expect(a.unresolved).toEqual([]);
    const test = mapNeutralFlag(flagArgs('legacy-checkout-redesign', { env: { statsig: 'test', ld: 'test' } }));
    expect(test.statsigFingerprint).not.toBe(a.statsigFingerprint);
  });
});

describe('LaunchDarkly segments (PLAN §20.3)', () => {
  it('copies rules, included and excluded keys; a weighted rule is noted', () => {
    const r = mapNeutralSegment(segArgs('legacy-internal-users', { env: { statsig: 'test', ld: 'test' } }));
    expect(types(r)).toEqual([]);
    expect(notes(r)).toEqual([expect.stringContaining('50% of matching contexts: re-bucketed')]);
    expect(r.desired).toMatchObject({ key: 'legacy-internal-users', included: ['u-1', 'u-2', 'u-3'], excluded: ['u-contractor-9'], tags: ['migrated-from-launchdarkly', 'migration-src-legacy'] });
    expect(r.desired!.rules).toEqual([{ description: 'Half of acme.example', clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@acme.example'], negate: false }], weight: 50_000, rolloutContextKind: 'user' }]);
  });

  it('keys of other kinds go to includedContexts', () => {
    const r = mapNeutralSegment(segArgs('legacy-beta-orgs'));
    expect(types(r)).toEqual([]);
    expect(r.desired!.includedContexts).toEqual([{ contextKind: 'organization', values: ['org-pilot'] }]);
    expect(r.desired!.included).toEqual([]);
  });

  it('a big segment is created empty (membership unreadable) for a manual import, without asking', () => {
    const r = mapNeutralSegment(segArgs('legacy-fraud-blocklist'));
    expect(types(r)).toEqual([]);
    expect(r.desired?.unbounded).toEqual({ contextKind: 'user', ids: [], manual: true });
    expect(r.fidelity.overall).toBe('manual');
    expect(notes(r)).toContainEqual(expect.stringContaining('import the member list'));
    const noPlan = mapNeutralSegment(segArgs('legacy-fraud-blocklist', { capabilities: { ...caps, bigSegments: 'unavailable' } }));
    expect(noPlan.skipped).toMatch(/no big segments/);
    expect(mapNeutralSegment(segArgs('legacy-fraud-blocklist', { env: { statsig: 'test', ld: 'test' } })).skipped).toMatch(/not present in source environment/);
  });
});

describe('LaunchDarkly experimentation → LaunchDarkly (PLAN §20.5)', () => {
  const expArgs = (key: string, env = 'production', over: Partial<MapArgs<NeutralExperiment>> = {}): MapArgs<NeutralExperiment> => {
    const entity = legacy.neutral!.experiments!.find((x) => x.key === key)!;
    return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: env, ld: env }, now: NOW, directory: DIRECTORY, ...over };
  };
  const metricArgs = (key: string, over: Partial<MapArgs<NeutralMetric>> = {}): MapArgs<NeutralMetric> => {
    const entity = legacy.neutral!.metrics!.find((m) => m.key === key)!;
    return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: '', ld: '' }, now: NOW, directory: DIRECTORY, ...over };
  };

  it('copies every field of a metric, matches the maintainer by email and resolves analysis units like context kinds', () => {
    const r = mapNeutralMetric(metricArgs('legacy-order-value'));
    expect(r.skipped).toBeUndefined();
    expect(types(r)).toEqual([]);
    expect(r.desired).toMatchObject({ key: 'legacy-order-value', kind: 'custom', eventKey: 'order_placed', isNumeric: true, unit: 'USD', successCriteria: 'HigherThanBaseline', unitAggregationType: 'sum', analysisType: 'percentile', percentileValue: 90, winsorLowerPercentile: 1, winsorUpperPercentile: 99, eventDefault: { disabled: false, value: 0 }, filters: { type: 'eventProperty', attribute: 'currency', op: 'in', values: ['USD'], negate: false }, analysisUnits: ['user'] });
    expect(r.desired!.tags).toEqual(['migrated-from-launchdarkly', 'migration-src-legacy', 'checkout', 'revenue']);
    // growth@acme-legacy.example is not a member of the target account: no maintainer, noted on the item.
    expect(r.desired!.maintainerId).toBeUndefined();
    expect(notes(r)).toContainEqual(expect.stringContaining('growth@acme-legacy.example is not a member'));
    const ops = mapNeutralMetric(metricArgs('legacy-checkout-completed'));
    expect(ops.desired!.maintainerId).toBe('mem-legacy-ops');
    expect(ops.desired!.analysisUnits).toEqual(['user', 'organization']);
    expect(types(ops)).toEqual([]);
    expect(ops.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('track()'));
  });

  it('references a warehouse-native data source by key (manual: it must exist in the target) and never migrates an archived metric', () => {
    const r = mapNeutralMetric(metricArgs('legacy-wh-revenue'));
    expect(types(r)).toEqual([]);
    expect(r.desired!.dataSource).toEqual({ key: 'legacy-snowflake', environmentKey: 'production' });
    expect(r.fidelity.overall).toBe('manual');
    expect(notes(r)).toContainEqual(expect.stringContaining('set up the data source “legacy-snowflake” in the target project'));
    expect(mapNeutralMetric(metricArgs('legacy-old-signup')).skipped).toMatch(/archived/);
    // Click and page view metrics carry their selector and URL matchers.
    expect(mapNeutralMetric(metricArgs('legacy-cta-click')).desired).toMatchObject({ kind: 'click', selector: '#checkout-cta', urls: [{ kind: 'exact', url: 'https://shop.acme-legacy.example/cart' }] });
    expect(mapNeutralMetric(metricArgs('legacy-cart-conversion')).desired!.denominator).toEqual({ eventName: 'cart_viewed', isNumeric: false, unitAggregationType: 'count_distinct' });
  });

  it('copies a funnel after its metrics and notes the maintainer LaunchDarkly requires', () => {
    const g = legacy.neutral!.metricGroups![0]!;
    const r = mapNeutralMetricGroup({ canonical: { snapshot: legacy }, entity: g, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: '', ld: '' }, now: NOW, directory: DIRECTORY });
    expect(r.desired).toEqual({ key: 'legacy-checkout-funnel', name: 'Checkout funnel', description: 'Cart → CTA → order.', kind: 'funnel', tags: ['migrated-from-launchdarkly', 'migration-src-legacy', 'checkout'], metrics: [{ key: 'legacy-cta-click', nameInGroup: 'Clicked CTA' }, { key: 'legacy-checkout-completed', nameInGroup: 'Completed checkout' }] });
    expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toEqual(['metric:legacy-checkout-completed', 'metric:legacy-cta-click']);
    expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('member behind the API token'));
  });

  it('copies a not-started draft as it is, on the rule it runs on, with its flag and metrics as dependencies', () => {
    const r = mapNeutralExperiment(expArgs('legacy-theme-test', 'test'));
    expect(r.skipped).toBeUndefined();
    expect(types(r)).toEqual([]);
    expect(r.desired).toMatchObject({
      key: 'legacy-theme-test',
      ldEnv: 'test',
      type: 'experiment',
      methodology: 'frequentist',
      analysisConfig: { significanceThreshold: '0.05', testDirection: 'two-sided', multipleComparisonCorrectionMethod: 'bonferroni', multipleComparisonCorrectionScope: 'variations', sequentialTestingEnabled: true },
      maintainerId: 'mem-legacy-ops',
      hypothesis: 'Dark mode users complete checkout more often.',
      randomizationUnit: 'user',
      canReshuffleTraffic: true,
      primary: { key: 'legacy-checkout-completed', isGroup: false },
      flags: [{ flagKey: 'legacy-theme', rule: { kind: 'rule', index: 0, description: 'Dark mode opt-in', sourceRuleId: 'rule-dark' }, notInExperimentVariation: 0 }],
      sourceStatus: 'not_started',
    });
    expect(r.desired!.treatments).toEqual([
      { name: 'Light', baseline: true, allocationPercent: '50', parameters: [{ flagKey: 'legacy-theme', variation: 0 }] },
      { name: 'Dark', baseline: false, allocationPercent: '50', parameters: [{ flagKey: 'legacy-theme', variation: 1 }] },
    ]);
    expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toEqual(['flag:legacy-theme', 'metric:legacy-checkout-completed', 'metric:legacy-order-value']);
    expect(r.fidelity.overall).toBe('full');
  });

  it('copies a running experiment as a not-started draft with its holdout, layer and funnel, noting that the source keeps running', () => {
    const r = mapNeutralExperiment(expArgs('legacy-cta-copy-test'));
    expect(types(r)).toEqual([]);
    expect(notes(r)).toContainEqual(expect.stringContaining('Running in the source project: the target gets the same design as a not-started draft'));
    expect(r.desired).toMatchObject({ holdoutKey: 'legacy-q3-holdout', layer: { key: 'legacy-checkout-layer', reservationPercent: 40 }, primary: { key: 'legacy-checkout-funnel', isGroup: true }, sourceStatus: 'running', analysisConfig: { bayesianThreshold: '0.95' } });
    expect(r.desired!.flags).toEqual([{ flagKey: 'legacy-cta-copy', rule: { kind: 'fallthrough' }, notInExperimentVariation: 0 }]);
    expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toEqual(['flag:legacy-cta-copy', 'holdout:legacy-q3-holdout', 'layer:legacy-checkout-layer', 'metric_group:legacy-checkout-funnel', 'metric:legacy-cta-click', 'metric:legacy-order-value']);
  });

  it('recreates a stopped experiment as a draft with its outcome in the description, randomized by a custom kind', () => {
    const r = mapNeutralExperiment(expArgs('legacy-checkout-redesign-test'));
    expect(types(r)).toEqual([]);
    expect(notes(r)).toContainEqual(expect.stringContaining('Stopped in the source project, winner “Redesign”: the design is recreated as a draft'));
    expect(r.desired).toMatchObject({ randomizationUnit: 'organization', attributes: ['plan'], sourceStatus: 'stopped', maintainerId: 'mem-legacy-ops' });
    expect(r.desired!.description).toContain('winner “Redesign”');
    expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toContain('randomization_unit:organization');
    expect(r.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('1 earlier iteration'));
    // The warehouse metric it measures is a dependency like any other; its own note is on the metric.
    expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toContain('metric:legacy-wh-revenue');
  });

  it('copies a bandit with its reallocation frequency and skips archived experiments and other environments', () => {
    const r = mapNeutralExperiment(expArgs('legacy-pricing-bandit'));
    expect(r.desired).toMatchObject({ type: 'mab', reallocationFrequencyMillis: 3_600_000, randomizationUnit: 'organization' });
    expect(r.desired!.treatments.map((t) => t.allocationPercent)).toEqual(['34', '33', '33']);
    expect(mapNeutralExperiment(expArgs('legacy-old-banner-test')).skipped).toMatch(/archived/);
    expect(mapNeutralExperiment(expArgs('legacy-theme-test', 'production')).skipped).toMatch(/not present/);
  });

  it('skips an experiment whose target plan has no experimentation, with the reason and no question', () => {
    const r = mapNeutralExperiment(expArgs('legacy-theme-test', 'test', { capabilities: { ...caps, experimentation: 'unavailable' } }));
    expect(types(r)).toEqual([]);
    expect(r.skipped).toMatch(/no experiments \(not on the plan\)/);
  });

  it('creates a running holdout unstarted (noted), and a layer whose reservations follow its experiments', () => {
    const h = legacy.neutral!.holdouts![0]!;
    const base = { canonical: { snapshot: legacy }, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, now: NOW, directory: DIRECTORY };
    const r = mapNeutralHoldout({ ...base, entity: h, env: { statsig: 'production', ld: 'production' } });
    expect(types(r)).toEqual([]);
    expect(notes(r)).toContainEqual(expect.stringContaining('created unstarted in the target, bucketing a new population'));
    expect(r.desired).toEqual({ key: 'legacy-q3-holdout', ldEnv: 'production', statsigEnv: 'production', name: 'Q3 holdout', description: 'Keeps 10% of users out of every Q3 experiment to measure their combined effect.', randomizationUnit: 'user', holdoutAmount: '10', metrics: [{ key: 'legacy-checkout-completed', isGroup: false }, { key: 'legacy-order-value', isGroup: false }], primaryMetricKey: 'legacy-checkout-completed' });
    expect(r.dependencies.map((d) => `${d.kind}:${d.key}`)).toEqual(['metric:legacy-checkout-completed', 'metric:legacy-order-value']);
    expect(mapNeutralHoldout({ ...base, entity: h, env: { statsig: 'test', ld: 'test' } }).skipped).toMatch(/not present/);
    const l = mapNeutralLayer({ ...base, entity: legacy.neutral!.layers![0]!, env: { statsig: '', ld: '' } });
    expect(l.desired).toEqual({ key: 'legacy-checkout-layer', name: 'Checkout layer', description: 'Mutually exclusive checkout experiments.' });
    expect(l.fidelity.notes.map((n) => n.message)).toContainEqual(expect.stringContaining('Reservations (1)'));
  });

  it('is deterministic for experimentation items too', () => {
    const a = mapNeutralExperiment(expArgs('legacy-cta-copy-test'));
    const b = mapNeutralExperiment(expArgs('legacy-cta-copy-test'));
    expect(a.statsigFingerprint).toBe(b.statsigFingerprint);
    expect(a.decisionSetHash).toBe(b.decisionSetHash);
    expect(a.unresolved).toEqual([]);
  });
});

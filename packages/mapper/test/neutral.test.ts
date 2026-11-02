import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot, NeutralFlag, NeutralSegment } from '@sslm/canonical';
import { mapNeutralFlag, mapNeutralSegment, type MapArgs, type MapperCapabilities, type Resolution } from '../src/index.ts';
import { CAPS, legacySnapshot, NOW, profileFor, server } from './fixtures.ts';

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
  return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: 'production', ld: 'production' }, now: NOW, ...over };
}
function segArgs(key: string, over: Partial<MapArgs<NeutralSegment>> = {}): MapArgs<NeutralSegment> {
  const entity = legacy.neutral!.segments.find((s) => s.key === key)!;
  return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: 'production', ld: 'production' }, now: NOW, ...over };
}
const types = (r: { unresolved: { type: string }[] }) => r.unresolved.map((d) => d.type).sort();
const resolve = (r: { unresolved: { id: string; type: string; fingerprint: string }[] }, picks: Record<string, string>): Map<string, Resolution> =>
  new Map(r.unresolved.filter((d) => picks[d.type]).map((d) => [d.id, { id: d.id, type: d.type as Resolution['type'], optionKey: picks[d.type]!, scope: 'resource' as const, fingerprint: d.fingerprint, decidedAt: NOW }]));

describe('LD project → LD project (PLAN §20.3)', () => {
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
    expect(r.fidelity.notes.map((n) => n.message)).toEqual([expect.stringContaining('Maintainer (ops@acme-legacy.example) not carried')]);
  });

  it('keeps clauses, negation and semVer operators as they are', () => {
    const r = mapNeutralFlag(flagArgs('legacy-ios-min-version', { env: { statsig: 'test', ld: 'test' } }));
    // `device` is missing in the target: unit_type_kind, recommended "create device".
    expect(types(r)).toEqual(['unit_type_kind']);
    expect(r.unresolved[0]!.recommended).toBe('create:device');
    expect(r.env.rules[0]!.clauses).toEqual([
      { contextKind: 'device', attribute: 'appVersion', op: 'semVerGreaterThan', values: ['4.2.0'], negate: false },
      { contextKind: 'device', attribute: 'os', op: 'in', values: ['ipados'], negate: true },
    ]);
    expect(r.dependencies).toEqual([{ kind: 'context_kind', key: 'device', entityId: 'device' }]);
    expect(r.shell.clientSideAvailability).toEqual({ usingEnvironmentId: false, usingMobileKey: true });
  });

  it('a rollout is acknowledged as re-bucketing; segment references become dependencies; own custom properties ask to be copied', () => {
    const r = mapNeutralFlag(flagArgs('legacy-checkout-redesign'));
    expect(types(r)).toEqual(['copy_custom_properties', 'partial_rollout_rebucket']);
    expect(r.env.fallthrough).toEqual({ rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 30_000 }, { variation: 1, weight: 70_000 }] } });
    expect(r.dependencies).toEqual([{ kind: 'segment', key: 'legacy-beta-orgs', entityId: 'legacy-beta-orgs' }]);
    // Preview applies the recommended "copy".
    expect(r.shell.customProperties['jira.issue']).toEqual({ name: 'Jira issue', value: ['ACME-412'] });
    const dropped = mapNeutralFlag(flagArgs('legacy-checkout-redesign', { resolutions: resolve(r, { copy_custom_properties: 'drop', partial_rollout_rebucket: 'acknowledge' }) }));
    expect(dropped.unresolved).toEqual([]);
    expect(dropped.shell.customProperties['jira.issue']).toBeUndefined();
    expect(dropped.fidelity.overall).toBe('partial');
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

    const none = mapNeutralFlag(flagArgs('legacy-pricing-tiers', { capabilities: { ...caps, prerequisites: 'unavailable' } }));
    expect(types(none)).toContain('prerequisite_unsupported');
    expect(none.env.prerequisites).toEqual([]);
    expect(none.dependencies.find((d) => d.kind === 'flag')).toBeUndefined();
  });

  it('a prerequisite on a flag that is not in the source is a missing_reference', () => {
    const r = mapNeutralFlag(flagArgs('legacy-receipt-emails'));
    expect(types(r)).toEqual(['missing_reference']);
    expect(r.unresolved[0]!.severity).toBe('blocking');
    expect(r.env.prerequisites).toEqual([]);
  });

  it('a segmentMatch on a segment that does not exist in that environment is a missing_reference', () => {
    const test = mapNeutralFlag(flagArgs('legacy-fraud-shield', { env: { statsig: 'test', ld: 'test' } }));
    expect(types(test)).toEqual(['missing_reference']);
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

  it('is deterministic: same inputs, same fingerprint and decision ids', () => {
    const a = mapNeutralFlag(flagArgs('legacy-checkout-redesign'));
    const b = mapNeutralFlag(flagArgs('legacy-checkout-redesign'));
    expect(a.statsigFingerprint).toBe(b.statsigFingerprint);
    expect(a.unresolved.map((d) => d.id)).toEqual(b.unresolved.map((d) => d.id));
    expect(a.unresolved[0]!.id).toBe('copy_custom_properties:src-legacy/flag/legacy-checkout-redesign:custom_properties');
    const test = mapNeutralFlag(flagArgs('legacy-checkout-redesign', { env: { statsig: 'test', ld: 'test' } }));
    expect(test.statsigFingerprint).not.toBe(a.statsigFingerprint);
  });
});

describe('LD segments (PLAN §20.3)', () => {
  it('copies rules, included and excluded keys; a weighted rule is acknowledged', () => {
    const r = mapNeutralSegment(segArgs('legacy-internal-users', { env: { statsig: 'test', ld: 'test' } }));
    expect(types(r)).toEqual(['partial_rollout_rebucket']);
    expect(r.desired).toMatchObject({ key: 'legacy-internal-users', included: ['u-1', 'u-2', 'u-3'], excluded: ['u-contractor-9'], tags: ['migrated-from-launchdarkly', 'migration-src-legacy'] });
    expect(r.desired!.rules).toEqual([{ description: 'Half of acme.example', clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@acme.example'], negate: false }], weight: 50_000, rolloutContextKind: 'user' }]);
  });

  it('keys of other kinds go to includedContexts', () => {
    const r = mapNeutralSegment(segArgs('legacy-beta-orgs'));
    expect(types(r)).toEqual([]);
    expect(r.desired!.includedContexts).toEqual([{ contextKind: 'organization', values: ['org-pilot'] }]);
    expect(r.desired!.included).toEqual([]);
  });

  it('a big segment asks to be created empty (membership unreadable), or skipped', () => {
    const r = mapNeutralSegment(segArgs('legacy-fraud-blocklist'));
    expect(types(r)).toEqual(['big_segment']);
    expect(r.unresolved[0]!.severity).toBe('blocking');
    expect(r.desired?.unbounded).toEqual({ contextKind: 'user', ids: [], manual: true });
    expect(r.fidelity.overall).toBe('manual');
    const skipped = mapNeutralSegment(segArgs('legacy-fraud-blocklist', { resolutions: resolve(r, { big_segment: 'skip' }) }));
    expect(skipped.skipped).toMatch(/big segment/);
    const noPlan = mapNeutralSegment(segArgs('legacy-fraud-blocklist', { capabilities: { ...caps, bigSegments: 'unavailable' } }));
    expect(noPlan.skipped).toMatch(/no big segments/);
    expect(mapNeutralSegment(segArgs('legacy-fraud-blocklist', { env: { statsig: 'test', ld: 'test' } })).skipped).toMatch(/not present in source environment/);
  });
});

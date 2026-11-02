import { describe, expect, it } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Config, type Gate, type Segment } from '@sslm/canonical';
import type { MappingProfile, Resolution } from '@sslm/mapper';
import { acrossSources, choiceError, choiceValue, describeUsage, knownKinds, parseChoice, sharedKinds, unitTypeStanding, unitTypeUsage, unsettledUnitTypes } from './unitTypes.ts';

const src = { sourceId: 's-mobile', sourceKind: 'console_api' as const, alias: 'mobile' };
const base = { source: src, completeness: { missing: [] }, tags: [], environments: null, passPercentage: 100, archived: false };
const rule = (idType: string, conditions: Gate['rules'][number]['conditions'] = []) => ({ ...base, id: 'r', name: 'r', idType, conditions });

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(src, '2026-11-02T00:00:00Z');
  s.unitTypes = [
    { name: 'userID', description: 'Logged-in customer ID' },
    { name: 'stableID', description: 'Install-stable anonymous ID' },
    { name: 'companyID', description: 'B2B account ID' },
    { name: 'deviceID', description: 'Hardware device ID' },
  ];
  s.gates = [
    { ...base, kind: 'gate', uid: 's-mobile/gate/a', id: 'a', name: 'a', enabled: true, idType: 'userID', holdoutIds: [], overrides: [{ unitType: 'companyID', ids: ['acct_1'], value: { kind: 'gate', pass: true }, environment: null }], rules: [rule('userID', [{ type: 'unit_id', customID: 'companyID', operator: 'any', targetValue: ['acct_1'], raw: {} }]), rule('stableID')] },
    { ...base, kind: 'gate', uid: 's-mobile/gate/b', id: 'b', name: 'b', enabled: true, idType: 'companyID', holdoutIds: [], overrides: [], rules: [] },
    { ...base, kind: 'gate', uid: 's-mobile/gate/old', id: 'old', name: 'old', enabled: true, idType: 'CustomID', holdoutIds: [], overrides: [], rules: [], archived: true },
  ] as unknown as Gate[];
  s.configs = [{ ...base, kind: 'config', uid: 's-mobile/config/c', id: 'c', name: 'c', enabled: true, idType: 'companyid', defaultValue: {}, holdoutIds: [], overrides: [], rules: [] }] as unknown as Config[];
  s.segments = [{ ...base, kind: 'segment', uid: 's-mobile/segment/s', id: 's', name: 's', enabled: true, idType: 'orgID', segmentType: 'rule_based', rules: [] }] as unknown as Segment[];
  return s;
}

const profile = (kinds: Record<string, string> = {}): MappingProfile => ({ version: 1, attributes: {}, policies: {}, sources: { 's-mobile': { envMapping: {}, unitTypeKinds: kinds } } });
const EXISTING = ['user', 'device'];

describe('unit types: where each is used', () => {
  it('counts keyed items, rule buckets, conditions and overrides; merges case variants; lists undeclared unit types last', () => {
    const u = unitTypeUsage(snapshot());
    expect(u.map((x) => x.name)).toEqual(['userID', 'stableID', 'companyID', 'deviceID', 'orgID']);
    const company = u.find((x) => x.name === 'companyID')!;
    expect(company).toMatchObject({ declared: true, keyed: { gate: 1, config: 1 }, conditions: 1, overrides: 1, ruleBuckets: 0 });
    expect(describeUsage(company)).toBe('1 gate · 1 dynamic config · 1 condition · 1 override');
    expect(u.find((x) => x.name === 'stableID')).toMatchObject({ keyed: {}, ruleBuckets: 1 });
    expect(describeUsage(u.find((x) => x.name === 'stableID')!)).toBe('1 rule bucket on it');
    expect(u.find((x) => x.name === 'orgID')).toMatchObject({ declared: false, keyed: { segment: 1 } });
    expect(describeUsage(u.find((x) => x.name === 'deviceID')!)).toBe('not used');
    // Archived items do not count, so their unit type is not listed.
    expect(u.find((x) => x.name.toLowerCase() === 'customid')).toBeUndefined();
  });
});

describe('unit types: the choice', () => {
  it('reads and writes profile values: a kind key, attribute:<name> on user, or attribute:<kind>/<name>; empty clears', () => {
    expect(parseChoice(undefined, 'companyID')).toEqual({ mode: 'kind', key: 'company', contextKind: 'company', configured: false });
    expect(parseChoice('account', 'companyID')).toEqual({ mode: 'kind', key: 'account', contextKind: 'account', configured: true });
    expect(parseChoice('attribute:companyID', 'companyID')).toEqual({ mode: 'attribute', key: 'companyID', contextKind: 'user', configured: true });
    expect(parseChoice('attribute:account/companyID', 'companyID')).toEqual({ mode: 'attribute', key: 'companyID', contextKind: 'account', configured: true });
    expect(choiceValue('kind', ' account ')).toBe('account');
    expect(choiceValue('attribute', 'companyID')).toBe('attribute:companyID');
    expect(choiceValue('attribute', 'companyID', 'user')).toBe('attribute:companyID');
    expect(choiceValue('attribute', 'companyID', ' account ')).toBe('attribute:account/companyID');
    expect(choiceValue('kind', '  ')).toBeNull();
  });

  it('refuses keys LD would refuse, the user key for a custom unit ID, and attributes for userID', () => {
    expect(choiceError('kind', 'account', 'companyID')).toBeUndefined();
    expect(choiceError('kind', 'user', 'userID')).toBeUndefined();
    expect(choiceError('kind', '', 'companyID')).toBeUndefined();
    expect(choiceError('kind', 'not a key', 'companyID')).toMatch(/Not a valid context kind key/);
    expect(choiceError('kind', 'multi', 'companyID')).toMatch(/Not a valid context kind key/);
    expect(choiceError('kind', 'user', 'companyID')).toMatch(/never the key of the user context/);
    expect(choiceError('attribute', 'companyID', 'companyID')).toBeUndefined();
    expect(choiceError('attribute', 'key', 'companyID')).toMatch(/reserved/);
    expect(choiceError('attribute', 'anything', 'userID')).toMatch(/userID is the key/);
    // The attribute may sit on any kind, as long as LD would accept the kind's key.
    expect(choiceError('attribute', 'companyID', 'companyID', 'account')).toBeUndefined();
    expect(choiceError('attribute', 'companyID', 'companyID', 'not a kind')).toMatch(/Not a valid context kind key/);
    expect(choiceError('attribute', 'companyID', 'companyID', 'multi')).toMatch(/Not a valid context kind key/);
  });
});

describe('unit types: standing', () => {
  const res = (unitType: string, optionKey: string): Resolution => ({ id: `unit_type_kind:s-mobile/unit_type/${unitType}:kind`, type: 'unit_type_kind', optionKey, scope: 'resource', decidedAt: '2026-11-02T00:00:00Z' });

  it('exists for user and for kinds LD has; otherwise asks per item unless configured', () => {
    expect(unitTypeStanding(profile(), [], 's-mobile', 'userID', EXISTING)).toEqual({ kind: 'exists', target: { contextKind: 'user', attribute: 'key' } });
    expect(unitTypeStanding(profile(), [], 's-mobile', 'stableID', EXISTING)).toEqual({ kind: 'exists', target: { contextKind: 'device', attribute: 'key' } });
    expect(unitTypeStanding(profile(), [], 's-mobile', 'companyID', EXISTING)).toEqual({ kind: 'asks', target: { contextKind: 'company', attribute: 'key' } });
    expect(unitTypeStanding(profile(), [res('companyID', 'create:account')], 's-mobile', 'companyID', EXISTING)).toMatchObject({ kind: 'asks', decided: 'account' });
    expect(unitTypeStanding(profile(), [res('companyID', 'attribute:companyID')], 's-mobile', 'companyID', EXISTING)).toMatchObject({ kind: 'asks', decided: 'attribute:companyID' });
    expect(unitTypeStanding(profile({ companyID: 'account' }), [], 's-mobile', 'companyID', EXISTING)).toEqual({ kind: 'creates', target: { contextKind: 'account', attribute: 'key' } });
    expect(unitTypeStanding(profile({ companyID: 'device' }), [], 's-mobile', 'companyID', EXISTING)).toEqual({ kind: 'exists', target: { contextKind: 'device', attribute: 'key' } });
    expect(unitTypeStanding(profile({ companyID: 'attribute:companyID' }), [], 's-mobile', 'companyID', EXISTING)).toEqual({ kind: 'attribute', target: { contextKind: 'user', attribute: 'companyID' }, kindExists: true });
    // An attribute of another kind: the kind exists in LD, or the migration creates it.
    expect(unitTypeStanding(profile({ companyID: 'attribute:device/companyID' }), [], 's-mobile', 'companyID', EXISTING)).toEqual({ kind: 'attribute', target: { contextKind: 'device', attribute: 'companyID' }, kindExists: true });
    expect(unitTypeStanding(profile({ companyID: 'attribute:account/companyID' }), [], 's-mobile', 'companyID', EXISTING)).toEqual({ kind: 'attribute', target: { contextKind: 'account', attribute: 'companyID' }, kindExists: false });
    expect(unitTypeStanding(profile(), [res('companyID', 'attribute:account/companyID')], 's-mobile', 'companyID', EXISTING)).toMatchObject({ kind: 'asks', decided: 'attribute:account/companyID' });
    // The profile matches unit types case-insensitively, like StatSig.
    expect(unitTypeStanding(profile({ COMPANYID: 'account' }), [], 's-mobile', 'companyID', EXISTING)).toMatchObject({ kind: 'creates' });
  });

  it('counts the unit types that still ask, for the nav badge', () => {
    const names = ['userID', 'stableID', 'companyID', 'deviceID', 'orgID'];
    expect(unsettledUnitTypes(profile(), [], 's-mobile', names, EXISTING)).toEqual(['companyID', 'orgID']);
    expect(unsettledUnitTypes(profile({ companyID: 'company' }), [res('orgID', 'create:org')], 's-mobile', names, EXISTING)).toEqual([]);
  });
});

describe('unit types: conflicts', () => {
  it('3.2: two unit types of one source on one kind, by default or by choice', () => {
    const names = ['userID', 'stableID', 'companyID', 'deviceID'];
    expect([...sharedKinds(profile(), 's-mobile', names)]).toEqual([['device', ['stableID', 'deviceID']]]);
    expect([...sharedKinds(profile({ deviceID: 'hardware' }), 's-mobile', names)]).toEqual([]);
    // A unit type kept as a user attribute shares nothing.
    expect([...sharedKinds(profile({ deviceID: 'attribute:deviceID' }), 's-mobile', names)]).toEqual([]);
    expect([...sharedKinds(profile({ companyID: 'device' }), 's-mobile', names)]).toEqual([['device', ['stableID', 'companyID', 'deviceID']]]);
  });

  it('16.5: a unit type in two sources is flagged when the sources send it to different kinds', () => {
    const p: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-web': { envMapping: {}, unitTypeKinds: { companyID: 'account' } }, 's-mobile': { envMapping: {}, unitTypeKinds: {} } } };
    const rows = acrossSources(p, [
      { sourceId: 's-web', label: 'acme-web', unitTypes: ['userID', 'companyID'] },
      { sourceId: 's-mobile', label: 'acme-mobile', unitTypes: ['userID', 'companyID', 'deviceID'] },
    ]);
    expect(rows.map((r) => [r.name, r.differ])).toEqual([
      ['userID', false],
      ['companyID', true],
    ]);
    expect(rows[1]!.targets.map((t) => t.kind)).toEqual(['account', 'company']);
    p.sources['s-mobile']!.unitTypeKinds.companyID = 'attribute:companyID';
    expect(acrossSources(p, [{ sourceId: 's-web', label: 'w', unitTypes: ['companyID'] }, { sourceId: 's-mobile', label: 'm', unitTypes: ['companyID'] }])[0]!.targets[1]!.kind).toBe('user.companyID');
    p.sources['s-mobile']!.unitTypeKinds.companyID = 'attribute:account/companyID';
    expect(acrossSources(p, [{ sourceId: 's-web', label: 'w', unitTypes: ['companyID'] }, { sourceId: 's-mobile', label: 'm', unitTypes: ['companyID'] }])[0]!.targets[1]!.kind).toBe('account.companyID');
  });

  it('offers user, the kinds LD has and every kind another unit type keys or carries an attribute on', () => {
    const p = profile({ companyID: 'account', orgID: 'attribute:tenant/orgID' });
    expect(knownKinds(p, [{ sourceId: 's-mobile', unitTypes: ['userID', 'stableID', 'companyID', 'deviceID', 'orgID'] }], ['user', 'device', 'org'])).toEqual(['user', 'account', 'device', 'org', 'tenant']);
  });
});

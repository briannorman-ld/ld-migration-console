import { describe, expect, it } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import type { MappingProfile } from '@sslm/mapper';
import { classify, computeGuide, computePeople, currentStep, describeTally, STEP_ORDER, teamKeysFor, type GuideInput, type Tally, provisionedBy } from './guide.ts';

const blocking = { severity: 'blocking' } as DecisionPoint;
const choice = { severity: 'choice' } as DecisionPoint;

describe('guide: where an item stands', () => {
  it('skipped and blocked win over what LaunchDarkly holds; otherwise LaunchDarkly decides', () => {
    expect(classify({ skipped: 'archived', unresolved: [blocking] }, { status: 'in_sync' })).toBe('skipped');
    expect(classify({ unresolved: [blocking] }, { status: 'in_sync' })).toBe('blocked');
    expect(classify({ unresolved: [choice] }, { status: 'in_sync' })).toBe('in_sync');
    expect(classify({ unresolved: [] }, { status: 'changed' })).toBe('changed');
    expect(classify({ unresolved: [] }, { status: 'absent' })).toBe('not_migrated');
  });

  it('describes a tally for the step line', () => {
    const t: Tally = { kind: 'gate', total: 12, inSync: 3, changed: 2, notMigrated: 5, blocked: 2, skipped: 0, setAside: 0, toMigrate: [], ldUnknown: false };
    expect(describeTally(t, 'gate')).toBe('3 of 12 in sync · 2 changed since · 5 not migrated · 2 wait for decisions');
    expect(describeTally({ ...t, total: 0 }, 'gate')).toBe('No gates in this environment.');
    expect(describeTally({ ...t, ldUnknown: true }, 'gate')).toMatch(/^reading LaunchDarkly…/);
  });
});

describe('guide: the current step', () => {
  it('is the first step not done, in dependency order, and cut over once all are', () => {
    const none = Object.fromEntries(STEP_ORDER.map((k) => [k, false])) as Record<(typeof STEP_ORDER)[number], boolean>;
    expect(currentStep(none)).toBe('connect');
    // The account-level steps (teams, people) never hold the guide: resources migrate without them and a later sync picks up what appeared.
    expect(currentStep({ ...none, connect: true })).toBe('environment');
    expect(currentStep({ ...none, connect: true, teams: true })).toBe('environment');
    expect(currentStep({ ...none, connect: true, teams: true, people: true })).toBe('environment');
    expect(currentStep({ ...none, connect: true, environment: true })).toBe('contexts');
    expect(currentStep({ ...none, connect: true, environment: true, teams: true, people: true })).toBe('contexts');
    expect(currentStep({ ...none, connect: true, environment: true, teams: true, people: true, contexts: true })).toBe('segments');
    expect(currentStep({ ...none, connect: true, environment: true, teams: true, people: true, contexts: true, segments: true })).toBe('flags');
    expect(currentStep({ ...none, connect: true, environment: true, teams: true, people: true, contexts: true, segments: true, flags: true })).toBe('experiments');
    expect(currentStep({ ...none, connect: true, environment: true, teams: true, people: true, contexts: true, segments: true, flags: true, experiments: true })).toBe('cutover');
  });

  it('reports LaunchDarkly as connecting (not "not connected") while the saved token reconnects', () => {
    const base: GuideInput = { sources: [], snapshots: [], m: null, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    const m = (ld: Partial<NonNullable<GuideInput['m']>['ld']>) => ({ ...base, m: { ld: { status: 'connecting', ...ld }, connected: false, capabilities: {} } as unknown as NonNullable<GuideInput['m']> });
    expect(computeGuide(m({})).connecting).toBe(true);
    expect(computeGuide(m({ status: 'connected', projectKey: 'p1', probing: 'Starting' })).connecting).toBe(true);
    expect(computeGuide(m({ status: 'disconnected' })).connecting).toBe(false);
    expect(computeGuide(m({ status: 'error', error: 'nope' })).connecting).toBe(false);
    expect(computeGuide(base).connecting).toBe(false);
  });

  it('a fresh workspace starts at Connect with nothing tallied', () => {
    const input: GuideInput = { sources: [], snapshots: [], m: null, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    const g = computeGuide(input);
    expect(g.current).toBe('connect');
    expect(g.connected).toBe(false);
    expect(g.envs).toEqual([]);
    expect(g.segments.total + g.gates.total + g.configs.total + g.autotunes.total).toBe(0);
    expect(Object.values(g.done).every((d) => !d)).toBe(true);
  });
});

describe('guide: people and teams (PLAN §8.3)', () => {
  const person = (email: string, name: string) => ({ email, name });
  const entity = (kind: 'gate' | 'config' | 'prompt', id: string, owner: { email: string; name: string } | undefined, team?: string): Record<string, unknown> => ({
    kind,
    uid: `src-a/${kind}/${id}`,
    id,
    name: id,
    source: { sourceId: 'src-a', sourceKind: 'console_api' },
    completeness: { missing: [] },
    tags: [],
    archived: false,
    targetApps: [],
    ...(owner ? { owner } : {}),
    team: team ?? null,
  });
  const snapshot = {
    source: { sourceId: 'src-a', sourceKind: 'console_api', alias: 'a' },
    environments: [],
    unitTypes: [],
    gates: [entity('gate', 'g1', person('bob@acme.example', 'Bob Okafor'), 'Checkout'), entity('gate', 'g2', person('bob@acme.example', 'Bob Okafor')), entity('gate', 'g3', person('gone@acme.example', 'Jordan Former'), 'Checkout'), { ...entity('gate', 'g4', person('x@acme.example', 'X')), archived: true }],
    configs: [entity('config', 'c1', person('priya@acme.example', 'Priya Raman'), 'Search')],
    segments: [],
    experiments: [],
    layers: [],
    holdouts: [],
    autotunes: [],
    prompts: [entity('prompt', 'p1', person('gone@acme.example', 'Jordan Former'))],
    teams: [{ id: 't1', name: 'Checkout', description: 'Checkout team', memberEmails: ['bob@acme.example', 'gone@acme.example'] }],
    alerts: [],
  } as never;
  const m = (over: Record<string, unknown> = {}) =>
    ({
      ld: { status: 'connected', members: [{ _id: 'mem-bob', email: 'Bob@acme.example' }, { _id: 'mem-alice', email: 'alice@acme.example', _pendingInvite: true }], teams: [] },
      connected: true,
      capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
      profile: { version: 1, sources: {}, attributes: {}, policies: {} },
      directory: { members: [{ id: 'mem-bob', email: 'bob@acme.example' }], teams: [], membersReadable: true, teamsReadable: true },
      ...over,
    }) as never;

  it('groups owners by email across kinds, counts their live items and matches LaunchDarkly members case-insensitively', () => {
    const p = computePeople([snapshot], m(), { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true });
    expect(p.owners.map((o) => [o.email, o.items, o.status, o.team ?? null])).toEqual([
      ['bob@acme.example', 2, 'member', 'Checkout'],
      ['gone@acme.example', 2, 'missing', 'Checkout'],
      ['priya@acme.example', 1, 'missing', 'Search'],
    ]);
    expect(p.owners[0]!.memberId).toBe('mem-bob');
    expect(p.teams.map((t) => [t.name, t.items, t.status, t.ldMemberIds])).toEqual([
      ['Checkout', 2, 'missing', ['mem-bob']],
      ['Search', 1, 'missing', []],
    ]);
  });

  /** A flag read onto the neutral model (PostHog here): the maintainer is the owner; the flag itself names nobody. */
  const neutralFlag = (key: string, maintainer: { id?: string; email?: string; teamKey?: string } | undefined, archived = false): Record<string, unknown> => ({
    kind: 'flag',
    uid: `src-hog/flag/${key}`,
    key,
    name: key,
    description: '',
    flagKind: 'boolean',
    variations: [{ value: true }, { value: false }],
    tags: [],
    temporary: false,
    archived,
    customProperties: {},
    experiments: [],
    environments: [],
    ...(maintainer ? { maintainer } : {}),
  });
  const hogSnapshot = {
    source: { sourceId: 'src-hog', sourceKind: 'posthog', alias: 'hog' },
    environments: [],
    unitTypes: [],
    // The organization's members: the only place a PostHog flag's owner has a name.
    users: [
      { id: 'u-bob', email: 'Bob@acme.example', name: 'Bob Okafor' },
      { email: 'dana@acme.example', name: 'Dana Whitfield' },
    ],
    gates: [],
    configs: [],
    segments: [],
    experiments: [],
    layers: [],
    holdouts: [],
    autotunes: [],
    prompts: [],
    teams: [],
    alerts: [],
    neutral: {
      flags: [
        neutralFlag('hog_checkout', { id: '7', email: 'bob@acme.example' }), // the same person as the StatSig gate owner
        neutralFlag('hog_search', { email: 'Dana@acme.example', teamKey: 'platform' }),
        neutralFlag('hog_retired', { email: 'retired@acme.example' }, true), // archived: never migrated, so not an item
        neutralFlag('hog_idonly', { id: '9' }), // a member ID of the source account: nobody to match
        neutralFlag('hog_nobody', undefined),
      ],
      segments: [],
      contextKinds: [],
    },
  } as never;

  it('counts neutral-model flags (LaunchDarkly, PostHog) for their maintainer, adding to the StatSig owner of the same email, naming them from the member list and skipping archived flags', () => {
    const p = computePeople([snapshot, hogSnapshot], m(), { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true });
    expect(p.owners.map((o) => [o.email, o.items, o.status, o.team ?? null, o.name ?? null])).toEqual([
      ['bob@acme.example', 3, 'member', 'Checkout', 'Bob Okafor'],
      ['gone@acme.example', 2, 'missing', 'Checkout', 'Jordan Former'],
      ['dana@acme.example', 1, 'missing', 'platform', 'Dana Whitfield'],
      ['priya@acme.example', 1, 'missing', 'Search', 'Priya Raman'],
    ]);
    expect(p.owners.find((o) => o.email === 'retired@acme.example')).toBeUndefined();
    // The maintainer team key is a team of its own, with no member list to read, and is matched to LD by key.
    expect(p.teams.map((t) => [t.name, t.items, t.status, t.memberEmails])).toEqual([
      ['Checkout', 2, 'missing', ['bob@acme.example', 'gone@acme.example']],
      ['platform', 1, 'missing', []],
      ['Search', 1, 'missing', []],
    ]);
    const withTeam = computePeople([snapshot, hogSnapshot], m({ directory: { members: [{ id: 'mem-bob', email: 'bob@acme.example' }], teams: [{ key: 'platform', name: 'Platform Engineering' }], membersReadable: true, teamsReadable: true } }), { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true });
    expect(withTeam.teams.find((t) => t.name === 'platform')).toMatchObject({ status: 'exists', ldKey: 'platform' });
    // A PostHog-only workspace: the same rows, with the member directory deciding the status.
    const hogOnly = computePeople([hogSnapshot], m(), { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true });
    expect(hogOnly.owners.map((o) => [o.email, o.items, o.status, o.name ?? null, o.memberId ?? null])).toEqual([
      ['bob@acme.example', 1, 'member', 'Bob Okafor', 'mem-bob'],
      ['dana@acme.example', 1, 'missing', 'Dana Whitfield', null],
    ]);
    // The profile's choice applies to neutral owners too.
    const decided = computePeople([hogSnapshot], m({ profile: { version: 1, sources: {}, attributes: {}, policies: {}, maintainers: { 'dana@acme.example': { teamKey: 'platform' } } } }), { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true });
    expect(decided.owners.find((o) => o.email === 'dana@acme.example')).toMatchObject({ status: 'chosen_team', teamKey: 'platform' });
  });

  it('names the provider for the step copy only when every source shares one', () => {
    const caps = { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true };
    expect(computePeople([snapshot], m(), caps).sourceLabel).toBe('StatSig');
    expect(computePeople([hogSnapshot], m(), caps).sourceLabel).toBe('PostHog');
    expect(computePeople([snapshot, hogSnapshot], m(), caps).sourceLabel).toBeUndefined();
    expect(computePeople([], m(), caps).sourceLabel).toBeUndefined();
  });

  it('reads the profile first: chosen members, teams and "unassigned" owners, and mapped or skipped teams', () => {
    const profile = { version: 1, sources: {}, attributes: {}, policies: {}, maintainers: { 'gone@acme.example': 'unassigned', 'priya@acme.example': { memberId: 'mem-alice' } }, teams: { Search: null } };
    const p = computePeople([snapshot], m({ profile, directory: { members: [{ id: 'mem-bob', email: 'bob@acme.example' }], teams: [{ key: 'checkout', name: 'Checkout' }], membersReadable: true, teamsReadable: true } }), { membersReadable: true, teamsReadable: true, canInvite: false, canCreateTeams: false });
    expect(p.owners.map((o) => o.status)).toEqual(['member', 'unassigned', 'chosen_member']);
    expect(p.teams.map((t) => [t.name, t.status, t.ldKey ?? null])).toEqual([
      ['Checkout', 'exists', 'checkout'],
      ['Search', 'skipped', null],
    ]);
    expect(p.canInvite).toBe(false);
  });

  it('the Teams step is done when every team has an answer, the People step when every owner has one; each on its own', () => {
    const base: GuideInput = { sources: [], snapshots: [snapshot], m: m(), env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    expect(computeGuide(base).done.teams).toBe(false);
    expect(computeGuide(base).done.people).toBe(false);
    // Teams created (or skipped), nobody invited yet: the Teams step is done and People is current.
    const teamsOnly = m({ profile: { version: 1, sources: {}, attributes: {}, policies: {}, teams: { Checkout: null, Search: null } } });
    expect(computeGuide({ ...base, m: teamsOnly }).done.teams).toBe(true);
    expect(computeGuide({ ...base, m: teamsOnly }).done.people).toBe(false);
    const decided = m({ profile: { version: 1, sources: {}, attributes: {}, policies: {}, maintainers: { 'gone@acme.example': 'unassigned', 'priya@acme.example': 'unassigned' }, teams: { Checkout: null, Search: null } } });
    expect(computeGuide({ ...base, m: decided }).done.teams).toBe(true);
    expect(computeGuide({ ...base, m: decided }).done.people).toBe(true);
  });

  it('an identity provider that provisions the account turns invites (and with Okta team sync, team creation) off; Connect waits for the answer', () => {
    const caps = { membersReadable: true, teamsReadable: true, canInvite: true, canCreateTeams: true };
    expect(computePeople([snapshot], m(), caps)).toMatchObject({ access: 'launchdarkly', accessAnswered: false, canInvite: true, canCreateTeams: true });
    expect(computePeople([snapshot], m(), { ...caps, access: 'launchdarkly' })).toMatchObject({ accessAnswered: true, canInvite: true, canCreateTeams: true });
    expect(computePeople([snapshot], m(), { ...caps, access: 'scim' })).toMatchObject({ canInvite: false, canCreateTeams: true });
    expect(computePeople([snapshot], m(), { ...caps, access: 'scim_team_sync' })).toMatchObject({ canInvite: false, canCreateTeams: false });
    const base: GuideInput = { sources: [], snapshots: [snapshot], m: m(), env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    expect(computeGuide(base).done.connect).toBe(false);
    expect(computeGuide({ ...base, access: 'scim' }).done.connect).toBe(true);
  });

  it('Teams and People never hold the guide: with Connect done the current step is the environment, however many owners are missing', () => {
    const base: GuideInput = { sources: [], snapshots: [snapshot], m: m(), env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    for (const access of ['launchdarkly', 'scim', 'scim_team_sync'] as const) {
      const g = computeGuide({ ...base, access });
      expect(g.done.teams).toBe(false);
      expect(g.done.people).toBe(false);
      expect(g.current).toBe('environment');
    }
    expect(provisionedBy('teams', 'scim')).toBeUndefined();
    expect(provisionedBy('teams', 'scim_team_sync')).toBe('Okta');
    expect(provisionedBy('people', 'scim')).toBe('SCIM');
    expect(provisionedBy('people', 'launchdarkly')).toBeUndefined();
  });

  it('an invitation carries the LaunchDarkly keys of the teams the owner is in, when those teams exist', () => {
    const teams = [
      { name: 'Checkout', memberEmails: ['bob@acme.example', 'Gone@acme.example'], items: 2, status: 'exists' as const, ldKey: 'checkout', ldMemberIds: [] },
      { name: 'Search', memberEmails: [], items: 1, status: 'missing' as const, ldMemberIds: [] },
      { name: 'Platform', memberEmails: [], items: 0, status: 'exists' as const, ldKey: 'platform', ldMemberIds: [] },
    ];
    expect(teamKeysFor({ email: 'gone@acme.example', team: 'Platform' }, teams)).toEqual(['checkout', 'platform']); // member of one, items in another
    expect(teamKeysFor({ email: 'priya@acme.example', team: 'Search' }, teams)).toEqual([]); // Search is not in LaunchDarkly yet
    expect(teamKeysFor({ email: 'nobody@acme.example' }, teams)).toEqual([]);
  });
});

describe('guide: the saved LaunchDarkly listing', () => {
  it('marks the tallies as of the saved read while the live refresh runs, and drops the mark once it has landed', () => {
    const base: GuideInput = { sources: [], snapshots: [], m: null, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    const m = (ld: Partial<NonNullable<GuideInput['m']>['ld']>) => ({ ...base, m: { ld: { status: 'connected', projectKey: 'p1', matrix: { capabilities: [], environments: [] }, ...ld }, connected: true, capabilities: {} } as unknown as NonNullable<GuideInput['m']> });
    expect(computeGuide(m({ stale: '2026-11-02T10:00:00Z' })).ldAsOf).toEqual({ at: '2026-11-02T10:00:00Z', refreshing: false, failed: false });
    expect(computeGuide(m({ stale: '2026-11-02T10:00:00Z', refreshing: true })).ldAsOf).toEqual({ at: '2026-11-02T10:00:00Z', refreshing: true, failed: false });
    expect(computeGuide(m({ stale: '2026-11-02T10:00:00Z', error: 'Could not read the LaunchDarkly project: 503' })).ldAsOf).toEqual({ at: '2026-11-02T10:00:00Z', refreshing: false, failed: true });
    // A live listing shows its own age; nothing re-reads on its own.
    expect(computeGuide(m({ flags: { items: [], loadedAt: '2026-11-02T11:00:00Z' } })).ldAsOf).toEqual({ at: '2026-11-02T11:00:00Z', refreshing: false, failed: false });
    expect(computeGuide(m({})).ldAsOf).toBeUndefined();
    expect(computeGuide(base).ldAsOf).toBeUndefined();
  });
});

describe('guide: context kinds (the required mapping)', () => {
  const source = { id: 'src-a', workspaceId: 'w', alias: 'a', label: 'acme-web', kind: 'console_api', createdAt: '2026-10-22T10:00:00Z' } as GuideInput['sources'][number];
  const snapshot = {
    source: { sourceId: 'src-a', sourceKind: 'console_api', alias: 'a' },
    environments: [{ name: 'staging' }],
    unitTypes: [{ name: 'userID' }, { name: 'stableID' }, { name: 'companyID' }],
    gates: [],
    configs: [],
    segments: [],
    experiments: [],
    layers: [],
    holdouts: [],
    autotunes: [],
    prompts: [],
    teams: [],
    alerts: [],
  } as unknown as GuideInput['snapshots'][number];
  const input = (kinds: Record<string, string>, over: { contextKinds?: MappingProfile['contextKinds']; randomizationUnits?: string[] } = {}): GuideInput => {
    const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 'src-a': { envMapping: { staging: 'test' }, unitTypeKinds: kinds } }, ...(over.contextKinds ? { contextKinds: over.contextKinds } : {}) };
    const m = {
      ld: { status: 'connected', projectKey: 'shop', contextKinds: ['user', 'device'], ...('randomizationUnits' in over ? { randomizationUnits: over.randomizationUnits } : { randomizationUnits: ['user'] }) },
      connected: true,
      capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user', 'device'] },
      profile,
      resolutions: new Map(),
    } as unknown as NonNullable<GuideInput['m']>;
    return { sources: [source], snapshots: [snapshot], m, env: 'staging', access: 'launchdarkly', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
  };

  it('every unit type but userID needs a choice before the step is done, even one whose default kind exists', () => {
    const g = computeGuide(input({}));
    expect(g.contexts.unitTypes).toEqual(['userID', 'stableID', 'companyID']);
    expect(g.contexts.rows.map((r) => [r.unitType, r.standing.kind])).toEqual([
      ['userID', 'exists'],
      ['stableID', 'unmapped'],
      ['companyID', 'unmapped'],
    ]);
    expect(g.contexts.unmapped).toBe(2);
    expect(g.contexts.toCreate).toEqual([]);
    expect(g.done.contexts).toBe(false);
    expect(g.current).toBe('contexts');
  });

  it('chosen kinds LaunchDarkly lacks are created, with whether each is to be a randomization unit; kinds it has are enabled alone', () => {
    const g = computeGuide(input({ stableID: 'device', companyID: 'company' }, { contextKinds: { company: { availableForExperiments: true }, device: { availableForExperiments: true } } }));
    expect(g.contexts.unmapped).toBe(0);
    expect(g.contexts.toCreate).toEqual([{ key: 'company', unitType: 'companyID', availableForExperiments: true }]);
    expect(g.contexts.toEnable).toEqual([{ key: 'device', unitTypes: ['stableID'] }]);
    expect(g.contexts.experimentsReadable).toBe(true);
    expect(g.done.contexts).toBe(false);
    // An attribute on a kind the migration creates needs that kind too.
    const attr = computeGuide(input({ stableID: 'device', companyID: 'attribute:account/companyID' }));
    expect(attr.contexts.toCreate).toEqual([{ key: 'account', unitType: 'companyID', availableForExperiments: false }]);
  });

  it('is done once every unit type has a kind that exists and every experiments choice is in effect', () => {
    const g = computeGuide(input({ stableID: 'device', companyID: 'device' }, { contextKinds: { device: { availableForExperiments: true } }, randomizationUnits: ['user', 'device'] }));
    expect(g.contexts.toCreate).toEqual([]);
    expect(g.contexts.toEnable).toEqual([]);
    expect(g.done.contexts).toBe(true);
    expect(g.current).toBe('segments');
    // Unreadable experimentation settings enable nothing from here and do not hold the step.
    const unreadable = computeGuide(input({ stableID: 'device', companyID: 'device' }, { contextKinds: { device: { availableForExperiments: true } }, randomizationUnits: undefined }));
    expect(unreadable.contexts.experimentsReadable).toBe(false);
    expect(unreadable.contexts.toEnable).toEqual([]);
    expect(unreadable.done.contexts).toBe(true);
  });
});

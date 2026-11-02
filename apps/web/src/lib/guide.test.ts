import { describe, expect, it } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import { classify, computeGuide, computePeople, currentStep, describeTally, STEP_ORDER, teamKeysFor, type GuideInput, type Tally, provisionedBy } from './guide.ts';

const blocking = { severity: 'blocking' } as DecisionPoint;
const choice = { severity: 'choice' } as DecisionPoint;

describe('guide: where an item stands', () => {
  it('skipped and blocked win over what LD holds; otherwise LD decides', () => {
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

  it('groups owners by email across kinds, counts their live items and matches LD members case-insensitively', () => {
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

  it('an invitation carries the LD keys of the teams the owner is in, when those teams exist', () => {
    const teams = [
      { name: 'Checkout', memberEmails: ['bob@acme.example', 'Gone@acme.example'], items: 2, status: 'exists' as const, ldKey: 'checkout', ldMemberIds: [] },
      { name: 'Search', memberEmails: [], items: 1, status: 'missing' as const, ldMemberIds: [] },
      { name: 'Platform', memberEmails: [], items: 0, status: 'exists' as const, ldKey: 'platform', ldMemberIds: [] },
    ];
    expect(teamKeysFor({ email: 'gone@acme.example', team: 'Platform' }, teams)).toEqual(['checkout', 'platform']); // member of one, items in another
    expect(teamKeysFor({ email: 'priya@acme.example', team: 'Search' }, teams)).toEqual([]); // Search is not in LD yet
    expect(teamKeysFor({ email: 'nobody@acme.example' }, teams)).toEqual([]);
  });
});

describe('guide: the saved LD listing', () => {
  it('marks the tallies as of the saved read while the live refresh runs, and drops the mark once it has landed', () => {
    const base: GuideInput = { sources: [], snapshots: [], m: null, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    const m = (ld: Partial<NonNullable<GuideInput['m']>['ld']>) => ({ ...base, m: { ld: { status: 'connected', projectKey: 'p1', matrix: { capabilities: [], environments: [] }, ...ld }, connected: true, capabilities: {} } as unknown as NonNullable<GuideInput['m']> });
    expect(computeGuide(m({ stale: '2026-11-02T10:00:00Z' })).ldAsOf).toEqual({ at: '2026-11-02T10:00:00Z', refreshing: true });
    expect(computeGuide(m({ stale: '2026-11-02T10:00:00Z', error: 'Could not read the LD project: 503' })).ldAsOf).toEqual({ at: '2026-11-02T10:00:00Z', refreshing: false });
    expect(computeGuide(m({})).ldAsOf).toBeUndefined();
    expect(computeGuide(base).ldAsOf).toBeUndefined();
  });
});

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRecord } from '@sslm/store';
import type { GuideInput } from '../lib/guide.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

const inviteLdMembers = vi.fn<(workspaceId: string, people: { email: string; name?: string; teamKeys?: string[] }[], role: string) => Promise<void>>(async () => undefined);
const createLdTeam = vi.fn<(workspaceId: string, team: { key: string; name: string; description?: string; memberIDs: string[] }) => Promise<void>>(async () => undefined);
const refreshLdPeople = vi.fn(async () => undefined);
const updateWorkspace = vi.fn(async () => undefined);
vi.mock('../lib/ld.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ld.ts')>()),
  inviteLdMembers: (...a: Parameters<typeof inviteLdMembers>) => inviteLdMembers(...a),
  createLdTeam: (...a: Parameters<typeof createLdTeam>) => createLdTeam(...a),
  refreshLdPeople: () => refreshLdPeople(),
  refreshLdState: async () => undefined,
}));
vi.mock('../lib/store.ts', () => ({ store: { updateWorkspace: (...a: unknown[]) => updateWorkspace(...(a as [])) } }));

const { GuideView, INVITE_ALL_PHRASE } = await import('./GuideView.tsx');

const person = (email: string, name: string) => ({ email, name });
const entity = (kind: 'gate' | 'config', id: string, owner: { email: string; name: string }, team?: string): Record<string, unknown> => ({
  kind,
  uid: `src-a/${kind}/${id}`,
  id,
  name: id,
  source: { sourceId: 'src-a', sourceKind: 'console_api' },
  completeness: { missing: [] },
  tags: [],
  archived: false,
  targetApps: [],
  owner,
  team: team ?? null,
});
const snapshot = {
  source: { sourceId: 'src-a', sourceKind: 'console_api', alias: 'a' },
  environments: [],
  unitTypes: [],
  gates: [entity('gate', 'g1', person('bob@acme.example', 'Bob Okafor'), 'Checkout'), entity('gate', 'g3', person('gone@acme.example', 'Jordan Former'), 'Checkout')],
  configs: [entity('config', 'c1', person('priya@acme.example', 'Priya Raman'), 'Search')],
  segments: [],
  experiments: [],
  layers: [],
  holdouts: [],
  autotunes: [],
  prompts: [],
  teams: [
    { id: 't1', name: 'Checkout', memberEmails: ['bob@acme.example', 'gone@acme.example'] },
    { id: 't2', name: 'Search', description: 'Search team', memberEmails: ['priya@acme.example'] },
  ],
  alerts: [],
} as never;

function setup(over: { canCreateTeams?: boolean; access?: WorkspaceRecord['accountAccess']; ldTeams?: { key: string; name: string }[] } = {}) {
  const saveProfile = vi.fn(() => Promise.resolve());
  const m = {
    ld: { status: 'connected', projectKey: 'shop', members: [{ _id: 'mem-bob', email: 'bob@acme.example' }], teams: [], ...(over.canCreateTeams ? { matrix: { capabilities: [{ key: 'teams', status: 'available' }], environments: [] } } : {}) },
    connected: true,
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
    profile: { version: 1, sources: {}, attributes: {}, policies: {} },
    directory: { members: [{ id: 'mem-bob', email: 'bob@acme.example' }], teams: over.ldTeams ?? [], membersReadable: true, teamsReadable: true },
    resolutionList: [],
    saveProfile,
  } as unknown as MigrationContext;
  const input: GuideInput = { sources: [], snapshots: [snapshot], m, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
  const nav = { connections: vi.fn(), ld: vi.fn(), mapping: vi.fn(), unitTypes: vi.fn(), decisions: vi.fn(), resource: vi.fn(), runs: vi.fn(), monitoring: vi.fn(), coverage: vi.fn() } as never;
  render(<GuideView workspaceId="w1" workspace={{ id: 'w1', name: 'Shop', ...(over.access ? { accountAccess: over.access } : {}) } as WorkspaceRecord} m={m} input={input} onEnvChange={vi.fn()} onMigrate={vi.fn()} nav={nav} />);
  return { saveProfile };
}


/** Expand a step by its title; the current step is already open, so clicking it would collapse it. */
function openStep(title: RegExp) {
  const b = screen.getByRole('button', { name: title });
  if (b.getAttribute('aria-expanded') !== 'true') fireEvent.click(b);
}

describe('GuideView: teams and people', () => {
  afterEach(() => {
    cleanup();
    inviteLdMembers.mockClear();
    createLdTeam.mockClear();
    refreshLdPeople.mockClear();
    updateWorkspace.mockClear();
  });

  it('asks on Connect how members and teams are managed, and saves the answer on the workspace', () => {
    setup();
    const q = screen.getByLabelText('How members and teams are managed') as HTMLSelectElement;
    expect(q.value).toBe('');
    fireEvent.change(q, { target: { value: 'scim' } });
    expect(updateWorkspace).toHaveBeenCalledWith('w1', { accountAccess: 'scim' });
  });

  it('keeps teams and people as separate steps, teams first, so teams can be created before anyone is invited', () => {
    setup();
    // Step headers read "<n>Title summary…"; the number is an aria-hidden span.
    const steps = screen.getAllByRole('button', { expanded: false }).map((b) => (b.textContent ?? '').replace(/^\d+/, ''));
    const teams = steps.findIndex((t) => t.startsWith('Teams'));
    const people = steps.findIndex((t) => t.startsWith('People'));
    const environment = steps.findIndex((t) => t.startsWith('Choose an environment'));
    expect(teams).toBeGreaterThan(-1);
    expect(people).toBe(teams + 1);
    expect(environment).toBe(people + 1); // account steps first, then the per-environment loop
    // Members and teams are account-level in LD: both steps say so in the header and inside.
    expect(screen.getAllByText('account-wide')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /account-wide/ }).map((b) => (b.textContent ?? '').replace(/^\d+/, '').split('account-wide')[0])).toEqual(['Teams', 'People']);
    openStep(/^Teams/);
    expect(screen.getByText(/Teams belong to your LaunchDarkly/).textContent).toMatch(/not to the project “shop”/);
    expect(screen.getByText('Checkout')).toBeTruthy(); // the team row
    expect(screen.getByText(/Teams are a LaunchDarkly Enterprise feature/)).toBeTruthy(); // this token's matrix lacks the teams capability
    expect(screen.queryByRole('button', { name: /Create all/ })).toBeNull();
    expect(screen.queryByText(/people are not in LaunchDarkly\./)).toBeNull(); // no owner rows in the Teams step
  });

  it('creates every missing team with one click when the token may create teams', async () => {
    setup({ canCreateTeams: true });
    openStep(/^Teams/);
    const teamsBar = screen.getByText('2 teams are not in LaunchDarkly.');
    // The bulk action sits above the team list.
    expect(teamsBar.compareDocumentPosition(screen.getByText('Checkout')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create all 2 teams' }));
    await screen.findByRole('button', { name: 'Create all 2 teams' }); // the model is static here, so the row stays until LaunchDarkly state refreshes
    expect(createLdTeam).toHaveBeenCalledTimes(2);
    expect(createLdTeam.mock.calls.map((c) => c[1])).toEqual([
      { key: 'checkout', name: 'Checkout', memberIDs: ['mem-bob'] },
      { key: 'search', name: 'Search', description: 'Search team', memberIDs: [] },
    ]);
  });

  it('invites everyone only after the word is typed, listing every address first', () => {
    setup();
    openStep(/^People/);
    const peopleBar = screen.getByText('2 people are not in LaunchDarkly.');
    // The bulk action sits above the owners table.
    expect(peopleBar.compareDocumentPosition(screen.getByText('StatSig owner').closest('table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Invite all 2 people/ }));
    const dialog = screen.getByRole('dialog', { name: 'Invite 2 people to LaunchDarkly' });
    expect(within(dialog).getByText(/join your whole LaunchDarkly account/)).toBeTruthy();
    expect(within(dialog).getByText('gone@acme.example')).toBeTruthy();
    expect(within(dialog).getByText('priya@acme.example')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Invite 2 people' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const field = within(dialog).getByLabelText('Confirmation');
    fireEvent.change(field, { target: { value: 'invit' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(inviteLdMembers).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: ` ${INVITE_ALL_PHRASE.toUpperCase()} ` } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(inviteLdMembers).toHaveBeenCalledTimes(1);
    expect(inviteLdMembers.mock.calls[0]![1].map((p) => p.email)).toEqual(['gone@acme.example', 'priya@acme.example']);
    expect(inviteLdMembers.mock.calls[0]![2]).toBe('reader');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts invited people into the teams created on the previous step', () => {
    setup({ ldTeams: [{ key: 'checkout', name: 'Checkout' }] });
    openStep(/^People/);
    fireEvent.click(screen.getByRole('button', { name: /Invite all 2 people/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('gone@acme.example').textContent).toMatch(/→ checkout/);
    fireEvent.change(within(dialog).getByLabelText('Confirmation'), { target: { value: INVITE_ALL_PHRASE } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invite 2 people' }));
    expect(inviteLdMembers.mock.calls[0]![1]).toEqual([
      { email: 'gone@acme.example', name: 'Jordan Former', teamKeys: ['checkout'] },
      { email: 'priya@acme.example', name: 'Priya Raman' }, // Search is not in LaunchDarkly yet
    ]);
  });

  it('neither account step is "you are here": the environment loop starts without teams or people set up', () => {
    setup({ access: 'launchdarkly' });
    const header = (title: RegExp) => screen.getByRole('button', { name: title });
    expect(header(/^Teams/).getAttribute('aria-expanded')).toBe('false');
    expect(header(/^People/).getAttribute('aria-expanded')).toBe('false');
    expect(header(/^Choose an environment/).textContent).toContain('you are here');
    openStep(/^People/);
    expect(screen.getByText(/Members and invitations belong to your LaunchDarkly/).textContent).toMatch(/do not wait for this one/);
  });

  it('with SCIM provisioning nobody is invited from here: the People step waits and re-checks', () => {
    setup({ access: 'scim', canCreateTeams: true });
    // The header says who does the work, and that nothing is written from here; Teams is still the console's.
    const people = screen.getByRole('button', { name: /^People/ });
    expect(people.textContent).toContain('waiting for SCIM');
    expect(people.textContent).toContain('3 owners · 2 waiting for SCIM');
    expect(people.textContent).not.toContain('account-wide');
    expect(screen.getAllByText('account-wide')).toHaveLength(1);
    openStep(/^People/);
    expect(screen.getByText(/Provisioned by SCIM\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Invite all/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.getByText('2 people are not provisioned yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(refreshLdPeople).toHaveBeenCalledTimes(1);
    // The owner table waits behind a toggle: there is nothing to do per owner but the fallback.
    expect(screen.queryByText('gone@acme.example')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 3 owners' }));
    expect(screen.getByText('gone@acme.example')).toBeTruthy();
    // Teams are still created from here under plain SCIM.
    openStep(/^Teams/);
    expect(screen.getByRole('button', { name: 'Create all 2 teams' })).toBeTruthy();
  });

  it('with Okta team sync, teams are not created either: the step lists the groups to push', () => {
    setup({ access: 'scim_team_sync', canCreateTeams: true });
    expect(screen.queryByText('account-wide')).toBeNull();
    expect(screen.getAllByText('waiting for Okta')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Teams/ }).textContent).toContain('2 teams · 2 groups to push from Okta');
    openStep(/^Teams/);
    expect(screen.getByText(/Provisioned by Okta\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create all/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Create “/ })).toBeNull();
    expect(screen.getByText('2 teams are not in LaunchDarkly yet.')).toBeTruthy();
    expect(screen.getByText(/push a group for each/).textContent).toMatch(/Checkout.*Search/);
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(refreshLdPeople).toHaveBeenCalledTimes(1);
    // The team list waits behind a toggle; skipping a team still works from there.
    expect(screen.queryByRole('button', { name: /^Skip/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 2 teams' }));
    expect(screen.getByText('Checkout')).toBeTruthy();
  });

  it('cancelling the confirmation invites nobody', () => {
    setup();
    openStep(/^People/);
    fireEvent.click(screen.getByRole('button', { name: /Invite all 2 people/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(inviteLdMembers).not.toHaveBeenCalled();
  });
});

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRecord } from '@sslm/store';
import type { GuideInput } from '../lib/guide.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

const inviteLdMembers = vi.fn<(workspaceId: string, people: { email: string; name?: string }[], role: string) => Promise<void>>(async () => undefined);
const createLdTeam = vi.fn<(workspaceId: string, team: { key: string; name: string; description?: string; memberIDs: string[] }) => Promise<void>>(async () => undefined);
vi.mock('../lib/ld.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ld.ts')>()),
  inviteLdMembers: (...a: Parameters<typeof inviteLdMembers>) => inviteLdMembers(...a),
  createLdTeam: (...a: Parameters<typeof createLdTeam>) => createLdTeam(...a),
  refreshLdState: async () => undefined,
}));

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

function setup(over: { canCreateTeams?: boolean } = {}) {
  const saveProfile = vi.fn(() => Promise.resolve());
  const m = {
    ld: { status: 'connected', projectKey: 'shop', members: [{ _id: 'mem-bob', email: 'bob@acme.example' }], teams: [], ...(over.canCreateTeams ? { matrix: { capabilities: [{ key: 'teams', status: 'available' }], environments: [] } } : {}) },
    connected: true,
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
    profile: { version: 1, sources: {}, attributes: {}, policies: {} },
    directory: { members: [{ id: 'mem-bob', email: 'bob@acme.example' }], teams: [], membersReadable: true, teamsReadable: true },
    resolutionList: [],
    saveProfile,
  } as unknown as MigrationContext;
  const input: GuideInput = { sources: [], snapshots: [snapshot], m, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
  const nav = { connections: vi.fn(), ld: vi.fn(), mapping: vi.fn(), unitTypes: vi.fn(), decisions: vi.fn(), resource: vi.fn(), runs: vi.fn(), monitoring: vi.fn(), coverage: vi.fn() } as never;
  render(<GuideView workspaceId="w1" workspace={{ id: 'w1', name: 'Shop' } as WorkspaceRecord} m={m} input={input} onEnvChange={vi.fn()} onMigrate={vi.fn()} nav={nav} />);
  return { saveProfile };
}

describe('GuideView: teams and people', () => {
  afterEach(() => {
    cleanup();
    inviteLdMembers.mockClear();
    createLdTeam.mockClear();
  });

  it('keeps teams and people as separate steps, teams first, so teams can be created before anyone is invited', () => {
    setup();
    // Step headers read "<n>Title summary…"; the number is an aria-hidden span.
    const steps = screen.getAllByRole('button', { expanded: false }).map((b) => (b.textContent ?? '').replace(/^\d+/, ''));
    const teams = steps.findIndex((t) => t.startsWith('Teams'));
    const people = steps.findIndex((t) => t.startsWith('People'));
    expect(teams).toBeGreaterThan(-1);
    expect(people).toBe(teams + 1);
    // Members and teams are account-level in LD: both steps say so in the header and inside.
    expect(screen.getAllByText('account-wide')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /account-wide/ }).map((b) => (b.textContent ?? '').replace(/^\d+/, '').split('account-wide')[0])).toEqual(['Teams', 'People']);
    fireEvent.click(screen.getByRole('button', { name: /^Teams/ }));
    expect(screen.getByText(/Teams belong to your LaunchDarkly/).textContent).toMatch(/not to the project “shop”/);
    expect(screen.getByText('Checkout')).toBeTruthy(); // the team row
    expect(screen.getByText(/Teams are an LD Enterprise feature/)).toBeTruthy(); // this token's matrix lacks the teams capability
    expect(screen.queryByRole('button', { name: /Create all/ })).toBeNull();
    expect(screen.queryByText(/people are not in LaunchDarkly\./)).toBeNull(); // no owner rows in the Teams step
  });

  it('creates every missing team with one click when the token may create teams', async () => {
    setup({ canCreateTeams: true });
    fireEvent.click(screen.getByRole('button', { name: /^Teams/ }));
    const teamsBar = screen.getByText('2 teams are not in LaunchDarkly.');
    // The bulk action sits above the team list.
    expect(teamsBar.compareDocumentPosition(screen.getByText('Checkout')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create all 2 teams' }));
    await screen.findByRole('button', { name: 'Create all 2 teams' }); // the model is static here, so the row stays until LD state refreshes
    expect(createLdTeam).toHaveBeenCalledTimes(2);
    expect(createLdTeam.mock.calls.map((c) => c[1])).toEqual([
      { key: 'checkout', name: 'Checkout', memberIDs: ['mem-bob'] },
      { key: 'search', name: 'Search', description: 'Search team', memberIDs: [] },
    ]);
  });

  it('invites everyone only after the word is typed, listing every address first', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^People/ }));
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

  it('cancelling the confirmation invites nobody', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /^People/ }));
    fireEvent.click(screen.getByRole('button', { name: /Invite all 2 people/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(inviteLdMembers).not.toHaveBeenCalled();
  });
});

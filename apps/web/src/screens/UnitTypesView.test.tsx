import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Gate } from '@sslm/canonical';
import type { MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import type { MigrationContext } from '../lib/useMigration.ts';
import { UnitTypesView } from './UnitTypesView.tsx';

const source: SourceRecord = { id: 's-mobile', workspaceId: 'w', alias: 'mobile', label: 'acme-mobile', kind: 'console_api', createdAt: '2026-10-22T10:00:00Z' };

function snapshot(): CanonicalSnapshot {
  const src = { sourceId: 's-mobile', sourceKind: 'console_api' as const, alias: 'mobile' };
  const s = emptySnapshot(src, '2026-11-02T00:00:00Z');
  s.unitTypes = [
    { name: 'userID', description: 'Logged-in customer ID' },
    { name: 'stableID' },
    { name: 'companyID', description: 'B2B account ID' },
    { name: 'deviceID' },
  ];
  s.gates = [{ kind: 'gate', uid: 's-mobile/gate/b', id: 'b', name: 'b', source: src, completeness: { missing: [] }, tags: [], enabled: true, idType: 'companyID', holdoutIds: [], overrides: [], rules: [], archived: false }] as unknown as Gate[];
  return s;
}

function setup(kinds: Record<string, string> = {}, over: Partial<MigrationContext> = {}) {
  const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-mobile': { envMapping: {}, unitTypeKinds: kinds } } };
  const saveProfile = vi.fn((_p: MappingProfile) => Promise.resolve());
  const m = {
    profile,
    resolutionList: [],
    connected: true,
    ld: { status: 'connected', instance: 'us', projectKey: 'statsig-migration' },
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user', 'device'] },
    saveProfile,
    ...over,
  } as unknown as MigrationContext;
  const nav = { onConnect: vi.fn(), onDecisions: vi.fn() };
  render(<UnitTypesView sources={[source]} snapshots={{ 's-mobile': snapshot() }} m={m} {...nav} />);
  return { saveProfile, nav };
}

describe('UnitTypesView', () => {
  afterEach(cleanup);

  it('lists every unit type with its usage and standing, and warns when two share a kind', () => {
    setup();
    expect(screen.getByText('companyID')).toBeTruthy();
    expect(screen.getByText('B2B account ID')).toBeTruthy();
    expect(screen.getByText('1 gate')).toBeTruthy();
    expect(screen.getAllByText('exists in LD')).toHaveLength(3); // userID → user, stableID and deviceID → device
    expect(screen.getByText('asks per item')).toBeTruthy(); // companyID → company, missing in LD
    // deviceID defaults to device too (3.2).
    expect(screen.getByText(/all map to the context kind/).textContent).toMatch(/stableID and deviceID all map to the context kind device/);
    // userID cannot be kept as an attribute of the user context.
    expect(screen.queryByLabelText('Where userID goes')).toBeNull();
    expect(screen.getByLabelText('Where companyID goes')).toBeTruthy();
  });

  it('saves a typed context kind into the profile, and refuses keys LD would refuse', () => {
    const { saveProfile } = setup();
    const input = screen.getByLabelText('Context kind for companyID') as HTMLInputElement;
    expect(input.placeholder).toBe('company');
    fireEvent.change(input, { target: { value: 'not a key' } });
    fireEvent.blur(input);
    expect(screen.getByText(/Not a valid context kind key/)).toBeTruthy();
    expect(saveProfile).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'account' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(saveProfile.mock.calls[0]![0]).toMatchObject({ sources: { 's-mobile': { unitTypeKinds: { companyID: 'account' } } } });
  });

  it('keeps a unit type as a user attribute with one choice, and resets to the default', () => {
    const { saveProfile } = setup({ deviceID: 'hardware' });
    fireEvent.change(screen.getByLabelText('Where companyID goes'), { target: { value: 'attribute' } });
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: { deviceID: 'hardware', companyID: 'attribute:companyID' } } } }));
    expect((screen.getByLabelText('User attribute for companyID') as HTMLInputElement).value).toBe('companyID');
    // deviceID is configured, so it shows as "will be created" and has a Reset.
    expect(screen.getByText('will be created')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: {} } } }));
  });

  it('shows the answer given per item so far, and offers to connect LD when disconnected', () => {
    const { nav } = setup({}, {
      connected: false,
      ld: { status: 'disconnected' },
      resolutionList: [{ id: 'unit_type_kind:s-mobile/unit_type/companyID:kind', type: 'unit_type_kind', optionKey: 'create:account', scope: 'resource', decidedAt: '2026-11-02T00:00:00Z' }],
    } as Partial<MigrationContext>);
    expect(screen.getByText(/answered on items so far/).textContent).toMatch(/account/);
    fireEvent.click(screen.getByRole('button', { name: 'Connect LaunchDarkly' }));
    expect(nav.onConnect).toHaveBeenCalled();
  });
});

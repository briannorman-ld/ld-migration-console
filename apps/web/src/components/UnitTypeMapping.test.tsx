import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Gate } from '@sslm/canonical';
import type { MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import type { MigrationContext } from '../lib/useMigration.ts';
import { UnitTypeMapping } from './UnitTypeMapping.tsx';

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

function setup(kinds: Record<string, string> = {}, over: Partial<MigrationContext> = {}, contextKinds?: MappingProfile['contextKinds']) {
  const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-mobile': { envMapping: {}, unitTypeKinds: kinds } }, ...(contextKinds ? { contextKinds } : {}) };
  const saveProfile = vi.fn((_p: MappingProfile) => Promise.resolve());
  const m = {
    profile,
    resolutionList: [],
    connected: true,
    ld: { status: 'connected', instance: 'us', projectKey: 'statsig-migration', randomizationUnits: ['user', 'device'] },
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user', 'device'] },
    saveProfile,
    ...over,
  } as unknown as MigrationContext;
  const onConnect = vi.fn();
  render(<UnitTypeMapping sources={[source]} snapshots={{ 's-mobile': snapshot() }} m={m} onConnect={onConnect} />);
  return { saveProfile, onConnect };
}

const select = (unitType: string) => screen.getByLabelText(`Context kind for ${unitType}`) as HTMLSelectElement;
const row = (unitType: string) => screen.getByText(unitType, { selector: 'span.font-mono' }).closest('tr')!;

describe('UnitTypeMapping', () => {
  afterEach(cleanup);

  it('lists every unit type with its usage; all but userID need a choice, with the default kind suggested', () => {
    setup();
    expect(screen.getByText('companyID')).toBeTruthy();
    expect(screen.getByText('B2B account ID')).toBeTruthy();
    expect(screen.getByText('1 gate')).toBeTruthy();
    expect(screen.getAllByText('exists in LaunchDarkly')).toHaveLength(1); // userID → user
    expect(screen.getAllByText('needs a context kind')).toHaveLength(3); // stableID, companyID, deviceID
    expect(row('stableID').textContent).toMatch(/suggested:\s*device\s*\(exists\)/);
    expect(row('companyID').textContent).toMatch(/suggested:\s*company\s*\(new\)/);
    expect(screen.getByText(/3 unit types need a context kind/)).toBeTruthy();
    // userID is fixed to the user context's key: no select.
    expect(screen.queryByLabelText('Context kind for userID')).toBeNull();
    expect(row('userID').textContent).toMatch(/the key of the user context/);
    // The suggestions of stableID and deviceID collide on device (3.2).
    expect(screen.getByText(/all map to the context kind/).textContent).toMatch(/stableID and deviceID all map to the context kind device/);
  });

  it('offers existing kinds, kinds other unit types create, a new kind and an attribute; choosing an existing kind saves it', () => {
    const { saveProfile } = setup({ deviceID: 'hardware' });
    const options = [...select('companyID').querySelectorAll('option')].map((o) => [o.value, o.textContent, o.parentElement?.getAttribute('label') ?? '']);
    expect(options).toEqual([
      ['', 'Choose a context kind…', ''],
      ['device', 'device', 'Existing in LaunchDarkly'],
      ['hardware', 'hardware', 'Created by this migration'],
      ['__new', 'New context kind… (suggested: company)', ''],
      ['__attribute', 'Attribute of a context kind…', ''],
    ]);
    // deviceID's own new kind is not offered back to it as "created for another unit type".
    expect([...select('deviceID').querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))).toEqual(['Existing in LaunchDarkly']);
    fireEvent.change(select('companyID'), { target: { value: 'device' } });
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: { deviceID: 'hardware', companyID: 'device' } } } }));
  });

  it('"New context kind" saves the suggested key at once, then a typed key; keys LaunchDarkly would refuse are refused', () => {
    const { saveProfile } = setup();
    fireEvent.change(select('companyID'), { target: { value: '__new' } });
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: { companyID: 'company' } } } }));
    const input = screen.getByLabelText('Key of the new context kind for companyID') as HTMLInputElement;
    expect(input.value).toBe('company');
    fireEvent.change(input, { target: { value: 'not a key' } });
    fireEvent.blur(input);
    expect(screen.getByText(/Not a valid context kind key/)).toBeTruthy();
    expect(saveProfile).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: 'account' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(saveProfile).toHaveBeenCalledTimes(2);
    expect(saveProfile.mock.calls[1]![0]).toMatchObject({ sources: { 's-mobile': { unitTypeKinds: { companyID: 'account' } } } });
    // The user key is never a custom unit ID's kind.
    fireEvent.change(input, { target: { value: 'user' } });
    fireEvent.blur(input);
    expect(screen.getByText(/never the key of the user context/)).toBeTruthy();
    cleanup();
    setup({ companyID: 'account' });
    expect(select('companyID').value).toBe('__new');
    expect(screen.getByText('will be created')).toBeTruthy();
  });

  it('keeps a unit type as an attribute of a context kind, user or another kind, and clears a choice', () => {
    const { saveProfile } = setup({ deviceID: 'hardware' });
    fireEvent.change(select('companyID'), { target: { value: '__attribute' } });
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: { deviceID: 'hardware', companyID: 'attribute:companyID' } } } }));
    expect((screen.getByLabelText('Attribute for companyID') as HTMLInputElement).value).toBe('companyID');
    const kind = screen.getByLabelText('Context kind carrying companyID') as HTMLInputElement;
    expect(kind.value).toBe('user');
    // The kinds offered: user, LD's kinds, and the kinds other unit types create (hardware for deviceID).
    expect([...document.querySelectorAll('#ld-context-kinds-s-mobile-companyID option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['user', 'device', 'hardware']);
    fireEvent.change(kind, { target: { value: 'not a kind' } });
    fireEvent.blur(kind);
    expect(screen.getByText(/Not a valid context kind key/)).toBeTruthy();
    fireEvent.change(kind, { target: { value: 'hardware' } });
    fireEvent.keyDown(kind, { key: 'Enter' });
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: { deviceID: 'hardware', companyID: 'attribute:hardware/companyID' } } } }));
    // Configured that way, the standing says the kind is created with the attribute on it.
    cleanup();
    setup({ deviceID: 'hardware', companyID: 'attribute:hardware/companyID' });
    expect(row('companyID').textContent).toMatch(/attribute\s*companyID\s*of kind\s*hardware.*the kind will be created/);
    cleanup();
    const again = setup({ companyID: 'attribute:device/companyID' });
    expect(row('companyID').textContent).toMatch(/attribute\s*companyID\s*of kind\s*device/);
    expect(row('companyID').textContent).not.toMatch(/will be created/);
    fireEvent.change(select('companyID'), { target: { value: '' } });
    expect(again.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ sources: { 's-mobile': { envMapping: {}, unitTypeKinds: {} } } }));
  });

  it('"available for experiments" is per kind: saved in the profile, read from LaunchDarkly when already enabled there', () => {
    const { saveProfile } = setup({ companyID: 'company', stableID: 'device' });
    const company = screen.getByLabelText('companyID: available for experiments') as HTMLInputElement;
    expect(company.checked).toBe(false);
    fireEvent.click(company);
    expect(saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ contextKinds: { company: { availableForExperiments: true } } }));
    // device is already a randomization unit of the project: shown enabled, not editable.
    const device = screen.getByLabelText('stableID: available for experiments') as HTMLInputElement;
    expect(device.checked).toBe(true);
    expect(device.disabled).toBe(true);
    expect(row('stableID').textContent).toMatch(/enabled in LaunchDarkly/);
    // userID's user kind always is; an unmapped row has nothing to enable yet.
    expect(row('userID').textContent).toMatch(/always/);
    expect(screen.queryByLabelText('deviceID: available for experiments')).toBeNull();
    cleanup();
    setup({ companyID: 'company' }, {}, { company: { availableForExperiments: true } });
    expect((screen.getByLabelText('companyID: available for experiments') as HTMLInputElement).checked).toBe(true);
  });

  it('accepts every suggestion at once, taking the answer given per item where there is one', () => {
    const { saveProfile } = setup({}, {
      resolutionList: [{ id: 'unit_type_kind:s-mobile/unit_type/companyID:kind', type: 'unit_type_kind', optionKey: 'create:account', scope: 'resource', decidedAt: '2026-11-02T00:00:00Z' }],
    } as Partial<MigrationContext>);
    expect(row('companyID').textContent).toMatch(/answered on items so far:\s*account/);
    fireEvent.click(screen.getByRole('button', { name: 'Accept 3 suggested' }));
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(saveProfile.mock.calls[0]![0]).toMatchObject({ sources: { 's-mobile': { unitTypeKinds: { stableID: 'device', companyID: 'account', deviceID: 'device' } } } });
  });

  it('offers to connect LaunchDarkly when disconnected', () => {
    const { onConnect } = setup({}, { connected: false, ld: { status: 'disconnected' } } as Partial<MigrationContext>);
    fireEvent.click(screen.getByRole('button', { name: 'Connect LaunchDarkly' }));
    expect(onConnect).toHaveBeenCalled();
  });
});

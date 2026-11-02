import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import type { PlanFlag } from '@sslm/planner';
import { EnvChooser, envChoices, FlagsTable } from './MigrateModal.tsx';

const sources: SourceRecord[] = [
  { id: 's-web', workspaceId: 'w', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-10-22T10:00:00Z' },
  { id: 's-mobile', workspaceId: 'w', alias: 'mobile', label: 'acme-mobile', kind: 'console_api', createdAt: '2026-10-22T10:00:00Z' },
];
const profile: MappingProfile = {
  version: 1,
  attributes: {},
  policies: {},
  sources: {
    's-web': { envMapping: { staging: 'test', production: 'production' }, unitTypeKinds: {} },
    's-mobile': { envMapping: { staging: 'test', production: null }, unitTypeKinds: {} },
  },
};
const ldEnvs = [
  { key: 'test', name: 'Test', critical: false },
  { key: 'production', name: 'Production', critical: true },
  { key: 'qa', name: 'QA', critical: false },
];

describe('target environments in the plan', () => {
  afterEach(cleanup);

  it('lists every LD environment with the source environments mapped to it', () => {
    expect(envChoices({ ldEnvs, profile }, sources)).toEqual([
      { key: 'test', name: 'Test', critical: false, mappedFrom: ['acme-web staging', 'acme-mobile staging'] },
      { key: 'production', name: 'Production', critical: true, mappedFrom: ['acme-web production'] },
      { key: 'qa', name: 'QA', critical: false, mappedFrom: [] },
    ]);
    expect(envChoices({ ldEnvs, profile }, sources.slice(0, 1))[0]!.mappedFrom).toEqual(['staging']);
  });

  it('lets the user add or drop environments, in project order, and refuses unmapped ones', () => {
    const onChange = vi.fn();
    const options = envChoices({ ldEnvs, profile }, sources);
    render(<EnvChooser options={options} chosen={['test']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Migrate to production'));
    expect(onChange).toHaveBeenLastCalledWith(['test', 'production']);
    fireEvent.click(screen.getByLabelText('Migrate to test'));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect((screen.getByLabelText('Migrate to qa') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('critical')).toBeTruthy();
    cleanup();
    render(<EnvChooser options={options} chosen={[]} onChange={onChange} />);
    expect(screen.getByText('Choose at least one environment.')).toBeTruthy();
  });

  it('lists each flag once at project level, saying whether it is new, created by the console or adopted, with the outcome per environment', () => {
    const base: Omit<PlanFlag, 'ldKey' | 'exists' | 'owned' | 'adopt' | 'status' | 'envs'> = { uid: 's-web/gate/x', kind: 'gate', entityId: 'x', sourceId: 's-web', flagKind: 'boolean', variations: [{ value: true, name: 'Pass' }, { value: false, name: 'Fail' }] };
    const flags: PlanFlag[] = [
      { ...base, ldKey: 'new_checkout_flow', exists: false, owned: false, adopt: false, status: 'ready', envs: [{ ldEnv: 'test', status: 'ready' }, { ldEnv: 'production', status: 'blocked', reason: '1 open decision' }] },
      { ...base, ldKey: 'kill_switch_payments', exists: true, owned: true, adopt: false, status: 'ready', envs: [{ ldEnv: 'test', status: 'ready' }] },
      { ...base, ldKey: 'legacy_banner', exists: true, owned: false, adopt: true, status: 'ready', envs: [{ ldEnv: 'test', status: 'ready' }] },
      { ...base, ldKey: 'holdout_gate', exists: false, owned: false, adopt: false, status: 'blocked', reason: '2 open decisions', envs: [{ ldEnv: 'test', status: 'blocked', reason: '2 open decisions' }] },
    ];
    render(<FlagsTable flags={flags} />);
    expect(screen.getAllByRole('row')).toHaveLength(5);
    expect(screen.getAllByText('new')).toHaveLength(2);
    expect(screen.getByText('in LD (created by this console)')).toBeTruthy();
    expect(screen.getByText('exists in LD · adopting')).toBeTruthy();
    expect(screen.getAllByText('create')).toHaveLength(1);
    expect(screen.getAllByText('update')).toHaveLength(2);
    expect(screen.getByText('2 open decisions')).toBeTruthy();
    const first = screen.getAllByRole('row')[1]!;
    expect(first.textContent).toContain('production');
    expect(first.textContent).toContain('blocked');
    // No environment column: the flag itself is created once for the project.
    expect(screen.queryByText('LD env')).toBeNull();
  });
});

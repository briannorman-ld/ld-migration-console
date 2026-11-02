import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { acmeSnapshot, CAPS, NOW, server } from '../../../../packages/mapper/test/fixtures.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { buildPlan } from '../lib/migration.ts';

const refresh = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve: () => resolve(), calls: 0 };
});
vi.mock('../lib/ld.ts', async (orig) => ({
  ...(await orig<typeof import('../lib/ld.ts')>()),
  refreshLdState: vi.fn(() => {
    refresh.calls++;
    return refresh.promise;
  }),
  ldSessionSnapshot: () => ({ status: 'connected' }),
}));
import type { MappingProfile, Resolution } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import type { PlanFlag } from '@sslm/planner';
import { EnvChooser, envChoices, FlagsTable, MigrateModal } from './MigrateModal.tsx';

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

  it('lists every LaunchDarkly environment with the source environments mapped to it', () => {
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
    expect(screen.getByText('in LaunchDarkly (created by this console)')).toBeTruthy();
    expect(screen.getByText('exists in LaunchDarkly · adopting')).toBeTruthy();
    expect(screen.getAllByText('create')).toHaveLength(1);
    expect(screen.getAllByText('update')).toHaveLength(2);
    expect(screen.getByText('2 open decisions')).toBeTruthy();
    const first = screen.getAllByRole('row')[1]!;
    expect(first.textContent).toContain('production');
    expect(first.textContent).toContain('blocked');
    // No environment column: the flag itself is created once for the project.
    expect(screen.queryByText('LaunchDarkly env')).toBeNull();
  });
});

describe('opening the plan', () => {
  beforeAll(() => server.listen());
  afterAll(() => server.close());
  afterEach(cleanup);

  it('shows the plan from the current LaunchDarkly listing at once, and lets it run only once the fresh read has landed', async () => {
    const web = await acmeSnapshot('web');
    const gate = web.gates.find((g) => g.id === 'new_checkout_flow')!;
    const m = {
      ld: { status: 'connected', projectKey: 'shop', instance: 'us', matrix: { projectKey: 'shop', instance: 'us', capabilities: [], environments: [{ key: 'test', name: 'Test', critical: false }] }, flags: { items: [], loadedAt: NOW }, segments: { test: [] }, contextKinds: ['user'] },
      connected: true,
      ldEnvs: [{ key: 'test', name: 'Test', critical: false }],
      profile: { version: 1, sources: { [web.source.sourceId]: { envMapping: { staging: 'test' }, unitTypeKinds: {} } }, attributes: {}, policies: {} },
      resolutions: new Map(),
      resolutionList: [],
      capabilities: CAPS,
      directory: { members: [], teams: [], membersReadable: false, teamsReadable: false },
      idLists: {},
      coverage: {},
      now: NOW,
      exclusions: new Map(),
      resolve: vi.fn(),
      saveResolutions: vi.fn(),
      setPolicy: vi.fn(),
    } as unknown as MigrationContext;
    // Accept the recommended answers first, so the plan has steps and only the check holds the
    // buttons. A new map each round, as useMigration makes one: the mapping memo keys on it.
    for (let i = 0; i < 5; i++) {
      const plan = buildPlan({ ...m, selection: { gates: [gate.uid], autotunes: [] }, ldEnvs: ['test'], snapshots: [web] });
      if (plan.decisions.length === 0) break;
      const answers = plan.decisions.map((d): [string, Resolution] => [d.id, { id: d.id, type: d.type, optionKey: d.recommended ?? d.options[0]!.key, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW }]);
      (m as { resolutions: ReadonlyMap<string, unknown> }).resolutions = new Map([...m.resolutions, ...answers]);
    }
    const src: SourceRecord = { id: web.source.sourceId, workspaceId: 'w', alias: 'web', label: 'acme-web', kind: 'config_spec', createdAt: NOW };
    render(<MigrateModal workspaceId="w" selection={{ gates: [gate.uid], autotunes: [] }} ldEnvs={['test']} sources={[src]} snapshots={[web]} m={m} onClose={vi.fn()} />);
    // The plan is on screen before the read completes, and the footer says the read is in progress.
    expect(screen.getAllByText('new_checkout_flow').length).toBeGreaterThan(0);
    expect(screen.getByText('Checking LaunchDarkly for the latest state…')).toBeTruthy();
    const dryRun = screen.getByRole('button', { name: 'Dry run' }) as HTMLButtonElement;
    expect(dryRun.disabled).toBe(true);
    expect(refresh.calls).toBe(1);
    await act(async () => {
      refresh.resolve();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText('Checking LaunchDarkly for the latest state…')).toBeNull();
    expect(screen.queryByText(/Could not read the latest LaunchDarkly state/)).toBeNull();
    expect(dryRun.disabled).toBe(false);
  });
});

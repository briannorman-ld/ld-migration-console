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
import { EnvChooser, envChoices, FlagsTable, MigrateModal, RunProgress } from './MigrateModal.tsx';
import type { RunRecord, StepRecord } from '@sslm/executor';

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

  it('caps a long flag list so the environment choice and the buttons stay in view, with a button for the rest', () => {
    const base: Omit<PlanFlag, 'ldKey' | 'uid' | 'entityId'> = { kind: 'gate', sourceId: 's-web', flagKind: 'boolean', variations: [{ value: true, name: 'Pass' }, { value: false, name: 'Fail' }], exists: false, owned: false, adopt: false, status: 'ready', envs: [{ ldEnv: 'test', status: 'ready' }] };
    const flags: PlanFlag[] = Array.from({ length: 95 }, (_, i) => ({ ...base, uid: `s-web/gate/g${i}`, entityId: `g${i}`, ldKey: `gate_${i}` }));
    render(<FlagsTable flags={flags} />);
    expect(screen.getAllByRole('row')).toHaveLength(41);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 95 flags (55 more)' }));
    expect(screen.getAllByRole('row')).toHaveLength(96);
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
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
    // The environment choice comes before the flag list, so it is in view however long the plan is.
    const envSection = screen.getByRole('region', { name: 'Environment targeting' });
    const flagsSection = screen.getByRole('region', { name: 'Flags' });
    expect(envSection.compareDocumentPosition(flagsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

describe('run progress', () => {
  afterEach(cleanup);
  const stepRec = (i: number, status: StepRecord['status']): StepRecord => ({ id: `context_kind:k${i}`, label: `Context kind k${i}`, status, step: { id: `context_kind:k${i}`, deps: [], op: 'ensure_context_kind', key: `k${i}`, name: `k${i}`, unitType: `k${i}Key` } });
  const bigRun = (): RunRecord => ({
    id: 'r',
    workspaceId: 'w',
    projectKey: 'p',
    label: 'big',
    dryRun: false,
    startedAt: '2026-11-02T10:00:00Z',
    status: 'running',
    steps: [...Array.from({ length: 300 }, (_, i) => stepRec(i, i === 7 ? 'failed' : 'done')), stepRec(300, 'running'), ...Array.from({ length: 2000 }, (_, i) => stepRec(301 + i, 'pending'))],
  });

  it('lists a window around the running step, keeps failed steps in view, and can show everything', () => {
    render(<RunProgress run={bigRun()} title="Migrating" />);
    const rows = () => screen.getAllByRole('listitem');
    // 12 before + the running one + 19 after, the failed step from above, and the two summaries.
    expect(rows().length).toBeLessThan(40);
    expect(screen.getByText('Context kind k300')).toBeTruthy();
    expect(screen.getByText('Context kind k7')).toBeTruthy();
    expect(screen.queryByText('Context kind k0')).toBeNull();
    expect(screen.getByText(/288 earlier steps \(287 done, 1 failed\)/)).toBeTruthy();
    // Number formatting follows the runtime's locale; the count is what matters.
    const more = screen.getByText(/more steps \(.* pending\)/).textContent ?? '';
    expect(more.replace(/[,.\u202f\u00a0]/g, '')).toMatch(/^1981 more steps \(1981 pending\)$/);
    fireEvent.click(screen.getByRole('button', { name: /^Show all .*steps$/ }));
    expect(rows().length).toBe(2301);
  });

  it('counts failed steps and distinct errors in the header, and reports them once the run has finished', () => {
    const run = bigRun();
    run.steps[7] = { ...run.steps[7]!, error: 'LaunchDarkly 400 for /flags/p: At least two variations must be defined' };
    run.steps[8] = { ...run.steps[8]!, status: 'failed', error: 'LaunchDarkly 400 for /flags/p: At least two variations must be defined' };
    run.steps[9] = { ...run.steps[9]!, status: 'failed', error: 'Flag “k9” appeared since planning and wasn\'t created by this app. Re-plan to decide.' };
    const { unmount } = render(<RunProgress run={run} title="Migrating" />);
    expect(screen.getByText('3 failed · 2 distinct errors')).toBeTruthy();
    // Still running: no report yet.
    expect(screen.queryByLabelText('Errors')).toBeNull();
    unmount();
    render(<RunProgress run={{ ...run, status: 'failed', finishedAt: '2026-11-02T12:00:00Z' }} title="Operations" />);
    const report = screen.getByLabelText('Errors');
    expect(report.textContent).toContain('3 steps failed');
    expect(report.textContent).toContain('2 distinct errors');
    fireEvent.click(screen.getByText('LaunchDarkly 400 for /flags/p: At least two variations must be defined'));
    expect(report.textContent).toContain('Context kind k7');
    expect(report.textContent).toContain('Context kind k8');
    expect(screen.getByRole('button', { name: 'Download report' })).toBeTruthy();
  });
});

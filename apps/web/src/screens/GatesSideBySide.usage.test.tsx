import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Gate } from '@sslm/canonical';
import type { MappingProfile } from '@sslm/mapper';
import type { ExclusionRecord, SourceRecord } from '@sslm/store';
import type { MigrationContext } from '../lib/useMigration.ts';
import { FlagSideBySide } from './GatesSideBySide.tsx';

const SRC = { sourceId: 's-web', sourceKind: 'console_api' as const, alias: 'web' };
const source: SourceRecord = { id: 's-web', workspaceId: 'w', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-11-02T10:00:00Z' };

function gate(id: string, over: Partial<Gate>): Gate {
  return { kind: 'gate', uid: `s-web/gate/${id}`, id, name: id, source: SRC, completeness: { missing: [] }, tags: [], targetApps: [], enabled: true, idType: 'userID', holdoutIds: [], overrides: [], rules: [], archived: false, ...over } as Gate;
}

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-02T00:00:00Z');
  s.environments = [{ name: 'production', isProduction: true, inferred: false }];
  s.gates = [
    gate('busy_gate', { usage: { exposuresPastDay: 1_152_000, exposuresPast7Days: 8_064_000 } }),
    gate('dead_gate', { usage: { exposuresPastDay: 0, exposuresPast7Days: 0, productionChecksPast7Days: false } }),
    gate('quiet_gate', { usage: { exposuresPastDay: 0, exposuresPast7Days: 0, productionChecksPast7Days: true } }),
  ];
  return s;
}

function Harness({ m }: { m: MigrationContext }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <>
      <output data-testid="selection">{[...selected].sort().join(',')}</output>
      <FlagSideBySide kind="gate" sources={[source]} snapshots={{ 's-web': snapshot() }} env="production" m={m} onMigrate={vi.fn()} onOpenMapping={vi.fn()} selected={selected} setSelected={setSelected} />
    </>
  );
}

function setup(exclusions: ExclusionRecord[] = []) {
  const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-web': { envMapping: { production: 'production' }, unitTypeKinds: {} } } };
  const exclude = vi.fn(() => Promise.resolve());
  const include = vi.fn(() => Promise.resolve());
  const m = {
    profile,
    resolutions: new Map(),
    resolutionList: [],
    idLists: {},
    coverage: {},
    now: '2026-11-02T12:00:00Z',
    connected: false,
    ldEnvs: [],
    ld: { status: 'disconnected' },
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
    exclusions: new Map(exclusions.map((e) => [e.uid, e])),
    exclude,
    include,
    resolve: vi.fn(() => Promise.resolve()),
    setPolicy: vi.fn(() => Promise.resolve()),
  } as unknown as MigrationContext;
  render(<Harness m={m} />);
  return { exclude, include };
}

const rowOf = (id: string) => screen.getByText(id).closest('tr')!;

describe('Gates explorer: usage column and "Don\'t migrate" (edge case 14.11)', () => {
  afterEach(cleanup);

  it('shows 7-day usage per gate and tells "unused" from "checked, no exposures"', () => {
    setup();
    expect(within(rowOf('busy_gate')).getByText('8.1M in 7 d')).toBeTruthy();
    expect(within(rowOf('dead_gate')).getByText('no checks in 7 days')).toBeTruthy();
    expect(within(rowOf('quiet_gate')).getByText('checked, no exposures')).toBeTruthy();
  });

  it('filters to gates with no exposures and explains the caveat', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'no_exposures' } });
    expect(screen.queryByText('busy_gate')).toBeNull();
    expect(screen.getByText('dead_gate')).toBeTruthy();
    expect(screen.getByText('quiet_gate')).toBeTruthy();
    expect(screen.getByText(/2 gates logged no exposures/).textContent).toMatch(/exposure logging off/);
  });

  it('sets a gate aside from its row, with the usage reason suggested', () => {
    const { exclude } = setup();
    fireEvent.click(screen.getByText('dead_gate'));
    const reason = screen.getByLabelText('Reason not to migrate dead_gate') as HTMLInputElement;
    expect(reason.value).toBe('No checks in StatSig in the past 7 days');
    fireEvent.click(screen.getByText("Don't migrate this gate"));
    expect(exclude).toHaveBeenCalledWith(['s-web/gate/dead_gate'], 'No checks in StatSig in the past 7 days');
  });

  it('a set-aside gate stays listed but cannot be selected, and can be brought back', () => {
    const { include } = setup([{ workspaceId: 'w', uid: 's-web/gate/dead_gate', reason: 'Hard-coded instead', markedAt: '2026-11-02T11:00:00Z' }]);
    const dead = rowOf('dead_gate');
    expect(within(dead).getByText('set aside')).toBeTruthy();
    expect((within(dead).getByLabelText('Select dead_gate') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByTestId('selection').textContent).toBe('s-web/gate/busy_gate,s-web/gate/quiet_gate');
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'set_aside' } });
    expect(screen.queryByText('busy_gate')).toBeNull();
    fireEvent.click(screen.getByText('dead_gate'));
    expect(screen.getByText('Hard-coded instead')).toBeTruthy();
    fireEvent.click(screen.getByText('Migrate it after all'));
    expect(include).toHaveBeenCalledWith(['s-web/gate/dead_gate']);
  });

  it('"Don\'t migrate these" marks the whole selection and clears it', () => {
    const { exclude } = setup();
    fireEvent.click(screen.getByLabelText('Select dead_gate'));
    fireEvent.click(screen.getByLabelText('Select quiet_gate'));
    fireEvent.click(screen.getByText("Don't migrate these"));
    expect(exclude).toHaveBeenCalledWith(['s-web/gate/dead_gate', 's-web/gate/quiet_gate'], 'No exposures in StatSig in the past 7 days');
  });
});

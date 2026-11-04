import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Gate, type Rule } from '@sslm/canonical';
import type { MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import type { MigrationContext } from '../lib/useMigration.ts';
import { FlagSideBySide, isOffIn } from './GatesSideBySide.tsx';

const SRC = { sourceId: 's-web', sourceKind: 'console_api' as const, alias: 'web' };
const source: SourceRecord = { id: 's-web', workspaceId: 'w', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-11-02T10:00:00Z' };
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12);

function rule(id: string, environments: string[] | null): Rule {
  return { id, name: id, passPercentage: 100, conditions: [{ type: 'public', operator: null, targetValue: null, field: null }] as Rule['conditions'], environments, idType: 'userID' };
}

function gate(id: string, over: Partial<Gate>): Gate {
  return { kind: 'gate', uid: `s-web/gate/${id}`, id, name: id, source: SRC, completeness: { missing: [] }, tags: [], targetApps: [], enabled: true, idType: 'userID', holdoutIds: [], overrides: [], rules: [rule(`${id}-r`, null)], archived: false, ...over } as Gate;
}

const GATES: Gate[] = [
  gate('live_gate', { createdTime: NOW - 400 * DAY, lastModifiedTime: NOW - 2 * DAY }),
  gate('toggled_off', { enabled: false, createdTime: NOW - 30 * DAY }),
  gate('status_disabled', { status: 'Disabled', createdTime: NOW - 10 * DAY }),
  gate('no_rules', { rules: [], createdTime: NOW - 200 * DAY }),
  gate('staging_only', { rules: [rule('st', ['staging'])] }),
  gate('override_only', { rules: [], overrides: [{ unitType: 'userID', ids: ['u1'], value: { kind: 'gate', pass: true }, environment: 'production' }] }),
  gate('fail_override_only', { rules: [], overrides: [{ unitType: 'userID', ids: ['u1'], value: { kind: 'gate', pass: false }, environment: null }] }),
];

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-02T00:00:00Z');
  s.environments = [{ name: 'production', isProduction: true, inferred: false }, { name: 'staging', isProduction: false, inferred: false }];
  s.gates = GATES;
  return s;
}

function Harness({ m }: { m: MigrationContext }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return <FlagSideBySide kind="gate" sources={[source]} snapshots={{ 's-web': snapshot() }} env="production" m={m} onMigrate={vi.fn()} onOpenMapping={vi.fn()} selected={selected} setSelected={setSelected} />;
}

function setup() {
  const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-web': { envMapping: { production: 'production' }, unitTypeKinds: {} } } };
  const m = {
    profile, resolutions: new Map(), resolutionList: [], idLists: {}, coverage: {}, now: '2026-11-02T12:00:00Z', connected: false, ldEnvs: [],
    ld: { status: 'disconnected' }, capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
    exclusions: new Map(), exclude: vi.fn(), include: vi.fn(), resolve: vi.fn(), setPolicy: vi.fn(),
  } as unknown as MigrationContext;
  render(<Harness m={m} />);
}

const shown = () => [...document.querySelectorAll('tbody tr span.font-mono')].map((e) => e.textContent);
const rowOf = (id: string) => screen.getByText(id).closest('tr')!;
const filterTo = (value: string) => fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value } });

describe('Gates explorer: "off" filters', () => {
  afterEach(cleanup);

  it('tells a disabled gate (toggle or status) from one that merely passes nobody', () => {
    expect(isOffIn(GATES[1]!, 'production')).toBe(true);
    expect(isOffIn(GATES[3]!, 'production')).toBe(true);
    expect(isOffIn(GATES[4]!, 'production')).toBe(true);
    expect(isOffIn(GATES[4]!, 'staging')).toBe(false);
    expect(isOffIn(GATES[5]!, 'production')).toBe(false);
    expect(isOffIn(GATES[6]!, 'production')).toBe(true);
    expect(isOffIn(GATES[0]!, 'production')).toBe(false);
  });

  it('"Disabled in StatSig" keeps only gates whose toggle is off', () => {
    setup();
    expect(screen.getByRole('option', { name: 'Disabled in StatSig (2)' })).toBeTruthy();
    filterTo('disabled');
    expect(shown()).toEqual(['status_disabled', 'toggled_off']);
  });

  it('"Passes nobody in production" adds gates with no applicable rule and no pass override here', () => {
    setup();
    expect(screen.getByRole('option', { name: 'Passes nobody in production (5)' })).toBeTruthy();
    filterTo('off_here');
    expect(shown()).toEqual(['fail_override_only', 'no_rules', 'staging_only', 'status_disabled', 'toggled_off']);
    expect(within(rowOf('no_rules')).getByText('passes nobody')).toBeTruthy();
    expect(within(rowOf('toggled_off')).getByText('disabled')).toBeTruthy();
    expect(within(rowOf('toggled_off')).queryByText('passes nobody')).toBeNull();
  });
});

describe('Gates explorer: Created column', () => {
  afterEach(cleanup);

  it('shows the StatSig creation date, a dash without one, and the last change in the tooltip', () => {
    setup();
    const cell = within(rowOf('live_gate')).getByText(/2025/);
    expect(cell.tagName).toBe('TIME');
    expect(cell.getAttribute('title')).toMatch(/^Created .*\nLast changed /);
    expect(within(rowOf('staging_only')).getByTitle('No creation date from StatSig').textContent).toBe('—');
  });

  it('sorts by creation date, newest first then oldest first, with undated gates last in their usual order', () => {
    setup();
    const header = screen.getByRole('button', { name: /Created/ });
    fireEvent.click(header);
    expect(header.closest('th')!.getAttribute('aria-sort')).toBe('descending');
    expect(shown()).toEqual(['status_disabled', 'toggled_off', 'no_rules', 'live_gate', 'fail_override_only', 'override_only', 'staging_only']);
    fireEvent.click(header);
    expect(header.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    expect(shown()).toEqual(['live_gate', 'no_rules', 'toggled_off', 'status_disabled', 'fail_override_only', 'override_only', 'staging_only']);
    fireEvent.click(header);
    expect(header.closest('th')!.getAttribute('aria-sort')).toBe('none');
  });
});

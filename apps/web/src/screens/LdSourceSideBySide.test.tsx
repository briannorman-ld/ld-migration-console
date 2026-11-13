import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type NeutralFlag } from '@sslm/canonical';
import type { MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import type { MigrationContext } from '../lib/useMigration.ts';
import { flagOwner, LdSourceSideBySide } from './LdSourceSideBySide.tsx';

const SRC = { sourceId: 's-hog', sourceKind: 'posthog' as const, alias: 'hog' };
const source: SourceRecord = { id: 's-hog', workspaceId: 'w', alias: 'hog', label: 'acme-hog', kind: 'posthog', createdAt: '2026-11-12T10:00:00Z' };

/** A PostHog flag on the neutral model: `maintainer` is the creator's email, never a name. */
const flag = (key: string, maintainer?: NeutralFlag['maintainer']): NeutralFlag => ({
  kind: 'flag',
  uid: `s-hog/flag/${key}`,
  key,
  name: key,
  description: '',
  flagKind: 'boolean',
  variations: [{ value: true }, { value: false }],
  tags: [],
  temporary: false,
  archived: false,
  customProperties: {},
  experiments: [],
  environments: [{ env: 'production', on: true, offVariation: 1, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] }],
  ...(maintainer ? { maintainer } : {}),
});

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-12T00:00:00Z');
  s.environments = [{ name: 'production', isProduction: true, inferred: false }];
  // The organization's members, as the PostHog normalizer fills them.
  s.users = [{ id: 'u-bob', email: 'Bob@acme.example', name: 'Bob Okafor' }, { email: 'dana@acme.example' }];
  s.neutral = {
    flags: [flag('hog_checkout', { id: '7', email: 'bob@acme.example' }), flag('hog_search', { email: 'dana@acme.example' }), flag('hog_orphan')],
    segments: [],
    contextKinds: [{ key: 'user', name: 'user' }],
  } as CanonicalSnapshot['neutral'];
  return s;
}

function Harness({ m }: { m: MigrationContext }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const nav = { connections: vi.fn(), ld: vi.fn(), mapping: vi.fn(), unitTypes: vi.fn(), decisions: vi.fn() };
  return <LdSourceSideBySide resource="flag" sources={[source]} snapshots={{ 's-hog': snapshot() }} env="production" m={m} onMigrate={vi.fn()} nav={nav} selected={selected} setSelected={setSelected} />;
}

function setup() {
  const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-hog': { envMapping: { production: 'production' }, unitTypeKinds: {} } } };
  const m = {
    profile,
    resolutions: new Map(),
    resolutionList: [],
    idLists: {},
    coverage: {},
    now: '2026-11-12T12:00:00Z',
    connected: false,
    ldEnvs: [],
    ld: { status: 'disconnected' },
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
    directory: { members: [], teams: [], membersReadable: false, teamsReadable: false },
    exclusions: new Map(),
    resolve: vi.fn(() => Promise.resolve()),
    setPolicy: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  } as unknown as MigrationContext;
  render(<Harness m={m} />);
}

// The key appears twice in a row (source and target columns); either leads to the row.
const rowOf = (key: string) => screen.getAllByText(key)[0]!.closest('tr')!;

describe('Neutral-source explorer: the flag owner in the detail', () => {
  afterEach(cleanup);

  it('shows the maintainer email with the name from the member list, and nothing for a flag without a maintainer', () => {
    setup();
    expect(screen.queryByTestId('flag-owner')).toBeNull();
    fireEvent.click(rowOf('hog_checkout'));
    const owner = screen.getByTestId('flag-owner');
    expect(within(owner).getByText('bob@acme.example')).toBeTruthy();
    expect(within(owner).getByText('Bob Okafor')).toBeTruthy();
    // A member the list knows only by email shows the email alone.
    fireEvent.click(rowOf('hog_search'));
    const dana = screen.getByTestId('flag-owner');
    expect(within(dana).getByText('dana@acme.example')).toBeTruthy();
    expect(dana.textContent).not.toContain('Bob');
    // No maintainer: the detail opens without an owner line.
    fireEvent.click(rowOf('hog_orphan'));
    expect(screen.getAllByText(/off serves/).length).toBeGreaterThan(0); // the source and target panels both render it
    expect(screen.queryByTestId('flag-owner')).toBeNull();
  });

  it('flagOwner: an email is matched to the member list case-insensitively, a team key stands alone, a bare member ID is nothing to show', () => {
    const users = [{ id: 'u-bob', email: 'Bob@acme.example', name: 'Bob Okafor' }];
    expect(flagOwner(flag('a', { email: 'BOB@acme.example' }), users)).toEqual({ email: 'bob@acme.example', name: 'Bob Okafor' });
    expect(flagOwner(flag('b', { email: 'dana@acme.example' }), users)).toEqual({ email: 'dana@acme.example' });
    expect(flagOwner(flag('c', { teamKey: 'platform' }), users)).toEqual({ teamKey: 'platform' });
    expect(flagOwner(flag('d', { id: '9' }), users)).toBeUndefined();
    expect(flagOwner(flag('e'), undefined)).toBeUndefined();
  });
});

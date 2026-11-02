import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalSnapshot, Segment } from '@sslm/canonical';
import type { SourceRecord } from '@sslm/store';
import { resetSecretsForTests, secrets } from '../lib/secrets.ts';
import { store } from '../lib/store.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { WarningsView } from './WarningsView.tsx';

/** StatSig's answer to GET /segments/{id}/id_list, by segment id; the key the client was built with is recorded. */
const statsig = vi.hoisted(() => ({ lists: {} as Record<string, string[]>, keys: [] as string[] }));
vi.mock('@sslm/statsig-client', async (orig) => ({
  ...(await orig<typeof import('@sslm/statsig-client')>()),
  StatsigConsoleClient: class {
    constructor(opts: { apiKey: string }) {
      statsig.keys.push(opts.apiKey);
    }
    async getIdList(id: string) {
      const ids = statsig.lists[id] ?? [];
      return { name: id, count: ids.length, ids };
    }
  },
}));

/** The pipeline worker's reconcile, in-process: hashes are the IDs themselves here. */
const reconcile = vi.fn(async (args: { ids?: string[]; rawCsv?: string; hashes?: string[]; count?: number }) => {
  const ids = args.ids ?? (args.rawCsv ?? '').split('\n').filter(Boolean);
  if (!args.hashes) return { ids, extra: [], coverage: { total: args.count ?? ids.length, matched: ids.length, missing: 0, extra: 0, verified: false } };
  const set = new Set(args.hashes);
  const matched = ids.filter((x) => set.has(x));
  return { ids: matched, extra: ids.filter((x) => !set.has(x)), coverage: { total: set.size, matched: matched.length, missing: set.size - matched.length, extra: ids.length - matched.length, verified: true } };
});
vi.mock('../pipeline/client.ts', () => ({ pipeline: () => ({ reconcileIdList: reconcile }) }));

const W = 'w-warnings';
const specSource: SourceRecord = { id: 'spec-1', workspaceId: W, alias: 'spec', label: 'acme-web (spec)', kind: 'config_spec', createdAt: '2026-10-22T10:00:00Z' };
const consoleSource: SourceRecord = { id: 'con-1', workspaceId: W, alias: 'web', label: 'acme-web', kind: 'console_api', baseUrl: 'https://statsigapi.net/console/v1', createdAt: '2026-10-22T10:00:00Z' };

const base = (sourceId: string, kind: 'config_spec' | 'console_api') => ({ source: { sourceId, sourceKind: kind }, completeness: { missing: [] as string[] }, tags: [], archived: false, targetApps: [] });
const segment = (sourceId: string, kind: 'config_spec' | 'console_api', id: string, idList: Segment['idList']): Segment =>
  ({ ...base(sourceId, kind), kind: 'segment', uid: `${sourceId}/segment/${id}`, id, name: id, segmentType: 'id_list', enabled: true, idType: 'userID', rules: [], idList }) as unknown as Segment;
const snapshot = (source: SourceRecord, segments: Segment[], warnings: unknown[] = []): CanonicalSnapshot =>
  ({
    schemaVersion: 1,
    source: { sourceId: source.id, sourceKind: source.kind, alias: source.alias },
    takenAt: '2026-10-22T10:05:00Z',
    completeness: { missing: [] },
    environments: [],
    unitTypes: [],
    tags: [],
    targetApps: [],
    users: [],
    gates: [],
    configs: [],
    segments,
    experiments: [],
    layers: [],
    holdouts: [],
    autotunes: [],
    metrics: [],
    paramStores: [],
    warnings,
  }) as unknown as CanonicalSnapshot;
const m = { idLists: {}, coverage: {} } as unknown as MigrationContext;

const partners = Array.from({ length: 12 }, (_, i) => `partner-${String(i + 1).padStart(5, '0')}`);
const hashedSeg = segment('spec-1', 'config_spec', 'wholesale_partners', { count: 12, hashed: { listName: 'wholesale_partners' } });

describe('Source warnings › ID lists', () => {
  beforeEach(async () => {
    resetSecretsForTests();
    statsig.lists = { wholesale_partners: partners };
    statsig.keys = [];
    reconcile.mockClear();
    for (const r of await store.listIdLists(W)) await store.deleteIdList(r.uid);
  });
  afterEach(cleanup);

  it('a config spec with no Console key: the list can be read from StatSig once a read-only key is entered here', async () => {
    render(<WarningsView workspaceId={W} sources={[specSource]} snapshots={{ 'spec-1': snapshot(specSource, [hashedSeg]) }} m={m} onResync={() => undefined} />);
    expect(await screen.findByText(/hashed: needs raw IDs/)).toBeTruthy();
    await screen.findByText(/Enter a read-only Console API key for this StatSig project/);
    const load = screen.getByRole('button', { name: 'Load from StatSig' }) as HTMLButtonElement;
    expect(load.disabled).toBe(true);
    // The CSV path is still there, as the fallback.
    expect(screen.getByRole('button', { name: 'Upload raw IDs' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Enter a Console API key' }));
    fireEvent.change(screen.getByLabelText('Console API key (read-only)'), { target: { value: 'console-readonly-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use key' }));
    expect(secrets.get('statsig', 'spec-1')).toBe('console-readonly-1');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Load from StatSig' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('id-list-access').textContent).toMatch(/key entered for this source/);

    fireEvent.click(screen.getByRole('button', { name: 'Load from StatSig' }));
    await waitFor(async () => expect((await store.listIdLists(W)).length).toBe(1));
    const [rec] = await store.listIdLists(W);
    expect(rec!.uid).toBe(hashedSeg.uid);
    expect(rec!.origin).toBe('console');
    expect(rec!.ids).toEqual(partners);
    expect(rec!.via).toBeUndefined();
    expect(rec!.coverage).toBeUndefined(); // no hash file: StatSig's own members are authoritative
    expect(statsig.keys).toContain('console-readonly-1');
    expect(await screen.findByText('loaded from StatSig')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload from StatSig' })).toBeTruthy();
  });

  it('a config spec borrows the key of a Console API source in the workspace, and checks the members against uploaded hashes', async () => {
    secrets.set('statsig', 'con-1', 'console-of-web', W);
    // The hash file knows 11 of the 12 members plus one the list no longer has: 1 missing, no "extra" (StatSig is authoritative).
    await store.saveIdListHashes({ uid: hashedSeg.uid, workspaceId: W, sourceId: 'spec-1', listName: 'wholesale_partners', uploadedAt: '2026-10-22T10:06:00Z', fileNames: ['wholesale_partners.txt'], hashes: [...partners.slice(0, 11), 'partner-gone'] });
    const snaps = { 'spec-1': snapshot(specSource, [hashedSeg]), 'con-1': snapshot(consoleSource, [segment('con-1', 'console_api', 'wholesale_partners', { count: 12, ids: partners })]) };
    render(<WarningsView workspaceId={W} sources={[specSource, consoleSource]} snapshots={snaps} m={m} onResync={() => undefined} />);

    await waitFor(() => expect(screen.getByTestId('id-list-access').textContent).toMatch(/through the Console API key of acme-web/));
    fireEvent.click(screen.getAllByRole('button', { name: 'Load from StatSig' })[0]!);
    await waitFor(async () => expect((await store.listIdLists(W)).some((r) => r.uid === hashedSeg.uid)).toBe(true));
    const rec = (await store.listIdLists(W)).find((r) => r.uid === hashedSeg.uid)!;
    expect(rec.via).toEqual({ sourceId: 'con-1', label: 'acme-web' });
    expect(rec.ids).toEqual(partners);
    expect(rec.coverage).toEqual({ total: 12, matched: 11, missing: 1, extra: 0, verified: true });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ ids: partners, count: 12 }));
    expect(new Set(statsig.keys)).toEqual(new Set(['console-of-web'])); // the access check and the read both use the borrowed key
    expect(await screen.findByText('loaded from StatSig via acme-web')).toBeTruthy();
    expect(screen.getByText('reconciled 91.6%')).toBeTruthy();
  });

  it('a Console API source loads a deferred list per row and names the budget for one above it', async () => {
    secrets.set('statsig', 'con-1', 'console-of-web', W);
    const deferred = segment('con-1', 'console_api', 'wholesale_partners', { count: 12 });
    const huge = segment('con-1', 'console_api', 'everyone_ever', { count: 400_000 });
    const warnings = [
      { code: 'fetch_skipped', path: '/segments/wholesale_partners/id_list', message: 'deferred' },
      { code: 'fetch_skipped', path: '/segments/everyone_ever/id_list', message: 'deferred' },
    ];
    render(<WarningsView workspaceId={W} sources={[consoleSource]} snapshots={{ 'con-1': snapshot(consoleSource, [deferred, huge], warnings) }} m={m} onResync={() => undefined} />);

    expect(await screen.findByText('above the Console API budget')).toBeTruthy();
    expect(screen.getAllByText('not loaded')).toHaveLength(2);
    const loads = await screen.findAllByRole('button', { name: 'Load from StatSig' });
    expect(loads).toHaveLength(1); // the huge list offers only the CSV upload
    await waitFor(() => expect((loads[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(loads[0]!);
    await waitFor(async () => expect((await store.listIdLists(W)).length).toBe(1));
    const [rec] = await store.listIdLists(W);
    expect(rec!.uid).toBe(deferred.uid);
    expect(rec!.origin).toBe('console');
    expect(rec!.coverage).toBeUndefined();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await screen.findByText('loaded')).toBeTruthy();
  });
});

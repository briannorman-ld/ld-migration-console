import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LdSession } from './ld.ts';

const refreshLdState = vi.fn(async () => undefined);
const listFlagStatuses = vi.fn(async () => ({}));
let session: LdSession = { status: 'connected', projectKey: 'p' };
vi.mock('./ld.ts', () => ({
  refreshLdState: (...a: unknown[]) => refreshLdState(...(a as [])),
  ldSessionSnapshot: () => session,
  ldClient: () => ({ listFlagStatuses }),
}));

const { checkMonitor } = await import('./monitor.ts');

const ld: LdSession = { status: 'connected', projectKey: 'p', matrix: { environments: [{ key: 'test', name: 'Test', critical: false }], capabilities: [] } as unknown as NonNullable<LdSession['matrix']> };

describe('checkMonitor', () => {
  beforeEach(() => {
    refreshLdState.mockClear();
    listFlagStatuses.mockClear();
  });

  it('re-reads the LaunchDarkly project by default (Refresh now, the 15-minute tick)', async () => {
    session = { status: 'connected', projectKey: 'p', flags: { items: [], loadedAt: '2026-11-03T09:00:00Z' }, stale: '2026-11-03T09:00:00Z' };
    await checkMonitor('w1', ld, []);
    expect(refreshLdState).toHaveBeenCalledTimes(1);
    expect(listFlagStatuses).toHaveBeenCalledWith('p', 'test');
  });

  it('with reuseListing, checks against the listing the session holds and reads only the flag statuses', async () => {
    session = { status: 'connected', projectKey: 'p', flags: { items: [], loadedAt: '2026-11-03T09:00:00Z' }, stale: '2026-11-03T09:00:00Z' };
    await checkMonitor('w2', ld, [], { reuseListing: true });
    expect(refreshLdState).not.toHaveBeenCalled();
    expect(listFlagStatuses).toHaveBeenCalledTimes(1);
  });

  it('with reuseListing but no listing yet, reads the project', async () => {
    session = { status: 'connected', projectKey: 'p' };
    await checkMonitor('w3', ld, [], { reuseListing: true });
    expect(refreshLdState).toHaveBeenCalledTimes(1);
  });

  it('a migrated flag keyed like an Object.prototype member gets no status from a listing without it (security review M4)', async () => {
    const f = {
      key: 'constructor',
      name: 'constructor',
      tags: ['migrated-from-statsig'],
      customProperties: { 'migration.id': { name: 'StatSig ID', value: ['constructor'] }, 'migration.source': { name: 'StatSig source', value: ['web'] }, 'migration.sync.test': { name: 'sync', value: ['fp', '1', '2026-01-01T00:00:00Z', 'dh'] } },
      variations: [],
      environments: {},
    };
    session = { status: 'connected', projectKey: 'p', flags: { items: [f as never], loadedAt: '2026-11-03T09:00:00Z' }, stale: '2026-11-03T09:00:00Z' };
    listFlagStatuses.mockResolvedValueOnce({});
    await checkMonitor('w4', ld, [], { reuseListing: true });
    const { store } = await import('./store.ts');
    expect(await store.listMonitorSamples('w4')).toEqual([]);
  });
});

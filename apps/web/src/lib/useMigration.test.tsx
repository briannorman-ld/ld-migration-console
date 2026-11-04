import 'fake-indexeddb/auto';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot } from '@sslm/canonical';
import { expectReconnect, reconnectSkipped } from './ld.ts';
import { store } from './store.ts';
import { useMigration } from './useMigration.ts';

const SRC = { sourceId: 's-web', sourceKind: 'console_api' as const, alias: 'web' };

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-03T00:00:00Z');
  s.environments = [{ name: 'production', isProduction: true, inferred: false }];
  return s;
}

/**
 * The context is rebuilt whenever anything in it changes, but its `inputs` (what the mapping memo
 * and the heavy walks key on) keep their identity across an LD session patch and an exclusion
 * change, and change on a decision save or a profile change.
 */
describe('useMigration', () => {
  afterEach(cleanup);

  it('keeps the mapping inputs stable across LD session patches and exclusions', async () => {
    const W = `w-${crypto.randomUUID()}`;
    await store.createWorkspace({ name: W });
    const snaps = [snapshot()];
    const { result } = renderHook(() => useMigration(W, snaps));
    await waitFor(() => expect(result.current).not.toBeNull());
    const m0 = result.current!;
    expect(m0.inputs.profile).toBe(m0.profile);

    // An LD session patch (here: the status) rebuilds the context, not the inputs.
    expectReconnect(W);
    await waitFor(() => expect(result.current!.ld.status).toBe('connecting'));
    expect(result.current).not.toBe(m0);
    expect(result.current!.inputs).toBe(m0.inputs);
    reconnectSkipped(W);
    await waitFor(() => expect(result.current!.ld.status).toBe('disconnected'));
    expect(result.current!.inputs).toBe(m0.inputs);

    // Setting an item aside changes the exclusions, not the inputs.
    await m0.exclude(['s-web/gate/x'], 'unused');
    await waitFor(() => expect(result.current!.exclusions.has('s-web/gate/x')).toBe(true));
    expect(result.current!.inputs).toBe(m0.inputs);

    // A decision save gives new inputs (a new resolutions map) with the same profile.
    await m0.saveResolutions([{ id: 'd1', type: 'case_insensitive_match', optionKey: 'x', scope: 'resource', decidedAt: '2026-11-03T00:00:00Z' }]);
    await waitFor(() => expect(result.current!.resolutions.has('d1')).toBe(true));
    const m1 = result.current!;
    expect(m1.inputs).not.toBe(m0.inputs);
    expect(m1.inputs.profile).toBe(m0.inputs.profile);

    // A policy gives a new profile; the people maps stay present for the memo (ensureProfile).
    await m1.setPolicy('case_insensitive_match', 'y');
    await waitFor(() => expect(result.current!.profile.policies.case_insensitive_match).toBe('y'));
    expect(result.current!.inputs).not.toBe(m1.inputs);
    expect(result.current!.profile.maintainers).toEqual({});
    expect(result.current!.profile.teams).toEqual({});
  });
});

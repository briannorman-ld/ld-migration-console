import { describe, expect, it } from 'vitest';
import { ldConnecting, probeStartPatch, type LdSession } from './ld.ts';

const matrix = { capabilities: [], environments: [] } as unknown as NonNullable<LdSession['matrix']>;
const connected: LdSession = { status: 'connected', projectKey: 'p1', matrix, flags: { items: [], loadedAt: 't' }, segments: { test: [] } };

describe('probeStartPatch', () => {
  it('keeps the matrix and flags while the same project is re-probed, so the app stays "connected"', () => {
    const patch = probeStartPatch(connected, 'p1');
    expect(patch).toEqual({ projectKey: 'p1', probing: 'Starting', error: undefined });
    expect('matrix' in patch).toBe(false);
    const next = { ...connected, ...patch };
    expect(next.status === 'connected' && !!next.matrix).toBe(true);
  });

  it('drops the old project state when switching projects', () => {
    const patch = probeStartPatch(connected, 'p2');
    expect(patch).toEqual({ projectKey: 'p2', probing: 'Starting', error: undefined, matrix: undefined, flags: undefined, segments: undefined, experiments: undefined });
  });

  it('a first probe (no matrix yet) clears as before', () => {
    expect(probeStartPatch({ status: 'connected', projectKey: 'p1' }, 'p1').matrix).toBeUndefined();
    expect('matrix' in probeStartPatch({ status: 'connected', projectKey: 'p1' }, 'p1')).toBe(true);
  });
});

describe('ldConnecting', () => {
  it('is true while the token is checked and while the first probe of the project runs', () => {
    expect(ldConnecting({ status: 'connecting' })).toBe(true);
    expect(ldConnecting({ status: 'connected', projectKey: 'p1', probing: 'Reading environments' })).toBe(true);
  });

  it('is false once the matrix is in, with no project chosen, on error, and when disconnected', () => {
    expect(ldConnecting(connected)).toBe(false);
    expect(ldConnecting({ ...connected, probing: 'Re-probing' })).toBe(false);
    expect(ldConnecting({ status: 'connected', projects: [] })).toBe(false);
    expect(ldConnecting({ status: 'error', error: 'Unauthorized' })).toBe(false);
    expect(ldConnecting({ status: 'disconnected' })).toBe(false);
    expect(ldConnecting(undefined)).toBe(false);
  });
});

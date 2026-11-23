/**
 * Scheduled changes of an LD source (PLAN §20.6): read per flag and environment, carried on the
 * flag's `scheduled_changes` caveat with an `env`, and applied by the mapper only in that
 * environment. An LD source raises no decision (PLAN §20.3): what can be scheduled is scheduled,
 * the rest is a note.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acmeLegacyProject, ACME_LEGACY_PROJECT_KEY, createLdApiHandlers } from '@sslm/demo-fixtures';
import { normalizeLdSnapshot, readLdProject } from '@sslm/adapters';
import { LdClient } from '@sslm/ld-client';
import { LD_DEFAULT_RESOURCES, type CanonicalSnapshot, type NeutralFlag } from '@sslm/canonical';
import { mapNeutralFlag, type MapArgs, type MapperCapabilities } from '../src/index.ts';
import { CAPS, DIRECTORY, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

const MAPPING = { test: 'test', production: 'production' };
let legacy: CanonicalSnapshot;
beforeAll(async () => {
  const origin = 'https://demo-ld.test';
  server.use(...createLdApiHandlers({ baseUrl: origin, getProject: acmeLegacyProject, token: 'api-test' }));
  const client = new LdClient({ instance: { id: 'us', label: 'test', origin }, token: 'api-test', transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5 } } });
  const raw = await readLdProject(client, ACME_LEGACY_PROJECT_KEY, { resources: [...LD_DEFAULT_RESOURCES, 'scheduled_changes'] });
  legacy = normalizeLdSnapshot(raw, { source: { sourceId: 'src-legacy', sourceKind: 'launchdarkly', alias: 'legacy' }, takenAt: '2026-11-23T00:00:00.000Z' });
});

const caps: MapperCapabilities = { ...CAPS, existingContextKinds: ['user', 'organization'], scheduledChanges: 'available' };
function args(key: string, env: string, over: Partial<MapArgs<NeutralFlag>> = {}): MapArgs<NeutralFlag> {
  const entity = legacy.neutral!.flags.find((f) => f.key === key)!;
  return { canonical: { snapshot: legacy }, entity, profile: profileFor(legacy, MAPPING), resolutions: new Map(), capabilities: caps, env: { statsig: env, ld: env }, now: NOW, directory: DIRECTORY, ...over };
}
const notes = (r: { fidelity: { notes: { message: string }[] } }) => r.fidelity.notes.map((n) => n.message);

describe('LD source scheduled changes (PLAN §20.6)', () => {
  it('schedules a flip in the environment it belongs to, with the flag’s whole targeting, and asks nothing', () => {
    const r = mapNeutralFlag(args('legacy-theme', 'production'));
    expect(r.unresolved).toEqual([]);
    expect(r.skipped).toBeUndefined();
    const sc = r.env.scheduledChanges!;
    expect(sc).toHaveLength(1);
    expect(Date.parse(sc[0]!.executionDate)).toBe(Date.UTC(2027, 5, 1, 9, 0, 0));
    expect(sc[0]!.state.on).toBe(true);
    // The current state is unchanged: the flip happens at the scheduled moment.
    expect(r.env.on).toBe(legacy.neutral!.flags.find((f) => f.key === 'legacy-theme')!.environments.find((e) => e.env === 'production')!.on);
  });

  it('applies only the environment’s own changes: the production flip is not scheduled in test', () => {
    const r = mapNeutralFlag(args('legacy-theme', 'test'));
    expect(r.unresolved).toEqual([]);
    expect(r.env.scheduledChanges).toBeUndefined();
    expect(notes(r).some((n) => /scheduled change/.test(n))).toBe(false);
  });

  it('schedules an added rule with the variation resolved on the target flag', () => {
    const r = mapNeutralFlag(args('legacy-pricing-tiers', 'test'));
    expect(r.unresolved).toEqual([]);
    const sc = r.env.scheduledChanges!;
    expect(sc).toHaveLength(1);
    const added = sc[0]!.state.rules.at(-1)!;
    expect(added.description).toBe('Plus for design partners');
    expect(added.clauses[0]).toMatchObject({ attribute: 'tier', op: 'in', values: ['design-partner'] });
    // `plus` is the second variation of the flag.
    expect(added.variation).toBe(1);
  });

  it('notes a change the console cannot translate instead of half-carrying it', () => {
    const r = mapNeutralFlag(args('legacy-kill-switch', 'production'));
    expect(r.unresolved).toEqual([]);
    expect(r.env.scheduledChanges).toBeUndefined();
    expect(notes(r).some((n) => /updateFallthroughVariationOrRollout/.test(n) && /not carried/.test(n))).toBe(true);
  });

  it('without scheduled changes on the target plan, migrates the current state and notes the pending change', () => {
    const r = mapNeutralFlag(args('legacy-theme', 'production', { capabilities: { ...caps, scheduledChanges: 'unavailable' } }));
    expect(r.unresolved).toEqual([]);
    expect(r.env.scheduledChanges).toBeUndefined();
    expect(notes(r).some((n) => /turnFlagOn/.test(n) && /not carried/.test(n))).toBe(true);
  });
});

import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acmeSnapshot, CAPS, NOW } from '../../../../packages/mapper/test/fixtures.ts';
import { server } from '../../../../packages/mapper/test/fixtures.ts';
import { collectDecisions, envTargets, mapGateFor, type MappingInputs } from './migration.ts';

/**
 * The explorers, Decisions view and readiness line all map the same entities on every render.
 * Mapping is memoized on (inputs, snapshot, entity, environment) so a click costs nothing.
 */
describe('mapping memo', () => {
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it('returns the same result object for the same inputs, and a fresh one once the inputs change', async () => {
    const web = await acmeSnapshot('web');
    const profile = { version: 1 as const, sources: {}, attributes: {}, policies: {} };
    const inputs: MappingInputs = { profile, resolutions: new Map(), capabilities: CAPS, directory: { members: [], teams: [], membersReadable: false, teamsReadable: false }, idLists: {}, coverage: {}, now: NOW };
    const env = envTargets(profile, web, false)[0]!;
    const gate = web.gates[0]!;

    const first = mapGateFor(web, gate, env, inputs);
    expect(mapGateFor(web, gate, env, inputs)).toBe(first);
    // collectDecisions reuses the explorer's results rather than mapping again.
    collectDecisions([web], profile, false, inputs);
    expect(mapGateFor(web, gate, env, inputs)).toBe(first);

    // A different environment, a new inputs object (a decision was saved) or a new snapshot (a sync) each miss.
    const other = envTargets(profile, web, false)[1]!;
    expect(mapGateFor(web, gate, other, inputs)).not.toBe(first);
    expect(mapGateFor(web, gate, env, { ...inputs })).not.toBe(first);
    expect(mapGateFor({ ...web }, gate, env, inputs)).not.toBe(first);
    // Equal content either way.
    expect(mapGateFor(web, gate, env, { ...inputs })).toEqual(first);
  });
});

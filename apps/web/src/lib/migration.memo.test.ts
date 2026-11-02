import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acmeSnapshot, CAPS, NOW } from '../../../../packages/mapper/test/fixtures.ts';
import { server } from '../../../../packages/mapper/test/fixtures.ts';
import { buildPlan, collectDecisions, envTargets, mapGateFor, type MappingInputs } from './migration.ts';

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

    // The MigrationContext is rebuilt on every LD session patch; made of the same parts, it still hits.
    expect(mapGateFor(web, gate, env, { ...inputs })).toBe(first);
    // A different environment, a new resolutions map (a decision was saved), a new profile, new ID
    // lists, a different `now` or a new snapshot (a sync) each miss.
    const other = envTargets(profile, web, false)[1]!;
    expect(mapGateFor(web, gate, other, inputs)).not.toBe(first);
    expect(mapGateFor(web, gate, env, { ...inputs, resolutions: new Map() })).not.toBe(first);
    expect(mapGateFor(web, gate, env, { ...inputs, profile: { ...profile } })).not.toBe(first);
    expect(mapGateFor(web, gate, env, { ...inputs, idLists: {} })).not.toBe(first);
    expect(mapGateFor(web, gate, env, { ...inputs, now: '2026-01-01T00:00:00.000Z' })).not.toBe(first);
    expect(mapGateFor({ ...web }, gate, env, inputs)).not.toBe(first);
    // Equal content either way.
    expect(mapGateFor(web, gate, env, { ...inputs, resolutions: new Map() })).toEqual(first);
  });

  it('a plan maps through the same memo, so the modal rebuilds without mapping again', async () => {
    const web = await acmeSnapshot('web');
    const profile = { version: 1 as const, sources: { [web.source.sourceId]: { envMapping: { staging: 'test' }, unitTypeKinds: {} } }, attributes: {}, policies: {} };
    const inputs: MappingInputs = { profile, resolutions: new Map(), capabilities: CAPS, directory: { members: [], teams: [], membersReadable: false, teamsReadable: false }, idLists: {}, coverage: {}, now: NOW };
    const gate = web.gates[0]!;
    const ld = { status: 'connected', projectKey: 'p', matrix: { projectKey: 'p', instance: 'us', capabilities: [], environments: [{ key: 'test', name: 'Test', critical: false }] }, flags: { items: [], loadedAt: NOW }, segments: { test: [] }, contextKinds: ['user'] } as never;
    const before = mapGateFor(web, gate, { statsig: 'staging', ld: 'test' }, inputs);
    const plan = buildPlan({ ...inputs, ld, selection: { gates: [gate.uid], autotunes: [] }, ldEnvs: ['test'], snapshots: [web] });
    expect(plan.items.some((i) => i.uid === gate.uid)).toBe(true);
    expect(mapGateFor(web, gate, { statsig: 'staging', ld: 'test' }, inputs)).toBe(before);
  });
});

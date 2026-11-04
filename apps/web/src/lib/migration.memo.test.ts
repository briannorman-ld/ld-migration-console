import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acmeSnapshot, CAPS, NOW } from '../../../../packages/mapper/test/fixtures.ts';
import { server } from '../../../../packages/mapper/test/fixtures.ts';
import type { DecisionType } from '@sslm/mapper';
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
    // A different environment, a different `now` or a new snapshot (a sync) each miss; a new
    // profile or new ID lists miss only where they changed what this gate read (below).
    const other = envTargets(profile, web, false)[1]!;
    expect(mapGateFor(web, gate, other, inputs)).not.toBe(first);
    // Saving a decision rebuilds the resolutions map. A map that changes nothing this gate looked up
    // (another entity's decision, or an unrelated id) still hits; one that answers or alters one of
    // this gate's own decisions misses.
    const own = first.unresolved[0] ?? first.applied[0]?.decision;
    expect(own).toBeDefined();
    const unrelated = new Map([['someone-else', { id: 'someone-else', type: own!.type, optionKey: 'x', scope: 'resource' as const, decidedAt: NOW }]]);
    expect(mapGateFor(web, gate, env, { ...inputs, resolutions: unrelated })).toBe(first);
    expect(mapGateFor(web, gate, env, { ...inputs, resolutions: new Map() })).toBe(first);
    const answered = new Map([[own!.id, { id: own!.id, type: own!.type, optionKey: own!.options[0]!.key, scope: 'resource' as const, fingerprint: own!.fingerprint, decidedAt: NOW }]]);
    const second = mapGateFor(web, gate, env, { ...inputs, resolutions: answered });
    expect(second).not.toBe(first);
    // The same answer in a fresh map (a live query re-reads the records) is still a hit.
    const again = new Map([[own!.id, { ...answered.get(own!.id)!, decidedAt: '2026-02-02T00:00:00.000Z' }]]);
    expect(mapGateFor(web, gate, env, { ...inputs, resolutions: again })).toBe(second);
    // ID lists are tracked like resolutions: a new object (every list fetched after a sync is one)
    // that changes nothing this gate looked up still hits; a gate whose segment's list arrived misses.
    // (The memo keeps one entry per gate and environment, so the baseline is taken afresh here.)
    const base = mapGateFor(web, gate, env, inputs);
    expect(mapGateFor(web, gate, env, { ...inputs, idLists: {} })).toBe(base);
    const wholesale = web.gates.find((g) => g.id === 'wholesale_portal')!;
    const partners = web.segments.find((s) => s.id === 'wholesale_partners')!;
    const deferred = mapGateFor(web, wholesale, env, inputs);
    expect(mapGateFor(web, wholesale, env, { ...inputs, idLists: { 'someone-else': ['x'] } })).toBe(deferred);
    const fetched = mapGateFor(web, wholesale, env, { ...inputs, idLists: { [partners.uid]: ['partner-00001'] } });
    expect(fetched).not.toBe(deferred);
    // The same list object in a new map (a live query re-reads the records) is still a hit.
    const list = ['partner-00001'];
    const a = mapGateFor(web, wholesale, env, { ...inputs, idLists: { [partners.uid]: list } });
    expect(mapGateFor(web, wholesale, env, { ...inputs, idLists: { [partners.uid]: list, other: ['y'] } })).toBe(a);
    expect(mapGateFor(web, gate, env, { ...inputs, now: '2026-01-01T00:00:00.000Z' })).not.toBe(first);
    expect(mapGateFor({ ...web }, gate, env, inputs)).not.toBe(first);
    // The profile is tracked like the resolutions (lib/profileReads.ts): a new object with the same
    // entries hits, one that changes an entry this gate read (the policy for a decision it raised,
    // its source's env mapping) misses, and one that changes an entry it never read (another
    // type's policy) still hits. Nothing of the tracked profile may end up in the result: results
    // are cloned into plans and runs.
    const withPeople = { ...profile, maintainers: {}, teams: {} };
    const tracked = mapGateFor(web, gate, env, { ...inputs, profile: withPeople });
    expect(mapGateFor(web, gate, env, { ...inputs, profile: { ...withPeople } })).toBe(tracked);
    // A choice for another owner (the People step) touches nothing this gate read. (ensureProfile
    // keeps `maintainers` and `teams` present, so the first choice is not a change from "absent".)
    expect(mapGateFor(web, gate, env, { ...inputs, profile: { ...withPeople, maintainers: { 'nobody@example.com': 'unassigned' } } })).toBe(tracked);
    expect(() => structuredClone(tracked)).not.toThrow();
    const raisedTypes = new Set([...tracked.unresolved, ...tracked.applied.map((a) => a.decision)].map((d) => d.type));
    const unrelatedType = (['maintainer_unknown', 'unit_type_kind', 'client_side_availability', 'any_case_sensitivity'] as DecisionType[]).find((t) => !raisedTypes.has(t))!;
    expect(mapGateFor(web, gate, env, { ...inputs, profile: { ...withPeople, policies: { [unrelatedType]: 'x' } } })).toBe(tracked);
    const raised = tracked.unresolved[0] ?? tracked.applied[0]!.decision;
    expect(mapGateFor(web, gate, env, { ...inputs, profile: { ...withPeople, policies: { [raised.type]: raised.options[0]!.key } } })).not.toBe(tracked);
    expect(mapGateFor(web, gate, env, { ...inputs, profile: { ...withPeople, sources: { [web.source.sourceId]: { envMapping: { staging: 'test' }, unitTypeKinds: {} } } } })).not.toBe(tracked);
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

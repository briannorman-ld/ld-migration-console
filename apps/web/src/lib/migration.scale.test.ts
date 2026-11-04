import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { monitorRows } from '@sslm/monitoring';
import type { DecisionType, MappingProfile } from '@sslm/mapper';
import { acmeSnapshot, CAPS, DIRECTORY, NOW, server } from '../../../../packages/mapper/test/fixtures.ts';
import { collectDecisions, envTargets, mapConfigFor, mapGateFor, type MappingInputs } from './migration.ts';
import { monitoredItems } from './monitor.ts';
import { resolutionsFor } from './useMigration.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

let web: CanonicalSnapshot;
beforeAll(async () => {
  web = await acmeSnapshot('web');
});

/** The demo snapshot with `n` copies of one gate and one config: a project the size of a real StatSig account. */
function bigSnapshot(n: number): CanonicalSnapshot {
  const gateBase = web.gates.find((g) => g.id === 'kill_switch_payments')!;
  const configBase = web.configs[0]!;
  const copies = <T extends { id: string; uid: string; name: string }>(base: T, prefix: string): T[] =>
    Array.from({ length: n }, (_, k) => {
      const id = `${prefix}_${k}`;
      return { ...base, id, uid: base.uid.replace(base.id, id), name: id };
    });
  return { ...web, gates: copies(gateBase, 'gate'), configs: copies(configBase, 'config') };
}

const time = (f: () => void): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
/** The best of three runs: the suite runs many files at once, and one run can land on a busy moment. */
const best = (f: () => void): number => Math.min(time(f), time(f), time(f));

/**
 * What WorkspaceScreen recomputes when the mapping inputs change: the decision list, the monitored
 * items and the monitor rows, each a walk over every entity in every environment through the
 * mapping memo (lib/migration.ts). On the main thread, so each must stay far below a frame budget's
 * worth of frozen page once the memo is warm. The walks run in 25–60 ms here on their own; the
 * bound is generous and fails only on a regression that remaps what did not change (a full remap
 * is half a second and more). Which results map again is asserted exactly.
 */
const WALK_BUDGET_MS = 250;
describe('mapping at scale', () => {
  it('a decision save, a maintainer choice and a narrow policy re-map only what consulted them', { timeout: 120_000 }, () => {
    const snap = bigSnapshot(1600);
    const profile: MappingProfile = {
      version: 1,
      sources: { [snap.source.sourceId]: { envMapping: { development: 'development', staging: 'staging', production: 'production', qa: null }, unitTypeKinds: {} } },
      attributes: {},
      policies: {},
      maintainers: {},
      teams: {},
    };
    let inputs: MappingInputs = { profile, resolutions: new Map(), capabilities: CAPS, directory: DIRECTORY, idLists: {}, coverage: {}, now: NOW };
    const walk = (i: MappingInputs) => {
      const decisions = collectDecisions([snap], i.profile, true, i);
      const items = monitoredItems([snap], i, true);
      const rows = monitorRows({ items, ldFlags: new Map(), statuses: {}, settings: [], samples: [], now: NOW });
      return { decisions, items, rows };
    };
    const env = envTargets(profile, snap, true)[0]!;
    const log: string[] = [];

    let first!: ReturnType<typeof walk>;
    log.push(`cold walk ${time(() => (first = walk(inputs))).toFixed(0)} ms (${first.items.length} mappings)`);
    expect(first.items.length).toBeGreaterThanOrEqual(2 * 1600 * 3);
    const warm = best(() => walk(inputs));
    log.push(`same inputs ${warm.toFixed(0)} ms`);
    expect(warm).toBeLessThan(WALK_BUDGET_MS);

    // A decision save: a new resolutions map answering one gate's first open decision.
    const gate0 = mapGateFor(snap, snap.gates[0]!, env, inputs);
    const gate1 = mapGateFor(snap, snap.gates[1]!, env, inputs);
    const config0 = mapConfigFor(snap, snap.configs[0]!, env, inputs);
    const open = gate0.unresolved[0]!;
    inputs = { ...inputs, resolutions: new Map(resolutionsFor([open], open.options[0]!.key, NOW).map((r) => [r.id, r])) };
    const save = best(() => walk(inputs));
    log.push(`decision save ${save.toFixed(0)} ms`);
    expect(save).toBeLessThan(WALK_BUDGET_MS);
    expect(mapGateFor(snap, snap.gates[0]!, env, inputs)).not.toBe(gate0);
    expect(mapGateFor(snap, snap.gates[1]!, env, inputs)).toBe(gate1);

    // A People-step choice: a new profile whose `maintainers` gained an owner nobody here has.
    inputs = { ...inputs, profile: { ...inputs.profile, maintainers: { 'nobody@acmeretail.example': { memberId: 'mem-nobody' } } } };
    const maintainer = best(() => walk(inputs));
    log.push(`maintainer choice ${maintainer.toFixed(0)} ms`);
    expect(maintainer).toBeLessThan(WALK_BUDGET_MS);
    expect(mapConfigFor(snap, snap.configs[0]!, env, inputs)).toBe(config0);

    // A policy on a decision type only the configs raise: every config maps again, no gate does.
    const typesOf = (kind: string) => new Set(first.decisions.filter((d) => d.decision.subject.kind === kind).map((d) => d.decision.type));
    const gateTypes = typesOf('gate');
    const configOnly = [...typesOf('config')].find((t) => !gateTypes.has(t))!;
    const option = first.decisions.find((d) => d.decision.type === configOnly)!.decision.options[0]!.key;
    inputs = { ...inputs, profile: { ...inputs.profile, policies: { [configOnly]: option } } };
    const narrow = time(() => walk(inputs));
    log.push(`policy on ${configOnly} (configs only) ${narrow.toFixed(0)} ms`);
    expect(mapGateFor(snap, snap.gates[1]!, env, inputs)).toBe(gate1);
    expect(mapConfigFor(snap, snap.configs[0]!, env, inputs)).not.toBe(config0);

    // A policy on a type every item raises re-maps every item: the one change left that costs a
    // full walk of the mapper (about 55 µs per mapping here).
    const everyType = [...gateTypes].find((t) => typesOf('config').has(t)) as DecisionType;
    const everyOption = first.decisions.find((d) => d.decision.type === everyType)!.decision.options[0]!.key;
    inputs = { ...inputs, profile: { ...inputs.profile, policies: { ...inputs.profile.policies, [everyType]: everyOption } } };
    log.push(`policy on ${everyType} (every item) ${time(() => walk(inputs)).toFixed(0)} ms`);
    console.log(log.join('\n'));
  });
});

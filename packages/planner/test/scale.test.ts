import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { planMigration, recommendedResolutions, type LdProjectState, type PlanRequest } from '../src/index.ts';
import { acmeSnapshot, CAPS, DIRECTORY, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

let web: CanonicalSnapshot;
beforeAll(async () => {
  web = await acmeSnapshot('web');
});

const EMPTY_LD: LdProjectState = { flags: new Map(), segments: {}, contextKinds: ['user'], criticalEnvs: ['production'] };

/** The demo snapshot with `n` copies of one gate: a project the size of a real StatSig account. */
function bigSnapshot(n: number): CanonicalSnapshot {
  const base = web.gates.find((g) => g.id === 'kill_switch_payments')!;
  const gates = Array.from({ length: n }, (_, k) => {
    const id = `gate_${k}`;
    return { ...base, id, uid: base.uid.replace(base.id, id), name: id };
  });
  return { ...web, gates };
}

/** Accept every decision, so the plan has steps (what a user who clicked through sees). */
function accepted(req: PlanRequest): PlanRequest {
  let r = req;
  for (let i = 0; i < 4; i++) {
    const p = planMigration(r);
    if (p.decisions.length === 0) break;
    const res = new Map(r.resolutions);
    for (const x of recommendedResolutions(p.decisions, NOW)) res.set(x.id, x);
    for (const d of p.decisions.filter((d) => d.severity === 'acknowledge')) res.set(d.id, { id: d.id, type: d.type, optionKey: d.recommended!, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW });
    r = { ...r, resolutions: res };
  }
  return r;
}

describe('planner at scale', () => {
  // The plan modal rebuilds the plan on every environment tick, on the main thread. Pruning and
  // ordering were once quadratic in the number of steps: 1,600 gates in three environments
  // (6,400 steps) took over five seconds and the browser showed "Page Unresponsive". The bound
  // here is generous (the linear version runs in about 120 ms); it fails only on a regression.
  it('plans 1,600 gates in three environments well under a second', { timeout: 60_000 }, () => {
    const snap = bigSnapshot(1600);
    const req = accepted({
      gates: snap.gates.map((g) => g.uid),
      ldEnvs: ['development', 'staging', 'production'],
      snapshots: [snap],
      profile: profileFor(snap, { development: 'development', staging: 'staging', production: 'production', qa: null }),
      resolutions: new Map(),
      capabilities: CAPS,
      directory: DIRECTORY,
      ld: EMPTY_LD,
      now: NOW,
    });
    const t = performance.now();
    const plan = planMigration(req);
    const ms = performance.now() - t;
    expect(plan.errors).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.steps).toHaveLength(6400);
    // Every shell first, then each environment in the order asked for.
    const ops = plan.steps.map((s) => (s.op === 'upsert_flag_shell' ? 'shell' : 'ldEnv' in s ? s.ldEnv : s.op));
    expect(ops.slice(0, 1600).every((o) => o === 'shell')).toBe(true);
    expect([...new Set(ops.slice(1600))]).toEqual(['development', 'staging', 'production']);
    expect(ms).toBeLessThan(2000);
  });
});

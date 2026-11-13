/**
 * End to end for a PostHog source (PLAN §22): the demo project "Acme Hog", read through the real
 * client and adapter against the MSW mock, planned by the real planner and written by the real
 * executor into the in-memory LaunchDarkly. What a user clicking "accept every recommendation" and
 * "migrate" gets, in one run: context kinds first, cohorts before the flags that match them,
 * prerequisites before their dependants, a scheduled change for the launch date, provenance on
 * every flag, and nothing written on a dry run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { planMigration, recommendedResolutions, type LdProjectState, type Plan, type PlanRequest } from '@sslm/planner';
import { Executor, newRun, type RunRecord } from '../src/index.ts';
import { CAPS, DIRECTORY, hogSnapshot, NOW, profileFor, server } from '../../planner/test/fixtures.ts';
import { fakeLd } from './fakeLd.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

let hog: CanonicalSnapshot;
beforeAll(async () => {
  hog = await hogSnapshot();
});

const EMPTY_LD: LdProjectState = { flags: new Map(), segments: {}, contextKinds: ['user'], criticalEnvs: ['production'] };
const live = () => hog.neutral!.flags.filter((f) => !f.archived);

function request(over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    gates: [],
    flags: live().map((f) => f.uid),
    ldEnvs: ['test'],
    snapshots: [hog],
    profile: profileFor(hog, { 'Acme Hog': 'test' }),
    resolutions: new Map(),
    capabilities: { ...CAPS, existingContextKinds: ['user'], bigSegments: 'available', scheduledChanges: 'available' },
    directory: DIRECTORY,
    ld: EMPTY_LD,
    now: NOW,
    ...over,
  };
}

/** Accept every recommended option and every acknowledgement, the way a user clicking through does. */
function acceptAll(req: PlanRequest): { req: PlanRequest; plan: Plan } {
  let r = req;
  let plan = planMigration(r);
  for (let i = 0; i < 6 && plan.decisions.length > 0; i++) {
    const res = new Map(r.resolutions);
    for (const x of recommendedResolutions(plan.decisions, NOW)) res.set(x.id, x);
    for (const d of plan.decisions.filter((d) => d.severity === 'acknowledge' && d.recommended)) res.set(d.id, { id: d.id, type: d.type, optionKey: d.recommended!, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW });
    if (res.size === r.resolutions.size) break;
    r = { ...r, resolutions: res };
    plan = planMigration(r);
  }
  return { req: r, plan };
}

const byKey = (plan: Plan, key: string) => plan.items.find((i) => i.entityId === key && i.kind === 'flag')!;
const stepIds = (plan: Plan) => plan.steps.map((s) => s.id);

describe('PostHog project → LaunchDarkly, end to end (PLAN §22)', () => {
  it('after accepting every recommendation, only the flags that need a human choice stay blocked, each for a named reason', () => {
    const { plan } = acceptAll(request());
    const blocked = plan.items
      .filter((i) => i.status === 'blocked')
      .map((i) => [i.kind, i.entityId, i.decisions.filter((d) => d.severity === 'blocking').map((d) => d.type).sort().join(',')])
      .sort((a, b) => a[1]!.localeCompare(b[1]!));
    // Payloads next to variation values have no LaunchDarkly shape (the user picks keys, payloads or
    // both); a cohort nested in a cohort has no segment-in-segment rule in LaunchDarkly, and the flag
    // matching that cohort waits for it.
    expect(blocked).toEqual([
      ['segment', 'enterprise-admins-in-eu', 'unsupported_condition'],
      ['flag', 'hog-nested-cohort', ''],
      ['flag', 'hog-pricing-page', 'variant_payloads'],
    ]);
    expect(byKey(plan, 'hog-nested-cohort').reason).toMatch(/depends on.*enterprise-admins-in-eu/);
    // Everything else the planner decided or skipped with a reason; nothing errored.
    expect(plan.errors).toEqual([]);
    expect(plan.items.filter((i) => i.status === 'error')).toEqual([]);
    const skipped = Object.fromEntries(plan.items.filter((i) => i.status === 'skipped').map((i) => [i.entityId, i.reason]));
    expect(skipped['survey-targeting-checkout-nps']).toMatch(/survey/i);
    expect(Object.keys(skipped)).not.toContain('hog-kill-switch');
    const ready = plan.items.filter((i) => i.status === 'ready' && i.kind === 'flag').map((i) => i.entityId).sort();
    expect(ready).toEqual(expect.arrayContaining(['hog-kill-switch', 'hog-checkout-redesign', 'hog-company-tier', 'hog-depends-on-checkout', 'hog-scheduled-launch', 'hog-staff-tools', 'hog-early-access', 'hog-ios-min-version']));
    expect(ready).not.toContain('hog-pricing-page');
  });

  it('orders the steps as LaunchDarkly needs them: context kinds, then cohorts, then flag shells before environments, prerequisites before dependants', () => {
    const { plan } = acceptAll(request());
    const ids = stepIds(plan);
    const at = (id: string) => {
      const i = ids.indexOf(id);
      expect(i, id).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Group types (and the device kind of the device-bucketed flag) become context kinds, each written
    // before the first environment that needs it; the steps start with context kinds.
    // Only kinds a selected flag uses are created: the "workspace" group type has no flag in the demo.
    const kinds = ids.filter((id) => id.startsWith('context_kind:')).sort();
    expect(kinds).toEqual(['context_kind:company', 'context_kind:device']);
    expect(ids[0]).toMatch(/^context_kind:/);
    const companyFlag = plan.steps.find((s) => s.id === 'env:test:hog-company-tier');
    expect(companyFlag?.deps).toContain('context_kind:company');
    expect(at('context_kind:company')).toBeLessThan(at('env:test:hog-company-tier'));
    // A set aggregated by a group type puts its clauses on that kind; a person set stays on user.
    const crossGroup = plan.steps.find((s) => s.id === 'env:test:hog-cross-group');
    expect(crossGroup?.deps).toEqual(['shell:hog-cross-group', 'context_kind:company']);
    expect(crossGroup?.op === 'update_flag_env' && crossGroup.desired.rules.map((r) => r.clauses.map((c) => `${c.contextKind}.${c.attribute}`))).toEqual([['company.tier'], ['user.plan']]);
    // The static cohort is a segment that is written before the flag matching it.
    const cohortSteps = ids.filter((s) => s.startsWith('segment:test:'));
    expect(cohortSteps.length).toBeGreaterThan(0);
    const checkout = plan.steps.find((s) => s.id === 'env:test:hog-checkout-redesign')!;
    const segDeps = checkout.deps.filter((d) => d.startsWith('segment:test:'));
    expect(segDeps.length).toBeGreaterThan(0);
    for (const d of segDeps) expect(at(d)).toBeLessThan(at('env:test:hog-checkout-redesign'));
    // Shell before its environment, parent flag before the one that depends on it.
    expect(at('shell:hog-depends-on-checkout')).toBeLessThan(at('env:test:hog-depends-on-checkout'));
    expect(at('env:test:hog-checkout-redesign')).toBeLessThan(at('env:test:hog-depends-on-checkout'));
    const dependant = plan.steps.find((s) => s.id === 'env:test:hog-depends-on-checkout');
    expect(dependant?.op === 'update_flag_env' && dependant.desired.prerequisites.map((p) => p.key)).toEqual(['hog-checkout-redesign']);
    // Every step's dependencies are earlier steps of the same plan.
    for (const s of plan.steps) for (const d of s.deps) expect(at(d), `${s.id} ← ${d}`).toBeLessThan(at(s.id));
  });

  it('carries the pending launch as a LaunchDarkly scheduled change with PostHog provenance on every step', () => {
    const { plan } = acceptAll(request());
    const launch = plan.steps.find((s) => s.id === 'env:test:hog-scheduled-launch');
    expect(launch?.op === 'update_flag_env' && launch.desired.scheduledChanges).toEqual([
      expect.objectContaining({ executionDate: '2027-01-04T09:00:00Z', state: expect.objectContaining({ on: true }) }),
    ]);
    expect(launch?.op === 'update_flag_env' && launch.desired.on).toBe(false);
    for (const s of plan.steps) {
      if (s.op === 'update_flag_env' || s.op === 'upsert_segment') expect(s.provenance).toMatchObject({ sourceKind: 'posthog', sourceAlias: 'hog' });
      if (s.op === 'ensure_context_kind') expect(s.sourceKind).toBe('posthog');
      if (s.op === 'upsert_flag_shell') expect(s.desired.tags).toEqual(expect.arrayContaining(['migrated-from-posthog', 'migration-src-hog']));
    }
  });

  it('a dry run touches nothing in LaunchDarkly and describes every write', async () => {
    const { plan } = acceptAll(request());
    const ld = fakeLd();
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, now: () => new Date(NOW) });
    const run = await ex.run(newRun({ id: 'run-hog-dry', workspaceId: 'w', projectKey: 'p', label: 'dry', dryRun: true, steps: plan.steps, now: new Date(NOW) }));
    expect(run.status).toBe('done');
    expect(run.steps.filter((s) => s.status === 'failed')).toEqual([]);
    expect(ld.flags.size).toBe(0);
    expect(ld.scheduled.size).toBe(0);
    expect(ld.calls.filter((c) => /^(create|semantic|json|schedule|import|put)/.test(c))).toEqual([]);
    const launch = run.steps.find((s) => s.step.id === 'env:test:hog-scheduled-launch');
    expect(launch?.message).toMatch(/^Would set targeting in test and create 1 scheduled change \(2027-01-04T09:00:00Z\): off/);
  });

  it('a real run creates every ready flag with its environment, the cohort segments and the scheduled change, and journals each step', async () => {
    const { plan } = acceptAll(request());
    const ld = fakeLd();
    const journal: RunRecord[] = [];
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async (r) => void journal.push(structuredClone(r)) }, actor: 'me@example.com', now: () => new Date(NOW) });
    const run = await ex.run(newRun({ id: 'run-hog-live', workspaceId: 'w', projectKey: 'p', label: 'live', dryRun: false, steps: plan.steps, now: new Date(NOW) }));
    const failed = run.steps.filter((s) => s.status !== 'done').map((s) => [s.step.id, s.status, s.error ?? s.message]);
    expect(failed).toEqual([]);
    expect(run.status).toBe('done');
    expect(run.steps.every((s) => s.status === 'done')).toBe(true);
    // One flag per ready item, each created once and given its targeting and provenance.
    const readyFlags = plan.items.filter((i) => i.status === 'ready' && i.kind === 'flag').map((i) => i.ldKey);
    expect([...ld.flags.keys()].sort()).toEqual([...readyFlags].sort());
    for (const key of readyFlags) {
      expect(ld.calls).toContain(`create ${key}`);
      expect(ld.calls.filter((c) => c === `create ${key}`)).toHaveLength(1);
      expect(ld.calls.some((c) => c.startsWith(`semantic ${key} test`))).toBe(true);
    }
    // The cohort segments were written (the fake records no create for segments, so the step records say so), and the launch is scheduled for 2027.
    const segmentSteps = run.steps.filter((s) => s.step.op === 'upsert_segment');
    expect(segmentSteps.length).toBeGreaterThan(0);
    for (const s of segmentSteps) expect(s.message, s.step.id).toMatch(/^Created /);
    const scheduled = [...ld.scheduled.values()].map((s) => new Date(s.executionDate).toISOString());
    expect(scheduled).toContain('2027-01-04T09:00:00.000Z');
    // Every step was journaled before it ran and after it finished.
    const launchStates = journal.map((r) => r.steps.find((s) => s.step.id === 'env:test:hog-scheduled-launch')?.status);
    expect(launchStates).toContain('running');
    expect(launchStates.at(-1)).toBe('done');
    // Nothing was written for the blocked flag.
    expect(ld.flags.has('hog-pricing-page')).toBe(false);
  });

  it('the flag the user leaves blocked does not block the rest, and resolving it adds exactly its steps', () => {
    const base = acceptAll(request());
    const open = base.plan.decisions.filter((d) => d.type === 'variant_payloads');
    expect(open).toHaveLength(1);
    const res = new Map(base.req.resolutions);
    for (const d of open) res.set(d.id, { id: d.id, type: d.type, optionKey: 'keys', scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW });
    const { plan } = acceptAll({ ...base.req, resolutions: res });
    expect(byKey(plan, 'hog-pricing-page').status).toBe('ready');
    const added = stepIds(plan).filter((id) => !stepIds(base.plan).includes(id)).sort();
    expect(added).toEqual(['env:test:hog-pricing-page', 'shell:hog-pricing-page']);
    const shell = plan.steps.find((s) => s.id === 'shell:hog-pricing-page');
    // Variant keys become the string variations; the "Not served" variation closes the multivariate flag.
    expect(shell?.op === 'upsert_flag_shell' && shell.desired.variations.map((v) => v.value)).toEqual(expect.arrayContaining(['control', '']));
  });
});

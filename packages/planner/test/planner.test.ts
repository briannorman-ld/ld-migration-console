import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { envBudget, estimateEnvBytes, mapGate, mapSegment, type Resolution } from '@sslm/mapper';
import { flagOwner, IN_SYNC_REASON, migrationStatus, ownsSegment, planMigration, recommendedResolutions, syncPropertyKey, type LdProjectState, type Plan, type PlanRequest, type PlanStep } from '../src/index.ts';
import { acmeSnapshot, CAPS, DIRECTORY, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

let web: CanonicalSnapshot;
beforeAll(async () => {
  web = await acmeSnapshot('web');
});

const EMPTY_LD: LdProjectState = { flags: new Map(), segments: {}, contextKinds: ['user'], criticalEnvs: ['production'] };
const uid = (id: string) => web.gates.find((g) => g.id === id)!.uid;

function request(gates: string[], over: Partial<PlanRequest> = {}): PlanRequest {
  return {
    gates: gates.map(uid),
    ldEnvs: ['test'],
    snapshots: [web],
    profile: profileFor(web, { development: null, staging: 'test', production: 'production', qa: null }),
    resolutions: new Map(),
    capabilities: CAPS,
    directory: DIRECTORY,
    ld: EMPTY_LD,
    now: NOW,
    ...over,
  };
}

/** Accept every recommended option, including acknowledgements (what a user clicking through does). */
function acceptAll(req: PlanRequest): PlanRequest {
  let r = req;
  for (let i = 0; i < 5; i++) {
    const plan = planMigration(r);
    if (plan.decisions.length === 0) break;
    const res = new Map(r.resolutions);
    for (const x of recommendedResolutions(plan.decisions, NOW)) res.set(x.id, x);
    for (const d of plan.decisions.filter((d) => d.severity === 'acknowledge')) res.set(d.id, { id: d.id, type: d.type, optionKey: d.recommended!, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW });
    r = { ...r, resolutions: res };
  }
  return r;
}

describe('planMigration', () => {
  it('writes the segments a segment matches before it (KNOWN-EDGE-CASES 9.15)', () => {
    const segUid = (id: string) => web.segments.find((s) => s.id === id)!.uid;
    const plan = planMigration(acceptAll(request([], { segments: [segUid('beta_or_vip')] })));
    const ids = plan.steps.map((s) => s.id);
    expect(ids).toContain('segment:test:beta_or_vip');
    expect(ids.indexOf('segment:test:beta_testers')).toBeLessThan(ids.indexOf('segment:test:beta_or_vip'));
    expect(ids.indexOf('segment:test:vip_customers')).toBeLessThan(ids.indexOf('segment:test:beta_or_vip'));
    expect(plan.steps.find((s) => s.id === 'segment:test:beta_or_vip')!.deps).toEqual(expect.arrayContaining(['segment:test:beta_testers', 'segment:test:vip_customers']));
    expect(plan.items.filter((i) => i.dependency).map((i) => i.entityId).sort()).toEqual(['beta_testers', 'vip_customers']);
  });

  it('writes a segment split off an oversized flag before the flag, after its context kind (KNOWN-EDGE-CASES 15.22)', () => {
    const plan = planMigration(acceptAll(request(['partner_api_allowlist'], { ldEnvs: ['production'] })));
    const seg = 'segment:production:partner_api_allowlist.allow-listed-accounts-key';
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['context_kind:company', 'shell:partner_api_allowlist', seg, 'env:production:partner_api_allowlist']);
    const segStep = plan.steps.find((s) => s.id === seg)!;
    expect(segStep).toMatchObject({ op: 'upsert_segment', deps: ['context_kind:company'], exists: false, provenance: { statsigType: 'segment', statsigId: 'partner_api_allowlist' } });
    if (segStep.op !== 'upsert_segment') throw new Error('segment step');
    expect(segStep.desired.includedContexts).toEqual([{ contextKind: 'company', values: expect.any(Array) }]);
    expect(segStep.desired.includedContexts[0]!.values).toHaveLength(12_000);
    const envStep = plan.steps.find((s) => s.id === 'env:production:partner_api_allowlist')!;
    if (envStep.op !== 'update_flag_env') throw new Error('env step');
    expect(envStep.deps).toContain(seg);
    const shell = plan.steps.find((s) => s.op === 'upsert_flag_shell')!;
    if (shell.op !== 'upsert_flag_shell') throw new Error('shell step');
    expect(estimateEnvBytes(envStep.desired)).toBeLessThan(envBudget(shell.desired, 2));
    expect(plan.items.find((i) => i.kind === 'segment')).toMatchObject({ dependency: true, status: 'ready', ldKey: 'partner_api_allowlist.allow-listed-accounts-key', requiredBy: [uid('partner_api_allowlist')] });
  });

  it('plans context kinds on their own (the guide creates them before segments), skipping kinds LaunchDarkly has', () => {
    const plan = planMigration(request([], { contextKinds: [{ key: 'plan', unitType: 'planKey' }, { key: 'user', unitType: 'userID' }, { key: 'company', unitType: 'companyID' }] }));
    expect(plan.steps.map((s) => s.id).sort()).toEqual(['context_kind:company', 'context_kind:plan']);
    expect(plan.steps.find((s) => s.id === 'context_kind:plan')).toMatchObject({ op: 'ensure_context_kind', key: 'plan', unitType: 'planKey', deps: [] });
    expect(plan.items).toEqual([]);
    expect(plan.ready).toBe(true);
    // A kind the project already has needs no step.
    expect(planMigration(request([], { contextKinds: [{ key: 'user', unitType: 'userID' }] })).steps).toEqual([]);
  });

  it('a kind marked "available for experiments" is also enabled as a randomization unit, after it is created; an existing kind is enabled alone', () => {
    const plan = planMigration(request([], { contextKinds: [{ key: 'company', unitType: 'companyID', availableForExperiments: true }, { key: 'plan', unitType: 'planKey' }] }));
    expect(plan.steps.map((s) => s.id).sort()).toEqual(['context_kind:company', 'context_kind:plan', 'randomization_unit:company']);
    expect(plan.steps.find((s) => s.id === 'randomization_unit:company')).toMatchObject({ op: 'ensure_randomization_unit', key: 'company', deps: ['context_kind:company'] });
    const existing = planMigration(request([], { contextKinds: [{ key: 'company', unitType: 'companyID', availableForExperiments: true }], ld: { ...EMPTY_LD, contextKinds: ['user', 'company'] } }));
    expect(existing.steps.map((s) => s.id)).toEqual(['randomization_unit:company']);
    expect(existing.steps[0]).toMatchObject({ deps: [] });
    // Already a randomization unit: nothing to do.
    expect(planMigration(request([], { contextKinds: [{ key: 'company', unitType: 'companyID', availableForExperiments: true }], ld: { ...EMPTY_LD, contextKinds: ['user', 'company'], randomizationUnits: ['user', 'company'] } })).steps).toEqual([]);
  });

  it('blocks until decisions are made, then orders shells → segments → environments', () => {
    const blocked = planMigration(request(['new_checkout_flow']));
    expect(blocked.ready).toBe(false);
    expect(blocked.steps).toEqual([]);
    expect(blocked.decisions.map((d) => d.type).sort()).toEqual(['case_insensitive_match', 'case_insensitive_match', 'case_insensitive_match', 'client_side_availability', 'holdout_attached', 'partial_rollout_rebucket']);

    const plan = planMigration(acceptAll(request(['new_checkout_flow'])));
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['shell:new_checkout_flow', 'segment:test:beta_testers', 'env:test:new_checkout_flow']);
    expect(plan.items.find((i) => i.entityId === 'beta_testers')).toMatchObject({ kind: 'segment', dependency: true, status: 'ready' });
  });

  it('creates every flag once, then configures each environment in turn, and rolls flags up at project level (PLAN §7)', () => {
    const owned: LdProjectState = {
      ...EMPTY_LD,
      flags: new Map([[
        'kill_switch_payments',
        { key: 'kill_switch_payments', tags: ['migrated-from-statsig', 'statsig-source-web'], customProperties: { 'migration.id': { value: ['kill_switch_payments'] }, 'migration.source': { value: ['web'] }, 'migration.type': { value: ['gate'] } }, kind: 'boolean' },
      ]]),
    };
    const plan = planMigration(acceptAll(request(['new_checkout_flow', 'kill_switch_payments'], { ldEnvs: ['test', 'production'], ld: owned })));
    expect(plan.errors).toEqual([]);
    const ids = plan.steps.map((s) => s.id);
    // Project level first: both shells. Then test's segment and targeting, then production's.
    expect(ids.slice(0, 2)).toEqual(['shell:kill_switch_payments', 'shell:new_checkout_flow']);
    expect(ids.slice(2)).toEqual(['segment:test:beta_testers', 'env:test:kill_switch_payments', 'env:test:new_checkout_flow', 'segment:production:beta_testers', 'env:production:kill_switch_payments', 'env:production:new_checkout_flow']);
    expect(plan.flags.map((f) => [f.ldKey, f.flagKind, f.status, f.exists, f.owned, f.adopt, f.envs.map((e) => `${e.ldEnv}:${e.status}`)])).toEqual([
      ['new_checkout_flow', 'boolean', 'ready', false, false, false, ['test:ready', 'production:ready']],
      ['kill_switch_payments', 'boolean', 'ready', true, true, false, ['test:ready', 'production:ready']],
    ]);
    expect(plan.flags[0]!.variations.map((v) => v.value)).toEqual([true, false]);
    // A flag whose targeting is blocked everywhere has no shell step and is reported as blocked.
    const blocked = planMigration(request(['new_checkout_flow']));
    expect(blocked.steps).toEqual([]);
    expect(blocked.flags.map((f) => [f.ldKey, f.status])).toEqual([['new_checkout_flow', 'blocked']]);
    expect(blocked.flags[0]!.reason).toMatch(/open decision/);
  });

  it('blocks a gate whose segment cannot migrate (docs/KNOWN-EDGE-CASES.md 5.7, 9.8)', () => {
    const plan = planMigration(acceptAll(request(['early_adopter_badge'])));
    expect(plan.ready).toBe(false);
    expect(plan.items.find((i) => i.entityId === 'early_adopters')).toMatchObject({ kind: 'segment', status: 'skipped', reason: expect.stringMatching(/can't be inlined/) });
    expect(plan.items.find((i) => i.entityId === 'early_adopter_badge')).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/depends on/) });
  });

  it('pulls in a prerequisite gate and migrates it first in the same environment', () => {
    const plan = planMigration(acceptAll(request(['checkout_express_pay'])));
    expect(plan.ready).toBe(true);
    const ids = plan.steps.map((s) => s.id);
    expect(ids.indexOf('env:test:new_checkout_flow')).toBeLessThan(ids.indexOf('env:test:checkout_express_pay'));
    expect(plan.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ dependency: true, requiredBy: [uid('checkout_express_pay')] });
  });

  it('creates context kinds before the flags that use them', () => {
    const plan = planMigration(acceptAll(request(['b2b_bulk_ordering'])));
    expect(plan.steps.map((s) => s.id)).toEqual(['context_kind:company', 'shell:b2b_bulk_ordering', 'env:test:b2b_bulk_ordering']);
    expect(plan.steps.find((s) => s.id === 'env:test:b2b_bulk_ordering')!.deps).toContain('context_kind:company');
  });

  it("doesn't write a dependency whose only dependent is blocked", () => {
    const base = acceptAll(request(['new_checkout_flow']));
    const ack = [...base.resolutions.values()].find((r) => r.type === 'partial_rollout_rebucket')!;
    const resolutions = new Map(base.resolutions);
    resolutions.delete(ack.id);
    const plan = planMigration({ ...base, resolutions });
    expect(plan.items.find((i) => i.entityId === 'beta_testers')!.status).toBe('ready');
    expect(plan.steps).toEqual([]);
  });

  it('keeps ready items when another item is blocked by a blocking decision', () => {
    const plan = planMigration(acceptAll(request(['kill_switch_payments', 'missing_email_prompt'])));
    expect(plan.ready).toBe(false);
    expect(plan.items.find((i) => i.entityId === 'missing_email_prompt')!.status).toBe('blocked');
    expect(plan.steps.map((s) => s.id)).toEqual(['shell:kill_switch_payments', 'env:test:kill_switch_payments']);
  });

  it('refuses a LaunchDarkly environment with no StatSig environment mapped to it', () => {
    const plan = planMigration(request(['kill_switch_payments'], { ldEnvs: ['sandbox'] }));
    expect(plan.items[0]).toMatchObject({ status: 'error' });
    expect(plan.items[0]!.reason).toMatch(/no StatSig environment/);
  });

  it('asks before touching a LaunchDarkly flag the app did not create (ownership guard)', () => {
    const ld: LdProjectState = { ...EMPTY_LD, flags: new Map([['kill_switch_payments', { key: 'kill_switch_payments', tags: [], customProperties: {}, kind: 'boolean' }]]) };
    const base = acceptAll(request(['kill_switch_payments']));
    const plan = planMigration({ ...base, ld });
    const d = plan.decisions.find((x) => x.type === 'key_collision')!;
    expect(d.severity).toBe('blocking');
    expect(plan.steps).toEqual([]);

    const adopt: Resolution = { id: d.id, type: d.type, optionKey: 'adopt', scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW };
    const adopted = planMigration({ ...base, ld, resolutions: new Map([...base.resolutions, [d.id, adopt]]) });
    expect(adopted.steps.find((s) => s.op === 'upsert_flag_shell')).toMatchObject({ exists: true, adopt: true });
  });

  it('flags production for typed confirmation', () => {
    expect(planMigration(acceptAll(request(['kill_switch_payments'], { ldEnvs: ['production'] }))).confirmEnvs).toEqual(['production']);
  });
});

describe('skipping flags already in sync (PlanRequest.skipInSync)', () => {
  /** The LaunchDarkly state of a gate the console synced from `plan`: provenance with the plan's fingerprint and decision hash. */
  const synced = (plan: Plan, key: string, sync?: string[]) => {
    const step = plan.steps.find((s) => s.id === `env:test:${key}`) as Extract<PlanStep, { op: 'update_flag_env' }>;
    return {
      key,
      tags: ['migrated-from-statsig', 'migration-src-web'],
      kind: 'boolean',
      customProperties: {
        'migration.id': { value: [key] },
        'migration.source': { value: ['web'] },
        'migration.type': { value: ['gate'] },
        [syncPropertyKey('test')]: { value: sync ?? [step.provenance.statsigFingerprint, '3', NOW, step.provenance.decisionSetHash] },
      },
    };
  };

  it('leaves an in-sync gate out, keeps a StatSig-changed one, and lets a dependent stand on an in-sync prerequisite', () => {
    const base = planMigration(acceptAll(request(['checkout_express_pay'])));
    const ld: LdProjectState = { ...EMPTY_LD, flags: new Map([['new_checkout_flow', synced(base, 'new_checkout_flow')]]) };
    const req = acceptAll(request(['new_checkout_flow', 'checkout_express_pay'], { ld, skipInSync: true }));
    const plan = planMigration(req);
    expect(plan.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ status: 'skipped', sync: 'in_sync', reason: IN_SYNC_REASON });
    expect(plan.steps.map((s) => s.id)).toEqual(['shell:checkout_express_pay', 'env:test:checkout_express_pay']);
    expect(plan.items.find((i) => i.entityId === 'checkout_express_pay')).toMatchObject({ status: 'ready', sync: 'not_in_ld' });
    expect(plan.flags.find((f) => f.ldKey === 'new_checkout_flow')).toMatchObject({ status: 'skipped', inSync: true });
    expect(plan.flags.find((f) => f.ldKey === 'checkout_express_pay')).toMatchObject({ status: 'ready', inSync: false });
    expect(plan.ready).toBe(true);

    // Without the option the in-sync flag is written again.
    const all = planMigration({ ...req, skipInSync: false });
    expect(all.steps.map((s) => s.id)).toContain('env:test:new_checkout_flow');
    expect(all.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ status: 'ready', sync: 'in_sync' });

    // StatSig changed since the last sync: the flag stays in the plan.
    const changed = planMigration({ ...req, ld: { ...EMPTY_LD, flags: new Map([['new_checkout_flow', synced(base, 'new_checkout_flow', ['old-fingerprint', '2', NOW, 'old-hash'])]]) } });
    expect(changed.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ status: 'ready', sync: 'statsig_changed' });
    expect(changed.steps.map((s) => s.id)).toContain('env:test:new_checkout_flow');
  });
});

describe('LaunchDarkly edited since the last sync (PLAN §8.3 ld_drift_on_sync)', () => {
  const synced = (plan: Plan, key: string, env: { version?: number; lastModified?: number }) => {
    const step = plan.steps.find((s) => s.id === `env:test:${key}`) as Extract<PlanStep, { op: 'update_flag_env' }>;
    return {
      key,
      tags: ['migrated-from-statsig', 'migration-src-web'],
      kind: 'boolean',
      customProperties: {
        'migration.id': { value: [key] },
        'migration.source': { value: ['web'] },
        'migration.type': { value: ['gate'] },
        [syncPropertyKey('test')]: { value: [step.provenance.statsigFingerprint, '3', NOW, step.provenance.decisionSetHash] },
      },
      environments: { test: { on: true, ...env } },
    };
  };

  it('blocks the environment until the user keeps the LaunchDarkly edit or overwrites it', () => {
    const base = acceptAll(request(['new_checkout_flow']));
    const first = planMigration(base);
    const edited = synced(first, 'new_checkout_flow', { version: 9, lastModified: Date.parse(NOW) + 3600_000 });
    const req: PlanRequest = { ...base, ld: { ...EMPTY_LD, flags: new Map([['new_checkout_flow', edited]]) } };
    const plan = planMigration(req);
    const d = plan.decisions.find((x) => x.type === 'ld_drift_on_sync')!;
    expect(d.severity).toBe('blocking');
    expect(d.recommended).toBe('keep_ld');
    expect(plan.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ status: 'blocked', sync: 'in_sync' });
    expect(plan.steps.map((s) => s.id)).not.toContain('env:test:new_checkout_flow');

    const keep: Resolution = { id: d.id, type: d.type, optionKey: 'keep_ld', scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW };
    const kept = planMigration({ ...req, resolutions: new Map([...req.resolutions, [d.id, keep]]) });
    expect(kept.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ status: 'skipped' });
    expect(kept.steps.map((s) => s.id)).not.toContain('env:test:new_checkout_flow');

    const over = planMigration({ ...req, resolutions: new Map([...req.resolutions, [d.id, { ...keep, optionKey: 'overwrite' }]]) });
    expect(over.steps.find((s) => s.id === 'env:test:new_checkout_flow')).toMatchObject({ overwriteLdChanges: true });

    // A later LaunchDarkly edit is a new question: the old answer goes stale.
    const later = synced(first, 'new_checkout_flow', { version: 10, lastModified: Date.parse(NOW) + 7200_000 });
    const again = planMigration({ ...req, ld: { ...EMPTY_LD, flags: new Map([['new_checkout_flow', later]]) }, resolutions: new Map([...req.resolutions, [d.id, keep]]) });
    expect(again.items.find((i) => i.entityId === 'new_checkout_flow')).toMatchObject({ status: 'blocked' });
  });

  it('does not mistake the console’s own provenance write, moments after the sync, for an edit', () => {
    const base = acceptAll(request(['new_checkout_flow']));
    const first = planMigration(base);
    const ours = synced(first, 'new_checkout_flow', { version: 4, lastModified: Date.parse(NOW) + 30_000 });
    const plan = planMigration({ ...base, ld: { ...EMPTY_LD, flags: new Map([['new_checkout_flow', ours]]) } });
    expect(plan.decisions.map((d) => d.type)).not.toContain('ld_drift_on_sync');
    expect(plan.steps.map((s) => s.id)).toContain('env:test:new_checkout_flow');
    // No per-environment information at all (an older listing): nothing to compare, so no question.
    const bare = planMigration({ ...base, ld: { ...EMPTY_LD, flags: new Map([['new_checkout_flow', { ...ours, environments: null }]]) } });
    expect(bare.decisions.map((d) => d.type)).not.toContain('ld_drift_on_sync');
  });
});

describe('autotunes (PLAN §11)', () => {
  const auid = (id: string) => web.autotunes.find((a) => a.id === id)!.uid;

  it('plans metric → shell → targeting → drafted bandit, with a randomization unit for custom kinds', () => {
    const plan = planMigration(acceptAll(request([], { autotunes: [auid('hero_image_autotune'), auid('b2b_pricing_autotune')] })));
    expect(plan.errors).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual([
      'context_kind:company',
      'randomization_unit:company',
      'metric:hero_click',
      'metric:quote_requested',
      'shell:b2b_pricing_autotune',
      'shell:hero_image_autotune',
      'env:test:b2b_pricing_autotune',
      'env:test:hero_image_autotune',
      'bandit:test:b2b_pricing_autotune',
      'bandit:test:hero_image_autotune',
    ]);
    const bandit = plan.steps.find((s) => s.id === 'bandit:test:hero_image_autotune')!;
    expect(bandit.op === 'create_bandit' && bandit.deps).toEqual(['env:test:hero_image_autotune', 'metric:hero_click']);
    expect(plan.items.filter((i) => i.kind === 'metric').map((i) => [i.ldKey, i.dependency])).toEqual([
      ['hero_click', true],
      ['quote_requested', true],
    ]);
    const env = plan.steps.find((s) => s.id === 'env:test:hero_image_autotune')!;
    expect(env.op === 'update_flag_env' && env.provenance.statsigType).toBe('autotune');
  });

  it('a running autotune is skipped until its decision is answered; a concluded one needs no bandit', () => {
    const plan = planMigration(request([], { autotunes: [auid('promo_banner_autotune'), auid('pricing_page_autotune')] }));
    expect(plan.decisions.map((d) => d.type)).toContain('autotune_running');
    expect(plan.items.find((i) => i.entityId === 'promo_banner_autotune')!.status).toBe('blocked');
    const done = planMigration(acceptAll(request([], { autotunes: [auid('promo_banner_autotune'), auid('pricing_page_autotune')] })));
    // "Wait" is the recommended answer: the running autotune stays in StatSig.
    expect(done.items.find((i) => i.entityId === 'promo_banner_autotune')).toMatchObject({ status: 'skipped' });
    expect(done.steps.map((s) => s.op)).toEqual(['upsert_flag_shell', 'update_flag_env']);
    expect(done.steps.some((s) => s.op === 'create_bandit' || s.op === 'upsert_metric')).toBe(false);
  });

  it('reuses an existing LaunchDarkly metric on the same event silently, and asks about a foreign one', () => {
    const base = acceptAll(request([], { autotunes: [auid('hero_image_autotune')] }));
    const same = planMigration({ ...base, ld: { ...EMPTY_LD, metrics: new Map([['hero_click', { key: 'hero_click', tags: [], eventKey: 'hero_click', kind: 'custom' }]]) } });
    expect(same.ready).toBe(true);
    expect(same.steps.find((s) => s.op === 'upsert_metric')).toMatchObject({ exists: true, adopt: true });
    const foreign = planMigration({ ...base, ld: { ...EMPTY_LD, metrics: new Map([['hero_click', { key: 'hero_click', tags: [], eventKey: 'Hero clicked', kind: 'custom' }]]) } });
    expect(foreign.decisions.map((d) => d.type)).toEqual(['key_collision']);
    expect(foreign.items.find((i) => i.kind === 'metric')!.status).toBe('blocked');
  });

  it('asks before touching a LaunchDarkly experiment the app did not create, and skips the randomization unit when enabled', () => {
    const base = acceptAll(request([], { autotunes: [auid('b2b_pricing_autotune')] }));
    const plan = planMigration({
      ...base,
      ld: { ...EMPTY_LD, randomizationUnits: ['user', 'company'], contextKinds: ['user', 'company'], experiments: { test: new Map([['b2b_pricing_autotune', { key: 'b2b_pricing_autotune', tags: [], type: 'mab', iterationStatus: 'running' }]]) } },
    });
    expect(plan.decisions.map((d) => d.type)).toEqual(['key_collision']);
    const adopted = planMigration({ ...base, ld: { ...EMPTY_LD, randomizationUnits: ['user', 'company'], contextKinds: ['user', 'company'], experiments: { test: new Map([['b2b_pricing_autotune', { key: 'b2b_pricing_autotune', tags: [], type: 'mab' }]]) } }, resolutions: new Map([...base.resolutions, [plan.decisions[0]!.id, { id: plan.decisions[0]!.id, type: 'key_collision' as const, optionKey: 'adopt', scope: 'resource' as const, fingerprint: plan.decisions[0]!.fingerprint, decidedAt: NOW }]]) });
    expect(adopted.ready).toBe(true);
    expect(adopted.steps.map((s) => s.id)).toEqual(['metric:quote_requested', 'shell:b2b_pricing_autotune', 'env:test:b2b_pricing_autotune', 'bandit:test:b2b_pricing_autotune']);
    expect(adopted.steps.find((s) => s.op === 'create_bandit')).toMatchObject({ exists: true, adopt: true });
  });
});

describe('dynamic configs (PLAN §10.1; edge cases 1.2, 10.1, 10.8)', () => {
  const cuid = (id: string) => web.configs.find((c) => c.id === id)!.uid;
  const owned = (key: string, type: 'gate' | 'config', extra: Partial<LdProjectState['flags'] extends ReadonlyMap<string, infer V> ? V : never> = {}) => ({
    key,
    tags: ['migrated-from-statsig', 'migration-src-web'],
    customProperties: { 'migration.id': { value: [key] }, 'migration.source': { value: ['web'] }, 'migration.type': { value: [type] } },
    kind: type === 'gate' ? 'boolean' : 'multivariate',
    ...extra,
  });

  it('plans a JSON flag shell with the default first, then the environment targeting', () => {
    const plan = planMigration(acceptAll(request([], { configs: [cuid('shipping_thresholds'), cuid('b2b_order_limits')] })));
    expect(plan.errors).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['context_kind:company', 'shell:b2b_order_limits', 'shell:shipping_thresholds', 'segment:test:enterprise_accounts', 'env:test:b2b_order_limits', 'env:test:shipping_thresholds']);
    const shell = plan.steps.find((s) => s.id === 'shell:shipping_thresholds')!;
    expect(shell.op === 'upsert_flag_shell' && shell.desired.variations.map((v) => v.name)).toEqual(['Default', 'UK', 'Canada']);
    const env = plan.steps.find((s) => s.id === 'env:test:shipping_thresholds')!;
    expect(env.op === 'update_flag_env' && env.variations.length).toBe(3);
    expect(env.op === 'update_flag_env' && env.provenance.statsigType).toBe('config');
    expect(plan.items.find((i) => i.entityId === 'shipping_thresholds')).toMatchObject({ kind: 'config', status: 'ready' });
  });

  it('1.2 / 10.8: a gate and a config with the same name cannot both become one LaunchDarkly key', () => {
    const plan = planMigration(acceptAll(request(['maintenance_mode'], { configs: [cuid('maintenance_mode')] })));
    expect(plan.items.find((i) => i.kind === 'gate' && i.entityId === 'maintenance_mode')).toMatchObject({ status: 'ready' });
    expect(plan.items.find((i) => i.kind === 'config' && i.entityId === 'maintenance_mode')).toMatchObject({ status: 'error', reason: expect.stringMatching(/gate “maintenance_mode” also produces LaunchDarkly key/) });
    expect(plan.steps.map((s) => s.id)).toEqual(['shell:maintenance_mode', 'env:test:maintenance_mode']);
  });

  it('refuses to turn a flag migrated from the gate of the same name into the config, and vice versa', () => {
    const ld: LdProjectState = { ...EMPTY_LD, flags: new Map([['maintenance_mode', owned('maintenance_mode', 'gate')]]) };
    const asConfig = planMigration(acceptAll(request([], { configs: [cuid('maintenance_mode')], ld })));
    expect(asConfig.items[0]).toMatchObject({ status: 'error', reason: expect.stringMatching(/migrated from the StatSig gate of the same name/) });
    const ld2: LdProjectState = { ...EMPTY_LD, flags: new Map([['maintenance_mode', owned('maintenance_mode', 'config')]]) };
    const asGate = planMigration(acceptAll(request(['maintenance_mode'], { ld: ld2 })));
    expect(asGate.items[0]).toMatchObject({ status: 'error', reason: expect.stringMatching(/migrated from the StatSig config of the same name/) });
  });

  it('10.1: appending a variation to a flag already migrated elsewhere is acknowledged first; variations are never removed', async () => {
    const web2 = await acmeSnapshot('web', 2); // shipping_thresholds gains "Australia"
    const before = planMigration(acceptAll(request([], { configs: [cuid('shipping_thresholds')] })));
    const shell = before.steps.find((s) => s.id === 'shell:shipping_thresholds')!;
    const variations = shell.op === 'upsert_flag_shell' ? shell.desired.variations : [];
    const ld: LdProjectState = {
      ...EMPTY_LD,
      flags: new Map([['shipping_thresholds', owned('shipping_thresholds', 'config', { variations, customProperties: { ...owned('x', 'config').customProperties, 'migration.id': { value: ['shipping_thresholds'] }, [syncPropertyKey('production')]: { value: ['fp', '5', NOW, 'd'] } } })]]),
    };
    const req = acceptAll(request([], { configs: [cuid('shipping_thresholds')], snapshots: [web2], ld }));
    const blocked = planMigration({ ...req, resolutions: new Map([...req.resolutions].filter(([, r]) => r.type !== 'variation_change_affects_migrated_env')) });
    const d = blocked.decisions.find((x) => x.type === 'variation_change_affects_migrated_env')!;
    expect(d).toMatchObject({ severity: 'acknowledge', title: expect.stringMatching(/“Australia”.*production/) });
    expect(blocked.items[0]).toMatchObject({ status: 'blocked' });

    const acknowledged = planMigration(req);
    expect(acknowledged.ready).toBe(true);
    const next = acknowledged.steps.find((s) => s.id === 'shell:shipping_thresholds')!;
    expect(next.op === 'upsert_flag_shell' && next.desired.variations.map((v) => v.name)).toEqual(['Default', 'UK', 'Canada', 'Australia']);

    // Syncing production in the same plan means no other environment is affected: nothing to acknowledge.
    const both = planMigration(acceptAll(request([], { configs: [cuid('shipping_thresholds')], snapshots: [web2], ld, ldEnvs: ['test', 'production'] })));
    expect(both.decisions.map((x) => x.type)).not.toContain('variation_change_affects_migrated_env');
    expect(both.ready).toBe(true);
  });
});

describe('migrationStatus (from LaunchDarkly provenance)', () => {
  const fp = { statsigFingerprint: 'abc', decisionSetHash: 'd1' };
  const flag = (sync?: string[]) => ({
    key: 'x',
    tags: ['migrated-from-statsig'],
    customProperties: { 'migration.id': { value: ['x'] }, 'migration.source': { value: ['web'] }, ...(sync ? { [syncPropertyKey('test')]: { value: sync } } : {}) },
  });
  it('reads in-sync, StatSig-changed and not-migrated states', () => {
    expect(migrationStatus(undefined, 'test', fp).status).toBe('not_in_ld');
    expect(migrationStatus({ key: 'x', tags: [], customProperties: {} }, 'test', fp).status).toBe('foreign');
    expect(migrationStatus(flag(), 'test', fp).status).toBe('not_migrated');
    expect(migrationStatus(flag(['abc', '3', NOW, 'd1']), 'test', fp)).toEqual({ status: 'in_sync', syncedAt: NOW });
    expect(migrationStatus(flag(['old', '2', NOW, 'd1']), 'test', fp).status).toBe('statsig_changed');
    expect(migrationStatus(flag(['abc', '3', NOW, 'd0']), 'test', fp).status).toBe('decisions_changed');
    expect(migrationStatus(flag(['abc', '3', NOW, 'd1']), 'test', fp, { id: 'x', source: 'mobile' }).status).toBe('other_source');
  });
  it('still reads the legacy StatSig-only scheme written by earlier builds', () => {
    const legacy = {
      key: 'x',
      tags: ['statsig-migrated', 'statsig-src-web'],
      customProperties: { 'statsig.id': { value: ['x'] }, 'statsig.source': { value: ['web'] }, 'statsig.type': { value: ['gate'] }, 'statsig.sync.test': { value: ['abc', '3', NOW, 'd1'] } },
    };
    expect(flagOwner(legacy)).toEqual({ id: 'x', source: 'web', type: 'gate' });
    expect(migrationStatus(legacy, 'test', fp)).toEqual({ status: 'in_sync', syncedAt: NOW });
    expect(ownsSegment({ tags: ['statsig-migrated', 'statsig-src-web'] }, 'web')).toBe(true);
    expect(ownsSegment({ tags: ['migrated-from-statsig', 'migration-src-web'] }, 'web')).toBe(true);
    expect(ownsSegment({ tags: ['migrated-from-statsig', 'migration-src-mobile'] }, 'web')).toBe(false);
    // A re-sync writes the current key next to a legacy one; the current one wins.
    const both = { ...legacy, customProperties: { ...legacy.customProperties, 'migration.sync.test': { value: ['new', '4', NOW, 'd1'] } } };
    expect(migrationStatus(both, 'test', { statsigFingerprint: 'new', decisionSetHash: 'd1' }).status).toBe('in_sync');
  });
});

// ---------------------------------------------------------------------------------------------
// LD project → LD project (PLAN §20)
// ---------------------------------------------------------------------------------------------
import { legacySnapshot } from './fixtures.ts';

describe('planMigration with a LaunchDarkly source (PLAN §20)', () => {
  let legacy: CanonicalSnapshot;
  beforeAll(async () => {
    legacy = await legacySnapshot();
  });
  const fuid = (key: string) => legacy.neutral!.flags.find((f) => f.key === key)!.uid;
  const suid = (key: string) => legacy.neutral!.segments.find((s) => s.key === key)!.uid;
  const ldWithKinds: LdProjectState = { ...EMPTY_LD, contextKinds: ['user', 'organization'] };
  function legacyRequest(over: Partial<PlanRequest>): PlanRequest {
    return {
      gates: [],
      ldEnvs: ['production'],
      snapshots: [legacy],
      profile: profileFor(legacy, { test: 'test', production: 'production' }),
      resolutions: new Map(),
      directory: { ...DIRECTORY, members: [...DIRECTORY.members, { id: 'mem-legacy-ops', email: 'ops@acme-legacy.example' }] },
      capabilities: { ...CAPS, existingContextKinds: ['user', 'organization'] },
      ld: ldWithKinds,
      now: NOW,
      ...over,
    };
  }

  it('plans a flag with its segment and prerequisite, writing LaunchDarkly provenance', () => {
    const blocked = planMigration(legacyRequest({ flags: [fuid('legacy-pricing-tiers')] }));
    expect(blocked.ready).toBe(false);
    expect(blocked.decisions.map((d) => d.type).sort()).toEqual(['copy_custom_properties', 'partial_rollout_rebucket', 'partial_rollout_rebucket']);

    const plan = planMigration(acceptAll(legacyRequest({ flags: [fuid('legacy-pricing-tiers')] })));
    expect(plan.errors).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual([
      'shell:legacy-checkout-redesign',
      'shell:legacy-pricing-tiers',
      'segment:production:legacy-beta-orgs',
      'env:production:legacy-checkout-redesign',
      'env:production:legacy-pricing-tiers',
    ]);
    const env = plan.steps.find((s) => s.id === 'env:production:legacy-pricing-tiers');
    expect(env?.op === 'update_flag_env' && env.provenance).toMatchObject({ sourceKind: 'launchdarkly', sourceAlias: 'legacy', statsigType: 'flag', statsigId: 'legacy-pricing-tiers', statsigVersion: 3 });
    expect(env?.op === 'update_flag_env' && env.desired.prerequisites).toEqual([{ key: 'legacy-checkout-redesign', variation: 0 }]);
    const seg = plan.steps.find((s) => s.id === 'segment:production:legacy-beta-orgs');
    expect(seg?.op === 'upsert_segment' && seg.provenance.sourceKind).toBe('launchdarkly');
    expect(plan.items.map((i) => [i.kind, i.entityId, i.dependency])).toEqual([
      ['flag', 'legacy-pricing-tiers', false],
      ['flag', 'legacy-checkout-redesign', true],
      ['segment', 'legacy-beta-orgs', true],
    ]);
    expect(plan.confirmEnvs).toEqual(['production']);
  });

  it('creates a missing context kind for the device flag', () => {
    const plan = planMigration(acceptAll(legacyRequest({ flags: [fuid('legacy-ios-min-version')], ldEnvs: ['test'] })));
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['context_kind:device', 'shell:legacy-ios-min-version', 'env:test:legacy-ios-min-version']);
    const ck = plan.steps[0];
    expect(ck?.op === 'ensure_context_kind' && ck.sourceKind).toBe('launchdarkly');
  });

  it('a segment can be migrated on its own', () => {
    const plan = planMigration(acceptAll(legacyRequest({ segments: [suid('legacy-internal-users')] })));
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['segment:production:legacy-internal-users']);
    expect(plan.items[0]).toMatchObject({ kind: 'segment', dependency: false, status: 'ready' });
    const step = plan.steps[0];
    expect(step?.op === 'upsert_segment' && step.desired.excluded).toEqual(['u-contractor-9']);
  });

  it('a flag on a big segment is blocked until the big_segment decision is answered, then carries the empty segment', () => {
    const blocked = planMigration(legacyRequest({ flags: [fuid('legacy-fraud-shield')] }));
    expect(blocked.ready).toBe(false);
    expect(blocked.decisions.map((d) => d.type)).toEqual(['big_segment']);
    const d = blocked.decisions[0]!;
    const plan = planMigration(legacyRequest({ flags: [fuid('legacy-fraud-shield')], resolutions: new Map([[d.id, { id: d.id, type: d.type, optionKey: 'create_empty', scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW }]]) }));
    expect(plan.ready).toBe(true);
    const seg = plan.steps.find((s) => s.op === 'upsert_segment');
    expect(seg?.op === 'upsert_segment' && seg.desired.unbounded).toEqual({ contextKind: 'user', ids: [], manual: true });
    expect(plan.items.find((i) => i.kind === 'segment')?.fidelity?.overall).toBe('manual');
  });

  it('skips archived flags and reports a key collision with an existing target flag', () => {
    const plan = planMigration(acceptAll(legacyRequest({ flags: [fuid('legacy-archived-promo'), fuid('legacy-kill-switch')], ld: { ...ldWithKinds, flags: new Map([['legacy-kill-switch', { key: 'legacy-kill-switch', tags: [], customProperties: {}, kind: 'boolean' }]]) } })));
    expect(plan.items.find((i) => i.entityId === 'legacy-archived-promo')).toMatchObject({ status: 'skipped' });
    expect(plan.items.find((i) => i.entityId === 'legacy-kill-switch')).toMatchObject({ status: 'blocked', reason: 'LaunchDarkly flag “legacy-kill-switch” already exists' });
    expect(plan.decisions.map((d) => d.type)).toEqual(['key_collision']);
  });

  it('an existing flag of the other kind is an error, and a flag the console migrated is re-synced', () => {
    const plan = planMigration(acceptAll(legacyRequest({ flags: [fuid('legacy-kill-switch')], ld: { ...ldWithKinds, flags: new Map([['legacy-kill-switch', { key: 'legacy-kill-switch', tags: [], customProperties: {}, kind: 'multivariate' }]]) } })));
    expect(plan.items[0]).toMatchObject({ status: 'error' });
    const owned = planMigration(
      acceptAll(
        legacyRequest({
          flags: [fuid('legacy-kill-switch')],
          ld: { ...ldWithKinds, flags: new Map([['legacy-kill-switch', { key: 'legacy-kill-switch', tags: ['migrated-from-launchdarkly', 'migration-src-legacy'], customProperties: { 'migration.kind': { value: ['launchdarkly'] }, 'migration.id': { value: ['legacy-kill-switch'] }, 'migration.source': { value: ['legacy'] }, 'migration.type': { value: ['flag'] } }, kind: 'boolean' }]]) },
        }),
      ),
    );
    expect(owned.ready).toBe(true);
    expect(owned.steps.map((s) => s.id)).toEqual(['shell:legacy-kill-switch', 'env:production:legacy-kill-switch']);
    const shell = owned.steps[0];
    expect(shell?.op === 'upsert_flag_shell' && shell.exists && !shell.adopt).toBe(true);
  });
});

describe('prompts → AI Configs (PLAN §6)', () => {
  const puid = (id: string) => web.prompts!.find((p) => p.id === id)!.uid;
  const directory = DIRECTORY;

  it('plans one project-level upsert_ai_config step per prompt, with no environment part', () => {
    const plan = planMigration(request([], { prompts: [puid('support_reply_assistant')], directory }));
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(['ai_config:support_reply_assistant']);
    const step = plan.steps[0]!;
    expect(step.op === 'upsert_ai_config' && step.desired.maintainerId).toBe('mem-priya');
    expect(step.op === 'upsert_ai_config' && step.provenance.statsigType).toBe('prompt');
    expect(plan.items[0]).toMatchObject({ kind: 'prompt', ldEnv: '', status: 'ready', exists: false });
    expect(plan.items[0]!.fidelity?.overall).toBe('manual');
  });

  it('re-syncs an AI Config the console created and asks before adopting a foreign one', () => {
    const owned = planMigration(request([], { prompts: [puid('support_reply_assistant')], directory, ld: { ...EMPTY_LD, aiConfigs: new Map([['support_reply_assistant', { key: 'support_reply_assistant', tags: ['migrated-from-statsig', 'migration-src-web'] }]]) } }));
    expect(owned.steps[0]).toMatchObject({ op: 'upsert_ai_config', exists: true, adopt: false });
    const foreign = planMigration(request([], { prompts: [puid('support_reply_assistant')], directory, ld: { ...EMPTY_LD, aiConfigs: new Map([['support_reply_assistant', { key: 'support_reply_assistant', tags: [] }]]) } }));
    expect(foreign.items[0]!.status).toBe('blocked');
    expect(foreign.decisions.map((d) => d.type)).toEqual(['key_collision']);
  });

  it('an owner who is not a LaunchDarkly member blocks the prompt until maintainer_unknown is answered (accepting the recommendation unblocks it)', () => {
    const req = request([], { prompts: [puid('product_description_writer')], directory });
    expect(planMigration(req).items[0]!.status).toBe('blocked');
    expect(planMigration(req).decisions.map((d) => d.type)).toEqual(['maintainer_unknown']);
    const plan = planMigration(acceptAll(req));
    expect(plan.ready).toBe(true);
    expect(plan.steps[0]!.op === 'upsert_ai_config' && plan.steps[0]!.desired.maintainerId).toBeUndefined();
  });
});

describe('mappers supplied by the caller', () => {
  it('maps through them instead of the pure mappers, with the same plan', () => {
    let gates = 0;
    let segments = 0;
    const req = request(['new_checkout_flow'], { ldEnvs: ['test', 'production'] });
    const plain = planMigration(req);
    const counted = planMigration({ ...req, mappers: { mapGate: (a) => (gates++, mapGate(a)), mapSegment: (a) => (segments++, mapSegment(a)) } });
    // One gate in two environments; its segment dependency is mapped through the supplied mapper too.
    expect(gates).toBe(2);
    expect(segments).toBeGreaterThan(0);
    expect(counted).toEqual(plain);
  });
});

import { describe, expect, it } from 'vitest';
import { LdAuthError, LdWriteError, type LdAiConfig, type LdExperiment, type LdFlag, type LdMetric } from '@sslm/ld-client';
import type { PlanStep } from '@sslm/planner';
import { Executor, footer, newRun, parseFooter, scheduledIdsFrom, segmentInstructions, withFooter, type LdWriter, type RunRecord } from '../src/index.ts';

/** Minimal in-memory LD: enough state for the executor's control flow, not LD's semantics. */
function fakeLd(over: Partial<Record<keyof LdWriter, (...a: never[]) => unknown>> = {}) {
  const flags = new Map<string, LdFlag>();
  const metrics = new Map<string, LdMetric>();
  const experiments = new Map<string, LdExperiment & { iteration?: unknown }>();
  const aiConfigs = new Map<string, LdAiConfig>();
  const units: string[] = ['user'];
  const calls: string[] = [];
  const approvals = new Map<string, { status: string; reviewStatus: string; executionDate?: number }>();
  const scheduled = new Map<string, { executionDate: number; instructions: unknown[] }>();
  const imports: { key: string; env: string; keys: string[]; mode: string }[] = [];
  let nextId = 1;
  const flag = (key: string, body: Record<string, unknown> = {}): LdFlag => ({
    key,
    name: key,
    tags: (body.tags as string[]) ?? [],
    customProperties: (body.customProperties as LdFlag['customProperties']) ?? {},
    variations: [
      { _id: `${key}-t`, value: true },
      { _id: `${key}-f`, value: false },
    ],
    environments: { test: { on: false, offVariation: 1, fallthrough: { variation: 1 }, rules: [], targets: [] } },
  });
  const base: LdWriter = {
    getFlag: async (_p, key) => (calls.push(`get ${key}`), flags.get(key) ?? null),
    createFlag: async (_p, body) => {
      calls.push(`create ${body.key}`);
      if (flags.has(body.key as string)) throw new LdWriteError(409, '/flags', { message: 'Duplicate flag key' });
      const f = flag(body.key as string, body);
      flags.set(f.key, f);
      return f;
    },
    patchFlagSemantic: async (_p, key, patch) => (calls.push(`semantic ${key} ${patch.environmentKey ?? ''}`), flags.get(key)!),
    patchFlagJson: async (_p, key, ops) => (calls.push(`json ${key} ${ops.map((o) => o.path).join(',')}`), flags.get(key)!),
    deleteFlag: async (_p, key) => void (calls.push(`delete ${key}`), flags.delete(key)),
    getSegment: async () => null,
    createSegment: async (_p, _e, b) => ({ key: b.key, name: b.name, tags: b.tags }),
    patchSegmentJson: async (_p, _e, key) => ({ key, name: key }),
    patchSegmentSemantic: async (_p, _e, key, patch) => (calls.push(`semantic segment ${key} ${patch.instructions.map((i) => `${i.kind}:${Array.isArray(i.values) ? i.values.length : ''}`).join(',')}`), { key, name: key }),
    deleteSegment: async () => undefined,
    putContextKind: async () => undefined,
    getAiConfig: async (_p, key) => (calls.push(`get ai ${key}`), aiConfigs.get(key) ?? null),
    createAiConfig: async (_p, body) => {
      calls.push(`create ai ${body.key}`);
      const a = { key: body.key, name: body.name, description: body.description ?? '', tags: body.tags ?? [], ...(body.maintainerId ? { _maintainer: { kind: 'member', member: { _id: body.maintainerId } } } : {}) };
      aiConfigs.set(a.key, a);
      return a;
    },
    patchAiConfig: async (_p, key, body) => (calls.push(`patch ai ${key} ${Object.keys(body).join(',')}`), { ...aiConfigs.get(key)!, ...body }),
    deleteAiConfig: async (_p, key) => void (calls.push(`delete ai ${key}`), aiConfigs.delete(key)),
    getMetric: async (_p, key) => (calls.push(`get metric ${key}`), metrics.get(key) ?? null),
    createMetric: async (_p, body) => {
      calls.push(`create metric ${body.key}`);
      const m = { key: body.key as string, name: body.name as string, kind: 'custom', eventKey: body.eventKey as string, tags: (body.tags as string[]) ?? [] };
      metrics.set(m.key, m);
      return m;
    },
    patchMetricJson: async (_p, key, ops) => (calls.push(`json metric ${key} ${ops.map((o) => o.path).join(',')}`), metrics.get(key)!),
    deleteMetric: async (_p, key) => void (calls.push(`delete metric ${key}`), metrics.delete(key)),
    getExperiment: async (_p, env, key) => (calls.push(`get experiment ${env}/${key}`), experiments.get(`${env}/${key}`) ?? null),
    createExperiment: async (_p, env, body) => {
      calls.push(`create experiment ${env}/${body.key}`);
      const e = { key: body.key as string, name: body.name as string, type: body.type as string, tags: (body.tags as string[]) ?? [], draftIteration: { status: 'not_started', hypothesis: '' }, iteration: body.iteration };
      experiments.set(`${env}/${e.key}`, e);
      return e;
    },
    createIteration: async (_p, env, key, body) => (calls.push(`iteration ${env}/${key}`), { ...experiments.get(`${env}/${key}`)!, iteration: body }),
    patchExperimentSemantic: async (_p, env, key, patch) => (calls.push(`semantic experiment ${env}/${key} ${patch.instructions.map((i) => i.kind).join(',')}`), experiments.get(`${env}/${key}`)!),
    getExperimentationSettings: async () => (calls.push('get settings'), { randomizationUnits: units.map((u) => ({ randomizationUnit: u })) }),
    putExperimentationSettings: async (_p, body) => {
      calls.push(`put settings ${body.randomizationUnits.map((u) => u.randomizationUnit).join(',')}`);
      units.splice(0, units.length, ...body.randomizationUnits.map((u) => u.randomizationUnit));
      return { randomizationUnits: body.randomizationUnits };
    },
    createSegmentImport: async (_p, env, key, keys, opts) => void (calls.push(`import ${env}/${key} ${keys.length} ${opts.mode}`), imports.push({ key, env, keys, mode: opts.mode })),
    getSegmentMembership: async (_p, env, key, contextKey) => ({ included: imports.some((i) => i.env === env && i.key === key && i.keys.includes(contextKey)), excluded: false }),
    createFlagApprovalRequest: async (_p, key, env, body) => {
      const id = `ar-${nextId++}`;
      calls.push(`approval ${env}/${key} ${body.executionDate ? 'scheduled' : 'now'} ${body.instructions.map((i) => i.kind).join(',')}`);
      approvals.set(id, { status: 'pending', reviewStatus: 'pending', ...(body.executionDate ? { executionDate: body.executionDate } : {}) });
      return { _id: id, status: 'pending', reviewStatus: 'pending' };
    },
    getFlagApprovalRequest: async (_p, _k, _e, id) => (calls.push(`get approval ${id}`), approvals.has(id) ? { _id: id, ...approvals.get(id)! } : null),
    deleteFlagApprovalRequest: async (_p, _k, _e, id) => void (calls.push(`delete approval ${id}`), approvals.delete(id)),
    createApprovalRequest: async (body) => {
      const id = `ar-${nextId++}`;
      calls.push(`approval ${body.resourceId} ${body.instructions.map((i) => i.kind).join(',')}`);
      approvals.set(id, { status: 'pending', reviewStatus: 'pending' });
      return { _id: id, status: 'pending', reviewStatus: 'pending' };
    },
    getApprovalRequest: async (id) => (calls.push(`get approval ${id}`), approvals.has(id) ? { _id: id, ...approvals.get(id)! } : null),
    deleteApprovalRequest: async (id) => void (calls.push(`delete approval ${id}`), approvals.delete(id)),
    listScheduledChanges: async () => [...scheduled.entries()].map(([id, v]) => ({ _id: id, ...v })),
    createScheduledChange: async (_p, key, env, body) => {
      const id = `sc-${nextId++}`;
      calls.push(`schedule ${env}/${key} ${new Date(body.executionDate).toISOString()}`);
      scheduled.set(id, { executionDate: body.executionDate, instructions: body.instructions });
      return { _id: id, executionDate: body.executionDate, instructions: body.instructions };
    },
    deleteScheduledChange: async (_p, _k, _e, id) => {
      calls.push(`unschedule ${id}`);
      if (!scheduled.delete(id)) throw new LdWriteError(404, '/scheduled-changes', null);
    },
  };
  return { client: { ...base, ...over } as LdWriter, flags, metrics, experiments, aiConfigs, units, calls, flag, approvals, scheduled, imports };
}

const desiredEnv = { ldEnv: 'test', statsigEnv: 'staging', on: true, offVariation: 1, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] };
const shell = (key: string): PlanStep => ({
  id: `shell:${key}`,
  deps: [],
  op: 'upsert_flag_shell',
  key,
  exists: false,
  adopt: false,
  desired: {
    key,
    name: key,
    description: '',
    variations: [
      { value: true, name: 'Pass' },
      { value: false, name: 'Fail' },
    ],
    defaults: { onVariation: 1, offVariation: 1 },
    temporary: true,
    tags: ['migrated-from-statsig', 'migration-src-web'],
    clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: true },
    customProperties: { 'migration.id': { name: 'StatSig ID', value: [key] }, 'migration.source': { name: 'StatSig source', value: ['web'] } },
  },
});
const env = (key: string, deps: string[] = [`shell:${key}`]): PlanStep => ({
  id: `env:test:${key}`,
  deps,
  op: 'update_flag_env',
  key,
  ldEnv: 'test',
  statsigEnv: 'staging',
  variations: [true, false],
  desired: desiredEnv,
  provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'gate', statsigId: key, statsigVersion: 3, statsigFingerprint: 'fp', decisionSetHash: 'dh' },
});

function setup(client: LdWriter, steps: PlanStep[]) {
  const saved: RunRecord[] = [];
  const ex = new Executor({ client, projectKey: 'p', journal: { save: async (r) => void saved.push(structuredClone(r)) }, actor: 'me@example.com', now: () => new Date('2026-10-22T00:00:00Z') });
  const run = newRun({ id: 'run-12345678', workspaceId: 'w', projectKey: 'p', label: 't', dryRun: false, steps, now: new Date('2026-10-22T00:00:00Z') });
  return { ex, run, saved };
}

describe('Executor', () => {
  it('a 403 creating a context kind fails that step and its dependents, learns the capability, and the run goes on', async () => {
    const ld = fakeLd({
      putContextKind: async (_p: string, key: string) => {
        if (key === 'plan') throw new LdWriteError(403, '/projects/p/context-kinds/plan', { message: 'Access to the requested resource was denied' });
      },
    });
    const learned: unknown[] = [];
    const kind = (key: string, deps: string[] = []): PlanStep => ({ id: `context_kind:${key}`, deps, op: 'ensure_context_kind', key, name: key, unitType: `${key}Key` });
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, onCapability: (c) => learned.push(c), now: () => new Date('2026-11-02T00:00:00Z') });
    const out = await ex.run(newRun({ id: 'r-kinds', workspaceId: 'w', projectKey: 'p', label: 'kinds', dryRun: false, steps: [kind('plan'), kind('team', ['context_kind:plan']), kind('org')], now: new Date() }));
    expect(out.status).not.toBe('stopped');
    expect(out.stopReason).toBeUndefined();
    expect(out.steps.map((s) => s.status)).toEqual(['failed', 'skipped', 'done']);
    expect(out.steps[0]!.error).toMatch(/can't create context kind “plan”.*createContextKind/);
    expect(out.steps[1]!.message).toMatch(/Skipped: depends on/);
    expect(learned).toContainEqual(expect.objectContaining({ key: 'context_kinds', status: 'not_permitted' }));
    expect(learned).toContainEqual(expect.objectContaining({ key: 'context_kinds', status: 'available' }));
  });

  it('creates, sets targeting, then records provenance in a separate patch', async () => {
    const ld = fakeLd();
    const { ex, run } = setup(ld.client, [shell('a'), env('a')]);
    const out = await ex.run(run);
    expect(out.status).toBe('done');
    expect(out.steps.map((s) => s.created ?? false)).toEqual([true, false]);
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['create a', 'semantic a test', 'json a /customProperties/migration.sync.test']);
  });

  it('journals every step before and after it runs', async () => {
    const { ex, run, saved } = setup(fakeLd().client, [shell('a'), env('a')]);
    await ex.run(run);
    expect(saved.map((r) => r.steps.map((s) => s.status[0]).join(''))).toEqual(['pp', 'rp', 'dp', 'dr', 'dd', 'dd']);
  });

  it('skips steps whose dependency failed, and keeps going with independent ones', async () => {
    const ld = fakeLd({ patchFlagSemantic: async (_p: string, key: string) => (key === 'a' ? Promise.reject(new LdWriteError(400, '/flags/p/a', { message: 'bad clause' })) : ({} as LdFlag)) });
    const { ex, run } = setup(ld.client, [shell('a'), shell('b'), env('a'), env('b', ['shell:b', 'env:test:a']), env('c', [])]);
    ld.flags.set('c', ld.flag('c'));
    const out = await ex.run(run);
    expect(out.status).toBe('failed');
    expect(out.steps.map((s) => [s.id, s.status])).toEqual([
      ['shell:a', 'done'],
      ['shell:b', 'done'],
      ['env:test:a', 'failed'],
      ['env:test:b', 'skipped'],
      ['env:test:c', 'done'],
    ]);
    expect(out.steps[2]!.error).toMatch(/bad clause/);
  });

  it('stops the whole run on a 429 that outlived the retries, instead of throttling step after step', async () => {
    const ld = fakeLd({ createFlag: async () => Promise.reject(new LdWriteError(429, '/flags/p', { message: 'Rate limit exceeded' })) });
    const { ex, run } = setup(ld.client, [shell('a'), shell('b')]);
    const out = await ex.run(run);
    expect(out.status).toBe('stopped');
    expect(out.steps.map((s) => s.status)).toEqual(['failed', 'pending']);
  });

  it('stops the whole run on a 401', async () => {
    const ld = fakeLd({ createFlag: async () => Promise.reject(new LdAuthError(401, '/flags/p')) });
    const { ex, run } = setup(ld.client, [shell('a'), shell('b')]);
    const out = await ex.run(run);
    expect(out.status).toBe('stopped');
    expect(out.steps.map((s) => s.status)).toEqual(['failed', 'pending']);
  });

  it('a 405 becomes an approval request with the same instructions; provenance waits for the approval', async () => {
    const ld = fakeLd({ patchFlagSemantic: async () => Promise.reject(new LdWriteError(405, '/flags/p/a', null)) });
    const learned: unknown[] = [];
    const { ex, run } = setup(ld.client, [shell('a'), env('a')]);
    (ex as unknown as { opts: { onCapability: (c: unknown) => void } }).opts.onCapability = (c) => learned.push(c);
    const out = await ex.run(run);
    expect(out.status).toBe('done');
    expect(out.steps[1]).toMatchObject({ status: 'pending_approval', approvalRequired: true, approvals: [{ kind: 'flag', purpose: 'targeting', status: 'pending' }] });
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['create a', 'approval test/a now turnFlagOn,updateOffVariation,updateFallthroughVariationOrRollout,replaceRules,replaceTargets']);
    expect(learned).toEqual([{ key: 'approvals', status: 'available', evidence: expect.stringMatching(/405 on a in test/) }]);

    // Reviewer applies it: the next check writes provenance and completes the step.
    ld.approvals.set('ar-1', { status: 'completed', reviewStatus: 'approved' });
    ld.calls.length = 0;
    const checked = await ex.checkApprovals(out);
    expect(checked.steps[1]).toMatchObject({ status: 'done', approvals: [{ status: 'applied', reviewStatus: 'approved' }] });
    expect(checked.steps[1]!.message).toMatch(/Approved and applied/);
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['json a /customProperties/migration.sync.test']);
  });

  it('a declined approval fails the step; a pending one is withdrawn by undo', async () => {
    const ld = fakeLd({ patchFlagSemantic: async () => Promise.reject(new LdWriteError(405, '/flags/p/a', null)) });
    const { ex, run } = setup(ld.client, [shell('a'), env('a')]);
    const out = await ex.run(run);
    ld.approvals.set('ar-1', { status: 'pending', reviewStatus: 'declined' });
    const checked = await ex.checkApprovals(structuredClone(out));
    expect(checked.steps[1]).toMatchObject({ status: 'failed', error: expect.stringMatching(/ar-1 declined/) });
    expect(checked.status).toBe('failed');

    ld.approvals.set('ar-1', { status: 'pending', reviewStatus: 'pending' });
    ld.calls.length = 0;
    const undone = await ex.undo(out);
    expect(undone.status).toBe('undone');
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['delete approval ar-1', 'delete a']);
  });

  it('a dry run in an approval-required environment reports the request it would file', async () => {
    const ld = fakeLd({ patchFlagSemantic: async () => Promise.reject(new LdWriteError(405, '/flags/p/a', null)) });
    ld.flags.set('a', ld.flag('a', { tags: ['migrated-from-statsig'], customProperties: { 'migration.id': { name: 'StatSig ID', value: ['a'] }, 'migration.source': { name: 'StatSig source', value: ['web'] } } }));
    const { ex } = setup(ld.client, []);
    const out = await ex.run(newRun({ id: 'dry-2', workspaceId: 'w', projectKey: 'p', label: 'dry', dryRun: true, steps: [env('a', [])], now: new Date() }));
    expect(out.steps[0]!.status).toBe('done');
    expect(out.steps[0]!.message).toMatch(/Would file an approval request/);
    expect(ld.approvals.size).toBe(0);
  });

  it('resumes an interrupted run, recognizing a create that already happened by its provenance', async () => {
    const ld = fakeLd();
    const { ex, run } = setup(ld.client, [shell('a'), env('a')]);
    // The tab closed after LD created the flag but before the journal recorded it.
    await ld.client.createFlag('p', { ...(shell('a') as Extract<PlanStep, { op: 'upsert_flag_shell' }>).desired });
    run.steps[0]!.status = 'running';
    const getFlag = ld.client.getFlag;
    let first = true;
    ld.client.getFlag = async (p, k) => (first && k === 'a' ? ((first = false), null) : getFlag(p, k));
    const out = await ex.run(run);
    expect(out.status).toBe('done');
    expect(out.steps[0]!.created).toBe(true);
  });

  it('refuses to adopt a flag that appeared since planning', async () => {
    const ld = fakeLd();
    ld.flags.set('a', ld.flag('a'));
    const { ex, run } = setup(ld.client, [shell('a')]);
    const out = await ex.run(run);
    expect(out.steps[0]!.error).toMatch(/appeared since planning/);
  });

  it('undo deletes what the run created, dependents first', async () => {
    const ld = fakeLd();
    const { ex, run } = setup(ld.client, [shell('a'), shell('b'), env('a'), env('b', ['shell:b', 'env:test:a'])]);
    await ex.run(run);
    ld.calls.length = 0;
    const out = await ex.undo(run);
    expect(out.status).toBe('undone');
    expect(ld.calls.filter((c) => c.startsWith('delete'))).toEqual(['delete b', 'delete a']);
  });

  describe('cancel (AbortSignal)', () => {
    const aborted = () => new DOMException('Cancelled by the user.', 'AbortError');

    it('a signal aborted before the run starts leaves every step pending and records the run as stopped, not failed', async () => {
      const ld = fakeLd();
      const { ex, run } = setup(ld.client, [shell('a'), env('a')]);
      const ctrl = new AbortController();
      ctrl.abort(aborted());
      const out = await ex.run(run, ctrl.signal);
      expect(out.status).toBe('stopped');
      expect(out.steps.map((s) => s.status)).toEqual(['pending', 'pending']);
      expect(out.stopReason).toMatch(/^Cancelled before “Flag “a” \(project settings\)”; 2 steps still pending/);
      expect(ld.calls).toEqual([]);
    });

    it('a cancel between steps finishes the current step, leaves the later ones pending, and the run resumes from there', async () => {
      const ctrl = new AbortController();
      const ld = fakeLd();
      const createFlag = ld.client.createFlag;
      // The user clicks Cancel while the first write is on the wire; LD still applies it.
      ld.client.createFlag = async (p, body) => {
        const f = await createFlag(p, body);
        ctrl.abort(aborted());
        return f;
      };
      const { ex, run, saved } = setup(ld.client, [shell('a'), env('a'), shell('b')]);
      const out = await ex.run(run, ctrl.signal);
      expect(out.status).toBe('stopped');
      expect(out.steps.map((s) => s.status)).toEqual(['done', 'pending', 'pending']);
      expect(out.steps[1]!.message).toBe('Cancelled before it started.');
      expect(out.stopReason).toMatch(/Cancelled before “Flag “a” targeting in test”; 2 steps still pending\. Resume from Runs/);
      expect(saved.at(-1)!.status).toBe('stopped');
      expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['create a']);

      // Resume (RunsView): a fresh executor on the journaled record, no signal this time.
      const { ex: again } = setup(ld.client, []);
      const resumed = await again.run(structuredClone(out));
      expect(resumed.status).toBe('done');
      expect(resumed.stopReason).toBeUndefined();
      expect(resumed.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
      expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['create a', 'semantic a test', 'json a /customProperties/migration.sync.test', 'create b']);
    });

    it('a write aborted in flight puts its step back to pending (not failed) so a resume re-checks it', async () => {
      const ctrl = new AbortController();
      const ld = fakeLd({
        patchFlagSemantic: async () => {
          // The transport rejects with the abort reason once the signal fires mid-request.
          ctrl.abort(aborted());
          throw aborted();
        },
      });
      const { ex, run } = setup(ld.client, [shell('a'), env('a'), shell('b')]);
      const out = await ex.run(run, ctrl.signal);
      expect(out.status).toBe('stopped');
      expect(out.steps.map((s) => s.status)).toEqual(['done', 'pending', 'pending']);
      expect(out.steps[1]).toMatchObject({ message: 'Cancelled while in flight; resuming re-checks what LaunchDarkly received.' });
      expect(out.steps[1]!.error).toBeUndefined();
      expect(out.steps[1]!.startedAt).toBeUndefined();
      expect(out.stopReason).toMatch(/Cancelled during “Flag “a” targeting in test”/);
    });

    it('a cancelled undo stops after the step in flight, keeps the rest as done, and can be undone again', async () => {
      const ld = fakeLd();
      const { ex, run } = setup(ld.client, [shell('a'), shell('b'), env('a'), env('b', ['shell:b', 'env:test:a'])]);
      await ex.run(run);
      const ctrl = new AbortController();
      const deleteFlag = ld.client.deleteFlag;
      ld.client.deleteFlag = async (p, key) => {
        await deleteFlag(p, key);
        ctrl.abort(aborted());
      };
      const out = await ex.undo(structuredClone(run), ctrl.signal);
      expect(out.status).toBe('undo_failed');
      expect(out.stopReason).toMatch(/^Undo cancelled before/);
      expect(out.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'undone']);
      expect(out.steps.every((s) => !s.error)).toBe(true);
      expect(ld.flags.has('b')).toBe(false);
      expect(ld.flags.has('a')).toBe(true);

      const again = await setup(ld.client, []).ex.undo(structuredClone(out));
      expect(again.status).toBe('undone');
      expect(again.stopReason).toBeUndefined();
      expect(ld.flags.size).toBe(0);
    });
  });

  it('a dry run writes nothing for new flags and passes dryRun for existing ones', async () => {
    const ld = fakeLd();
    const { ex } = setup(ld.client, []);
    const dry = newRun({ id: 'dry-1', workspaceId: 'w', projectKey: 'p', label: 'dry', dryRun: true, steps: [shell('a'), env('a')], now: new Date() });
    const out = await ex.run(dry);
    expect(out.steps.map((s) => s.message)).toEqual(['Would create boolean flag “a” (migrated-from-statsig, migration-src-web).', 'Would set targeting in test: on, 0 rules, default true.']);
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual([]);
  });
});

describe('scheduled changes (PLAN §5.1; time_condition → schedule)', () => {
  const flip = '2027-11-26T05:00:00Z';
  const scheduledEnv = (key: string): PlanStep => ({
    ...(env(key) as Extract<PlanStep, { op: 'update_flag_env' }>),
    desired: { ...desiredEnv, fallthrough: { variation: 1 }, scheduledChanges: [{ executionDate: flip, description: 'Black Friday', state: { on: true, offVariation: 1, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] } }] },
  });

  it('creates one full-state scheduled change per flip after the targeting patch, and records the ids in the sync provenance', async () => {
    const ld = fakeLd();
    const { ex, run } = setup(ld.client, [shell('a'), scheduledEnv('a')]);
    const out = await ex.run(run);
    expect(out.status).toBe('done');
    expect(out.steps[1]!.scheduledChangeIds).toEqual(['sc-1']);
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['create a', 'semantic a test', `schedule test/a ${new Date(flip).toISOString()}`, 'json a /customProperties/migration.sync.test']);
    const sc = ld.scheduled.get('sc-1')!;
    expect(sc.instructions.map((i) => (i as { kind: string }).kind)).toEqual(['turnFlagOn', 'updateOffVariation', 'updateFallthroughVariationOrRollout', 'replaceRules', 'replaceTargets']);
    expect((sc.instructions[2] as { variationId: string }).variationId).toBe('a-t');
    expect(out.steps[1]!.message).toMatch(/created 1 scheduled change/);
  });

  it('a re-sync deletes the scheduled changes the previous sync recorded before creating the new set', async () => {
    const ld = fakeLd();
    const f = ld.flag('a', { tags: ['migrated-from-statsig'], customProperties: { 'migration.id': { name: 'StatSig ID', value: ['a'] }, 'migration.source': { name: 'StatSig source', value: ['web'] }, 'migration.sync.test': { name: 'sync', value: ['fp', '1', '2026-01-01T00:00:00Z', 'dh', 'sc:old-1', 'sc:old-2'] } } });
    ld.flags.set('a', f);
    ld.scheduled.set('old-1', { executionDate: 1, instructions: [] });
    const { ex, run } = setup(ld.client, [scheduledEnv('a')]);
    run.steps[0]!.step.deps = [];
    const out = await ex.run(run);
    expect(out.status).toBe('done');
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['semantic a test', 'unschedule old-1', 'unschedule old-2', `schedule test/a ${new Date(flip).toISOString()}`, 'json a /customProperties/migration.sync.test']);
    expect(scheduledIdsFrom(['fp', '1', 't', 'dh', 'sc:x', 'sc:y'])).toEqual(['x', 'y']);
  });

  it('when LaunchDarkly refuses the scheduled change, the step fails, the capability is learned and nothing half-scheduled is left', async () => {
    const ld = fakeLd({ createScheduledChange: async () => Promise.reject(new LdWriteError(405, '/scheduled-changes', { message: 'Not available on this plan' })) });
    const learned: unknown[] = [];
    const { ex, run } = setup(ld.client, [shell('a'), scheduledEnv('a')]);
    (ex as unknown as { opts: { onCapability: (c: unknown) => void } }).opts.onCapability = (c) => learned.push(c);
    const out = await ex.run(run);
    expect(out.steps[1]).toMatchObject({ status: 'failed', scheduledChangeIds: [], capability: { key: 'scheduled_changes', status: 'unavailable' } });
    expect(out.steps[1]!.error).toMatch(/refused the scheduled change/);
    expect(ld.calls).not.toContainEqual('json a /customProperties/migration.sync.test');
    expect(learned).toHaveLength(1);
  });

  it('in an approval-required environment each scheduled change is an approval request with an executionDate', async () => {
    const ld = fakeLd({ patchFlagSemantic: async () => Promise.reject(new LdWriteError(405, '/flags/p/a', null)) });
    const { ex, run } = setup(ld.client, [shell('a'), scheduledEnv('a')]);
    const out = await ex.run(run);
    expect(out.steps[1]!.approvals!.map((a) => [a.purpose, a.executionDate ?? ''])).toEqual([
      ['targeting', ''],
      ['scheduled_change', flip],
    ]);
    expect(ld.approvals.get('ar-2')?.executionDate).toBe(Date.parse(flip));
    expect(ld.scheduled.size).toBe(0);
  });

  it('undo deletes the scheduled changes the run created', async () => {
    const ld = fakeLd();
    const { ex, run } = setup(ld.client, [shell('a'), scheduledEnv('a')]);
    await ex.run(run);
    ld.calls.length = 0;
    await ex.undo(run);
    expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['unschedule sc-1', 'delete a']);
    expect(ld.scheduled.size).toBe(0);
  });
});

describe('segment members over LaunchDarkly’s 1,500-target request limit', () => {
  const listSegment = (ids: string[]): PlanStep => ({
    id: 'segment:test:wholesale_partners',
    deps: [],
    op: 'upsert_segment',
    ldEnv: 'test',
    key: 'wholesale_partners',
    exists: false,
    adopt: false,
    desired: { key: 'wholesale_partners', ldEnv: 'test', statsigEnv: 'staging', name: 'Wholesale partners', description: '', tags: ['migrated-from-statsig'], rules: [], included: ids, includedContexts: [] },
    provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'segment', statsigId: 'wholesale_partners', statsigFingerprint: 'fp', decisionSetHash: 'dh' },
  });
  const withSegments = () => {
    const segments = new Map<string, Record<string, unknown>>();
    const ld = fakeLd({
      getSegment: async (_p: string, _e: string, key: string) => segments.get(key) ?? null,
      createSegment: async (_p: string, _e: string, b: Record<string, unknown>) => (segments.set(b.key as string, { key: b.key, name: b.name, tags: b.tags, included: [] }), segments.get(b.key as string)!),
      patchSegmentJson: async (_p: string, _e: string, key: string, ops: { path: string; value?: unknown }[]) => (ld.calls.push(`json segment ${key} ${ops.map((o) => o.path).join(',')}`), segments.get(key)!),
    });
    return ld;
  };

  it('writes a small list in the one JSON patch, as before', async () => {
    const ld = withSegments();
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, now: () => new Date('2026-11-02T00:00:00Z') });
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 's', dryRun: false, steps: [listSegment(Array.from({ length: 1500 }, (_, i) => `p-${i}`))], now: new Date() }));
    expect(out.steps[0]!.status).toBe('done');
    expect(ld.calls.filter((c) => c.includes('segment'))).toEqual(['json segment wholesale_partners /rules,/included,/includedContexts,/description,/tags']);
  });

  it('writes a bigger list in batches of 1,500 after the rules, each in its own request', async () => {
    const ld = withSegments();
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, now: () => new Date('2026-11-02T00:00:00Z') });
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 's', dryRun: false, steps: [listSegment(Array.from({ length: 3200 }, (_, i) => `p-${i}`))], now: new Date() }));
    expect(out.steps[0]!.status).toBe('done');
    expect(out.steps[0]!.message).toMatch(/3200 IDs in 4 requests/);
    expect(ld.calls.filter((c) => c.includes('segment'))).toEqual([
      'json segment wholesale_partners /rules,/description,/tags',
      'semantic segment wholesale_partners addIncludedUsers:1500',
      'semantic segment wholesale_partners addIncludedUsers:1500',
      'semantic segment wholesale_partners addIncludedUsers:200',
    ]);
  });
});

describe('big segments (PLAN §8.3 big_segment)', () => {
  const ids = Array.from({ length: 20_000 }, (_, i) => `fraud-${i}`);
  const big: PlanStep = {
    id: 'segment:test:fraud_blocklist',
    deps: [],
    op: 'upsert_segment',
    ldEnv: 'test',
    key: 'fraud_blocklist',
    exists: false,
    adopt: false,
    desired: { key: 'fraud_blocklist', ldEnv: 'test', statsigEnv: 'staging', name: 'Fraud blocklist', description: '', tags: ['migrated-from-statsig', 'migration-src-web'], rules: [], included: [], includedContexts: [], unbounded: { contextKind: 'user', ids } },
    provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'segment', statsigId: 'fraud_blocklist', statsigFingerprint: 'fp', decisionSetHash: 'dh' },
  };
  const withSegments = () => {
    const segments = new Map<string, Record<string, unknown>>();
    const ld = fakeLd({
      getSegment: async (_p: string, _e: string, key: string) => segments.get(key) ?? null,
      createSegment: async (_p: string, _e: string, b: Record<string, unknown>) => (segments.set(b.key as string, { key: b.key, name: b.name, tags: b.tags, unbounded: b.unbounded ?? false }), segments.get(b.key as string)!),
      patchSegmentJson: async (_p: string, _e: string, key: string, ops: { path: string }[]) => (ld.calls.push(`json segment ${key} ${ops.map((o) => o.path).join(',')}`), segments.get(key)!),
      deleteSegment: async (_p: string, _e: string, key: string) => void (ld.calls.push(`delete segment ${key}`), segments.delete(key)),
    });
    return { ld, segments };
  };

  it('a LaunchDarkly-source big segment is created without an import, and its sync comment names LaunchDarkly', async () => {
    const { ld, segments } = withSegments();
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, sleep: async () => undefined, now: () => new Date('2026-10-30T00:00:00Z') });
    const step: PlanStep = {
      ...big,
      id: 'segment:test:legacy-fraud-blocklist',
      key: 'legacy-fraud-blocklist',
      desired: { ...big.desired, key: 'legacy-fraud-blocklist', statsigEnv: 'test', tags: ['migrated-from-launchdarkly', 'migration-src-legacy'], unbounded: { contextKind: 'user', ids: [], manual: true } },
      provenance: { sourceKind: 'launchdarkly', sourceAlias: 'legacy', statsigType: 'segment', statsigId: 'legacy-fraud-blocklist', statsigFingerprint: 'fp', decisionSetHash: 'dh' },
    };
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'ld', dryRun: false, steps: [step], now: new Date() }));
    expect(out.status).toBe('done');
    expect(segments.get('legacy-fraud-blocklist')).toMatchObject({ unbounded: true });
    expect(ld.imports).toEqual([]);
    expect(out.steps[0]!.message).toMatch(/without members: import the member list yourself/);
    expect(out.steps[0]!.import).toBeUndefined();
  });

  it('creates an unbounded segment, patches only metadata, imports the CSV in replace mode and confirms membership on a sample', async () => {
    const { ld, segments } = withSegments();
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, sleep: async () => undefined, now: () => new Date('2026-10-22T00:00:00Z') });
    const learned: unknown[] = [];
    (ex as unknown as { opts: { onCapability: (c: unknown) => void } }).opts.onCapability = (c) => learned.push(c);
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'big', dryRun: false, steps: [big], now: new Date() }));
    expect(out.status).toBe('done');
    expect(segments.get('fraud_blocklist')).toMatchObject({ unbounded: true });
    expect(ld.imports).toEqual([{ key: 'fraud_blocklist', env: 'test', keys: ids, mode: 'replace' }]);
    expect(ld.calls.filter((c) => c.startsWith('json') || c.startsWith('import'))).toEqual(['json segment fraud_blocklist /description,/tags', 'import test/fraud_blocklist 20000 replace']);
    expect(out.steps[0]!.import).toEqual({ ids: 20_000, sampled: 3, confirmed: 3 });
    expect(out.steps[0]!.message).toMatch(/imported 20,000 user IDs .*3 sampled keys confirmed/);
    expect(learned).toEqual([{ key: 'big_segments', status: 'available', evidence: expect.any(String) }]);
  });

  it('refuses to turn an existing standard segment into a big one in place', async () => {
    const { ld, segments } = withSegments();
    segments.set('fraud_blocklist', { key: 'fraud_blocklist', name: 'x', tags: ['migrated-from-statsig', 'migration-src-web'], unbounded: false });
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, sleep: async () => undefined });
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'big', dryRun: false, steps: [big], now: new Date() }));
    expect(out.steps[0]!.error).toMatch(/as a standard segment/);
    expect(ld.imports).toEqual([]);
  });

  it('a plan without big segments is learned from the refused create', async () => {
    const { ld } = withSegments();
    ld.client.createSegment = async () => Promise.reject(new LdWriteError(400, '/segments', { message: 'unbounded segments are not enabled' }));
    const learned: unknown[] = [];
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, sleep: async () => undefined, onCapability: (c) => learned.push(c) });
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'big', dryRun: false, steps: [big], now: new Date() }));
    expect(out.steps[0]!.error).toMatch(/refused to create a big segment/);
    expect(learned).toEqual([{ key: 'big_segments', status: 'unavailable', evidence: 'POST big segment → 400' }]);
  });

  it('a dry run describes the import without writing', async () => {
    const { ld } = withSegments();
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, sleep: async () => undefined });
    const out = await ex.run(newRun({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'big', dryRun: true, steps: [big], now: new Date() }));
    expect(out.steps[0]!.message).toBe('Would create big segment “fraud_blocklist” in test with 20,000 user IDs (big segment).');
    expect(ld.imports).toEqual([]);
  });
});

describe('segment approval instructions', () => {
  it('diffs rules and targets into semantic-patch instructions, chunking targets at 1,500', () => {
    const current = { key: 's', name: 's', tags: ['migrated-from-statsig'], rules: [{ _id: 'r1', clauses: [] }], included: ['u1', 'u2'], includedContexts: [{ contextKind: 'org', values: ['o1'] }] };
    const desired = { key: 's', ldEnv: 'test', statsigEnv: 'staging', name: 's', description: '', tags: ['migrated-from-statsig', 'migration-src-web'], rules: [{ description: 'Beta', clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith' as const, values: ['@acme.test'], negate: false }] }], included: ['u2', ...Array.from({ length: 1600 }, (_, i) => `n${i}`)], includedContexts: [{ contextKind: 'org', values: ['o2'] }] };
    const out = segmentInstructions(current, desired);
    expect(out.map((i) => i.kind)).toEqual(['removeRule', 'addRule', 'removeIncludedUsers', 'addIncludedUsers', 'addIncludedUsers', 'removeIncludedTargets', 'addIncludedTargets', 'addTags']);
    expect(out[2]!.values).toEqual(['u1']);
    expect(out[3]!.values).toHaveLength(1500);
    expect(out[4]!.values).toHaveLength(100);
    expect(out[7]).toEqual({ kind: 'addTags', values: ['migration-src-web'] });
  });

  it('refuses weighted rules, which approvals cannot express in one step', () => {
    const desired = { key: 's', ldEnv: 'test', statsigEnv: 'staging', name: 's', description: '', tags: [], rules: [{ description: 'Sample', clauses: [], weight: 10_000, rolloutContextKind: 'user' }], included: [], includedContexts: [] };
    expect(() => segmentInstructions({ key: 's', name: 's' }, desired)).toThrow(/percentage/);
  });

  it('a 405 on a segment write files a generic approval request with the segment resource id', async () => {
    const ld = fakeLd({
      getSegment: async () => ({ key: 'beta', name: 'beta', tags: ['migrated-from-statsig', 'migration-src-web'], rules: [], included: [] }),
      patchSegmentJson: async () => Promise.reject(new LdWriteError(405, '/segments/p/test/beta', null)),
    });
    const step: PlanStep = {
      id: 'segment:test:beta',
      deps: [],
      op: 'upsert_segment',
      ldEnv: 'test',
      key: 'beta',
      exists: true,
      adopt: false,
      desired: { key: 'beta', ldEnv: 'test', statsigEnv: 'staging', name: 'beta', description: '', tags: ['migrated-from-statsig', 'migration-src-web'], rules: [], included: ['u1'], includedContexts: [] },
      provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'segment', statsigId: 'beta', statsigFingerprint: 'fp', decisionSetHash: 'dh' },
    };
    const { ex, run } = setup(ld.client, [step]);
    const out = await ex.run(run);
    expect(out.steps[0]).toMatchObject({ status: 'pending_approval', approvals: [{ kind: 'segment', purpose: 'targeting', status: 'pending' }] });
    expect(ld.calls.filter((c) => c.startsWith('approval'))).toEqual(['approval proj/p:env/test:segment/beta addIncludedUsers']);
  });
});

describe('segment provenance footer', () => {
  describe('autotunes → bandits', () => {
    const jsonShell = (key: string): PlanStep => ({
      ...(shell(key) as Extract<PlanStep, { op: 'upsert_flag_shell' }>),
      desired: {
        ...(shell(key) as Extract<PlanStep, { op: 'upsert_flag_shell' }>).desired,
        variations: [
          { value: { copy: 'A' }, name: 'A' },
          { value: { copy: 'B' }, name: 'B' },
        ],
        customProperties: { 'migration.id': { name: 'StatSig ID', value: [key] }, 'migration.type': { name: 'StatSig type', value: ['autotune'] }, 'migration.source': { name: 'StatSig source', value: ['web'] } },
      },
    });
    const metric: PlanStep = {
      id: 'metric:promo_click',
      deps: [],
      op: 'upsert_metric',
      key: 'promo_click',
      exists: false,
      adopt: false,
      desired: { key: 'promo_click', name: 'promo_click', description: '', kind: 'custom', eventKey: 'promo_click', isNumeric: false, successCriteria: 'HigherThanBaseline', tags: ['migrated-from-statsig', 'migration-src-web'], analysisUnits: ['user'] },
      provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'metric', statsigId: 'promo_click', statsigFingerprint: 'fp', decisionSetHash: 'dh' },
    };
    const unit: PlanStep = { id: 'randomization_unit:company', deps: [], op: 'ensure_randomization_unit', key: 'company' };
    const bandit = (key: string): PlanStep => ({
      id: `bandit:test:${key}`,
      deps: [`env:test:${key}`, 'metric:promo_click'],
      op: 'create_bandit',
      key,
      ldEnv: 'test',
      statsigEnv: 'staging',
      flagKey: key,
      exists: false,
      adopt: false,
      desired: {
        key,
        ldEnv: 'test',
        statsigEnv: 'staging',
        name: key,
        description: 'Bandit',
        hypothesis: 'h',
        flagKey: key,
        ruleId: 'fallthrough',
        treatments: [
          { name: 'A', baseline: true, allocationPercent: '50', variation: 0 },
          { name: 'B', baseline: false, allocationPercent: '50', variation: 1 },
        ],
        metricKey: 'promo_click',
        randomizationUnit: 'user',
        reallocationFrequencyMillis: 3_600_000,
        tags: ['migrated-from-statsig', 'migration-src-web'],
      },
      provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'autotune', statsigId: key, statsigVersion: 2, statsigFingerprint: 'fp', decisionSetHash: 'dh' },
    });
    const jsonFlag = (ld: ReturnType<typeof fakeLd>, key: string): LdFlag => ({
      ...ld.flag(key, { tags: ['migrated-from-statsig', 'migration-src-web'], customProperties: { 'migration.id': { name: 'StatSig ID', value: [key] }, 'migration.source': { name: 'StatSig source', value: ['web'] } } }),
      variations: [
        { _id: `${key}-a`, value: { copy: 'A' } },
        { _id: `${key}-b`, value: { copy: 'B' } },
      ],
      environments: { test: { on: false, offVariation: 0, fallthrough: { variation: 0 }, rules: [], targets: [], version: 7 } },
    });

    it('creates the metric, the randomization unit and a drafted mab experiment with variation IDs and the flag version', async () => {
      const ld = fakeLd();
      ld.flags.set('promo', jsonFlag(ld, 'promo'));
      const jsonEnv: PlanStep = {
        ...(env('promo') as Extract<PlanStep, { op: 'update_flag_env' }>),
        variations: [{ copy: 'A' }, { copy: 'B' }],
        desired: { ...desiredEnv, on: false, offVariation: 0, fallthrough: { rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }] } } },
      };
      const { ex, run } = setup(ld.client, [unit, metric, { ...(jsonShell('promo') as Extract<PlanStep, { op: 'upsert_flag_shell' }>), exists: true }, jsonEnv, bandit('promo')]);
      const out = await ex.run(run);
      expect(out.steps.map((s) => s.error ?? '')).toEqual(['', '', '', '', '']);
      expect(out.status).toBe('done');
      expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual([
        'put settings user,company',
        'create metric promo_click',
        'json promo /clientSideAvailability,/customProperties/migration.type',
        'semantic promo test',
        'json promo /customProperties/migration.sync.test',
        'create experiment test/promo',
      ]);
      const created = ld.experiments.get('test/promo')!;
      expect(created.type).toBe('mab');
      expect(created.iteration).toMatchObject({
        primarySingleMetricKey: 'promo_click',
        randomizationUnit: 'user',
        reallocationFrequencyMillis: 3_600_000,
        treatments: [
          { name: 'A', baseline: true, allocationPercent: '50', parameters: [{ flagKey: 'promo', variationId: 'promo-a' }] },
          { name: 'B', baseline: false, allocationPercent: '50', parameters: [{ flagKey: 'promo', variationId: 'promo-b' }] },
        ],
        flags: { promo: { ruleId: 'fallthrough', flagConfigVersion: 7, notInExperimentVariationId: 'promo-a' } },
      });
      expect(out.steps.map((s) => s.created ?? false)).toEqual([true, true, false, false, true]);
    });

    it('replaces a draft iteration on re-sync, leaves a running one alone, and reuses a same-event metric', async () => {
      const ld = fakeLd();
      ld.flags.set('promo', jsonFlag(ld, 'promo'));
      ld.metrics.set('promo_click', { key: 'promo_click', kind: 'custom', eventKey: 'promo_click', tags: ['other'] });
      ld.experiments.set('test/promo', { key: 'promo', name: 'promo', type: 'mab', tags: ['migrated-from-statsig', 'migration-src-web'], draftIteration: { status: 'not_started', hypothesis: '' } });
      const { ex, run } = setup(ld.client, [metric, bandit('promo')]);
      const out = await ex.run(run);
      expect(out.status).toBe('done');
      expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['json metric promo_click /tags', 'iteration test/promo']);
      ld.experiments.set('test/promo', { key: 'promo', name: 'promo', type: 'mab', tags: ['migrated-from-statsig', 'migration-src-web'], currentIteration: { status: 'running', hypothesis: '' } });
      const again = await ex.run(newRun({ id: 'run-2', workspaceId: 'w', projectKey: 'p', label: 't', dryRun: false, steps: [bandit('promo')], now: new Date() }));
      expect(again.steps[0]!.message).toMatch(/running iteration; left as is/);
    });

    it('undo archives the experiment it created, deletes its metric and restores the randomization units', async () => {
      const ld = fakeLd();
      ld.flags.set('promo', jsonFlag(ld, 'promo'));
      const { ex, run } = setup(ld.client, [unit, metric, bandit('promo')]);
      const done = await ex.run(run);
      ld.calls.length = 0;
      const undone = await ex.undo(done);
      expect(undone.status).toBe('undone');
      expect(ld.calls.filter((c) => !c.startsWith('get'))).toEqual(['semantic experiment test/promo archiveExperiment', 'delete metric promo_click', 'put settings user']);
    });
  });

  it('round-trips and replaces an old footer', () => {
    const f = footer({ sourceAlias: 'web', statsigId: 'vip', statsigFingerprint: 'abc', decisionSetHash: 'd' }, new Date('2026-10-22T00:00:00Z'));
    const once = withFooter('VIPs', f);
    expect(withFooter(once, f)).toBe(once);
    expect(parseFooter(once)).toEqual({ from: 'statsig', src: 'web', id: 'vip', fp: 'abc', d: 'd', at: '2026-10-22T00:00:00.000Z' });
  });

  it('writes the source kind into the footer for a LaunchDarkly-source segment (PLAN §20.3)', () => {
    const f = footer({ sourceKind: 'launchdarkly', sourceAlias: 'legacy', statsigId: 'legacy-beta-orgs', statsigFingerprint: 'abc', decisionSetHash: 'd' }, new Date('2026-10-30T00:00:00Z'));
    expect(f).toBe('[ld-migration: from=launchdarkly; src=legacy; id=legacy-beta-orgs; fp=abc; d=d; at=2026-10-30T00:00:00.000Z]');
    expect(parseFooter(withFooter('Beta orgs', f))?.from).toBe('launchdarkly');
  });
});

describe('prompts → AI Configs (upsert_ai_config, PLAN §6)', () => {
  const step = (over: Partial<Extract<PlanStep, { op: 'upsert_ai_config' }>> = {}): PlanStep => ({
    id: 'ai_config:support_reply_assistant',
    deps: [],
    op: 'upsert_ai_config',
    key: 'support_reply_assistant',
    exists: false,
    adopt: false,
    desired: { key: 'support_reply_assistant', name: 'Support reply assistant', description: 'Drafts replies.', tags: ['migrated-from-statsig', 'migration-src-web', 'search'], mode: 'completion', maintainerId: 'mem-priya' },
    provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'prompt', statsigId: 'support_reply_assistant', statsigVersion: 4, statsigFingerprint: 'fp1', decisionSetHash: 'dh' },
    ...over,
  });
  const exec = (ld: ReturnType<typeof fakeLd>, steps: PlanStep[], dryRun = false) => {
    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, now: () => new Date('2026-11-02T00:00:00Z') });
    const run = newRun({ id: 'run-aiconfig', workspaceId: 'w', projectKey: 'p', label: 't', dryRun, steps, now: new Date('2026-11-02T00:00:00Z') });
    return { ex, run };
  };

  it('creates the shell with the provenance footer and maintainer, never touching variations; a re-sync only patches what changed', async () => {
    const ld = fakeLd();
    const { ex, run } = exec(ld, [step()]);
    await ex.run(run);
    expect(run.status).toBe('done');
    expect(run.steps[0]!.message).toMatch(/Created AI Config/);
    const created = ld.aiConfigs.get('support_reply_assistant')!;
    expect(created.tags).toEqual(['migrated-from-statsig', 'migration-src-web', 'search']);
    expect(parseFooter(created.description)).toMatchObject({ from: 'statsig', src: 'web', id: 'support_reply_assistant', fp: 'fp1' });
    expect(ld.calls).toEqual(['get ai support_reply_assistant', 'create ai support_reply_assistant']);

    // Same desired state, new fingerprint: the footer changes, nothing else.
    ld.calls.length = 0;
    const again = exec(ld, [step({ exists: true, provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'prompt', statsigId: 'support_reply_assistant', statsigFingerprint: 'fp2', decisionSetHash: 'dh' } })]);
    await again.ex.run(again.run);
    expect(again.run.steps[0]!.message).toBe('Updated AI Config “support_reply_assistant” (description).');
    expect(ld.calls).toEqual(['get ai support_reply_assistant', 'patch ai support_reply_assistant description']);
  });

  it('refuses a foreign AI Config that appeared since planning unless adopted, and undo deletes only what it created', async () => {
    const ld = fakeLd();
    ld.aiConfigs.set('support_reply_assistant', { key: 'support_reply_assistant', name: 'Theirs', description: 'Hand-made', tags: ['ops'] });
    const { ex, run } = exec(ld, [step()]);
    await ex.run(run);
    expect(run.status).toBe('failed');
    expect(run.steps[0]!.error).toMatch(/wasn't created by this app/);

    const adopted = exec(ld, [step({ exists: true, adopt: true })]);
    await adopted.ex.run(adopted.run);
    expect(adopted.run.status).toBe('done');
    expect(adopted.run.steps[0]!.message).toMatch(/Updated AI Config .* \(name, description, tags, maintainerId\)/);
    // Undo of an adopted config restores the pre-image's name, description and tags.
    ld.calls.length = 0;
    await adopted.ex.undo(adopted.run);
    expect(ld.calls).toEqual(['patch ai support_reply_assistant name,description,tags']);

    const fresh = fakeLd();
    const created = exec(fresh, [step()]);
    await created.ex.run(created.run);
    await created.ex.undo(created.run);
    expect(fresh.aiConfigs.has('support_reply_assistant')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { PlanStep } from '@sslm/planner';
import { applySupersession, Executor, newRun, resumeOutlook, stepIdentity, supersededSteps, undoHoldMessage, undoHolds, undoOutlook, type RunRecord } from '../src/index.ts';
import { fakeLd } from './fakeLd.ts';

const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-11-02T00:00:00.000Z';
const T2 = '2026-11-03T00:00:00.000Z';

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
const env = (key: string, ldEnv: string): PlanStep => ({
  id: `env:${ldEnv}:${key}`,
  deps: [`shell:${key}`],
  op: 'update_flag_env',
  key,
  ldEnv,
  statsigEnv: 'staging',
  variations: [true, false],
  desired: { ldEnv, statsigEnv: 'staging', on: true, rules: [], fallthrough: { variation: 0 }, offVariation: 1, targets: [], prerequisites: [] },
  provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'gate', statsigId: key, statsigVersion: 3, statsigFingerprint: 'fp', decisionSetHash: 'dh' },
});
const segment = (key: string, ldEnv: string): PlanStep =>
  ({ id: `segment:${ldEnv}:${key}`, deps: [], op: 'upsert_segment', ldEnv, key, exists: false, adopt: false, desired: { key, name: key, description: '', tags: [], rules: [], included: [], excluded: [] }, provenance: { sourceKind: 'statsig', sourceAlias: 'web', statsigType: 'segment', statsigId: key, statsigFingerprint: 'fp', decisionSetHash: 'dh' } }) as unknown as PlanStep;

/** A run whose steps are in the given states (`done` by default). */
function runWith(id: string, startedAt: string, steps: PlanStep[], status: RunRecord['status'] = 'done', stepStatus: (s: PlanStep) => RunRecord['steps'][number]['status'] = () => 'done', dryRun = false): RunRecord {
  const r = newRun({ id, workspaceId: 'w', projectKey: 'p', label: `run ${id}`, dryRun, steps, now: new Date(startedAt) });
  r.status = status;
  for (const s of r.steps) {
    s.status = stepStatus(s.step);
    if (s.status === 'done') s.finishedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  }
  return r;
}

describe('superseded steps (resume after a later run did the work)', () => {
  it('identity is per resource and environment, so another environment does not supersede', () => {
    expect(stepIdentity(env('a', 'production'))).not.toBe(stepIdentity(env('a', 'staging')));
    expect(stepIdentity(shell('a'))).toBe(stepIdentity(shell('a')));
    expect(stepIdentity(segment('s', 'production'))).not.toBe(stepIdentity(segment('s', 'staging')));
  });

  it('a later finished run supersedes the pending steps it covered; the rest stay outstanding', () => {
    const stopped = runWith('old', T0, [shell('a'), env('a', 'production'), shell('b'), env('b', 'production'), segment('s', 'production')], 'stopped', (s) => (s.id === 'shell:a' ? 'done' : 'pending'));
    const later = runWith('new', T1, [shell('a'), env('a', 'production'), segment('s', 'production')]);
    const map = supersededSteps(stopped, [stopped, later]);
    expect([...map.keys()].sort()).toEqual(['env:production:a', 'segment:production:s']);
    expect(map.get('env:production:a')).toMatchObject({ runId: 'new', runLabel: 'run new', startedAt: T1 });
    expect(resumeOutlook(stopped, [stopped, later])).toEqual({ outstanding: 2, superseded: 2, by: [{ runId: 'new', runLabel: 'run new', steps: 2 }] });
  });

  it('ignores dry runs, earlier runs, other projects, undone steps and the run itself', () => {
    const stopped = runWith('old', T1, [shell('a'), env('a', 'production')], 'stopped', () => 'pending');
    const dry = runWith('dry', T2, [shell('a'), env('a', 'production')], 'done', () => 'done', true);
    const earlier = runWith('earlier', T0, [shell('a'), env('a', 'production')]);
    const undone = runWith('undone', T2, [shell('a'), env('a', 'production')], 'undone', () => 'undone');
    const other = { ...runWith('other', T2, [shell('a'), env('a', 'production')]), projectKey: 'q' };
    expect(supersededSteps(stopped, [stopped, dry, earlier, undone, other]).size).toBe(0);
    expect(resumeOutlook(stopped, [stopped, dry, earlier, undone, other])).toEqual({ outstanding: 2, superseded: 0, by: [] });
  });

  it('the newest later run wins when several did the same step', () => {
    const stopped = runWith('old', T0, [shell('a')], 'stopped', () => 'pending');
    const mid = runWith('mid', T1, [shell('a')]);
    const newest = runWith('newest', T2, [shell('a')]);
    expect(supersededSteps(stopped, [newest, stopped, mid]).get('shell:a')?.runId).toBe('newest');
  });

  it('a resume skips the superseded steps and never re-creates the flag the later run made', async () => {
    const ld = fakeLd();
    // Pending shell + production targeting for `a`, and a still-outstanding staging targeting.
    const stopped = runWith('old', T0, [shell('a'), env('a', 'production'), env('a', 'staging')], 'stopped', () => 'pending');
    // The later run created `a` and set production.
    const later = runWith('new', T1, [shell('a'), env('a', 'production')]);
    ld.flags.set('a', { ...ld.flag('a', { tags: ['migrated-from-statsig', 'migration-src-web'], customProperties: { 'migration.id': { name: 'StatSig ID', value: ['a'] }, 'migration.source': { name: 'StatSig source', value: ['web'] } } }), environments: { production: { on: true, rules: [], fallthrough: { variation: 0 }, offVariation: 1, targets: [] }, staging: { on: false, rules: [], fallthrough: { variation: 1 }, offVariation: 1, targets: [] } } });

    const marked = applySupersession(stopped, supersededSteps(stopped, [stopped, later]), new Date(T2));
    expect(marked).toBe(2);
    expect(stopped.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'pending']);
    expect(stopped.steps[0]!.message).toBe('Superseded: run “run new” (#new) migrated this on 2026-11-02; not replayed.');

    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, now: () => new Date(T2) });
    const out = await ex.run(stopped);
    expect(out.status).toBe('done');
    expect(out.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'done']);
    // No create: the skipped shell step never claimed the flag, and the staging step read it.
    expect(ld.calls.filter((c) => c.startsWith('create'))).toEqual([]);
    expect(ld.calls).toContain('get a');
    expect(out.steps[0]!.created).toBeUndefined();
  });
});

describe('undo holds (a later run wrote to the same place since)', () => {
  const held = (run: RunRecord, runs: RunRecord[]) => new Map([...undoHolds(run, runs)].map(([id, h]) => [id, undoHoldMessage(h)]));

  it('holds a step a later run did again; the steps only this run did stay undoable', () => {
    const old = runWith('old', T0, [shell('a'), env('a', 'production'), env('a', 'staging'), segment('s', 'production')]);
    const later = runWith('new', T1, [shell('a'), env('a', 'production')]);
    const holds = undoHolds(old, [old, later]);
    expect([...holds.keys()].sort()).toEqual(['env:production:a', 'shell:a']);
    expect(holds.get('env:production:a')).toMatchObject({ runId: 'new', reason: 'same_step', resource: 'flag “a”' });
    expect(undoOutlook(old, [old, later])).toEqual({ undoable: 4, held: 2, by: [{ runId: 'new', runLabel: 'run new', steps: 2 }] });
    expect(undoHoldMessage(holds.get('env:production:a')!)).toBe('Not undone: run “run new” (#new) migrated flag “a” again on 2026-11-02; the state before this run is older than what it wrote. Undo that run first, then Undo… again.');
  });

  it('holds every step of a resource this run created once a later run wrote to it, whichever environment', () => {
    const old = runWith('old', T0, [shell('a'), env('a', 'production'), env('a', 'staging'), shell('b'), env('b', 'production')]);
    old.steps[0]!.created = true;
    old.steps[3]!.created = true;
    // The later run only touched staging of `a`: deleting `a` would still erase that.
    const later = runWith('new', T1, [shell('a'), env('a', 'staging')], 'done', (s) => (s.id === 'shell:a' ? 'skipped' : 'done'));
    const holds = undoHolds(old, [old, later]);
    expect([...holds.keys()].sort()).toEqual(['env:production:a', 'env:staging:a', 'shell:a']);
    expect(holds.get('env:production:a')?.reason).toBe('created_resource');
    expect(undoHoldMessage(holds.get('shell:a')!)).toMatch(/wrote to flag “a” on 2026-11-02, which this run created; deleting it would erase/);
  });

  it('a later step that was undone, a dry run, an earlier run and another project hold nothing', () => {
    const old = runWith('old', T1, [shell('a'), env('a', 'production')]);
    old.steps[0]!.created = true;
    const undone = runWith('undone', T2, [shell('a'), env('a', 'production')], 'undone', () => 'undone');
    const dry = runWith('dry', T2, [shell('a'), env('a', 'production')], 'done', () => 'done', true);
    const earlier = runWith('earlier', T0, [shell('a'), env('a', 'production')]);
    const other = { ...runWith('other', T2, [shell('a'), env('a', 'production')]), projectKey: 'q' };
    expect(undoHolds(old, [old, undone, dry, earlier, other]).size).toBe(0);
  });

  it('a step the later run filed for approval counts as written; the newest later run is named', () => {
    const old = runWith('old', T0, [shell('a'), env('a', 'production')]);
    const mid = runWith('mid', T1, [shell('a'), env('a', 'production')]);
    const newest = runWith('newest', T2, [shell('a'), env('a', 'production')], 'done', (s) => (s.id === 'shell:a' ? 'done' : 'pending_approval'));
    expect(undoHolds(old, [newest, old, mid]).get('env:production:a')?.runId).toBe('newest');
  });

  it('undo leaves held steps alone, never deletes the flag, ends undo_failed, and finishes once the later run is undone', async () => {
    const ld = fakeLd();
    const flagA = { ...ld.flag('a'), environments: { production: { on: true, rules: [], fallthrough: { variation: 0 }, offVariation: 1, targets: [] } } };
    ld.flags.set('a', flagA);
    ld.flags.set('b', ld.flag('b'));
    const old = runWith('old', T0, [shell('a'), env('a', 'production'), shell('b')]);
    old.steps[0]!.created = true;
    old.steps[2]!.created = true;
    const later = runWith('new', T1, [shell('a'), env('a', 'production')], 'done', (s) => (s.id === 'shell:a' ? 'skipped' : 'done'));

    const ex = new Executor({ client: ld.client, projectKey: 'p', journal: { save: async () => undefined }, now: () => new Date(T2) });
    const out = await ex.undo(old, undefined, held(old, [old, later]));
    expect(out.status).toBe('undo_failed');
    expect(out.stopReason).toBe('2 steps were not undone: later runs have written to the same resources since. Undo those runs first, then Undo… again.');
    expect(out.steps.map((s) => s.status)).toEqual(['done', 'done', 'undone']);
    expect(out.steps[0]!.error).toMatch(/^Not undone: run “run new” \(#new\) wrote to flag “a”/);
    expect(ld.calls.filter((c) => c.startsWith('delete'))).toEqual(['delete b']);

    // The later run is undone: its steps release the hold and Undo… again finishes the job.
    for (const s of later.steps) if (s.status === 'done') s.status = 'undone';
    later.status = 'undone';
    const again = await ex.undo(out, undefined, held(out, [out, later]));
    expect(again.status).toBe('undone');
    expect(again.steps.map((s) => s.status)).toEqual(['undone', 'undone', 'undone']);
    expect(again.steps[0]!.error).toBeUndefined();
    expect(again.stopReason).toBeUndefined();
    expect(ld.calls.filter((c) => c.startsWith('delete'))).toEqual(['delete b', 'delete a']);
  });
});

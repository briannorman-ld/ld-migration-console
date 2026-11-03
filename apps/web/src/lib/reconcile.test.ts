import { describe, expect, it } from 'vitest';
import { syncPropertyKey } from '@sslm/canonical';
import type { ResourceChange, RunRecord, StepRecord } from '@sslm/executor';
import type { LdFlagSummary, LdSegment } from '@sslm/ld-client';
import type { PlanStep } from '@sslm/planner';
import { latestChanges, listsTouchedByRun, mergeByKey, needsNothing, staleAfterRun } from './reconcile.ts';

const RUN_START = '2026-11-02T10:00:00.000Z';
const BEFORE = '2026-10-01T00:00:00.000Z';
const AFTER = '2026-11-02T10:00:05.000Z';

const shell = (key: string): PlanStep => ({ id: `shell:${key}`, deps: [], op: 'upsert_flag_shell', key, exists: false, adopt: false, desired: {} as never });
const env = (key: string, ldEnv: string): PlanStep => ({ id: `env:${ldEnv}:${key}`, deps: [], op: 'update_flag_env', key, ldEnv, statsigEnv: ldEnv, variations: [true, false], desired: {} as never, provenance: {} as never });
const segment = (key: string, ldEnv: string): PlanStep => ({ id: `seg:${ldEnv}:${key}`, deps: [], op: 'upsert_segment', key, ldEnv, exists: false, adopt: false, desired: {} as never, provenance: {} as never });

const rec = (step: PlanStep, status: StepRecord['status'], extra: Partial<StepRecord> = {}): StepRecord => ({ id: step.id, label: step.id, status, step, ...extra });
const run = (steps: StepRecord[], dryRun = false): RunRecord => ({ id: 'r1', workspaceId: 'w', projectKey: 'p', label: 'l', dryRun, startedAt: RUN_START, status: 'done', steps });

const flag = (key: string, syncs: Record<string, string> = {}): LdFlagSummary => ({
  key,
  tags: [],
  customProperties: Object.fromEntries(Object.entries(syncs).map(([ldEnv, at]) => [syncPropertyKey(ldEnv), { name: 'sync', value: ['fp', '1', at, 'dsh'] }])),
});
const flags = (...fs: LdFlagSummary[]) => new Map(fs.map((f) => [f.key, f]));
const seg = (key: string): LdSegment => ({ key, name: key } as LdSegment);

describe('staleAfterRun', () => {
  it('asks for nothing when the listing shows what the run wrote', () => {
    const r = run([rec(shell('a'), 'done'), rec(env('a', 'development'), 'done'), rec(segment('s', 'development'), 'done')]);
    expect(staleAfterRun(r, flags(flag('a', { development: AFTER })), { development: [seg('s')] })).toEqual({ flagKeys: [], segments: [] });
  });

  it('re-reads a created flag the listing lacks, once, however many of its steps are done', () => {
    const r = run([rec(shell('a'), 'done'), rec(env('a', 'development'), 'done'), rec(env('a', 'test'), 'done')]);
    expect(staleAfterRun(r, flags(), undefined).flagKeys).toEqual(['a']);
  });

  it('re-reads a re-synced flag whose listed sync record predates the run', () => {
    const r = run([rec(env('a', 'development'), 'done')]);
    expect(staleAfterRun(r, flags(flag('a', { development: BEFORE })), undefined).flagKeys).toEqual(['a']);
    // A sync in another environment does not count for this one.
    expect(staleAfterRun(r, flags(flag('a', { test: AFTER })), undefined).flagKeys).toEqual(['a']);
  });

  it('re-reads a segment missing from its environment listing', () => {
    const r = run([rec(segment('s', 'development'), 'done')]);
    expect(staleAfterRun(r, flags(), { development: [], test: [seg('s')] }).segments).toEqual([{ ldEnv: 'development', key: 's' }]);
  });

  it('after an undo, re-reads what the listing still shows as the run\'s result', () => {
    const r = run([rec(shell('a'), 'undone', { created: true }), rec(env('a', 'development'), 'undone'), rec(shell('b'), 'undone'), rec(env('b', 'development'), 'undone'), rec(segment('s', 'development'), 'undone', { created: true })]);
    // a: created by the run and still listed; b: adopted, its sync restored to the earlier record, so it is fine.
    const out = staleAfterRun(r, flags(flag('a', { development: AFTER }), flag('b', { development: BEFORE })), { development: [seg('s')] });
    expect(out).toEqual({ flagKeys: ['a'], segments: [{ ldEnv: 'development', key: 's' }] });
  });

  it('ignores dry runs and steps that failed, were skipped or await approval', () => {
    expect(staleAfterRun(run([rec(shell('a'), 'done')], true), flags(), undefined).flagKeys).toEqual([]);
    const r = run([rec(shell('a'), 'failed'), rec(env('b', 'development'), 'pending_approval'), rec(shell('c'), 'skipped')]);
    expect(staleAfterRun(r, flags(), undefined)).toEqual({ flagKeys: [], segments: [] });
  });
});

describe('mergeByKey', () => {
  const items = [{ key: 'a', v: 1 }, { key: 'b', v: 1 }, { key: 'c', v: 1 }];
  it('replaces in place, appends new keys and removes null ones, leaving the rest untouched', () => {
    expect(mergeByKey(items, [{ key: 'b', item: { key: 'b', v: 2 } }, { key: 'd', item: { key: 'd', v: 2 } }, { key: 'a', item: null }, { key: 'zz', item: null }])).toEqual([
      { key: 'b', v: 2 },
      { key: 'c', v: 1 },
      { key: 'd', v: 2 },
    ]);
  });
  it('copies the list when there is nothing to merge', () => {
    const out = mergeByKey(items, []);
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });
});

describe('what a run reported, ready to merge', () => {
  it('keeps the last report per flag and per (environment, segment); a null is a deletion', () => {
    const f = (v: number) => ({ key: 'a', version: v }) as never;
    const changes: ResourceChange[] = [
      { kind: 'flag', key: 'a', flag: f(1) },
      { kind: 'segment', ldEnv: 'test', key: 's', segment: { key: 's', name: 's' } as never },
      { kind: 'flag', key: 'a', flag: f(2) },
      { kind: 'segment', ldEnv: 'production', key: 's', segment: { key: 's', name: 's2' } as never },
      { kind: 'flag', key: 'b', flag: f(9) },
      { kind: 'flag', key: 'b', flag: null },
      { kind: 'segment', ldEnv: 'test', key: 's', segment: null },
    ];
    expect(latestChanges(changes)).toEqual({
      flags: [
        { key: 'a', flag: f(2) },
        { key: 'b', flag: null },
      ],
      segments: [
        { ldEnv: 'test', key: 's', segment: null },
        { ldEnv: 'production', key: 's', segment: { key: 's', name: 's2' } },
      ],
    });
    expect(latestChanges([])).toEqual({ flags: [], segments: [] });
  });

  it('names only the listings the steps that ran could have changed', () => {
    const rec = (step: PlanStep, status: StepRecord['status']): StepRecord => ({ id: step.id, label: step.id, status, step });
    const kind: PlanStep = { id: 'context_kind:k', deps: [], op: 'ensure_context_kind', key: 'k', name: 'k', unitType: 'kKey' };
    const unit: PlanStep = { id: 'randomization_unit:k', deps: [], op: 'ensure_randomization_unit', key: 'k' };
    const bandit = (env: string): PlanStep => ({ id: `bandit:${env}:x`, deps: [], op: 'create_bandit', key: 'x', ldEnv: env, statsigEnv: env, flagKey: 'x', exists: false, adopt: false, desired: {} as never, provenance: {} as never });
    const metric: PlanStep = { id: 'metric:m', deps: [], op: 'upsert_metric', key: 'm', exists: false, adopt: false, desired: {} as never, provenance: {} as never };
    const ai: PlanStep = { id: 'ai_config:p', deps: [], op: 'upsert_ai_config', key: 'p', exists: false, adopt: false, desired: {} as never, provenance: {} as never };
    const run = (steps: StepRecord[]): RunRecord => ({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'l', dryRun: false, startedAt: RUN_START, status: 'done', steps });

    // Flags and segments only: nothing to list.
    expect(needsNothing(listsTouchedByRun(run([rec(shell('a'), 'done')])))).toBe(true);
    // A pending or skipped step wrote nothing; a failed one may have.
    expect(needsNothing(listsTouchedByRun(run([rec(kind, 'pending'), rec(metric, 'skipped')])))).toBe(true);
    expect(listsTouchedByRun(run([rec(kind, 'failed'), rec(bandit('test'), 'done'), rec(bandit('test'), 'done'), rec(bandit('production'), 'undone'), rec(metric, 'done'), rec(ai, 'pending_approval'), rec(unit, 'done')]))).toEqual({
      contextKinds: true,
      metrics: true,
      experimentEnvs: ['test', 'production'],
      aiConfigs: true,
      settings: true,
    });
  });
});

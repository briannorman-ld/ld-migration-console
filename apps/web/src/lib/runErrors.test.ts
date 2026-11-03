import { describe, expect, it } from 'vitest';
import type { RunRecord, StepRecord } from '@sslm/executor';
import { groupRunErrors, normalizeError, runErrorCounts, runErrorCsv, runErrorReport } from './runErrors.ts';

const rec = (i: number, status: StepRecord['status'], error?: string): StepRecord => ({ id: `shell:f${i}`, label: `Flag “f${i}” (project settings)`, status, step: { id: `shell:f${i}`, deps: [], op: 'upsert_flag_shell', key: `f${i}`, exists: false, adopt: false, desired: {} as never }, ...(error ? { error } : {}) });
const run: RunRecord = {
  id: 'run-12345678',
  workspaceId: 'w',
  projectKey: 'p',
  label: '3175 gates and 605 dynamic configs → production',
  dryRun: false,
  startedAt: '2026-11-02T10:00:00Z',
  finishedAt: '2026-11-02T12:00:00Z',
  status: 'failed',
  steps: [
    rec(1, 'done'),
    rec(2, 'failed', 'LaunchDarkly 400 for /flags/statsig-migrator: At least two variations must be defined'),
    rec(3, 'failed', 'LaunchDarkly 400 for /flags/statsig-migrator: At least two variations must be defined'),
    rec(4, 'failed', 'Flag “f4” appeared since planning and wasn\'t created by this app. Re-plan to decide.'),
    rec(5, 'failed', 'Flag “f5” appeared since planning and wasn\'t created by this app. Re-plan to decide.'),
    rec(6, 'failed', 'LaunchDarkly 400 for /flags/statsig-migrator/f6: Prerequisite flag not found'),
    rec(7, 'skipped'),
  ],
};

describe('run errors', () => {
  it('groups failures by cause, ignoring the quoted names and resource paths, biggest group first', () => {
    const groups = groupRunErrors(run);
    expect(groups.map((g) => [g.steps.length, g.message])).toEqual([
      [2, 'LaunchDarkly 400 for /flags/statsig-migrator: At least two variations must be defined'],
      [2, 'Flag “f4” appeared since planning and wasn\'t created by this app. Re-plan to decide.'],
      [1, 'LaunchDarkly 400 for /flags/statsig-migrator/f6: Prerequisite flag not found'],
    ]);
    expect(normalizeError('Segment “a” appeared in test since planning')).toBe(normalizeError('Segment “b” appeared in test since planning'));
    expect(runErrorCounts(run)).toEqual({ failed: 5, distinct: 3 });
    expect(runErrorCounts({ steps: [rec(1, 'done')] })).toEqual({ failed: 0, distinct: 0 });
  });

  it('writes a Markdown report with one section per problem and a CSV with one row per failed step', () => {
    const md = runErrorReport(run);
    expect(md).toContain('# Run run-1234: 3175 gates and 605 dynamic configs → production');
    expect(md).toContain('5 failed step(s), 3 distinct error(s).');
    expect(md).toContain('## LaunchDarkly 400 for /flags/statsig-migrator: At least two variations must be defined');
    expect(md).toContain('- Flag “f2” (project settings)');
    const csv = runErrorCsv(run).split('\n');
    expect(csv[0]).toBe('step,label,operation,key,ldEnv,error');
    expect(csv).toHaveLength(7);
    expect(csv[1]).toContain('"shell:f2","Flag “f2” (project settings)","upsert_flag_shell","f2","","LaunchDarkly 400');
  });
});

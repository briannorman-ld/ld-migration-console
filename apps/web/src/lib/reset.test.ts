import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { LdAuthError, LdWriteError } from '@sslm/ld-client';
import { planReset, planSize, resetProject } from './reset.ts';

type Client = Parameters<typeof resetProject>[0];

/** An LD project with a few flags; `deleteFlag` records what it removed and can fire the cancel. */
function fakeProject(onDelete?: (key: string, n: number) => void, projectKey = 'p') {
  const flags = new Set(['a', 'b', 'c', 'd']);
  const deleted: string[] = [];
  const client: Client = {
    getProject: async (key) => ({ _id: '1', key, name: `Project ${key}` }) as never,
    listEnvironments: async () => [{ _id: '1', key: 'test', name: 'Test', color: 'fff', tags: [] } as never],
    listExperiments: async () => [],
    patchExperimentSemantic: async () => ({ key: 'x', name: 'x' }) as never,
    listFlags: async () => [...flags].map((key) => ({ key, name: key }) as never),
    deleteFlag: async (_p, key) => {
      flags.delete(key);
      deleted.push(key);
      onDelete?.(key, deleted.length);
    },
    listSegments: async () => [],
    deleteSegment: async () => undefined,
    listMetrics: async () => [],
    deleteMetric: async () => undefined,
    listContextKinds: async () => ({ items: [] }),
    putContextKind: async () => undefined,
    deleteEnvironment: async () => undefined,
  };
  return { client, flags, deleted, projectKey };
}

describe('planReset', () => {
  it('lists everything the reset will touch, and writes nothing', async () => {
    const writes: string[] = [];
    const client: Client = {
      getProject: async () => ({ _id: '1', key: 'shop', name: 'Shop' }) as never,
      listEnvironments: async () => [
        { _id: '1', key: 'production', name: 'Production', tags: [] },
        { _id: '2', key: 'staging', name: 'Staging', tags: ['migrated-from-statsig'] },
        { _id: '3', key: 'qa', name: 'QA', tags: ['statsig-migrated'] },
      ] as never,
      listFlags: async () => [{ key: 'f1', name: 'Flag one' }, { key: 'f2' }] as never,
      listSegments: async (_p, env) => (env === 'production' ? ([{ key: 'beta', name: 'Beta users' }] as never) : []),
      listMetrics: async () => [{ key: 'm1', name: 'Checkout' }] as never,
      listExperiments: async (_p, env) =>
        env === 'production'
          ? ([
              { key: 'x1', name: 'Running one', currentIteration: { status: 'running', treatments: [{ _id: 't1' }] } },
              { key: 'x2', name: 'Archived one', archivedDate: 1 },
            ] as never)
          : [],
      listContextKinds: async () => ({ items: [{ key: 'user' }, { key: 'org', name: 'Organization' }, { key: 'old', archived: true }] }),
      deleteFlag: async (...a) => void writes.push(a.join(' ')),
      deleteSegment: async (...a) => void writes.push(a.join(' ')),
      deleteMetric: async (...a) => void writes.push(a.join(' ')),
      patchExperimentSemantic: async (...a) => void writes.push(a.join(' ')) as never,
      putContextKind: async (...a) => void writes.push(a.join(' ')),
      deleteEnvironment: async (...a) => void writes.push(a.join(' ')),
    };
    const plan = await planReset(client, 'shop');
    expect(writes).toEqual([]);
    expect(plan).toMatchObject({
      projectKey: 'shop',
      projectName: 'Shop',
      flags: [{ key: 'f1', name: 'Flag one' }, { key: 'f2' }],
      segments: [{ env: 'production', key: 'beta', name: 'Beta users' }],
      metrics: [{ key: 'm1', name: 'Checkout' }],
      experiments: [{ env: 'production', key: 'x1', name: 'Running one', running: true, winningTreatmentId: 't1' }],
      contextKinds: [{ key: 'org', name: 'Organization' }],
      unreadable: [],
    });
    // Both migrated tags count as ours; LD's own environment is kept.
    expect(plan.environments).toEqual([
      { key: 'production', name: 'Production', action: 'keep', reason: 'not created by this console' },
      { key: 'staging', name: 'Staging', action: 'delete', reason: 'created by this console' },
      { key: 'qa', name: 'QA', action: 'delete', reason: 'created by this console' },
    ]);
    expect(planSize(plan)).toBe(2 + 1 + 1 + 1 + 1 + 2);
  });

  it('never plans to delete the last environment, even when it is ours', async () => {
    const { client } = fakeProject();
    client.listEnvironments = async () => [{ _id: '1', key: 'only', name: 'Only', tags: ['migrated-from-statsig'] }] as never;
    const plan = await planReset(client, 'p');
    expect(plan.environments).toEqual([{ key: 'only', name: 'Only', action: 'keep', reason: 'a project needs at least one environment' }]);
  });

  it('refuses a project whose key does not match what LD returned', async () => {
    const { client } = fakeProject();
    client.getProject = async () => ({ _id: '1', key: 'other', name: 'Other' }) as never;
    await expect(planReset(client, 'p')).rejects.toThrow(/returned project “other” for key “p”/);
  });

  it('records listings LD refused instead of failing, and leaves them out of the plan', async () => {
    const { client } = fakeProject();
    client.listExperiments = async () => {
      throw new Error('403 Forbidden');
    };
    const plan = await planReset(client, 'p');
    expect(plan.experiments).toEqual([]);
    expect(plan.unreadable).toEqual(['experiments in test: 403 Forbidden']);
  });
});

describe('resetProject', () => {
  it('deletes exactly what the plan lists, not what the project holds at run time', async () => {
    const { client, flags, deleted } = fakeProject();
    const plan = await planReset(client, 'p');
    flags.add('added-after-preview');
    const report = await resetProject(client, plan);
    expect(deleted).toEqual(['a', 'b', 'c', 'd']);
    expect(flags.has('added-after-preview')).toBe(true);
    expect(report.deleted.flags).toBe(4);
  });

  it('addresses every request to the plan’s project key', async () => {
    const seen = new Set<string>();
    const { client } = fakeProject();
    client.deleteFlag = async (p) => void seen.add(p);
    client.deleteEnvironment = async (p) => void seen.add(p);
    client.listEnvironments = async () => [
      { _id: '1', key: 'a', name: 'A', tags: [] },
      { _id: '2', key: 'b', name: 'B', tags: ['migrated-from-statsig'] },
    ] as never;
    const plan = await planReset(client, 'shop');
    await resetProject(client, plan);
    expect([...seen]).toEqual(['shop']);
  });
});

describe('resetProject stops on systemic failures', () => {
  it('a 429 that survived the retries stops the reset instead of crawling through every item', async () => {
    const { client, flags, deleted } = fakeProject();
    const plan = await planReset(client, 'p');
    const inner = client.deleteFlag;
    client.deleteFlag = async (p, key, signal) => {
      if (key === 'b') throw new LdWriteError(429, '/flags/p/b', { message: 'Rate limited' });
      return inner(p, key, signal);
    };
    const phases: string[] = [];
    const report = await resetProject(client, plan, (p) => phases.push(p.phase));
    expect(report.stopped).toEqual({ what: 'delete flag b', reason: expect.stringContaining('429') });
    expect(deleted).toEqual(['a']);
    expect(flags.size).toBe(3);
    expect(report.failures).toEqual([]);
    expect(phases.at(-1)).toBe('Stopped');
    expect(phases).not.toContain('Deleting segments');
  });

  it('a rejected token or an unreachable LD stops it too; an ordinary refusal does not', async () => {
    const { client } = fakeProject();
    client.listEnvironments = async () => [
      { _id: '1', key: 'a', name: 'A', tags: [] },
      { _id: '2', key: 'b', name: 'B', tags: ['migrated-from-statsig'] },
    ] as never;
    const withEnv = await planReset(client, 'p');

    client.deleteEnvironment = async () => {
      throw new LdAuthError(401, '/projects/p/environments/b');
    };
    expect((await resetProject(client, withEnv)).stopped?.what).toBe('delete environment b');

    client.deleteEnvironment = async () => {
      throw new LdWriteError('unreachable', '/projects/p/environments/b', null);
    };
    expect((await resetProject(client, withEnv)).stopped?.what).toBe('delete environment b');

    client.deleteEnvironment = async () => {
      throw new LdWriteError(403, '/projects/p/environments/b', { message: 'Forbidden' });
    };
    const report = await resetProject(client, withEnv);
    expect(report.stopped).toBeUndefined();
    expect(report.failures).toEqual([{ what: 'delete environment b', reason: expect.stringContaining('Forbidden') }]);
  });
});

describe('resetProject cancel', () => {
  it('stops after the request in flight and reports what was deleted so far', async () => {
    const ctrl = new AbortController();
    const { client, flags, deleted } = fakeProject((_key, n) => n === 2 && ctrl.abort(new DOMException('Cancelled by the user.', 'AbortError')));
    const plan = await planReset(client, 'p');
    const phases: string[] = [];
    const report = await resetProject(client, plan, (p) => phases.push(p.phase), ctrl.signal);
    expect(report.cancelled).toBe(true);
    expect(report.deleted.flags).toBe(2);
    expect(deleted).toEqual(['a', 'b']);
    expect(flags.size).toBe(2);
    expect(report.failures).toEqual([]);
    expect(phases.at(-1)).toBe('Cancelled');
    expect(phases).not.toContain('Deleting segments');
  });

  it('a signal aborted before the start deletes nothing', async () => {
    const { client, deleted } = fakeProject();
    const plan = await planReset(client, 'p');
    const ctrl = new AbortController();
    ctrl.abort();
    const report = await resetProject(client, plan, undefined, ctrl.signal);
    expect(report.cancelled).toBe(true);
    expect(deleted).toEqual([]);
  });

  it('without a signal, runs to the end as before', async () => {
    const { client, flags } = fakeProject();
    const report = await resetProject(client, await planReset(client, 'p'));
    expect(report.cancelled).toBeUndefined();
    expect(report.deleted.flags).toBe(4);
    expect(flags.size).toBe(0);
  });
});

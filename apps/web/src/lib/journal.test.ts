import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@sslm/executor';
import { coalescedJournal } from './journal.ts';

const run = (status: RunRecord['status']): RunRecord => ({ id: 'r', workspaceId: 'w', projectKey: 'p', label: 'l', dryRun: false, startedAt: '2026-11-02T10:00:00Z', status, steps: [] });

describe('coalescedJournal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes a running record at most once per interval, the latest state, and a terminal one at once', async () => {
    const writes: RunRecord['status'][] = [];
    const j = coalescedJournal(async (r) => void writes.push(r.status), { intervalMs: 2000 });
    const r = run('running');
    await j.save(r);
    await j.save(r);
    await j.save(r);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['running']);
    await j.save(r);
    await vi.advanceTimersByTimeAsync(1500);
    expect(writes).toEqual(['running']);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).toEqual(['running', 'running']);
    r.status = 'done';
    await j.save(r);
    expect(writes).toEqual(['running', 'running', 'done']);
  });

  it('a failed deferred write neither blocks nor hides the terminal write', async () => {
    let fail = true;
    const writes: string[] = [];
    const j = coalescedJournal(
      async (r) => {
        if (fail) throw new Error('quota');
        writes.push(r.status);
      },
      { intervalMs: 100 },
    );
    const r = run('running');
    await j.save(r);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([]);
    fail = false;
    r.status = 'stopped';
    await j.save(r);
    expect(writes).toEqual(['stopped']);
  });
});

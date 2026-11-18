import 'fake-indexeddb/auto';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunJournalRecord } from '@sslm/store';
import type { LdSession } from '../lib/ld.ts';
import { checkRunApprovals, resumeRun, undoRun } from '../lib/migration.ts';
import { store } from '../lib/store.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { RunsView } from './RunsView.tsx';

/** A run of one flag step, as the executor journals it; `over` sets its status, the step's, and the flag's key (a later run of the same key supersedes a stopped one). */
const run = (workspaceId: string, id: string, label: string, over: Partial<RunJournalRecord> & { stepStatus?: RunJournalRecord['steps'][number]['status']; key?: string } = {}): RunJournalRecord => {
  const { stepStatus = 'done', key = 'new_checkout', ...rest } = over;
  return {
    id,
    workspaceId,
    projectKey: 'shop',
    label,
    dryRun: false,
    startedAt: `2026-01-04T00:0${id.length % 10}:00Z`,
    finishedAt: '2026-01-04T00:09:00Z',
    status: 'done',
    steps: [
      {
        id: 's1',
        label: `Flag ${key}`,
        status: stepStatus,
        step: { id: 's1', deps: [], op: 'upsert_flag_shell', key, exists: true, adopt: false, desired: {} } as unknown as RunJournalRecord['steps'][number]['step'],
        hasPreImage: true,
      },
    ],
    ...rest,
  };
};

const m = { ld: { status: 'connected', projectKey: 'shop', instance: 'us' }, connected: true } as unknown as MigrationContext;

describe('runs from a workspace file', () => {
  afterEach(cleanup);

  it('are listed as history only: an imported badge and note, and no Resume or Undo', async () => {
    const ws = await store.createWorkspace({ name: `Runs ${crypto.randomUUID()}` });
    const importedAt = '2026-01-05T00:00:00Z';
    await store.saveRun(run(ws.id, 'own-stopped', 'Mine, stopped', { status: 'stopped', stepStatus: 'pending', startedAt: '2026-01-04T00:01:00Z', key: 'own_a' }));
    await store.saveRun(run(ws.id, 'own-done', 'Mine, done', { startedAt: '2026-01-04T00:02:00Z', key: 'own_b' }));
    await store.saveRun(run(ws.id, 'file-stopped', 'Theirs, stopped', { status: 'stopped', stepStatus: 'pending', importedAt, startedAt: '2026-01-04T00:03:00Z', key: 'file_a' }));
    await store.saveRun(run(ws.id, 'file-done', 'Theirs, done', { importedAt, startedAt: '2026-01-04T00:04:00Z', key: 'file_b' }));

    render(<RunsView workspaceId={ws.id} m={m} />);
    await screen.findByText('Theirs, done');
    expect(screen.getAllByText('imported')).toHaveLength(2);
    expect(screen.getAllByText(/Imported from a workspace file .*: shown as history only\. Imported runs can’t be resumed or undone here\./)).toHaveLength(2);
    // The browser's own runs keep their actions (a stopped run can be resumed or undone); the file's get none.
    expect(screen.getAllByRole('button', { name: /^Resume/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Undo…' })).toHaveLength(2);
    const card = (label: string) => screen.getByText(label).closest('.p-4')!;
    expect(card('Mine, stopped').querySelector('button[class*="py-1.5"]')?.textContent).toMatch(/^Resume/);
    expect(card('Theirs, stopped').textContent).not.toContain('Resume');
    expect(card('Theirs, done').textContent).not.toContain('Undo');
    expect(card('Mine, done').textContent).toContain('Undo…');
  });

  it('are refused by resume, undo and the approval check, whatever record the caller passes', async () => {
    const ws = await store.createWorkspace({ name: `Runs ${crypto.randomUUID()}` });
    const stored = run(ws.id, 'file-stopped', 'Theirs', { status: 'stopped', stepStatus: 'pending', importedAt: '2026-01-05T00:00:00Z' });
    await store.saveRun(stored);
    const ld = { status: 'connected', projectKey: 'shop', instance: 'us' } as unknown as LdSession;
    // The record on screen, and a copy with the mark stripped: the stored record decides.
    const { importedAt: _mark, ...stripped } = stored;
    for (const r of [stored, stripped]) {
      await expect(resumeRun(ws.id, ld, r)).rejects.toThrow(/Imported from a workspace file/);
      await expect(undoRun(ws.id, ld, { ...r, status: 'done' })).rejects.toThrow(/Imported from a workspace file/);
      await expect(checkRunApprovals(ws.id, ld, r)).rejects.toThrow(/Imported from a workspace file/);
    }
    // Nothing moved in the journal.
    expect((await store.getRun('file-stopped'))?.status).toBe('stopped');
    expect((await store.getRun('file-stopped'))?.steps[0]?.status).toBe('pending');
  });
});

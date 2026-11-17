import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptySnapshot } from '@sslm/canonical';
import { encodeWorkspaceFile, exportWorkspaceBundle } from '@sslm/store';
import { store } from '../lib/store.ts';
import { ExportWorkspaceModal, ImportWorkspaceModal, workspaceFileName } from './WorkspaceFile.tsx';

/** jsdom has no object URLs and no navigation: record the download instead. */
const downloads: { name: string; blob: Blob }[] = [];
beforeAll(() => {
  URL.createObjectURL = vi.fn((blob: Blob) => {
    downloads.push({ name: '', blob });
    return 'blob:test';
  });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = function () {
    downloads[downloads.length - 1]!.name = this.download;
  };
});

async function seedWorkspace(name: string) {
  const ws = await store.createWorkspace({ name });
  await store.addSource(ws.id, { id: `${ws.id}-src`, alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-01-01T00:00:00Z' });
  await store.saveSnapshot(ws.id, emptySnapshot({ sourceId: `${ws.id}-src`, sourceKind: 'console_api', alias: 'web' }, '2026-01-01T00:00:00Z'));
  await store.saveResolutions(ws.id, [{ id: 'd1', type: 'value_type', optionKey: 'a', scope: 'resource', decidedAt: '2026-01-02T00:00:00Z' }]);
  return (await store.getWorkspace(ws.id))!;
}

const file = (bytes: Uint8Array<ArrayBuffer>) => new File([bytes], 'x.sslm');
const choose = (f: File) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [f] } });

describe('workspace file', () => {
  afterEach(cleanup);

  it('names the file after the workspace and the day', () => {
    expect(workspaceFileName('Contoso migration', new Date('2026-11-16T10:00:00Z'))).toBe('contoso-migration-2026-11-16.sslm');
    expect(workspaceFileName('  ', new Date('2026-11-16T10:00:00Z'))).toBe('workspace-2026-11-16.sslm');
  });

  it('exports only with a confirmed passphrase, downloads the file and records the export time', async () => {
    const ws = await seedWorkspace('Export me');
    render(<ExportWorkspaceModal workspace={ws} onClose={vi.fn()} />);
    const exportBtn = () => screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement;
    expect(exportBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Passphrase for this file'), { target: { value: 'short' } });
    expect(screen.getByText('At least 8 characters.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Passphrase for this file'), { target: { value: 'correct horse battery' } });
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'correct horse' } });
    expect(screen.getByText('The two don’t match.')).toBeTruthy();
    expect(exportBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'correct horse battery' } });
    expect(exportBtn().disabled).toBe(false);

    const before = downloads.length;
    fireEvent.click(exportBtn());
    await screen.findByText(/^Saved/, undefined, { timeout: 10_000 });
    expect(downloads).toHaveLength(before + 1);
    expect(downloads[before]!.name).toMatch(/^export-me-\d{4}-\d{2}-\d{2}\.sslm$/);
    expect((await store.getWorkspace(ws.id))?.lastExportAt).toBeTruthy();
    // The body is encrypted: the source's label is not in the clear.
    const text = await new Promise<string>((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result as string);
      fr.readAsText(downloads[before]!.blob);
    });
    expect(text.startsWith('SSLM1\n')).toBe(true);
    expect(text).not.toContain('acme-web');
  }, 15_000);

  it('imports a new workspace from the start screen: asks for the passphrase, shows the plan, then creates it', async () => {
    const ws = await seedWorkspace('Teammate’s copy');
    const bundle = await exportWorkspaceBundle(store, ws.id);
    await store.deleteWorkspace(ws.id);
    const bytes = await encodeWorkspaceFile(bundle, { passphrase: 'open sesame', iterations: 1_000 });

    const onImported = vi.fn();
    render(<ImportWorkspaceModal onClose={vi.fn()} onImported={onImported} />);
    await act(async () => void choose(file(bytes)));
    await screen.findByText(/The file is encrypted/);
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText('That passphrase doesn’t open this file.');
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'open sesame' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    await screen.findByText(/A new workspace is created here/);
    expect(screen.getByText('Decisions').closest('tr')?.textContent).toContain('1');
    expect(await store.getWorkspace(ws.id)).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));
    await screen.findByRole('button', { name: 'Open workspace' });
    expect((await store.getWorkspace(ws.id))?.name).toBe('Teammate’s copy');
    expect((await store.listResolutions(ws.id)).map((r) => r.id)).toEqual(['d1']);
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(onImported).toHaveBeenCalledWith(ws.id);
  });

  it('merging into the open workspace shows what is new, and says so when nothing is', async () => {
    const ws = await seedWorkspace('Mine');
    const bundle = await exportWorkspaceBundle(store, ws.id);
    // The teammate decided one more thing and re-decided d1 later.
    bundle.tables.resolutions = [
      { ...bundle.tables.resolutions[0]!, optionKey: 'b', decidedAt: '2026-01-03T00:00:00Z' },
      { id: 'd2', type: 'value_type', optionKey: 'a', scope: 'resource', decidedAt: '2026-01-03T00:00:00Z', workspaceId: ws.id },
    ];
    const bytes = await encodeWorkspaceFile(bundle);

    const onImported = vi.fn();
    render(<ImportWorkspaceModal into={ws} onClose={vi.fn()} onImported={onImported} />);
    await act(async () => void choose(file(bytes)));
    await screen.findByText(/Merged into/);
    const decisions = screen.getByText('Decisions').closest('tr')!;
    const cells = [...decisions.querySelectorAll('td')].map((c) => c.textContent);
    expect(cells).toEqual(['Decisions', '1', '1', '—']);
    const snaps = [...screen.getByText('Snapshots').closest('tr')!.querySelectorAll('td')].map((c) => c.textContent);
    expect(snaps).toEqual(['Snapshots', '—', '—', '1']);
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 records' }));
    await screen.findByText(/Imported 2 records/);
    const got = Object.fromEntries((await store.listResolutions(ws.id)).map((r) => [r.id, r.optionKey]));
    expect(got).toEqual({ d1: 'b', d2: 'a' });
    cleanup();

    // The same file again: nothing to write.
    render(<ImportWorkspaceModal into={ws} onClose={vi.fn()} onImported={onImported} />);
    await act(async () => void choose(file(bytes)));
    await screen.findByText('This browser already has everything in the file. Nothing to write.');
    expect((screen.getByRole('button', { name: 'Import 0 records' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a file that is not a workspace file', async () => {
    render(<ImportWorkspaceModal onClose={vi.fn()} onImported={vi.fn()} />);
    await act(async () => void choose(new File([new TextEncoder().encode('{"hello":"world"}')], 'x.json')));
    await screen.findByText(/Not a workspace file/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose file…' })).toBeTruthy());
  });
});

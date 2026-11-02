import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRecord } from '@sslm/store';
import { rememberOnDevice, resetSecretsForTests, secrets } from '../lib/secrets.ts';
import { store } from '../lib/store.ts';
import { RememberKeysCard, UnlockKeysBar } from './DeviceVault.tsx';

const workspace = (id: string, over: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({ id, name: 'Contoso', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z', isDemo: false, ld: { instance: 'us', projectKey: 'p' }, ...over });
const flush = () => new Promise((r) => setTimeout(r, 60));

describe('device vault UI', () => {
  beforeEach(resetSecretsForTests);
  afterEach(cleanup);

  it('restores a device vault on open without asking anything', async () => {
    const id = `w-${crypto.randomUUID()}`;
    await store.createWorkspace({ id, name: `Contoso ${id}` });
    secrets.set('statsig', 'src-1', 'console-key', id);
    await flush();
    resetSecretsForTests(); // the next tab
    render(<UnlockKeysBar workspaceId={id} workspace={workspace(id)} />);
    await waitFor(() => expect(secrets.get('statsig', 'src-1')).toBe('console-key'));
    expect(screen.queryByRole('region', { name: 'Unlock keys' })).toBeNull();
  });

  it('shows the unlock bar only for a locked passphrase vault, and reports a wrong passphrase', async () => {
    const id = `w-${crypto.randomUUID()}`;
    await store.createWorkspace({ id, name: `Contoso ${id}` });
    secrets.set('statsig', 'src-1', 'console-key', id);
    await rememberOnDevice(id, 'correct horse battery staple');
    resetSecretsForTests(); // the next tab
    render(<UnlockKeysBar workspaceId={id} workspace={workspace(id)} />);
    const input = await screen.findByLabelText('Passphrase');
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/passphrase doesn't unlock/);
    fireEvent.change(input, { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unlock keys' })).toBeNull());
    expect(secrets.get('statsig', 'src-1')).toBe('console-key');
  });

  it('stays hidden when nothing is stored', async () => {
    const id = `w-${crypto.randomUUID()}`;
    render(<UnlockKeysBar workspaceId={id} workspace={workspace(id)} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('region', { name: 'Unlock keys' })).toBeNull();
  });

  it('card: device by default; protect with a confirmed passphrase; keep in memory only; back to the device', async () => {
    const id = `w-${crypto.randomUUID()}`;
    await store.createWorkspace({ id, name: `Contoso ${id}` });
    secrets.set('ld', id, 'api-ld-token');
    await flush();
    const { rerender } = render(<RememberKeysCard workspaceId={id} workspace={workspace(id)} />);
    await screen.findByText(/kept on this device and restored/);
    expect(screen.getByText(/Holding the LaunchDarkly token/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Protect with a passphrase' }));
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct horse battery staple' } });
    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: 'different one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Protect with this passphrase' }));
    await screen.findByText('The passphrases differ.');
    fireEvent.change(screen.getByLabelText('Confirm'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Protect with this passphrase' }));
    await screen.findByText(/protected with a passphrase on this device and unlocked/);
    const rec = (await store.getVault(id))!;
    expect(rec.device).toBeUndefined();
    expect(rec.blob.salt).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Keep in memory only' }));
    await waitFor(async () => expect(await store.getVault(id)).toBeUndefined());
    rerender(<RememberKeysCard workspaceId={id} workspace={workspace(id, { tokenStorage: 'memory' })} />);
    await screen.findByText(/kept in memory only/);
    expect(secrets.get('ld', id)).toBe('api-ld-token');

    fireEvent.click(screen.getByRole('button', { name: 'Keep on this device' }));
    await waitFor(async () => expect((await store.getVault(id))?.device).toBeInstanceOf(CryptoKey));
    rerender(<RememberKeysCard workspaceId={id} workspace={workspace(id, { tokenStorage: 'device' })} />);
    await screen.findByText(/kept on this device and restored/);
  });
});

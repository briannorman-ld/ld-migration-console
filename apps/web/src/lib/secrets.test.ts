import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetDevice, isDeviceVaultUnlocked, rememberOnDevice, resetSecretsForTests, secrets, unlockDeviceVault, WrongPassphraseError } from './secrets.ts';
import { store } from './store.ts';

const ws = () => `w-${crypto.randomUUID()}`;
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('secrets vault', () => {
  beforeEach(resetSecretsForTests);

  it('keeps tokens in memory only until the user remembers them on this device', async () => {
    const w = ws();
    secrets.set('ld', w, 'api-ld-token');
    secrets.set('statsig', 'src-1', 'console-key', w);
    await flush();
    expect(await store.getVault(w)).toBeUndefined();
    expect(JSON.stringify(await store.db.workspaces.toArray())).not.toContain('api-ld-token');
  });

  it('encrypts the workspace’s tokens, restores them after a “reload”, and keeps saving new ones while unlocked', async () => {
    const w = ws();
    secrets.set('ld', w, 'api-ld-token');
    secrets.set('statsig', 'src-1', 'console-key', w);
    secrets.set('statsig', 'other-ws-src', 'not-mine', 'another-workspace');
    await rememberOnDevice(w, 'correct horse battery staple');
    const blob = (await store.getVault(w))!.blob;
    expect(JSON.stringify(blob)).not.toMatch(/api-ld-token|console-key|not-mine/);
    expect(isDeviceVaultUnlocked(w)).toBe(true);

    // A new key entered while unlocked is persisted too.
    secrets.set('statsig', 'src-2', 'console-key-2', w);
    await flush();
    expect((await store.getVault(w))!.blob.ciphertext).not.toBe(blob.ciphertext);

    // New tab: memory is empty, the blob is still there.
    resetSecretsForTests();
    expect(secrets.get('ld', w)).toBeUndefined();
    await expect(unlockDeviceVault(w, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(isDeviceVaultUnlocked(w)).toBe(false);
    const restored = await unlockDeviceVault(w, 'correct horse battery staple');
    expect(restored).toEqual({ ld: true, statsig: ['src-1', 'src-2'], ldSources: [] });
    expect(secrets.get('ld', w)).toBe('api-ld-token');
    expect(secrets.get('statsig', 'src-2')).toBe('console-key-2');
    expect(secrets.get('statsig', 'other-ws-src')).toBeUndefined();
  });

  it('drops a forgotten token from the stored blob, and forgets the device on request', async () => {
    const w = ws();
    secrets.set('ld', w, 'api-ld-token');
    secrets.set('statsig', 'src-1', 'console-key', w);
    await rememberOnDevice(w, 'correct horse battery staple');
    secrets.forget('ld', w);
    await flush();
    resetSecretsForTests();
    expect(await unlockDeviceVault(w, 'correct horse battery staple')).toEqual({ ld: false, statsig: ['src-1'], ldSources: [] });
    await forgetDevice(w);
    expect(await store.getVault(w)).toBeUndefined();
    expect(secrets.get('statsig', 'src-1')).toBe('console-key');
    await expect(unlockDeviceVault(w, 'x')).rejects.toThrow(/No keys are stored/);
  });

  it('refuses a short passphrase', async () => {
    await expect(rememberOnDevice(ws(), 'short')).rejects.toThrow(/at least 8/);
  });
});

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { isDeviceVaultUnlocked, keepInMemoryOnly, keepOnDevice, rememberOnDevice, resetSecretsForTests, restoreDeviceVault, secrets, unlockDeviceVault, vaultMode, WrongPassphraseError } from './secrets.ts';
import { store } from './store.ts';

const ws = async () => {
  const id = `w-${crypto.randomUUID()}`;
  await store.createWorkspace({ id, name: `Contoso ${id}` });
  return id;
};
const flush = () => new Promise((r) => setTimeout(r, 60));

describe('secrets vault', () => {
  beforeEach(resetSecretsForTests);

  it('keeps tokens on this device by default: the first token creates a device vault, and a new tab gets them back without a prompt', async () => {
    const w = await ws();
    secrets.set('ld', w, 'api-ld-token');
    secrets.set('statsig', 'src-1', 'console-key', w);
    secrets.set('statsig', 'other-ws-src', 'not-mine', 'another-workspace');
    await flush();
    const rec = (await store.getVault(w))!;
    expect(rec.device).toBeInstanceOf(CryptoKey);
    expect(rec.device!.extractable).toBe(false);
    expect(rec.blob.salt).toBeUndefined();
    expect(JSON.stringify(rec.blob)).not.toMatch(/api-ld-token|console-key|not-mine/);
    expect(JSON.stringify(await store.db.workspaces.toArray())).not.toContain('api-ld-token');
    expect(vaultMode(rec, undefined)).toBe('device');

    // New tab: memory is empty; opening the workspace restores the tokens.
    resetSecretsForTests();
    expect(secrets.get('ld', w)).toBeUndefined();
    expect(await restoreDeviceVault(w)).toEqual({ ld: true, statsig: ['src-1'], ldSources: [], phSources: [] });
    expect(secrets.get('ld', w)).toBe('api-ld-token');
    expect(secrets.get('statsig', 'src-1')).toBe('console-key');
    expect(secrets.get('statsig', 'other-ws-src')).toBeUndefined();
    expect(isDeviceVaultUnlocked(w)).toBe(true);
    // Already open: nothing to do.
    expect(await restoreDeviceVault(w)).toBeUndefined();

    // A key entered in the restored session is saved into the same vault.
    secrets.set('statsig', 'src-2', 'console-key-2', w);
    await flush();
    resetSecretsForTests();
    expect(await restoreDeviceVault(w)).toEqual({ ld: true, statsig: ['src-1', 'src-2'], ldSources: [], phSources: [] });
  });

  it('memory only is an opt-out: nothing reaches disk until the user keeps keys on the device again', async () => {
    const w = await ws();
    await keepInMemoryOnly(w);
    secrets.set('ld', w, 'api-ld-token');
    await flush();
    expect(await store.getVault(w)).toBeUndefined();
    expect(vaultMode(undefined, (await store.getWorkspace(w))!.tokenStorage)).toBe('memory');
    expect(secrets.get('ld', w)).toBe('api-ld-token');

    await keepOnDevice(w);
    expect((await store.getVault(w))?.device).toBeInstanceOf(CryptoKey);
    resetSecretsForTests();
    expect(await restoreDeviceVault(w)).toEqual({ ld: true, statsig: [], ldSources: [], phSources: [] });
  });

  it('a passphrase replaces the device key: the blob carries the salt, the record no key, and a new tab must unlock', async () => {
    const w = await ws();
    secrets.set('ld', w, 'api-ld-token');
    secrets.set('statsig', 'src-1', 'console-key', w);
    await flush();
    await rememberOnDevice(w, 'correct horse battery staple');
    const rec = (await store.getVault(w))!;
    expect(rec.device).toBeUndefined();
    expect(rec.blob.salt).toBeDefined();
    expect(JSON.stringify(rec.blob)).not.toMatch(/api-ld-token|console-key/);
    expect(vaultMode(rec, undefined)).toBe('passphrase');

    // A new key entered while unlocked is persisted too.
    secrets.set('statsig', 'src-2', 'console-key-2', w);
    await flush();
    expect((await store.getVault(w))!.blob.ciphertext).not.toBe(rec.blob.ciphertext);

    resetSecretsForTests();
    expect(await restoreDeviceVault(w)).toBeUndefined(); // waits for the passphrase
    expect(secrets.get('ld', w)).toBeUndefined();
    await expect(unlockDeviceVault(w, 'wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(isDeviceVaultUnlocked(w)).toBe(false);
    expect(await unlockDeviceVault(w, 'correct horse battery staple')).toEqual({ ld: true, statsig: ['src-1', 'src-2'], ldSources: [], phSources: [] });
    expect(secrets.get('statsig', 'src-2')).toBe('console-key-2');
  });

  it('a token entered while a passphrase vault is locked stays in memory and is saved once unlocked', async () => {
    const w = await ws();
    secrets.set('ld', w, 'api-ld-token');
    await flush();
    await rememberOnDevice(w, 'correct horse battery staple');
    resetSecretsForTests();
    secrets.set('statsig', 'src-1', 'console-key', w);
    await flush();
    expect((await store.getVault(w))!.blob.salt).toBeDefined(); // not replaced by a device vault
    await unlockDeviceVault(w, 'correct horse battery staple');
    secrets.set('statsig', 'src-1', 'console-key', w); // re-entered (or re-saved) while unlocked
    await flush();
    resetSecretsForTests();
    expect(await unlockDeviceVault(w, 'correct horse battery staple')).toEqual({ ld: true, statsig: ['src-1'], ldSources: [], phSources: [] });
  });

  it('drops a forgotten token from the stored blob, and keeps nothing on disk after opting out', async () => {
    const w = await ws();
    secrets.set('ld', w, 'api-ld-token');
    secrets.set('statsig', 'src-1', 'console-key', w);
    await flush();
    secrets.forget('ld', w);
    await flush();
    resetSecretsForTests();
    expect(await restoreDeviceVault(w)).toEqual({ ld: false, statsig: ['src-1'], ldSources: [], phSources: [] });
    await keepInMemoryOnly(w);
    expect(await store.getVault(w)).toBeUndefined();
    expect(secrets.get('statsig', 'src-1')).toBe('console-key');
    secrets.set('statsig', 'src-2', 'console-key-2', w);
    await flush();
    expect(await store.getVault(w)).toBeUndefined();
    await expect(unlockDeviceVault(w, 'x')).rejects.toThrow(/No keys are stored/);
  });
});

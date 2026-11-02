/**
 * Token vault (PLAN §3.4). By default tokens live only in this module's Map: never in React
 * state snapshots, IndexedDB, workspace files, URLs or logs, and closing the tab forgets them.
 *
 * "Remember on this device" is opt-in per workspace: the workspace's tokens are AES-GCM encrypted
 * under a passphrase-derived key (PBKDF2, @sslm/store vault.ts) and only that blob reaches
 * IndexedDB. The passphrase is never kept; the derived, non-extractable key stays in memory for
 * the session, so new tokens entered while unlocked are re-encrypted and saved too. On the next
 * open the workspace asks for the passphrase once and the tokens come back.
 */
import { useSyncExternalStore } from 'react';
import { decryptVault, encryptVault, newVaultKey, unlockVaultKey, WrongPassphraseError, type UnlockedVault } from '@sslm/store';
import { store } from './store.ts';

/** `ld_source`: the read token of an LD project attached as a *source* (PLAN §20.2), keyed by source id. */
type SecretKind = 'statsig' | 'ld' | 'ld_source';

const vault = new Map<string, string>();
/** Which workspace each in-memory secret belongs to (StatSig keys are keyed by source id). */
const owners = new Map<string, string>();
/** Workspaces whose device vault is unlocked: the key to re-encrypt with on every change. */
const unlocked = new Map<string, UnlockedVault>();
const listeners = new Set<() => void>();
const key = (kind: SecretKind, id: string) => `${kind}:${id}`;
const notify = () => listeners.forEach((l) => l());

async function persist(workspaceId: string): Promise<void> {
  const u = unlocked.get(workspaceId);
  if (!u) return;
  const entries: Record<string, string> = {};
  for (const [k, ws] of owners) if (ws === workspaceId && vault.has(k)) entries[k] = vault.get(k)!;
  await store.saveVault(workspaceId, await encryptVault(entries, u));
}

export const secrets = {
  /** `workspaceId` ties the secret to a workspace so "remember on this device" knows what to save. */
  set(kind: SecretKind, id: string, value: string, workspaceId: string = id): void {
    vault.set(key(kind, id), value);
    owners.set(key(kind, id), workspaceId);
    notify();
    void persist(workspaceId);
  },
  get(kind: SecretKind, id: string): string | undefined {
    return vault.get(key(kind, id));
  },
  has(kind: SecretKind, id: string): boolean {
    return vault.has(key(kind, id));
  },
  forget(kind: SecretKind, id: string): void {
    const k = key(kind, id);
    const ws = owners.get(k);
    vault.delete(k);
    owners.delete(k);
    notify();
    if (ws) void persist(ws);
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export { WrongPassphraseError };

/**
 * Turn on "remember on this device" for a workspace: derive a key from the passphrase, encrypt
 * the tokens in memory for that workspace, save the blob, and keep the key for later changes.
 */
export async function rememberOnDevice(workspaceId: string, passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  unlocked.set(workspaceId, await newVaultKey(passphrase));
  await persist(workspaceId);
  notify();
}

/**
 * Unlock the device vault of a workspace: decrypt with the passphrase and load the tokens into
 * memory. Returns the kinds restored. Throws WrongPassphraseError on a mismatch.
 */
export async function unlockDeviceVault(workspaceId: string, passphrase: string): Promise<{ ld: boolean; statsig: string[]; ldSources: string[] }> {
  const rec = await store.getVault(workspaceId);
  if (!rec) throw new Error('No keys are stored on this device for this workspace.');
  const u = await unlockVaultKey(rec.blob, passphrase);
  const entries = await decryptVault(rec.blob, u);
  const restored = { ld: false, statsig: [] as string[], ldSources: [] as string[] };
  for (const [k, v] of Object.entries(entries)) {
    vault.set(k, v);
    owners.set(k, workspaceId);
    if (k === key('ld', workspaceId)) restored.ld = true;
    else if (k.startsWith('statsig:')) restored.statsig.push(k.slice('statsig:'.length));
    else if (k.startsWith('ld_source:')) restored.ldSources.push(k.slice('ld_source:'.length));
  }
  unlocked.set(workspaceId, u);
  notify();
  return restored;
}

/** Stop remembering: delete the blob and drop the key. Tokens stay in memory for this session. */
export async function forgetDevice(workspaceId: string): Promise<void> {
  unlocked.delete(workspaceId);
  await store.deleteVault(workspaceId);
  notify();
}

export function isDeviceVaultUnlocked(workspaceId: string): boolean {
  return unlocked.has(workspaceId);
}

export function useDeviceVaultUnlocked(workspaceId: string): boolean {
  return useSyncExternalStore(
    (l) => secrets.subscribe(l),
    () => unlocked.has(workspaceId),
  );
}

/** Test-only: drop every in-memory secret and key, as a fresh tab would. */
export function resetSecretsForTests(): void {
  vault.clear();
  owners.clear();
  unlocked.clear();
  notify();
}

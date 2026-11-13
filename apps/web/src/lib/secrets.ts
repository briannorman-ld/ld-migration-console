/**
 * Token vault (PLAN §3.4). Tokens live in this module's Map: never in React state snapshots,
 * workspace files, URLs or logs. What reaches IndexedDB is only an AES-GCM blob per workspace.
 *
 * By default a workspace's tokens are **kept on this device**: the first token entered creates a
 * non-extractable AES key (WebCrypto) that is stored in IndexedDB next to the blob. The browser
 * can decrypt with it but never reveals it, so the tokens come back on every open without a
 * prompt, while a copy of the database yields only ciphertext. Two alternatives per workspace:
 * - **passphrase**: the key is derived from a passphrase (PBKDF2) that is never stored; the vault
 *   is unlocked once per session. For shared machines.
 * - **memory only**: nothing reaches disk; closing the tab forgets the tokens.
 */
import { useSyncExternalStore } from 'react';
import { decryptVault, encryptVault, isDeviceVault, isPassphraseVault, newDeviceVaultKey, newVaultKey, unlockVaultKey, WrongPassphraseError, type UnlockedVault, type VaultRecord } from '@sslm/store';
import { store } from './store.ts';

/**
 * `ld_source`: the read token of an LD project attached as a *source* (PLAN §20.2), keyed by
 * source id. `ph_source`: the personal API key of a PostHog project source (PLAN §22.2), same keying.
 */
type SecretKind = 'statsig' | 'ld' | 'ld_source' | 'ph_source';

const vault = new Map<string, string>();
/** Which workspace each in-memory secret belongs to (StatSig keys are keyed by source id). */
const owners = new Map<string, string>();
/** Workspaces whose vault is open: the key to re-encrypt with on every change. */
const unlocked = new Map<string, UnlockedVault>();
/** Device vaults being created, so two tokens entered at once share one key. */
const enabling = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const key = (kind: SecretKind, id: string) => `${kind}:${id}`;
const notify = () => listeners.forEach((l) => l());

async function persist(workspaceId: string): Promise<void> {
  const u = unlocked.get(workspaceId);
  if (!u) return;
  const entries: Record<string, string> = {};
  for (const [k, ws] of owners) if (ws === workspaceId && vault.has(k)) entries[k] = vault.get(k)!;
  await store.saveVault(workspaceId, await encryptVault(entries, u), isDeviceVault(u) ? u.key : undefined);
}

/**
 * Save after a change: into the open vault, or, when the workspace has no vault yet and has not
 * opted out, by creating its device vault first. A locked passphrase vault is left alone: the
 * token stays in memory until the user unlocks (UnlockKeysBar) and it is re-encrypted then.
 */
async function persistOrEnable(workspaceId: string): Promise<void> {
  if (unlocked.has(workspaceId)) return persist(workspaceId);
  let p = enabling.get(workspaceId);
  if (!p) {
    p = (async () => {
      const [ws, rec] = await Promise.all([store.getWorkspace(workspaceId), store.getVault(workspaceId)]);
      if (ws?.tokenStorage === 'memory' || rec) return;
      unlocked.set(workspaceId, await newDeviceVaultKey());
      notify();
    })().finally(() => enabling.delete(workspaceId));
    enabling.set(workspaceId, p);
  }
  await p;
  await persist(workspaceId);
}

export const secrets = {
  /** `workspaceId` ties the secret to a workspace so the vault knows what to save. */
  set(kind: SecretKind, id: string, value: string, workspaceId: string = id): void {
    vault.set(key(kind, id), value);
    owners.set(key(kind, id), workspaceId);
    notify();
    void persistOrEnable(workspaceId);
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

export interface Restored {
  ld: boolean;
  statsig: string[];
  ldSources: string[];
  phSources: string[];
}

function load(workspaceId: string, entries: Record<string, string>): Restored {
  const restored: Restored = { ld: false, statsig: [], ldSources: [], phSources: [] };
  for (const [k, v] of Object.entries(entries)) {
    vault.set(k, v);
    owners.set(k, workspaceId);
    if (k === key('ld', workspaceId)) restored.ld = true;
    else if (k.startsWith('statsig:')) restored.statsig.push(k.slice('statsig:'.length));
    else if (k.startsWith('ld_source:')) restored.ldSources.push(k.slice('ld_source:'.length));
    else if (k.startsWith('ph_source:')) restored.phSources.push(k.slice('ph_source:'.length));
  }
  return restored;
}

/**
 * Open a device vault on workspace open: decrypt with the stored device key and load the tokens.
 * Undefined when the workspace has no device vault (memory only, or a passphrase vault, which
 * waits for its passphrase). Idempotent: an open vault is not reloaded.
 */
export async function restoreDeviceVault(workspaceId: string): Promise<Restored | undefined> {
  if (unlocked.has(workspaceId)) return undefined;
  const rec = await store.getVault(workspaceId);
  if (!rec?.device) return undefined;
  const u: UnlockedVault = { key: rec.device };
  const entries = await decryptVault(rec.blob, u);
  const restored = load(workspaceId, entries);
  unlocked.set(workspaceId, u);
  notify();
  return restored;
}

/**
 * Protect a workspace's tokens with a passphrase: derive a key, re-encrypt the tokens in memory
 * under it, save the blob without a device key, and keep the derived key for later changes.
 */
export async function rememberOnDevice(workspaceId: string, passphrase: string): Promise<void> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  unlocked.set(workspaceId, await newVaultKey(passphrase));
  await store.updateWorkspace(workspaceId, { tokenStorage: 'device' });
  await persist(workspaceId);
  notify();
}

/**
 * Unlock a passphrase vault: decrypt with the passphrase and load the tokens into memory.
 * Returns the kinds restored. Throws WrongPassphraseError on a mismatch.
 */
export async function unlockDeviceVault(workspaceId: string, passphrase: string): Promise<Restored> {
  const rec = await store.getVault(workspaceId);
  if (!rec) throw new Error('No keys are stored on this device for this workspace.');
  const u = await unlockVaultKey(rec.blob, passphrase);
  const entries = await decryptVault(rec.blob, u);
  const restored = load(workspaceId, entries);
  unlocked.set(workspaceId, u);
  notify();
  return restored;
}

/**
 * Keep this workspace's tokens in memory only: delete the vault, drop its key, and remember the
 * choice so the next token entered does not recreate a device vault. Tokens already in memory
 * stay until the tab closes.
 */
export async function keepInMemoryOnly(workspaceId: string): Promise<void> {
  unlocked.delete(workspaceId);
  await store.updateWorkspace(workspaceId, { tokenStorage: 'memory' });
  await store.deleteVault(workspaceId);
  notify();
}

/** Back to the default: a device vault, created now with whatever tokens are in memory. */
export async function keepOnDevice(workspaceId: string): Promise<void> {
  await store.updateWorkspace(workspaceId, { tokenStorage: 'device' });
  const rec = await store.getVault(workspaceId);
  if (rec) return;
  unlocked.set(workspaceId, await newDeviceVaultKey());
  await persist(workspaceId);
  notify();
}

/** @deprecated Kept for the older UI path; same as `keepInMemoryOnly`. */
export const forgetDevice = keepInMemoryOnly;

export type VaultMode = 'device' | 'passphrase' | 'memory';

/** How a workspace's tokens are kept, from its vault record and its opt-out flag. */
export function vaultMode(rec: VaultRecord | undefined, tokenStorage: 'device' | 'memory' | undefined): VaultMode {
  if (rec) return isPassphraseVault(rec.blob) ? 'passphrase' : 'device';
  return tokenStorage === 'memory' ? 'memory' : 'device';
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
  enabling.clear();
  notify();
}

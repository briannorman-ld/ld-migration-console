import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import type { WorkspaceRecord } from '@sslm/store';
import { restoreAndReconnect, unlockAndReconnect } from '../lib/deviceVault.ts';
import { isSharedOrigin, SHARED_ORIGIN_NOTE } from '../lib/origin.ts';
import { keepInMemoryOnly, keepOnDevice, rememberOnDevice, secrets, useDeviceVaultUnlocked, vaultMode } from '../lib/secrets.ts';
import { store } from '../lib/store.ts';
import { Button, Callout, Card, Input, Label } from './ui.tsx';

/**
 * Mounted at the top of every workspace (PLAN §3.4). On open it restores a device vault without
 * a prompt and reconnects LaunchDarkly. For a passphrase vault it shows the unlock bar instead:
 * one passphrase brings every token back; "Not now" leaves the workspace usable without them.
 */
export function UnlockKeysBar({ workspaceId, workspace }: { workspaceId: string; workspace: WorkspaceRecord }) {
  const stored = useLiveQuery(() => store.getVault(workspaceId), [workspaceId]);
  const unlocked = useDeviceVaultUnlocked(workspaceId);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissed, setDismissed] = useState(false);

  // A device vault opens by itself; nothing to ask.
  useEffect(() => {
    void restoreAndReconnect(workspaceId, workspace).catch(() => undefined);
    // Once per workspace: the record changing later (a new token saved) must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  if (!stored || stored.device || unlocked || dismissed) return null;
  const unlock = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await unlockAndReconnect(workspaceId, workspace, passphrase);
      setPassphrase('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-info-line/50 bg-info-bg px-4 py-2 text-sm" role="region" aria-label="Unlock keys">
      <span>
        <b>Keys are protected with a passphrase on this device.</b> Enter it to restore the LaunchDarkly and StatSig tokens for this session.
      </span>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (passphrase) void unlock();
        }}
      >
        <Input type="password" autoComplete="current-password" aria-label="Passphrase" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="w-48 py-1" />
        <Button type="submit" className="py-1 text-xs" disabled={!passphrase || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <Button type="button" variant="ghost" className="py-1 text-xs" onClick={() => setDismissed(true)} disabled={busy}>
          Not now
        </Button>
      </form>
      {error && (
        <span className="text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * How this workspace's tokens are kept (PLAN §3.4): on this device under a key the browser
 * holds (default), protected with a passphrase, or in memory only. Tokens are only ever written
 * to IndexedDB as an AES-GCM blob.
 */
export function RememberKeysCard({ workspaceId, workspace }: { workspaceId: string; workspace: WorkspaceRecord }) {
  const stored = useLiveQuery(() => store.getVault(workspaceId), [workspaceId]);
  const sources = useLiveQuery(() => store.listSources(workspaceId), [workspaceId]) ?? [];
  const unlocked = useDeviceVaultUnlocked(workspaceId);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [protecting, setProtecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const mode = vaultMode(stored, workspace.tokenStorage);
  const inMemory = [
    ...(secrets.has('ld', workspaceId) ? ['the LaunchDarkly token'] : []),
    ...sources.filter((s) => s.kind === 'console_api' && !s.isDemo && secrets.has('statsig', s.id)).map((s) => `the StatSig key for ${s.label}`),
    ...sources.filter((s) => s.kind === 'launchdarkly' && !s.isDemo && secrets.has('ld_source', s.id)).map((s) => `the LaunchDarkly read token for ${s.label}`),
    ...sources.filter((s) => s.kind === 'posthog' && !s.isDemo && secrets.has('ph_source', s.id)).map((s) => `the PostHog key for ${s.label}`),
  ];

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await fn());
      setPassphrase('');
      setConfirm('');
      setProtecting(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passphraseForm = (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          if (passphrase !== confirm) throw new Error('The passphrases differ.');
          await rememberOnDevice(workspaceId, passphrase);
          return inMemory.length ? `Protected ${inMemory.join(' and ')} with the passphrase. Keys you enter later are protected too.` : 'Turned on. Tokens you enter from now on are protected with the passphrase.';
        });
      }}
    >
      <p className="text-xs text-fg-muted">
        The passphrase is never stored, so losing it means entering the tokens again. You are asked for it once per session.
        {inMemory.length ? ` Will protect ${inMemory.join(' and ')}.` : ''}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="vault-pass">Passphrase</Label>
          <Input id="vault-pass" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="vault-pass2">Confirm</Label>
          <Input id="vault-pass2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" disabled={passphrase.length < 8 || busy}>
          {busy ? 'Encrypting…' : 'Protect with this passphrase'}
        </Button>
        {mode !== 'memory' && (
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setProtecting(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">Keys on this device</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          Tokens are only ever stored encrypted (AES-GCM) in this browser, and are sent only to StatSig and LaunchDarkly. By default the key is one this browser holds and cannot export, so
          the tokens come back when you reopen the workspace. On a shared machine, protect them with a passphrase or keep them in memory only.
        </p>
      </div>

      {mode === 'device' && !protecting && (
        <>
          <Callout tone="green">
            {stored
              ? 'Keys are kept on this device and restored when you open this workspace.'
              : 'Keys you enter are kept on this device and restored when you open this workspace.'}
            {inMemory.length ? ` Holding ${inMemory.join(' and ')}.` : ''}
          </Callout>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="py-1 text-xs" disabled={busy} onClick={() => setProtecting(true)}>
              Protect with a passphrase
            </Button>
            <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => void run(async () => (await keepInMemoryOnly(workspaceId), 'Keeping keys in memory only. The tokens stay until you close the tab.'))}>
              Keep in memory only
            </Button>
          </div>
        </>
      )}
      {mode === 'device' && protecting && passphraseForm}

      {mode === 'passphrase' && unlocked && (
        <>
          <Callout tone="green">Keys are protected with a passphrase on this device and unlocked for this session.{inMemory.length ? ` Holding ${inMemory.join(' and ')}.` : ''}</Callout>
          <Button variant="ghost" className="py-1 text-xs" disabled={busy} onClick={() => void run(async () => (await keepInMemoryOnly(workspaceId), 'Keeping keys in memory only. The tokens stay until you close the tab.'))}>
            Keep in memory only
          </Button>
        </>
      )}
      {mode === 'passphrase' && !unlocked && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await unlockAndReconnect(workspaceId, workspace, passphrase);
              return `Unlocked: ${[r.ld ? 'LaunchDarkly token' : '', r.statsig ? `${r.statsig} StatSig key${r.statsig === 1 ? '' : 's'}` : '', r.ldSources ? `${r.ldSources} LaunchDarkly source token${r.ldSources === 1 ? '' : 's'}` : '', r.phSources ? `${r.phSources} PostHog key${r.phSources === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') || 'no tokens were stored'}.`;
            });
          }}
        >
          <div>
            <Label htmlFor="vault-unlock">Passphrase</Label>
            <Input id="vault-unlock" type="password" autoComplete="current-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </div>
          <Button type="submit" disabled={!passphrase || busy}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(async () => (await keepInMemoryOnly(workspaceId), 'Forgotten on this device; keys are kept in memory only.'))}>
            Forget on this device
          </Button>
        </form>
      )}

      {mode === 'memory' && (
        <>
          <Callout tone="amber">
            Keys are kept in memory only: closing the tab forgets them.{inMemory.length ? ` Holding ${inMemory.join(' and ')}.` : ''}
            {isSharedOrigin() ? ` ${SHARED_ORIGIN_NOTE}` : ''}
          </Callout>
          <Button variant="secondary" className="py-1 text-xs" disabled={busy} onClick={() => void run(async () => (await keepOnDevice(workspaceId), 'Keys are kept on this device again.'))}>
            Keep on this device
          </Button>
          {passphraseForm}
        </>
      )}

      {error && <Callout tone="red">{error}</Callout>}
      {done && !error && <p className="text-xs text-fg-muted">{done}</p>}
    </Card>
  );
}

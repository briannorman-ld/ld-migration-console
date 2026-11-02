import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { WorkspaceRecord } from '@sslm/store';
import { unlockAndReconnect } from '../lib/deviceVault.ts';
import { useLdSession } from '../lib/ld.ts';
import { forgetDevice, rememberOnDevice, secrets, useDeviceVaultUnlocked } from '../lib/secrets.ts';
import { store } from '../lib/store.ts';
import { Button, Callout, Card, Input, Label } from './ui.tsx';

/**
 * Shown at the top of a workspace whose keys are remembered on this device but not yet unlocked
 * this session (PLAN §3.4 "unlocked per session"). One passphrase brings every token back and
 * reconnects LaunchDarkly; "Not now" leaves the workspace usable without them.
 */
export function UnlockKeysBar({ workspaceId, workspace }: { workspaceId: string; workspace: WorkspaceRecord }) {
  const stored = useLiveQuery(() => store.getVault(workspaceId), [workspaceId]);
  const unlocked = useDeviceVaultUnlocked(workspaceId);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissed, setDismissed] = useState(false);
  if (!stored || unlocked || dismissed) return null;
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
        <b>Keys are remembered on this device.</b> Enter the passphrase to restore the LaunchDarkly and StatSig tokens for this session.
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
 * "Remember on this device" (PLAN §3.4): opt in with a passphrase, see what is remembered, unlock
 * after a reload, or forget. Tokens are only ever written to IndexedDB as an AES-GCM blob.
 */
export function RememberKeysCard({ workspaceId, workspace }: { workspaceId: string; workspace: WorkspaceRecord }) {
  const stored = useLiveQuery(() => store.getVault(workspaceId), [workspaceId]);
  const sources = useLiveQuery(() => store.listSources(workspaceId), [workspaceId]) ?? [];
  const unlocked = useDeviceVaultUnlocked(workspaceId);
  const ld = useLdSession(workspaceId);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const inMemory = [
    ...(secrets.has('ld', workspaceId) ? ['the LaunchDarkly token'] : []),
    ...sources.filter((s) => s.kind === 'console_api' && !s.isDemo && secrets.has('statsig', s.id)).map((s) => `the StatSig key for ${s.label}`),
    ...sources.filter((s) => s.kind === 'launchdarkly' && !s.isDemo && secrets.has('ld_source', s.id)).map((s) => `the LaunchDarkly read token for ${s.label}`),
  ];

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await fn());
      setPassphrase('');
      setConfirm('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3 p-5">
      <div>
        <h3 className="text-sm font-semibold">Remember keys on this device</h3>
        <p className="mt-0.5 text-xs text-fg-muted">
          Optional. Tokens are encrypted in this browser with a passphrase (AES-GCM, key derived with PBKDF2) and unlocked once per session. The passphrase itself is never stored, so losing
          it means entering the tokens again. Tokens are still sent only to StatSig and LaunchDarkly, and never leave this browser otherwise.
        </p>
      </div>
      {stored && unlocked && (
        <>
          <Callout tone="green">Keys are remembered on this device and unlocked for this session.{ld.status === 'connected' ? ' LaunchDarkly reconnects on the next open after you enter the passphrase.' : ''}</Callout>
          <Button variant="secondary" className="py-1 text-xs" disabled={busy} onClick={() => void run(async () => (await forgetDevice(workspaceId), 'Forgotten on this device. The tokens stay in memory until you close the tab.'))}>
            Forget on this device
          </Button>
        </>
      )}
      {stored && !unlocked && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await unlockAndReconnect(workspaceId, workspace, passphrase);
              return `Unlocked: ${[r.ld ? 'LaunchDarkly token' : '', r.statsig ? `${r.statsig} StatSig key${r.statsig === 1 ? '' : 's'}` : '', r.ldSources ? `${r.ldSources} LaunchDarkly source token${r.ldSources === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') || 'no tokens were stored'}.`;
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
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(async () => (await forgetDevice(workspaceId), 'Forgotten on this device.'))}>
            Forget on this device
          </Button>
        </form>
      )}
      {!stored && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (passphrase !== confirm) throw new Error('The passphrases differ.');
              await rememberOnDevice(workspaceId, passphrase);
              return inMemory.length ? `Remembered ${inMemory.join(' and ')}. Keys you enter later are remembered too.` : 'Turned on. Tokens you enter from now on are remembered on this device.';
            });
          }}
        >
          <p className="text-xs text-fg-muted">{inMemory.length ? `Will remember ${inMemory.join(' and ')}.` : 'No tokens are in memory yet; whatever you connect from now on is remembered.'}</p>
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
              {busy ? 'Encrypting…' : 'Remember on this device'}
            </Button>
          </div>
        </form>
      )}
      {error && <Callout tone="red">{error}</Callout>}
      {done && !error && <p className="text-xs text-fg-muted">{done}</p>}
    </Card>
  );
}

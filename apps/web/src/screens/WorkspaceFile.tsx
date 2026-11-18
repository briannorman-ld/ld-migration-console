/**
 * Workspace file export and import (PLAN §3.3 "Workspace file (.sslm)"). The export modal asks
 * for a passphrase for the file (the default; plain JSON is an explicit opt-out) and downloads
 * everything IndexedDB holds for the workspace, tokens excepted. The import modal reads a file,
 * asks for its passphrase when it has one, shows what the merge would write before anything is
 * written, and applies it: into the workspace it is opened from, or, from the start screen, as a
 * new workspace (or into the same workspace when the file is from it).
 */
import { useId, useRef, useState } from 'react';
import {
  applyWorkspaceImport,
  decodeWorkspaceFile,
  encodeWorkspaceFile,
  exportWorkspaceBundle,
  importPlanSize,
  planWorkspaceImport,
  readWorkspaceFileHeader,
  WORKSPACE_BUNDLE_TABLE_LABEL,
  WORKSPACE_BUNDLE_TABLES,
  WORKSPACE_FILE_EXTENSION,
  WORKSPACE_FILE_MIME,
  WorkspaceFileFormatError,
  WorkspaceFilePassphraseRequired,
  WrongPassphraseError,
  type WorkspaceBundle,
  type WorkspaceBundleTable,
  type WorkspaceFileHeader,
  type WorkspaceImportPlan,
  type WorkspaceRecord,
} from '@sslm/store';
import { Button, Callout, Input, Label, Modal, Spinner } from '../components/ui.tsx';
import { formatBytes, readFileBytes } from '../lib/bytes.ts';
import { download } from '../lib/migration.ts';
import { isSharedOrigin } from '../lib/origin.ts';
import { store } from '../lib/store.ts';

const MIN_PASSPHRASE = 8;

/** `Contoso migration` on 2026-11-16 → `contoso-migration-2026-11-16.sslm`. */
export function workspaceFileName(name: string, at = new Date()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  return `${slug}-${at.toISOString().slice(0, 10)}${WORKSPACE_FILE_EXTENSION}`;
}

export function ExportWorkspaceModal({ workspace, onClose }: { workspace: WorkspaceRecord; onClose: () => void }) {
  const id = useId();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [plain, setPlain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ bytes: number; filename: string }>();
  const tooShort = !plain && passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = !plain && confirm.length > 0 && confirm !== passphrase;
  const ready = plain || (passphrase.length >= MIN_PASSPHRASE && confirm === passphrase);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const bundle = await exportWorkspaceBundle(store, workspace.id);
      const bytes = await encodeWorkspaceFile(bundle, plain ? {} : { passphrase });
      const filename = workspaceFileName(workspace.name);
      download(filename, bytes, WORKSPACE_FILE_MIME);
      await store.updateWorkspace(workspace.id, { lastExportAt: new Date().toISOString() });
      setDone({ bytes: bytes.byteLength, filename });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export workspace file" onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <Callout tone="green">
            Saved <b>{done.filename}</b> ({formatBytes(done.bytes)}). {plain ? 'It is plain JSON: keep it where only your team can read it.' : 'Whoever imports it will need the passphrase; it is not stored anywhere.'}
          </Callout>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            The file holds everything this browser keeps for <b className="text-fg">{workspace.name}</b>: sources, snapshots, decisions, the mapping profile, runs and their undo pre-images, ID lists, items set aside and monitoring. Tokens are never
            included. Snapshots can carry people’s IDs from override lists and ID lists, so the file is encrypted with a passphrase of its own.
          </p>
          {!plain && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor={`${id}-pass`}>Passphrase for this file</Label>
                <Input id={`${id}-pass`} type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} aria-invalid={tooShort} />
                {tooShort && <p className="mt-1 text-xs text-error">At least {MIN_PASSPHRASE} characters.</p>}
              </div>
              <div>
                <Label htmlFor={`${id}-confirm`}>Repeat it</Label>
                <Input id={`${id}-confirm`} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
                {mismatch && <p className="mt-1 text-xs text-error">The two don’t match.</p>}
              </div>
            </div>
          )}
          <label className="flex items-start gap-2 text-fg-muted">
            <input type="checkbox" className="mt-0.5" checked={plain} onChange={(e) => setPlain(e.target.checked)} />
            <span>Export without a passphrase (plain JSON)</span>
          </label>
          {plain && (
            <Callout tone="amber">
              Anyone who gets the file can read every override list, ID list and spec upload in it. Only do this for a file that stays on your own machine.
            </Callout>
          )}
          {error && <Callout tone="red">{error}</Callout>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void run()} disabled={!ready || busy}>
              {busy && <Spinner />} Export
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

type Phase =
  | { kind: 'pick' }
  | { kind: 'passphrase'; bytes: Uint8Array; header: WorkspaceFileHeader; error?: string }
  | { kind: 'planning' }
  | { kind: 'plan'; bundle: WorkspaceBundle; plan: WorkspaceImportPlan }
  | { kind: 'applying'; plan: WorkspaceImportPlan }
  | { kind: 'done'; plan: WorkspaceImportPlan };

export function ImportWorkspaceModal({ into, onClose, onImported }: {
  /** The workspace to merge into. Absent (the start screen): the file's own workspace, created here if missing. */
  into?: WorkspaceRecord;
  onClose: () => void;
  onImported: (workspaceId: string) => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [error, setError] = useState<string>();
  const [passphrase, setPassphrase] = useState('');
  const busy = phase.kind === 'planning' || phase.kind === 'applying';

  const plan = async (bytes: Uint8Array, pass?: string) => {
    setPhase({ kind: 'planning' });
    try {
      const bundle = await decodeWorkspaceFile(bytes, pass ? { passphrase: pass } : {});
      const p = await planWorkspaceImport(store, bundle, {
        ...(into ? { into: into.id } : {}),
        ...(isSharedOrigin() ? { tokenStorage: 'memory' as const } : {}),
      });
      setPhase({ kind: 'plan', bundle, plan: p });
    } catch (e) {
      if (e instanceof WrongPassphraseError || e instanceof WorkspaceFilePassphraseRequired) {
        setPhase({ kind: 'passphrase', bytes, header: readWorkspaceFileHeader(bytes).header, ...(pass ? { error: 'That passphrase doesn’t open this file.' } : {}) });
        return;
      }
      setPhase({ kind: 'pick' });
      setError(e instanceof WorkspaceFileFormatError ? e.message : `Could not read the file: ${(e as Error).message}`);
    }
  };

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(undefined);
    try {
      const bytes = await readFileBytes(file);
      const { header } = readWorkspaceFileHeader(bytes);
      if (header.encryption) setPhase({ kind: 'passphrase', bytes, header });
      else await plan(bytes);
    } catch (e) {
      setError(e instanceof WorkspaceFileFormatError ? e.message : `Could not read the file: ${(e as Error).message}`);
    }
  };

  const apply = async (p: WorkspaceImportPlan) => {
    setPhase({ kind: 'applying', plan: p });
    try {
      await applyWorkspaceImport(store, p);
      setPhase({ kind: 'done', plan: p });
    } catch (e) {
      setPhase({ kind: 'pick' });
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={into ? `Import into ${into.name}` : 'Import a workspace file'} onClose={busy ? undefined : onClose}>
      <div className="space-y-4 text-sm">
        {phase.kind === 'pick' && (
          <>
            <p className="text-fg-muted">
              {into
                ? 'Merges a workspace file into this workspace: what the file has and this browser lacks is added, and a decision or setting both have keeps whichever was made later. Nothing is written until you have seen the result.'
                : 'Opens a workspace file exported from this console, here or on another machine, as a workspace in this browser. If the workspace already exists here, the file is merged into it. Nothing is written until you have seen the result.'}
            </p>
            <input ref={fileInput} id={`${id}-file`} type="file" accept={`${WORKSPACE_FILE_EXTENSION},${WORKSPACE_FILE_MIME},application/octet-stream`} className="hidden" onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
            {error && <Callout tone="red">{error}</Callout>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => fileInput.current?.click()}>Choose file…</Button>
            </div>
          </>
        )}
        {phase.kind === 'passphrase' && (
          <>
            <p className="text-fg-muted">
              <b className="text-fg">{phase.header.workspaceName}</b>, exported {new Date(phase.header.exportedAt).toLocaleString()}. The file is encrypted; enter the passphrase it was exported with.
            </p>
            <div>
              <Label htmlFor={`${id}-pass`}>Passphrase</Label>
              <Input
                id={`${id}-pass`}
                type="password"
                autoComplete="off"
                autoFocus
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && passphrase && void plan(phase.bytes, passphrase)}
                aria-invalid={!!phase.error}
              />
              {phase.error && <p className="mt-1 text-xs text-error">{phase.error}</p>}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPhase({ kind: 'pick' })}>
                Back
              </Button>
              <Button onClick={() => void plan(phase.bytes, passphrase)} disabled={!passphrase}>
                Open
              </Button>
            </div>
          </>
        )}
        {(phase.kind === 'planning' || phase.kind === 'applying') && (
          <p className="flex items-center gap-2 text-fg-muted" role="status">
            <Spinner /> {phase.kind === 'planning' ? 'Reading the file and comparing it with this browser…' : 'Writing…'}
          </p>
        )}
        {phase.kind === 'plan' && <PlanView plan={phase.plan} bundle={phase.bundle} into={into} onBack={() => setPhase({ kind: 'pick' })} onApply={() => void apply(phase.plan)} />}
        {phase.kind === 'done' && (
          <>
            <Callout tone="green">
              {phase.plan.create ? (
                <>
                  Created <b>{phase.plan.create.name}</b> from the file.
                </>
              ) : (
                <>Imported {importPlanSize(phase.plan)} records.</>
              )}{' '}
              Tokens are not in a workspace file: connect LaunchDarkly and the sources again if they are not already connected here.
            </Callout>
            <div className="flex justify-end">
              <Button onClick={() => onImported(phase.plan.workspaceId)}>{phase.plan.create ? 'Open workspace' : 'Done'}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PlanView({ plan, bundle, into, onBack, onApply }: { plan: WorkspaceImportPlan; bundle: WorkspaceBundle; into?: WorkspaceRecord; onBack: () => void; onApply: () => void }) {
  const total = importPlanSize(plan);
  const rows = WORKSPACE_BUNDLE_TABLES.filter((t) => bundle.tables[t].length > 0);
  const conflicts = rows.reduce((n, t) => n + plan.counts[t].conflict, 0);
  const replaced = rows.filter((t) => plan.counts[t].replace > 0);
  return (
    <>
      <p className="text-fg-muted">
        <b className="text-fg">{bundle.workspace.name}</b>, exported {new Date(bundle.exportedAt).toLocaleString()}.{' '}
        {plan.create ? (
          plan.renamed ? (
            <>
              A workspace of that name already exists here, so a new one named <b className="text-fg">{plan.renamed}</b> is created.
            </>
          ) : (
            'A new workspace is created here.'
          )
        ) : (
          <>
            Merged into <b className="text-fg">{into?.name ?? bundle.workspace.name}</b>.
          </>
        )}
      </p>
      <table className="w-full text-left text-xs">
        <thead className="text-fg-muted">
          <tr>
            <th className="py-1 font-medium">In the file</th>
            <th className="py-1 text-right font-medium">Added</th>
            <th className="py-1 text-right font-medium" title="Both have it; the file’s copy is newer">
              Replaced
            </th>
            <th className="py-1 text-right font-medium" title="Both have it; yours is newer or the same, or the record never changes">
              Kept
            </th>
            {conflicts > 0 && (
              <th className="py-1 text-right font-medium" title="Belongs to another workspace in this browser">
                Elsewhere
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const c = plan.counts[t];
            return (
              <tr key={t} className="border-t border-line-soft">
                <td className="py-1">{WORKSPACE_BUNDLE_TABLE_LABEL[t]}</td>
                <td className="py-1 text-right tabular-nums">{c.add || '—'}</td>
                <td className="py-1 text-right tabular-nums">{c.replace || '—'}</td>
                <td className="py-1 text-right tabular-nums text-fg-muted">{c.keep || '—'}</td>
                {conflicts > 0 && <td className="py-1 text-right tabular-nums text-fg-muted">{c.conflict || '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {replaced.length > 0 && (
        <Callout tone="amber">
          <p className="font-medium">Replaced by the file’s newer copies</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {replaced.map((t) => (
              <li key={t}>{describeReplaced(t, plan, bundle)}</li>
            ))}
          </ul>
        </Callout>
      )}
      {conflicts > 0 && (
        <Callout tone="amber">
          {conflicts} records in the file (sources, snapshots or ID lists) already belong to another workspace in this browser, most likely from an earlier import of the same file. They are left where they are.
        </Callout>
      )}
      {total === 0 && !plan.create && <Callout tone="blue">This browser already has everything in the file. Nothing to write.</Callout>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onApply} disabled={total === 0 && !plan.create}>
          {plan.create ? 'Create workspace' : `Import ${total} record${total === 1 ? '' : 's'}`}
        </Button>
      </div>
    </>
  );
}

/** How many replaced records are named before "and N more". */
const REPLACED_SHOWN = 8;

/**
 * One line per table with replacements, so the user sees which of their own records give way
 * (SECURITY-REVIEW M2): the mapping profile as a sentence with the file's time, lists by their
 * ids or keys (the plan's `replaced`), the other one-per-workspace records by name.
 */
function describeReplaced(t: WorkspaceBundleTable, plan: WorkspaceImportPlan, bundle: WorkspaceBundle): string {
  const label = WORKSPACE_BUNDLE_TABLE_LABEL[t];
  if (t === 'profiles') {
    const at = bundle.tables.profiles[0]?.updatedAt;
    return `The mapping profile (environment mapping, unit types, attributes, policies) is replaced by the file’s${at ? `, last changed ${new Date(at).toLocaleString()}` : ''}.`;
  }
  const names = plan.replaced[t].filter(Boolean);
  if (names.length === 0) return `${label}: replaced by the file’s copy.`;
  const shown = names.slice(0, REPLACED_SHOWN).join(', ');
  const more = names.length - Math.min(names.length, REPLACED_SHOWN);
  return `${label} (${names.length}): ${shown}${more > 0 ? `, and ${more} more` : ''}.`;
}

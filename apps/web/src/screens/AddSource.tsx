import { useState } from 'react';
import { ENTITY_KINDS, type EntityKind, type SourceDescriptor, type SourceKind } from '@sslm/canonical';
import { MAX_SPEC_BYTES } from '@sslm/adapters';
import { LD_INSTANCES, type LdInstanceId } from '@sslm/ld-client';
import { STATSIG_CONSOLE_BASE_URL } from '@sslm/statsig-client';
import { appendLog, describeProgress, describeTransportEvent, SyncActivity, type SyncLogEntry } from '../components/SyncActivity.tsx';
import { Button, Callout, Card, Input, Label, Select, Spinner } from '../components/ui.tsx';
import { KIND_LABEL } from '../lib/kinds.ts';
import { secrets } from '../lib/secrets.ts';
import { store } from '../lib/store.ts';
import { syncConsoleSource, syncLdSource, uploadSpec } from '../lib/sync.ts';

/**
 * Add a source: a StatSig project (Console API key, recommended, or an uploaded config spec,
 * PLAN §4.2), or another LaunchDarkly project read with its own token (PLAN §20.2).
 */
export function AddSource({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [kind, setKind] = useState<SourceKind>('console_api');
  const [label, setLabel] = useState('');
  const [alias, setAlias] = useState('');
  const [key, setKey] = useState('');
  const [ldInstance, setLdInstance] = useState<LdInstanceId>('us');
  const [ldProject, setLdProject] = useState('');
  const [file, setFile] = useState<File>();
  const [kinds, setKinds] = useState<Set<EntityKind>>(() => new Set(ENTITY_KINDS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [log, setLog] = useState<SyncLogEntry[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; endpoint: string }>();

  const add = async () => {
    setBusy(true);
    setError(undefined);
    setLog([]);
    setProgress(undefined);
    const push = (e: SyncLogEntry) => setLog((l) => appendLog(l, e));
    const a = (alias || label || (kind === 'launchdarkly' ? ldProject : '') || 'src').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24);
    // Only Console API sources have a crawl scope; a spec file already holds whatever it holds.
    const scope = kind === 'console_api' && kinds.size < ENTITY_KINDS.length ? { resources: ENTITY_KINDS.filter((k) => kinds.has(k)) } : {};
    const source: SourceDescriptor = {
      id: crypto.randomUUID(),
      alias: a,
      label: label || (kind === 'launchdarkly' ? `${ldProject.trim()} (LaunchDarkly)` : a),
      kind,
      createdAt: new Date().toISOString(),
      ...(kind === 'console_api' ? { baseUrl: STATSIG_CONSOLE_BASE_URL, ...scope } : {}),
      ...(kind === 'launchdarkly' ? { ld: { instance: ldInstance, projectKey: ldProject.trim() } } : {}),
    };
    try {
      await store.addSource(workspaceId, source);
      if (kind === 'launchdarkly') {
        secrets.set('ld_source', source.id, key.trim(), workspaceId);
        setKey('');
        await syncLdSource(workspaceId, source, {
          onProgress: (p) => {
            setProgress(p);
            push(describeProgress(p));
          },
          onTransport: (e) => push(describeTransportEvent(e)),
        });
      } else if (kind === 'console_api') {
        secrets.set('statsig', source.id, key.trim(), workspaceId);
        setKey('');
        await syncConsoleSource(workspaceId, source, {
          onProgress: (p) => {
            setProgress(p);
            push(describeProgress(p));
          },
          onTransport: (e) => push(describeTransportEvent(e)),
        });
      } else if (file) {
        await uploadSpec(workspaceId, source, file);
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="font-display text-xl font-semibold tracking-tight">Add a source</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant={kind === 'console_api' ? 'primary' : 'secondary'} onClick={() => setKind('console_api')}>
          StatSig Console API key
        </Button>
        <Button variant={kind === 'config_spec' ? 'primary' : 'secondary'} onClick={() => setKind('config_spec')}>
          StatSig config spec
        </Button>
        <Button variant={kind === 'launchdarkly' ? 'primary' : 'secondary'} onClick={() => setKind('launchdarkly')}>
          LaunchDarkly project
        </Button>
      </div>
      <Card className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="src-label">Name</Label>
            <Input id="src-label" value={label} placeholder={kind === 'launchdarkly' ? 'acme-legacy (LaunchDarkly)' : 'acme-web'} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="src-alias">Alias (prefix for consolidation)</Label>
            <Input id="src-alias" value={alias} placeholder={kind === 'launchdarkly' ? 'legacy' : 'web'} onChange={(e) => setAlias(e.target.value)} />
          </div>
        </div>
        {kind === 'launchdarkly' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="src-ld-instance">Instance</Label>
                <Select id="src-ld-instance" value={ldInstance} onChange={(e) => setLdInstance(e.target.value as LdInstanceId)}>
                  {Object.values(LD_INSTANCES).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="src-ld-project">Project key</Label>
                <Input id="src-ld-project" value={ldProject} placeholder="legacy-storefront" spellCheck={false} onChange={(e) => setLdProject(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="src-ld-token">Access token (read access to that project)</Label>
              <Input id="src-ld-token" type="password" autoComplete="off" spellCheck={false} placeholder="api-…" value={key} onChange={(e) => setKey(e.target.value)} />
              <p className="mt-1.5 text-xs text-fg-muted">
                A Reader token is enough. It may belong to a <b>different LaunchDarkly account or instance</b> than the target project; it is kept encrypted on this device and sent
                only to that instance’s API. The source project is only ever read: flags, their per-environment targeting, segments
                and context kinds. Experiments and metrics are not read (they end in the source and launch new in the target).
              </p>
            </div>
          </>
        ) : kind === 'console_api' ? (
          <>
            <div>
              <Label htmlFor="src-key">Console API key (read-only)</Label>
              <Input id="src-key" type="password" autoComplete="off" spellCheck={false} placeholder="console-…" value={key} onChange={(e) => setKey(e.target.value)} />
              <p className="mt-1.5 text-xs text-fg-muted">
                Kept encrypted on this device and sent only to statsigapi.net. A Console API key belongs to <b>one StatSig project</b> (StatSig has no API that lists an
                organization’s projects), so add one source per project; several sources consolidate into this workspace’s single LaunchDarkly project.
              </p>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Resources to read</legend>
              <p className="mb-2 text-xs text-fg-muted">
                Uncheck what you don’t plan to migrate; each kind is one or more paged requests, so a smaller scope syncs faster. Gates reference segments, so keep
                segments when you keep gates. You can add the same project again later with a wider scope.
              </p>
              <div className="grid grid-cols-3 gap-x-4 gap-y-1.5">
                {ENTITY_KINDS.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={kinds.has(k)}
                      onChange={(e) =>
                        setKinds((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
                    />
                    {KIND_LABEL[k]}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex gap-3 text-xs">
                <button type="button" className="text-link hover:underline" onClick={() => setKinds(new Set(ENTITY_KINDS))}>
                  Select all
                </button>
                <button type="button" className="text-link hover:underline" onClick={() => setKinds(new Set<EntityKind>(['gate', 'segment']))}>
                  Gates and segments only
                </button>
              </div>
              {kinds.size === 0 && <p className="mt-1.5 text-xs text-error">Pick at least one resource kind.</p>}
            </fieldset>
            <p className="text-xs text-fg-muted">
              The browser talks to the StatSig Console API directly; no relay or server sits in between. The key is used read-only and nothing is written to StatSig.
            </p>
          </>
        ) : (
          <div>
            <Label htmlFor="src-file">Config spec file (.json, .json.gz)</Label>
            <input
              id="src-file"
              type="file"
              accept=".json,.gz,.br,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Checked here as well as in the parser, so a wrong file is refused before it is read at all.
                if (f && f.size > MAX_SPEC_BYTES) {
                  setFile(undefined);
                  setError(`“${f.name}” is ${(f.size / 1024 / 1024).toFixed(0)} MB; config specs are far smaller than ${MAX_SPEC_BYTES / 1024 / 1024} MB. Check that this is the download_config_specs file.`);
                  return;
                }
                setError(undefined);
                setFile(f);
              }}
              className="text-sm"
            />
            <p className="mt-1.5 text-xs text-fg-muted">
              Fetch with <code>curl -o spec.json "https://api.statsigcdn.com/v2/download_config_specs/&lt;CLIENT_KEY&gt;.json"</code> using a client key that has only the
              “Allow Download Config Specs” scope and covers all environments and target apps. The file stays in this browser.
            </p>
          </div>
        )}
        {error && <Callout tone="red">{error}</Callout>}
        <div className="flex items-center gap-3">
          <Button onClick={add} disabled={busy || (kind === 'console_api' ? !key || kinds.size === 0 : kind === 'launchdarkly' ? !key || !ldProject.trim() : !file)}>
            {busy && <Spinner />} {busy && kind !== 'config_spec' ? 'Syncing…' : 'Add source'}
          </Button>
          {busy && progress && (
            <span className="text-xs text-fg-muted tabular-nums">
              {progress.done}/{progress.total} · {progress.endpoint}
            </span>
          )}
        </div>
        {kind !== 'config_spec' && (busy || (error && log.length > 0)) && <SyncActivity log={log} running={busy} />}
      </Card>
    </div>
  );
}

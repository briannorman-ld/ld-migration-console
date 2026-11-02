import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseIdListFile } from '@sslm/adapters';
import { entityUid, type CanonicalSnapshot, type Segment, type SnapshotWarning } from '@sslm/canonical';
import { LIST_SEGMENT_MAX } from '@sslm/mapper';
import type { IdListHashesRecord, IdListRecord, SourceRecord } from '@sslm/store';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { Badge, Button, Callout, Card, Input, Spinner } from '../components/ui.tsx';
import { consoleAccessFor, fetchDeferredIdListsReport, ID_LIST_AUTO_MAX, ID_LIST_FETCH_MAX, type ConsoleAccess, type ConsoleAccessBlocked, type IdListFetchReport } from '../lib/migration.ts';
import { secrets } from '../lib/secrets.ts';
import { store } from '../lib/store.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { pipeline } from '../pipeline/client.ts';

const ID_LIST_PATH = /^\/segments\/(.+)\/id_list$/;

/** Segment id of a deferred-list warning path, or '' for any other warning. */
function segmentOf(path: string): string {
  return ID_LIST_PATH.exec(path)?.[1] ?? '';
}

const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');

/**
 * Schema mismatches, skipped endpoints, partial-spec hints: never silently swallowed. The ID-list
 * panel handles the lists a source can't deliver on its own: deferred Console API lists (loaded on
 * request, including the big ones), and a config spec's hashed lists, which are read from StatSig
 * through a Console API key when one is available, or reconciled from the `get_id_lists` files and
 * a raw-ID CSV otherwise (PLAN §4.2).
 */
export function WarningsView({
  workspaceId,
  sources,
  snapshots,
  m,
  onResync,
}: {
  workspaceId: string;
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  m: MigrationContext | null;
  onResync: (source: SourceRecord) => void;
}) {
  const idListRecs = useLiveQuery(() => store.listIdLists(workspaceId), [workspaceId]) ?? [];
  const hashRecs = useLiveQuery(() => store.listIdListHashes(workspaceId), [workspaceId]) ?? [];
  return (
    <div className="space-y-4">
      <h2 className="font-display text-xl font-semibold tracking-tight">Source warnings</h2>
      {sources.map((s) => (
        <SourceWarnings key={s.id} workspaceId={workspaceId} source={s} sources={sources} snapshot={snapshots[s.id]} snapshots={snapshots} m={m} idListRecs={idListRecs} hashRecs={hashRecs} onResync={() => onResync(s)} />
      ))}
    </div>
  );
}

type Fetch = { kind: 'idle' } | { kind: 'running'; message: string } | { kind: 'done'; report: IdListFetchReport } | { kind: 'error'; message: string };

function SourceWarnings({
  workspaceId,
  source,
  sources,
  snapshot,
  snapshots,
  m,
  idListRecs,
  hashRecs,
  onResync,
}: {
  workspaceId: string;
  source: SourceRecord;
  sources: SourceRecord[];
  snapshot: CanonicalSnapshot | undefined;
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  m: MigrationContext | null;
  idListRecs: IdListRecord[];
  hashRecs: IdListHashesRecord[];
  onResync: () => void;
}) {
  const allSnapshots = useMemo(() => Object.values(snapshots).filter((x): x is CanonicalSnapshot => !!x), [snapshots]);
  const w: SnapshotWarning[] = snapshot?.warnings ?? [];
  const pager = usePager(w);
  const [fetch, setFetch] = useState<Fetch>({ kind: 'idle' });

  // Deferred ID lists by segment id: loaded already (in IndexedDB) or loadable on request.
  const idLists = useMemo(() => {
    const out = new Map<string, 'loaded' | 'loadable' | 'too_big'>();
    if (!snapshot) return out;
    for (const x of w) {
      const seg = segmentOf(x.path ?? '');
      if (!seg || x.code !== 'fetch_skipped') continue;
      const entity = snapshot.segments.find((s) => s.id === seg);
      const loaded = !!m?.idLists[entityUid(snapshot.source.sourceId, 'segment', seg)] || !!entity?.idList?.ids;
      out.set(seg, loaded ? 'loaded' : (entity?.idList?.count ?? 0) > ID_LIST_FETCH_MAX ? 'too_big' : 'loadable');
    }
    return out;
  }, [w, snapshot, m?.idLists]);
  const loadable = [...idLists.values()].filter((v) => v === 'loadable').length;
  const tooBig = [...idLists.values()].filter((v) => v === 'too_big').length;

  const load = async () => {
    if (!m || !snapshot) return;
    setFetch({ kind: 'running', message: 'Starting…' });
    try {
      const report = await fetchDeferredIdListsReport(workspaceId, [source], [snapshot], m.idLists, (message) => setFetch({ kind: 'running', message }), ID_LIST_FETCH_MAX);
      setFetch({ kind: 'done', report });
    } catch (e) {
      setFetch({ kind: 'error', message: (e as Error).message });
    }
  };

  // Lists the mapper can't use as delivered: hashed (spec), deferred (console), or uploaded.
  const lists = useMemo(() => (snapshot?.segments ?? []).filter((s) => s.segmentType !== 'rule_based' && !s.archived && (s.idList?.hashed || !s.idList?.ids || idListRecs.some((r) => r.uid === s.uid))), [snapshot, idListRecs]);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <span className="font-medium">{source.label}</span>
        <Badge tone={w.length ? 'amber' : 'green'}>{w.length} warnings</Badge>
        <span className="text-xs text-fg-muted">missing from this source kind: {snapshot?.completeness.missing.join(', ') || 'nothing'}</span>
        <div className="ml-auto flex items-center gap-2">
          {idLists.size > 0 && source.kind === 'console_api' && (
            <Button
              variant="secondary"
              className="py-1 text-xs"
              disabled={fetch.kind === 'running' || !m || loadable === 0}
              onClick={() => void load()}
              title={loadable === 0 ? 'Every loadable list is loaded' : `Load the ${loadable} deferred list${loadable === 1 ? '' : 's'} (lists above ${ID_LIST_AUTO_MAX.toLocaleString()} IDs are not loaded automatically; they migrate as big segments)`}
            >
              {fetch.kind === 'running' ? <Spinner /> : null} Load deferred ID lists{loadable ? ` (${loadable})` : ''}
            </Button>
          )}
          {source.kind === 'console_api' && (
            <Button variant="secondary" className="py-1 text-xs" onClick={onResync} title="Crawl StatSig again and retry every skipped endpoint">
              Sync again
            </Button>
          )}
        </div>
      </div>
      {fetch.kind === 'running' && (
        <div className="flex items-center gap-2 px-4 py-2 text-xs text-fg-muted">
          <Spinner /> {fetch.message}
        </div>
      )}
      {fetch.kind === 'error' && (
        <div className="px-4 py-2">
          <Callout tone="red">{fetch.message}</Callout>
        </div>
      )}
      {fetch.kind === 'done' && (
        <div className="px-4 py-2">
          <Callout tone={fetch.report.blocked.length ? 'amber' : 'green'}>
            Loaded {fetch.report.loaded.length} ID list{fetch.report.loaded.length === 1 ? '' : 's'}.
            {fetch.report.tooBig.length > 0 && ` ${fetch.report.tooBig.length} stay deferred: above ${ID_LIST_FETCH_MAX.toLocaleString()} IDs, which is more than the Console API budget allows in one go.`}
            {fetch.report.blocked.map((b) => ` ${b.reason}`)}
          </Callout>
        </div>
      )}
      {snapshot && lists.length > 0 && m && <IdListsPanel workspaceId={workspaceId} source={source} sources={sources} snapshots={allSnapshots} segments={lists} m={m} idListRecs={idListRecs} hashRecs={hashRecs} />}
      {w.length === 0 ? (
        <div className="p-4">
          <Callout tone="green">No schema mismatches or skipped endpoints.</Callout>
        </div>
      ) : (
        <>
          {tooBig > 0 && fetch.kind === 'idle' && (
            <div className="px-4 pt-2 text-xs text-fg-muted">
              {tooBig} deferred list{tooBig === 1 ? ' is' : 's are'} above {ID_LIST_FETCH_MAX.toLocaleString()} IDs and can't be loaded through the Console API budget; export the list from StatSig and upload it as a raw-ID CSV below (the Console API returns 100 IDs per request).
            </div>
          )}
          <PagerBar pager={pager} label="warnings" className="px-4 py-2" />
          <ul className="divide-y divide-line-soft text-sm">
            {pager.slice.map((x, i) => {
              const seg = segmentOf(x.path ?? '');
              const state = seg ? idLists.get(seg) : undefined;
              return (
                <li key={`${pager.from}-${i}`} className="flex flex-wrap items-center gap-3 px-4 py-2">
                  <Badge tone={x.code === 'schema_mismatch' ? 'red' : 'amber'}>{x.code}</Badge>
                  <span className="font-mono text-xs text-fg-muted">{x.path}</span>
                  <span className="text-fg-muted">{x.message}</span>
                  {state === 'loaded' && <Badge tone="green">loaded</Badge>}
                  {state === 'loadable' && <Badge tone="violet" title="Above the automatic limit: load it on request; it migrates as a big segment">big segment</Badge>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

type Busy = { uid: string; message: string } | null;
type Access = { kind: 'checking' } | ({ kind: 'ok' } & ConsoleAccess) | ({ kind: 'blocked' } & ConsoleAccessBlocked);

/**
 * One row per ID list the source can't deliver ready to use. The first choice is always to read
 * the members from StatSig: a Console API source with its own key, a config spec through a key
 * entered here or borrowed from a Console API source of the workspace. A raw-ID CSV is the fallback
 * (no key, or a list above the Console API budget). Uploads and fetched lists stay in IndexedDB
 * (customer data, local only); hashing runs in the pipeline worker. The mapper reads the result
 * through `idLists` and `coverage`, so the Decisions page updates as soon as a list is in.
 */
function IdListsPanel({
  workspaceId,
  source,
  sources,
  snapshots,
  segments,
  m,
  idListRecs,
  hashRecs,
}: {
  workspaceId: string;
  source: SourceRecord;
  sources: SourceRecord[];
  snapshots: CanonicalSnapshot[];
  segments: Segment[];
  m: MigrationContext;
  idListRecs: IdListRecord[];
  hashRecs: IdListHashesRecord[];
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string>();
  const [access, setAccess] = useState<Access>({ kind: 'checking' });
  const [keyDraft, setKeyDraft] = useState('');
  const [keyOpen, setKeyOpen] = useState(false);
  const hashInput = useRef<Record<string, HTMLInputElement | null>>({});
  const rawInput = useRef<Record<string, HTMLInputElement | null>>({});

  // Can this source's lists be read from StatSig right now? Re-checked when a key is entered or the vault unlocks.
  useEffect(() => {
    let live = true;
    const check = () => {
      void consoleAccessFor(source, sources, snapshots).then((a) => {
        if (live) setAccess('blocked' in a ? { kind: 'blocked', ...a } : { kind: 'ok', ...a });
      });
    };
    check();
    const unsubscribe = secrets.subscribe(check);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [source, sources, snapshots]);

  const applyKey = () => {
    const key = keyDraft.trim();
    if (!key) return;
    secrets.set('statsig', source.id, key, workspaceId);
    setKeyDraft('');
    setKeyOpen(false);
  };

  const loadFromStatsig = async (seg: Segment) => {
    setError(undefined);
    setBusy({ uid: seg.uid, message: 'Connecting to StatSig…' });
    try {
      const a = await consoleAccessFor(source, sources, snapshots, seg.id);
      if ('blocked' in a) throw new Error(a.blocked);
      setBusy({ uid: seg.uid, message: `Reading ${n(seg.idList?.count)} IDs from StatSig${a.via.own ? '' : ` through ${a.via.label}`}…` });
      const list = await a.client.getIdList(seg.id);
      if (list.ids.length === 0) throw new Error(`StatSig returned no IDs for segment ${seg.id}${a.via.own ? '' : ` through ${a.via.label}: is it the same StatSig project?`}.`);
      const hashes = hashRecs.find((r) => r.uid === seg.uid)?.hashes;
      let coverage: IdListRecord['coverage'];
      if (seg.idList?.hashed && hashes) {
        // The spec's hashes check the fetch; StatSig's own members stay authoritative, so a hash the
        // files don't know (a list that grew since the files were exported) is not an "extra".
        setBusy({ uid: seg.uid, message: `Checking ${n(list.ids.length)} IDs against ${n(hashes.length)} hashes…` });
        const result = await pipeline().reconcileIdList({ ids: list.ids, hashes, count: seg.idList?.count });
        coverage = { ...result.coverage, extra: 0 };
      }
      await store.saveIdList({
        uid: seg.uid,
        workspaceId,
        sourceId: source.id,
        fetchedAt: new Date().toISOString(),
        ids: list.ids,
        origin: 'console',
        ...(a.via.own ? {} : { via: { sourceId: a.via.sourceId, label: a.via.label } }),
        ...(coverage ? { coverage } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const uploadHashes = async (seg: Segment, files: FileList | null) => {
    if (!files?.length) return;
    setError(undefined);
    setBusy({ uid: seg.uid, message: `Reading ${files.length} hash file${files.length === 1 ? '' : 's'}…` });
    try {
      const existing = hashRecs.find((r) => r.uid === seg.uid);
      const set = new Set(existing?.hashes ?? []);
      const names = [...(existing?.fileNames ?? [])];
      for (const f of Array.from(files).sort((a, b) => a.lastModified - b.lastModified)) {
        parseIdListFile(await f.text(), set);
        names.push(f.name);
      }
      await store.saveIdListHashes({ uid: seg.uid, workspaceId, sourceId: source.id, listName: seg.idList?.hashed?.listName ?? seg.id, uploadedAt: new Date().toISOString(), fileNames: names, hashes: [...set] });
      // A raw upload or StatSig read made before the hashes arrived was unverified: check it now.
      const rec = idListRecs.find((r) => r.uid === seg.uid);
      if (rec) {
        setBusy({ uid: seg.uid, message: `Re-checking ${n(rec.ids.length)} IDs against ${n(set.size)} hashes…` });
        const result = await pipeline().reconcileIdList({ ids: rec.ids, hashes: [...set], count: seg.idList?.count });
        if (rec.origin === 'upload') await store.saveIdList({ ...rec, fetchedAt: new Date().toISOString(), ids: result.ids, coverage: result.coverage });
        else await store.saveIdList({ ...rec, fetchedAt: new Date().toISOString(), coverage: { ...result.coverage, extra: 0 } });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const uploadRaw = async (seg: Segment, files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(undefined);
    setBusy({ uid: seg.uid, message: `Hashing the IDs in ${file.name}…` });
    try {
      const hashes = hashRecs.find((r) => r.uid === seg.uid)?.hashes;
      const result = await pipeline().reconcileIdList({ rawCsv: await file.text(), hashes, count: seg.idList?.count });
      if (result.ids.length === 0) throw new Error(`No usable IDs in ${file.name}: ${hashes ? 'none of them hash to an entry of the StatSig list' : 'the file is empty'}.`);
      await store.saveIdList({ uid: seg.uid, workspaceId, sourceId: source.id, fetchedAt: new Date().toISOString(), ids: result.ids, origin: 'upload', fileName: file.name, coverage: result.coverage });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const spec = source.kind === 'config_spec';
  const viaLabel = access.kind === 'ok' && !access.via.own ? access.via.label : undefined;

  return (
    <div className="border-b border-line-soft px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">ID lists</span>
        <span className="text-xs text-fg-muted">
          {spec
            ? 'A config spec names large lists but ships their members only as hashes (get_id_lists). The console reads the members from StatSig with a read-only Console API key and checks them against the hashes; without a key, upload the hash files and a CSV of the raw IDs instead. Everything is hashed and stored in this browser only.'
            : `Lists above ${ID_LIST_AUTO_MAX.toLocaleString()} IDs are not loaded automatically: load each from StatSig here (up to ${ID_LIST_FETCH_MAX.toLocaleString()} IDs, the Console API budget), or upload a CSV export. Above ${LIST_SEGMENT_MAX.toLocaleString()} IDs they migrate as LD big segments.`}
        </span>
      </div>
      {spec && access.kind === 'ok' && (
        <p className="mb-2 text-xs text-fg-muted" data-testid="id-list-access">
          Reading from StatSig {viaLabel ? `through the Console API key of ${viaLabel}` : 'with the Console API key entered for this source'}.
          {!viaLabel && (
            <Button variant="ghost" className="ml-2 py-0.5 text-xs" onClick={() => secrets.forget('statsig', source.id)}>
              Forget key
            </Button>
          )}
        </p>
      )}
      {access.kind === 'blocked' && (
        <div className="mb-2" data-testid="id-list-access">
          <Callout tone="blue">
            <span>{access.blocked}</span>
            {access.needsKey && !keyOpen && (
              <Button variant="secondary" className="ml-2 py-0.5 text-xs" onClick={() => setKeyOpen(true)}>
                Enter a Console API key
              </Button>
            )}
            {access.needsKey && keyOpen && (
              <form
                className="mt-2 flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  applyKey();
                }}
              >
                <Input type="password" autoComplete="off" aria-label="Console API key (read-only)" placeholder="console-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} className="w-72" />
                <Button type="submit" className="py-1 text-xs" disabled={!keyDraft.trim()}>
                  Use key
                </Button>
                <Button type="button" variant="ghost" className="py-1 text-xs" onClick={() => setKeyOpen(false)}>
                  Cancel
                </Button>
                <span className="text-xs text-fg-muted">Read-only key for the same StatSig project. Kept encrypted on this device, sent only to statsigapi.net.</span>
              </form>
            )}
          </Callout>
        </div>
      )}
      {error && (
        <div className="mb-2">
          <Callout tone="red">{error}</Callout>
        </div>
      )}
      <ul className="divide-y divide-line-soft text-sm">
        {segments.map((seg) => {
          const rec = idListRecs.find((r) => r.uid === seg.uid);
          const hashes = hashRecs.find((r) => r.uid === seg.uid);
          const cov = rec?.coverage;
          const count = seg.idList?.count ?? rec?.ids.length;
          const pct = cov && cov.total ? Math.floor((cov.matched / cov.total) * 1000) / 10 : undefined;
          const big = (rec?.ids.length ?? count ?? 0) > LIST_SEGMENT_MAX;
          const loaded = !!rec || !!seg.idList?.ids;
          const overBudget = (seg.idList?.count ?? 0) > ID_LIST_FETCH_MAX;
          const canFetch = access.kind === 'ok' && !overBudget;
          return (
            <li key={seg.uid} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-mono text-xs">{seg.id}</span>
              <span className="text-xs text-fg-muted">
                {n(count)} {seg.idType} IDs
              </span>
              {big && <Badge tone="violet" title={`Above LD's ${LIST_SEGMENT_MAX.toLocaleString()}-ID list limit: migrates as a big segment (CSV import, Enterprise)`}>big segment</Badge>}
              {!rec && seg.idList?.hashed && <Badge tone="amber">hashed: needs raw IDs</Badge>}
              {!rec && !seg.idList?.hashed && !seg.idList?.ids && <Badge tone="amber">not loaded</Badge>}
              {rec?.origin !== 'upload' && loaded && (
                <Badge tone="green" title={rec?.via ? `Read from StatSig through the Console API key of ${rec.via.label}` : 'Read from StatSig through the Console API'}>
                  {rec?.via ? `loaded from StatSig via ${rec.via.label}` : rec?.origin === 'console' && spec ? 'loaded from StatSig' : 'loaded'}
                </Badge>
              )}
              {cov && (
                <Badge tone={cov.verified ? (cov.missing === 0 ? 'green' : 'amber') : 'blue'} title={cov.verified ? `${n(cov.matched)} of ${n(cov.total)} hashes matched; ${n(cov.missing)} missing${cov.extra ? `; ${n(cov.extra)} uploaded IDs not in the list` : ''}` : 'No hash file uploaded: checked against the count only'}>
                  {cov.verified ? `reconciled ${pct}%` : `uploaded, unverified (${n(cov.matched)}/${n(cov.total)})`}
                </Badge>
              )}
              {hashes && (
                <span className="text-xs text-fg-muted" title={hashes.fileNames.join(', ')}>
                  {n(hashes.hashes.length)} hashes from {hashes.fileNames.length} file{hashes.fileNames.length === 1 ? '' : 's'}
                </span>
              )}
              {rec?.fileName && <span className="text-xs text-fg-muted">{rec.fileName}</span>}
              {busy?.uid === seg.uid && (
                <span className="flex items-center gap-1 text-xs text-fg-muted">
                  <Spinner /> {busy.message}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {overBudget && !loaded && (
                  <span className="text-xs text-fg-muted" title={`The Console API returns 100 IDs per request; ${n(seg.idList?.count)} IDs would take ${n(Math.ceil((seg.idList?.count ?? 0) / 100))} requests. Export the list from StatSig and upload it instead.`}>
                    above the Console API budget
                  </span>
                )}
                {!overBudget && (access.kind !== 'blocked' || !loaded) && (
                  <Button
                    variant={loaded ? 'ghost' : 'primary'}
                    className="py-1 text-xs"
                    disabled={!!busy || !canFetch}
                    onClick={() => void loadFromStatsig(seg)}
                    title={
                      access.kind === 'blocked'
                        ? access.blocked
                        : access.kind === 'checking'
                          ? 'Checking the Console API key…'
                          : `Read the ${n(seg.idList?.count)} IDs through the StatSig Console API${viaLabel ? ` (key of ${viaLabel})` : ''}${seg.idList?.hashed ? ', then check them against the hashes' : ''}`
                    }
                  >
                    {loaded ? 'Reload from StatSig' : 'Load from StatSig'}
                  </Button>
                )}
                {seg.idList?.hashed && (
                  <>
                    <input ref={(el) => void (hashInput.current[seg.uid] = el)} type="file" multiple className="hidden" onChange={(e) => void uploadHashes(seg, e.target.files).then(() => (e.target.value = ''))} />
                    <Button variant="secondary" className="py-1 text-xs" disabled={!!busy} onClick={() => hashInput.current[seg.uid]?.click()} title="The get_id_lists file(s) for this list: one +hash or -hash per line. Several files apply oldest first. Optional when the list is read from StatSig; they verify it.">
                      {hashes ? 'Add hash file' : 'Upload hash file'}
                    </Button>
                  </>
                )}
                <input ref={(el) => void (rawInput.current[seg.uid] = el)} type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => void uploadRaw(seg, e.target.files).then(() => (e.target.value = ''))} />
                <Button variant="secondary" className="py-1 text-xs" disabled={!!busy} onClick={() => rawInput.current[seg.uid]?.click()} title="Fallback when StatSig can't be read: a CSV (first column) or one ID per line, hashed in the browser and compared with the StatSig list.">
                  {rec?.origin === 'upload' ? 'Replace raw IDs' : 'Upload raw IDs'}
                </Button>
                {rec && (
                  <Button variant="ghost" className="py-1 text-xs" disabled={!!busy} onClick={() => void store.deleteIdList(seg.uid)} title="Forget this list's members on this device">
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {m.coverage && Object.keys(m.coverage).length > 0 && <p className="mt-2 text-xs text-fg-muted">Partial coverage is a decision (hashed_id_list) on the Decisions page: accept it to migrate the matched IDs, or reload the list from StatSig / upload a fuller CSV.</p>}
    </div>
  );
}

import { useState } from 'react';
import { ENTITY_KINDS, type EntityKind, type SourceDescriptor, type SourceKind } from '@sslm/canonical';
import { MAX_SPEC_BYTES, POSTHOG_REGIONS, PostHogClient, type PostHogRegionId } from '@sslm/adapters';
import { LD_INSTANCES, LdClient, type LdInstanceId, type LdProject } from '@sslm/ld-client';
import { STATSIG_CONSOLE_BASE_URL, StatsigConsoleClient } from '@sslm/statsig-client';
import { appendLog, describeProgress, describeTransportEvent, SyncActivity, type SyncLogEntry } from '../components/SyncActivity.tsx';
import { SearchSelect } from '../components/SearchSelect.tsx';
import { Button, Callout, Card, Input, Label, Select, Spinner } from '../components/ui.tsx';
import { KIND_LABEL } from '../lib/kinds.ts';
import { secrets } from '../lib/secrets.ts';
import { deriveAlias, specSourceLabel } from '../lib/sourceNaming.ts';
import { store } from '../lib/store.ts';
import { useFlag } from '../lib/flags.ts';
import { syncConsoleSource, syncLdSource, syncPostHogSource, uploadPostHogPayload, uploadSpec } from '../lib/sync.ts';

/** Shortest string we try as a LaunchDarkly token; anything shorter is still being typed. */
const MIN_LD_TOKEN_LENGTH = 8;
/** Shortest string we try as a PostHog personal API key (`phx_…`); anything shorter is still being typed. */
const MIN_PH_KEY_LENGTH = 8;

/** The read scopes a PostHog personal API key needs (PLAN §22.1); the console never writes. */
const POSTHOG_READ_SCOPES = ['feature_flag:read', 'cohort:read', 'group:read', 'person:read', 'project:read', 'property_definition:read', 'user:read', 'organization_member:read'];

/** A PostHog project the key can read, as `PostHogClient.listReadableProjects` returns it. */
interface PostHogProjectOption {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
}

/**
 * Add a source: a StatSig project (Console API key, recommended, or an uploaded config spec,
 * PLAN §4.2), another LaunchDarkly project read with its own token (PLAN §20.2), or a PostHog
 * project read with a personal API key or from an uploaded local-evaluation payload (PLAN §22.2).
 *
 * The source names itself. A Console key belongs to one StatSig project, so its name comes from
 * `GET /project`; a LaunchDarkly token or PostHog key can read many projects, so they are listed
 * and one is picked; a spec or payload file is named after the file. The alias (tags, provenance,
 * consolidation prefix; see `sourceNaming.ts`) is derived from that name and made unique in the
 * workspace.
 */
export function AddSource({ workspaceId, onDone }: { workspaceId: string; onDone: () => void }) {
  const [kind, setKind] = useState<SourceKind>('console_api');
  const [key, setKey] = useState('');
  const [ldInstance, setLdInstance] = useState<LdInstanceId>('us');
  const [ldProject, setLdProject] = useState('');
  const [ldProjects, setLdProjects] = useState<LdProject[]>();
  const [ldListing, setLdListing] = useState(false);
  const [ldListError, setLdListError] = useState<string>();
  // PLAN §22 ships behind the console's own `posthog-source` flag: off, the tile is not offered.
  const posthogOn = useFlag('posthogSource');
  const [phRegion, setPhRegion] = useState<PostHogRegionId>('us');
  const [phProject, setPhProject] = useState('');
  const [phProjects, setPhProjects] = useState<PostHogProjectOption[]>();
  const [phListing, setPhListing] = useState(false);
  const [phListError, setPhListError] = useState<string>();
  const [file, setFile] = useState<File>();
  const [kinds, setKinds] = useState<Set<EntityKind>>(() => new Set(ENTITY_KINDS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [log, setLog] = useState<SyncLogEntry[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number; endpoint: string }>();

  // A LaunchDarkly token can read many projects, so they are listed and one is picked. The
  // listing is a click, not a keystroke: a token is sent to an API only when the user asks, and
  // only to the instance chosen at that moment (changing the instance clears the listing).
  const listLdProjects = async () => {
    const token = key.trim();
    if (token.length < MIN_LD_TOKEN_LENGTH) return;
    const ctrl = new AbortController();
    setLdListing(true);
    setLdProjects(undefined);
    setLdListError(undefined);
    setLdProject('');
    try {
      const listed = await new LdClient({ instance: ldInstance, token }).listProjects(ctrl.signal);
      const projects = [...listed].sort((a, b) => a.name.localeCompare(b.name));
      setLdProjects(projects);
      if (projects.length === 1) setLdProject(projects[0]!.key);
    } catch (e) {
      setLdListError((e as Error).message);
    } finally {
      setLdListing(false);
    }
  };
  const resetLdListing = () => {
    setLdProjects(undefined);
    setLdListError(undefined);
    setLdProject('');
  };
  const ldDisclaimer = LD_INSTANCES[ldInstance].disclaimer;

  // Same rule for PostHog: the key is sent once, on a click, to the region chosen at that moment.
  const listPhProjects = async () => {
    const k = key.trim();
    if (k.length < MIN_PH_KEY_LENGTH) return;
    const ctrl = new AbortController();
    setPhListing(true);
    setPhProjects(undefined);
    setPhListError(undefined);
    setPhProject('');
    try {
      const listed = await new PostHogClient({ region: phRegion, key: k }).listReadableProjects(ctrl.signal);
      const projects = [...listed].sort((a, b) => a.name.localeCompare(b.name) || a.organizationName.localeCompare(b.organizationName));
      setPhProjects(projects);
      if (projects.length === 1) setPhProject(projects[0]!.id);
    } catch (e) {
      setPhListError((e as Error).message);
    } finally {
      setPhListing(false);
    }
  };
  const resetPhListing = () => {
    setPhProjects(undefined);
    setPhListError(undefined);
    setPhProject('');
  };
  // The PostHog tile covers both PostHog inputs: the API read and the payload upload.
  const isPostHog = kind === 'posthog' || kind === 'posthog_payload';
  // Live sources sync on add and show the activity log; uploads just parse the file.
  const isLive = kind !== 'config_spec' && kind !== 'posthog_payload';

  const add = async () => {
    setBusy(true);
    setError(undefined);
    setLog([]);
    setProgress(undefined);
    const push = (e: SyncLogEntry) => setLog((l) => appendLog(l, e));
    const handlers = {
      onProgress: (p: { done: number; total: number; endpoint: string }) => {
        setProgress(p);
        push(describeProgress(p));
      },
      onTransport: (e: Parameters<typeof describeTransportEvent>[0]) => push(describeTransportEvent(e)),
    };
    try {
      const taken = (await store.listSources(workspaceId)).map((s) => s.alias);
      const base = { id: crypto.randomUUID(), kind, createdAt: new Date().toISOString() };
      if (kind === 'launchdarkly') {
        const project = ldProjects?.find((p) => p.key === ldProject);
        if (!project) throw new Error('Choose the LaunchDarkly project to read.');
        const source: SourceDescriptor = {
          ...base,
          alias: deriveAlias(project.key, taken, 'ld'),
          label: `${project.name} (LaunchDarkly)`,
          ld: { instance: ldInstance, projectKey: project.key },
        };
        await store.addSource(workspaceId, source);
        secrets.set('ld_source', source.id, key.trim(), workspaceId);
        setKey('');
        await syncLdSource(workspaceId, source, handlers);
      } else if (kind === 'posthog') {
        const project = phProjects?.find((p) => p.id === phProject);
        if (!project) throw new Error('Choose the PostHog project to read.');
        const source: SourceDescriptor = {
          ...base,
          alias: deriveAlias(project.name, taken, 'posthog'),
          label: `${project.name} (PostHog)`,
          posthog: { region: phRegion, projectId: project.id, projectName: project.name },
        };
        await store.addSource(workspaceId, source);
        secrets.set('ph_source', source.id, key.trim(), workspaceId);
        setKey('');
        await syncPostHogSource(workspaceId, source, handlers);
      } else if (kind === 'posthog_payload') {
        if (!file) throw new Error('Choose the flags definitions file to upload.');
        const stem = file.name.replace(/\.json$/i, '').trim();
        const source: SourceDescriptor = { ...base, alias: deriveAlias('posthog', taken, 'posthog'), label: stem ? `${stem} (PostHog payload)` : 'PostHog payload' };
        await store.addSource(workspaceId, source);
        await uploadPostHogPayload(workspaceId, source, file);
      } else if (kind === 'console_api') {
        // One request validates the key and names the project before anything is saved.
        const apiKey = key.trim();
        const client = new StatsigConsoleClient({ baseUrl: STATSIG_CONSOLE_BASE_URL, apiKey, transport: { onEvent: handlers.onTransport } });
        const project = await client.validateKey();
        // `GET /project` carries only the id; the name is read from the project settings.
        const label = (await client.projectName()) || project.name?.trim() || `StatSig project ${project.id}`;
        // Only Console API sources have a crawl scope; a spec file already holds whatever it holds.
        const scope = kinds.size < ENTITY_KINDS.length ? { resources: ENTITY_KINDS.filter((k) => kinds.has(k)) } : {};
        const source: SourceDescriptor = { ...base, alias: deriveAlias(label, taken, 'statsig'), label, baseUrl: STATSIG_CONSOLE_BASE_URL, ...scope };
        await store.addSource(workspaceId, source);
        secrets.set('statsig', source.id, apiKey, workspaceId);
        setKey('');
        await syncConsoleSource(workspaceId, source, handlers);
      } else if (file) {
        const source: SourceDescriptor = { ...base, alias: deriveAlias('spec', taken, 'spec'), label: specSourceLabel(file.name) };
        await store.addSource(workspaceId, source);
        await uploadSpec(workspaceId, source, file);
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canAdd =
    kind === 'console_api' ? !!key.trim() && kinds.size > 0 : kind === 'launchdarkly' ? !!key.trim() && !!ldProject : kind === 'posthog' ? !!key.trim() && !!phProject : !!file;

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
        {posthogOn && (
          <Button variant={isPostHog ? 'primary' : 'secondary'} onClick={() => setKind('posthog')}>
            PostHog project
          </Button>
        )}
      </div>
      <Card className="space-y-4 p-5">
        {isPostHog ? (
          <>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <legend className="sr-only">How to read the PostHog project</legend>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="src-ph-input"
                  checked={kind === 'posthog'}
                  onChange={() => {
                    setKind('posthog');
                    setFile(undefined);
                  }}
                />
                Read the project with a personal API key
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="src-ph-input"
                  checked={kind === 'posthog_payload'}
                  onChange={() => {
                    setKind('posthog_payload');
                    resetPhListing();
                  }}
                />
                Upload a local-evaluation payload instead
              </label>
            </fieldset>
            {kind === 'posthog' ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="src-ph-region">Region</Label>
                    <Select
                      id="src-ph-region"
                      value={phRegion}
                      onChange={(e) => {
                        setPhRegion(e.target.value as PostHogRegionId);
                        resetPhListing();
                      }}
                    >
                      {Object.values(POSTHOG_REGIONS).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="src-ph-key">Personal API key (read scopes)</Label>
                    <Input
                      id="src-ph-key"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="phx_…"
                      value={key}
                      onChange={(e) => {
                        setKey(e.target.value);
                        resetPhListing();
                      }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button variant="secondary" onClick={listPhProjects} disabled={phListing || key.trim().length < MIN_PH_KEY_LENGTH}>
                    {phListing && <Spinner />} List projects
                  </Button>
                  <span className="text-xs text-fg-muted">Sends the key to {POSTHOG_REGIONS[phRegion].origin.replace('https://', '')} once, to list the projects it can read.</span>
                </div>
                <div>
                  <Label htmlFor="src-ph-project">Project to read</Label>
                  <SearchSelect
                    id="src-ph-project"
                    value={phProject}
                    options={(phProjects ?? []).map((p) => ({ key: p.id, name: `${p.name} (${p.organizationName})` }))}
                    disabled={!phProjects}
                    placeholder={
                      phListing
                        ? 'Listing the projects this key can read…'
                        : phProjects
                          ? phProjects.length
                            ? `Search ${phProjects.length} projects…`
                            : 'This key can read no project'
                          : phListError
                            ? 'Could not list projects'
                            : 'Paste the key and list its projects first'
                    }
                    emptyText="No project matches"
                    onChange={setPhProject}
                  />
                  {phListError && <p className="mt-1.5 text-xs text-error">{phListError}</p>}
                  <p className="mt-1.5 text-xs text-fg-muted">
                    The key needs only the read scopes <code>{POSTHOG_READ_SCOPES.join(', ')}</code>. It is kept encrypted on this device and sent only to that region’s API; the
                    project is only ever read (flags, cohorts, group types and property definitions) and nothing is written to PostHog. A PostHog project has no environments, so
                    this source maps to <b>one LaunchDarkly environment</b>; add one source per PostHog project (dev, staging, prod) and they consolidate here.
                  </p>
                </div>
              </>
            ) : (
              <div>
                <Label htmlFor="src-ph-file">Flags definitions payload (.json)</Label>
                <input
                  id="src-ph-file"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    setError(undefined);
                    setFile(e.target.files?.[0]);
                  }}
                  className="text-sm"
                />
                <p className="mt-1.5 text-xs text-fg-muted">
                  Download it with{' '}
                  <code>
                    curl -H "Authorization: Bearer &lt;personal or secret key&gt;" "https://us.posthog.com/flags/definitions?token=&lt;project api token&gt;&amp;send_cohorts" -o
                    posthog-flags.json
                  </code>{' '}
                  (use <code>eu.posthog.com</code> or your own host as needed). The file stays in this browser. The payload holds every active flag with its full targeting and the
                  property cohorts, but <b>no archived flags, static-cohort members, owners or scheduled changes</b>; read the project with a key when you need those.
                </p>
              </div>
            )}
          </>
        ) : kind === 'launchdarkly' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="src-ld-instance">Instance</Label>
                <Select
                  id="src-ld-instance"
                  value={ldInstance}
                  onChange={(e) => {
                    setLdInstance(e.target.value as LdInstanceId);
                    resetLdListing();
                  }}
                >
                  {Object.values(LD_INSTANCES).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="src-ld-token">Access token (read access to the source project)</Label>
                <Input
                  id="src-ld-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="api-…"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    resetLdListing();
                  }}
                />
              </div>
            </div>
            {ldDisclaimer && (
              <Callout>
                <b>{ldDisclaimer.title}:</b> {ldDisclaimer.body.join(' ')}
              </Callout>
            )}
            <div className="flex items-center gap-3">
              <Button variant="secondary" onClick={listLdProjects} disabled={ldListing || key.trim().length < MIN_LD_TOKEN_LENGTH}>
                {ldListing && <Spinner />} List projects
              </Button>
              <span className="text-xs text-fg-muted">Sends the token to {LD_INSTANCES[ldInstance].origin.replace('https://', '')} once, to list the projects it can read.</span>
            </div>
            <div>
              <Label htmlFor="src-ld-project">Project to read</Label>
              <SearchSelect
                id="src-ld-project"
                value={ldProject}
                options={ldProjects ?? []}
                disabled={!ldProjects}
                placeholder={
                  ldListing
                    ? 'Listing the projects this token can read…'
                    : ldProjects
                      ? ldProjects.length
                        ? `Search ${ldProjects.length} projects…`
                        : 'This token can read no project'
                      : ldListError
                        ? 'Could not list projects'
                        : 'Paste the token and list its projects first'
                }
                emptyText="No project matches"
                onChange={setLdProject}
              />
              {ldListError && <p className="mt-1.5 text-xs text-error">{ldListError}</p>}
              <p className="mt-1.5 text-xs text-fg-muted">
                A Reader token is enough. It may belong to a <b>different LaunchDarkly account or instance</b> than the target project; it is kept encrypted on this device and sent
                only to that instance’s API. The source project is only ever read: flags, their per-environment targeting, segments and context kinds. Experiments and metrics
                are not read (they end in the source and launch new in the target).
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
                organization’s projects), so add one source per project; several sources consolidate into this workspace’s single LaunchDarkly project. The source takes
                the project’s name.
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
              “Allow Download Config Specs” scope and covers all environments and target apps. The file stays in this browser; the source is named after it.
            </p>
          </div>
        )}
        {error && <Callout tone="red">{error}</Callout>}
        <div className="flex items-center gap-3">
          <Button onClick={add} disabled={busy || !canAdd}>
            {busy && <Spinner />} {busy && isLive ? 'Syncing…' : 'Add source'}
          </Button>
          {busy && progress && (
            <span className="text-xs text-fg-muted tabular-nums">
              {progress.done}/{progress.total} · {progress.endpoint}
            </span>
          )}
        </div>
        {isLive && (busy || (error && log.length > 0)) && <SyncActivity log={log} running={busy} />}
      </Card>
    </div>
  );
}

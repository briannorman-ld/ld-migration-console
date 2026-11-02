import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EntityKind } from '@sslm/canonical';
import { optionLabel, sanitizeKey, type MappingProfile } from '@sslm/mapper';
import type { SourceRecord, WorkspaceRecord } from '@sslm/store';
import { DecisionCard } from '../components/DecisionCard.tsx';
import { Badge, Button, Callout, Card, cx, Select, Spinner } from '../components/ui.tsx';
import { computeGuide, describeTally, STEP_ORDER, STEP_TITLE, type GuideInput, type GuideModel, type StepKey, type Tally } from '../lib/guide.ts';
import { KIND_LABEL } from '../lib/kinds.ts';
import { createLdEnvironment, refreshLdState, reprobe } from '../lib/ld.ts';
import type { MigrationSelection } from '../lib/migration.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

export interface GuideNav {
  connections: () => void;
  ld: () => void;
  mapping: () => void;
  decisions: () => void;
  resource: (kind: EntityKind) => void;
  runs: () => void;
  monitoring: () => void;
  coverage: () => void;
}

/**
 * The guided migration (lib/guide.ts): one environment at a time, step by step, with the action
 * for each step where the user is. Every step stays open to revisit; the current one is expanded.
 */
export function GuideView({
  workspaceId,
  workspace,
  m,
  input,
  onEnvChange,
  onMigrate,
  nav,
}: {
  workspaceId: string;
  workspace: WorkspaceRecord;
  m: MigrationContext | null;
  input: GuideInput;
  onEnvChange: (env: string) => void;
  onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void;
  nav: GuideNav;
}) {
  const g = computeGuide(input);
  const [opened, setOpened] = useState<Partial<Record<StepKey, boolean>>>({});
  const isOpen = (k: StepKey) => opened[k] ?? k === g.current;

  // Segments and experiments in the chosen LD environment are read on demand (what a plan needs).
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!m?.connected) return;
    const missing = g.ldEnvs.filter((e) => !m.ld.segments?.[e] && !asked.current.has(e));
    if (!missing.length) return;
    missing.forEach((e) => asked.current.add(e));
    void refreshLdState(workspaceId, { segmentEnvs: missing }).catch(() => undefined);
  }, [m, g.ldEnvs, workspaceId]);

  const doneCount = STEP_ORDER.filter((k) => g.done[k]).length;

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h2 className="font-display text-xl font-semibold tracking-tight">Migration guide</h2>
        <p className="mt-1 text-sm text-fg-muted">
          One environment at a time, in dependency order: context kinds first, then segments, then the flags that use them, then experiments. Each step runs only what you confirm;
          repeat from step 2 for the next environment.
        </p>
      </div>
      <ol className="space-y-3">
        {STEP_ORDER.map((k, i) => (
          <Step key={k} n={i + 1} title={STEP_TITLE[k]} done={g.done[k]} current={g.current === k} open={isOpen(k)} onToggle={() => setOpened((o) => ({ ...o, [k]: !isOpen(k) }))} summary={summaryFor(k, g, input)}>
            {k === 'connect' && <Connect g={g} input={input} nav={nav} />}
            {k === 'environment' && <Environment workspaceId={workspaceId} g={g} m={m} onEnvChange={onEnvChange} nav={nav} />}
            {k === 'contexts' && <Contexts workspaceId={workspaceId} g={g} m={m} nav={nav} onMigrate={onMigrate} />}
            {k === 'segments' && <Items g={g} tallies={[g.segments]} noun="segment" nav={nav} onMigrate={onMigrate} toSelection={(uids) => ({ gates: [], autotunes: [], segments: uids })} />}
            {k === 'flags' && <Items g={g} tallies={[g.gates, g.configs]} noun="flag" nav={nav} onMigrate={onMigrate} toSelection={(uids) => ({ gates: uids.filter((u) => g.gates.toMigrate.includes(u)), configs: uids.filter((u) => g.configs.toMigrate.includes(u)), autotunes: [] })} />}
            {k === 'experiments' && <Experiments g={g} nav={nav} onMigrate={onMigrate} />}
            {k === 'cutover' && <CutOver g={g} input={input} workspace={workspace} nav={nav} doneCount={doneCount} />}
          </Step>
        ))}
      </ol>
    </div>
  );
}

function summaryFor(k: StepKey, g: GuideModel, input: GuideInput): string {
  switch (k) {
    case 'connect':
      return `${g.synced} source${g.synced === 1 ? '' : 's'} synced · LaunchDarkly ${g.connected ? `project “${input.m?.ld.projectKey ?? ''}”` : g.connecting ? 'connecting…' : 'not connected'}`;
    case 'environment':
      return g.env ? (g.ldEnvs.length ? `${g.env} → LD ${g.ldEnvs.join(', ')}` : `${g.env} is not mapped to an LD environment yet`) : 'No environment chosen';
    case 'contexts':
      return g.contexts.unitTypes.length === 0 ? 'No unit types in this environment' : g.contexts.open.length ? `${g.contexts.open.length} unit type${g.contexts.open.length === 1 ? '' : 's'} need${g.contexts.open.length === 1 ? 's' : ''} a context kind` : `${g.contexts.unitTypes.length} unit type${g.contexts.unitTypes.length === 1 ? '' : 's'} mapped`;
    case 'segments':
      return describeTally(g.segments, 'segment');
    case 'flags':
      return `Gates: ${describeTally(g.gates, 'gate')} Dynamic configs: ${describeTally(g.configs, 'dynamic config')}`;
    case 'experiments':
      return `Autotunes: ${describeTally(g.autotunes, 'autotune')}${g.endInSource.length ? ` · ${g.endInSource.map((x) => `${x.count} ${KIND_LABEL[x.kind].toLowerCase()}`).join(', ')} end in StatSig` : ''}`;
    case 'cutover':
      return input.monitoring.loaded ? (input.monitoring.attention ? `${input.monitoring.attention} item${input.monitoring.attention === 1 ? '' : 's'} need attention` : `${input.monitoring.rows} migrated item${input.monitoring.rows === 1 ? '' : 's'} monitored`) : 'Monitoring starts once something is migrated';
  }
}

function Step({ n, title, done, current, open, onToggle, summary, children }: { n: number; title: string; done: boolean; current: boolean; open: boolean; onToggle: () => void; summary: string; children: ReactNode }) {
  return (
    <li>
      <Card className={cx('overflow-hidden', current && 'border-accent ring-1 ring-accent/40')}>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover" onClick={onToggle} aria-expanded={open}>
          <span aria-hidden className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-success-fill text-on-accent' : current ? 'bg-accent text-on-accent' : 'border border-line text-fg-muted')}>
            {done ? '✓' : n}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-semibold">{title}</span>
              {current && !done && <Badge tone="blue">you are here</Badge>}
            </span>
            <span className="block truncate text-xs text-fg-muted">{summary}</span>
          </span>
          <span className="text-xs text-fg-subtle">{open ? 'Hide' : 'Show'}</span>
        </button>
        {open && <div className="space-y-3 border-t border-line px-4 py-4 text-sm">{children}</div>}
      </Card>
    </li>
  );
}

function Connect({ g, input, nav }: { g: GuideModel; input: GuideInput; nav: GuideNav }) {
  return (
    <>
      <p className="text-fg-muted">A source project to read from and the LaunchDarkly project to write to. Nothing is written until step 4.</p>
      <ul className="space-y-1">
        <li className="flex items-center gap-2">
          <Mark ok={g.synced > 0} /> {g.synced > 0 ? `${g.synced} source${g.synced === 1 ? '' : 's'} synced: ${input.sources.map((s) => s.label).join(', ')}` : 'No source synced yet'}
          <Button variant="ghost" className="ml-auto py-1 text-xs" onClick={nav.connections}>
            {g.synced > 0 ? 'Sources' : 'Connect a source'}
          </Button>
        </li>
        <li className="flex items-center gap-2">
          <Mark ok={g.connected} busy={g.connecting} />{' '}
          {g.connected ? (
            `LaunchDarkly project “${input.m?.ld.projectKey}” connected`
          ) : g.connecting ? (
            <span role="status">Connecting to LaunchDarkly{input.m?.ld.probing ? `: ${input.m.ld.probing.toLowerCase()}` : ''}…</span>
          ) : input.m?.ld.status === 'error' && input.m.ld.error ? (
            <span className="text-error">LaunchDarkly: {input.m.ld.error}</span>
          ) : (
            'LaunchDarkly not connected, or no target project chosen'
          )}
          <Button variant="ghost" className="ml-auto py-1 text-xs" onClick={nav.ld}>
            {g.connected || g.connecting ? 'LaunchDarkly' : 'Connect LaunchDarkly'}
          </Button>
        </li>
      </ul>
    </>
  );
}

function Environment({ workspaceId, g, m, onEnvChange, nav }: { workspaceId: string; g: GuideModel; m: MigrationContext | null; onEnvChange: (env: string) => void; nav: GuideNav }) {
  const [creating, setCreating] = useState<string>();
  const [error, setError] = useState<string>();
  const save = (fn: (p: MappingProfile) => void) => {
    if (!m) return;
    const next: MappingProfile = structuredClone(m.profile);
    fn(next);
    void m.saveProfile(next);
  };
  const create = async (sourceId: string, isProduction: boolean) => {
    const key = sanitizeKey(g.env).toLowerCase();
    setCreating(sourceId);
    setError(undefined);
    try {
      await createLdEnvironment(workspaceId, { key, name: g.env, critical: isProduction });
      save((p) => void ((p.sources[sourceId] ??= { envMapping: {}, unitTypeKinds: {} }).envMapping[g.env] = key));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(undefined);
    }
  };
  const prod = g.envBySource.some((x) => x.isProduction);
  return (
    <>
      <p className="text-fg-muted">Pick the source environment to migrate and the LaunchDarkly environment it lands in. Start with a non-production environment; production last, once the SDKs are switched there.</p>
      <label className="flex items-center gap-2">
        Source environment
        <Select value={g.env} onChange={(e) => onEnvChange(e.target.value)} aria-label="Source environment">
          {g.envs.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
        {prod && <Badge tone="red">production</Badge>}
      </label>
      {!g.connected && (
        <Callout tone="blue">
          {g.connecting ? (
            <span className="inline-flex items-center gap-2">
              <Spinner /> Connecting to LaunchDarkly… the LD environments appear when the connection is up.
            </span>
          ) : (
            'Connect LaunchDarkly (step 1) to map it to an LD environment.'
          )}
        </Callout>
      )}
      {g.connected && m && (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line-soft">
            {g.envBySource.map(({ source, ldEnv, isProduction }) => (
              <tr key={source.id}>
                <td className="py-1.5 pr-3">
                  {source.label} <span className="font-mono text-xs text-fg-muted">{g.env}</span>
                </td>
                <td className="py-1.5 text-fg-subtle">→</td>
                <td className="py-1.5">
                  <Select
                    aria-label={`LD environment for ${source.label} ${g.env}`}
                    value={ldEnv ?? ''}
                    onChange={(ev) => save((p) => void ((p.sources[source.id] ??= { envMapping: {}, unitTypeKinds: {} }).envMapping[g.env] = ev.target.value || null))}
                  >
                    <option value="">not migrated</option>
                    {m.ldEnvs.map((l) => (
                      <option key={l.key} value={l.key}>
                        {l.key}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1.5 pl-2 text-xs">
                  {!ldEnv && !m.ldEnvs.some((l) => l.key === sanitizeKey(g.env).toLowerCase()) && (
                    <Button variant="ghost" className="py-1 text-xs" disabled={!!creating} onClick={() => void create(source.id, isProduction)}>
                      {creating === source.id ? <Spinner /> : null} Create “{sanitizeKey(g.env).toLowerCase()}” in LD
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <Callout tone="red">{error}</Callout>}
      <p className="text-xs text-fg-muted">
        Every environment's mapping, and the unit types, are on the{' '}
        <button type="button" className="text-link hover:underline" onClick={nav.mapping}>
          Mapping
        </button>{' '}
        page.
      </p>
    </>
  );
}

function Contexts({ workspaceId, g, m, nav, onMigrate }: { workspaceId: string; g: GuideModel; m: MigrationContext | null; nav: GuideNav; onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void }) {
  const [probing, setProbing] = useState(false);
  const kinds = g.contexts.toCreate;
  return (
    <>
      <p className="text-fg-muted">
        StatSig buckets and targets by unit types; LaunchDarkly by context kinds. Decide where each unit type goes before anything else, because every rule, rollout and target refers
        to it: a new context kind (created on the first migration), an attribute of the user context, or a kind another unit type already uses.
      </p>
      {g.contexts.unitTypes.length === 0 && <Callout tone="blue">{g.ldEnvs.length ? 'The sources in this environment declare no unit types; userID maps to the user context.' : 'Map the environment first (step 2).'}</Callout>}
      {g.contexts.open.map((d) => (
        <DecisionCard key={d.decision.id} decision={d.decision} onChoose={(o) => m && void m.resolve([d.decision], o)} />
      ))}
      {g.contexts.decided.length > 0 && (
        <ul className="space-y-1 text-xs">
          {g.contexts.decided.map((d) => (
            <li key={d.decision.id} className="flex items-center gap-2">
              <Mark ok /> <span className="font-mono">{d.decision.subject.id}</span> <span className="text-fg-muted">{optionLabel(d.decision, d.resolvedWith!.optionKey)}</span>
            </li>
          ))}
        </ul>
      )}
      {kinds.length > 0 && g.contexts.open.length === 0 && (
        <div className="space-y-2 rounded-md border border-line p-3">
          <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Context kinds to create in LaunchDarkly</div>
          <ul className="space-y-0.5 text-xs">
            {kinds.map((k) => (
              <li key={k.key} className="flex items-center gap-2">
                <code className="font-mono">{k.key}</code> <span className="text-fg-muted">for {k.unitType}</span>
              </li>
            ))}
          </ul>
          {g.contexts.canCreate ? (
            <div className="flex items-center gap-3">
              <Button onClick={() => onMigrate({ gates: [], autotunes: [], contextKinds: kinds }, g.ldEnvs)}>
                Create {kinds.length} context kind{kinds.length === 1 ? '' : 's'} in LD…
              </Button>
              <span className="text-xs text-fg-muted">A small run of its own, so the kinds exist before any segment or flag refers to them. Needs the createContextKind role.</span>
            </div>
          ) : (
            <Callout tone="amber">
              This token cannot create context kinds (its role lacks createContextKind). Ask a LaunchDarkly admin to create the kinds above in project “{m?.ld.projectKey}”, or connect with a
              Developer, Maintainer or Project Admin token; then re-probe.{' '}
              <Button
                variant="secondary"
                className="ml-2 py-1 text-xs"
                disabled={probing}
                onClick={() => {
                  setProbing(true);
                  void reprobe(workspaceId).finally(() => setProbing(false));
                }}
              >
                {probing ? <Spinner /> : null} Re-probe
              </Button>
            </Callout>
          )}
        </div>
      )}
      {g.contexts.unitTypes.length > 0 && g.contexts.open.length === 0 && g.contexts.decided.length === 0 && kinds.length === 0 && (
        <p className="text-xs text-fg-muted">
          Every unit type here already has a context kind in LaunchDarkly, or is userID. Change a mapping on the{' '}
          <button type="button" className="text-link hover:underline" onClick={nav.mapping}>
            Mapping
          </button>{' '}
          page.
        </p>
      )}
    </>
  );
}

function Items({ g, tallies, noun, nav, onMigrate, toSelection }: { g: GuideModel; tallies: Tally[]; noun: string; nav: GuideNav; onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void; toSelection: (uids: string[]) => MigrationSelection }) {
  const uids = tallies.flatMap((t) => t.toMigrate);
  const blocked = tallies.reduce((n, t) => n + t.blocked, 0);
  const total = tallies.reduce((n, t) => n + t.total, 0);
  const unknown = tallies.some((t) => t.ldUnknown);
  return (
    <>
      <p className="text-fg-muted">
        {noun === 'segment'
          ? 'Segments go first: flags reference them, so a flag migrated later finds its segments already in place. Big ID lists import as big segments where the plan allows.'
          : 'Gates become boolean flags and dynamic configs become JSON flags, with rules, rollouts and overrides translated. A gate used as a prerequisite migrates before the flags that depend on it.'}
      </p>
      {!g.ldEnvs.length && <Callout tone="blue">Map the environment first (step 2).</Callout>}
      {g.ldEnvs.length > 0 && (
        <>
          <ul className="space-y-1">
            {tallies.map((t) => (
              <li key={t.kind} className="flex items-center gap-2">
                <Mark ok={!t.ldUnknown && t.toMigrate.length === 0} /> <span className="font-medium">{KIND_LABEL[t.kind]}</span>
                <span className="text-fg-muted">{describeTally(t, KIND_LABEL[t.kind].toLowerCase().replace(/s$/, ''))}</span>
                <Button variant="ghost" className="ml-auto py-1 text-xs" onClick={() => nav.resource(t.kind)}>
                  View
                </Button>
              </li>
            ))}
          </ul>
          {blocked > 0 && (
            <Callout tone="amber">
              {blocked} item{blocked === 1 ? ' waits' : 's wait'} for blocking decisions. They are planned but will not run until answered, in the plan or on the{' '}
              <button type="button" className="font-medium underline" onClick={nav.decisions}>
                Decisions
              </button>{' '}
              page.
            </Callout>
          )}
          <div className="flex items-center gap-3">
            <Button disabled={uids.length === 0 || unknown} onClick={() => onMigrate(toSelection(uids), g.ldEnvs)}>
              {unknown ? 'Reading LaunchDarkly…' : uids.length ? `Migrate ${uids.length} ${noun}${uids.length === 1 ? '' : 's'} to ${g.ldEnvs.join(', ')}…` : total ? `All ${noun}s are in sync` : `No ${noun}s to migrate`}
            </Button>
            <span className="text-xs text-fg-muted">Opens the plan: what will be created or changed, item by item, before anything runs.</span>
          </div>
        </>
      )}
    </>
  );
}

function Experiments({ g, nav, onMigrate }: { g: GuideModel; nav: GuideNav; onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void }) {
  const t = g.autotunes;
  return (
    <>
      <p className="text-fg-muted">
        Experiments, layers and holdouts end in StatSig and start new in LaunchDarkly: nothing is moved mid-flight, so finish or stop them in StatSig and recreate them on the migrated
        flags. Autotunes migrate as flags with a drafted multi-armed bandit.
      </p>
      {g.endInSource.length > 0 && (
        <ul className="space-y-1 text-xs">
          {g.endInSource.map((x) => (
            <li key={x.kind} className="flex items-center gap-2">
              <span className="text-fg-muted">
                {x.count} {KIND_LABEL[x.kind].toLowerCase()}: end in StatSig, start new in LD.
              </span>
              <button type="button" className="text-link hover:underline" onClick={nav.coverage}>
                What migrates
              </button>
            </li>
          ))}
        </ul>
      )}
      {g.ldEnvs.length > 0 && (
        <div className="flex items-center gap-2">
          <Mark ok={!t.ldUnknown && t.toMigrate.length === 0} /> <span className="font-medium">Autotunes</span>
          <span className="text-fg-muted">{describeTally(t, 'autotune')}</span>
          <Button variant="ghost" className="ml-auto py-1 text-xs" onClick={() => nav.resource('autotune')}>
            View
          </Button>
          <Button disabled={t.toMigrate.length === 0 || t.ldUnknown} className="py-1 text-xs" onClick={() => onMigrate({ gates: [], autotunes: t.toMigrate }, g.ldEnvs)}>
            {t.toMigrate.length ? `Migrate ${t.toMigrate.length} autotune${t.toMigrate.length === 1 ? '' : 's'}…` : t.total ? 'In sync' : 'None'}
          </Button>
        </div>
      )}
    </>
  );
}

function CutOver({ g, input, workspace, nav, doneCount }: { g: GuideModel; input: GuideInput; workspace: WorkspaceRecord; nav: GuideNav; doneCount: number }) {
  void workspace;
  return (
    <>
      <p className="text-fg-muted">Once {g.env || 'an environment'} is migrated, point that environment's SDKs at LaunchDarkly, keep StatSig running until its checks go quiet, then repeat from step 2 for the next environment.</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Swap the SDK in the apps that run in this environment and watch Monitoring: LD traffic rising, StatSig checks falling to zero.</li>
        <li>Re-sync when StatSig changes; Monitoring flags drift from either side, and the plan shows exactly what a re-sync would change.</li>
        <li>When StatSig checks have been at zero for a while, archive the gates there, and stop syncing this environment.</li>
        <li>Then the next environment, production last.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="py-1 text-xs" onClick={nav.monitoring}>
          Monitoring{input.monitoring.attention ? ` (${input.monitoring.attention} need attention)` : ''}
        </Button>
        <Button variant="secondary" className="py-1 text-xs" onClick={nav.runs}>
          Runs{input.interruptedRuns ? ` (${input.interruptedRuns} interrupted)` : ''}
        </Button>
        <span className="text-xs text-fg-muted">
          {doneCount} of {STEP_ORDER.length - 1} steps done for {g.env || 'this environment'}.
        </span>
      </div>
    </>
  );
}

function Mark({ ok, busy }: { ok: boolean; busy?: boolean }) {
  if (busy && !ok) {
    return (
      <span aria-hidden className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-fg-muted">
        <Spinner />
      </span>
    );
  }
  return (
    <span aria-hidden className={cx('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold', ok ? 'bg-success-fill text-on-accent' : 'border border-line text-fg-subtle')}>
      {ok ? '✓' : ''}
    </span>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EntityKind } from '@sslm/canonical';
import { optionLabel, sanitizeKey, teamKeyFor, type MappingProfile } from '@sslm/mapper';
import type { AccountAccess, SourceRecord, WorkspaceRecord } from '@sslm/store';
import { DecisionCard } from '../components/DecisionCard.tsx';
import { Badge, Button, Callout, Card, cx, Input, Modal, Select, Spinner } from '../components/ui.tsx';
import { ACCESS_LABEL, ACCOUNT_WIDE_STEPS, computeGuide, describeTally, LOOP_STEP, provisionedBy, STEP_ORDER, STEP_TITLE, teamKeysFor, type GuideInput, type GuideModel, type OwnerRow, type StepKey, type Tally, type TeamRow } from '../lib/guide.ts';

/** The number the guide shows for "Choose an environment", for callouts that point back to it. */
const ENV_STEP = STEP_ORDER.indexOf('environment') + 1;
import { KIND_LABEL } from '../lib/kinds.ts';
import { timeAgo } from '../lib/time.ts';
import { createLdEnvironment, createLdTeam, FRESH_LD_LISTING_MS, inviteLdMembers, refreshLdPeople, refreshLdState, reprobe, requireLdApprovals, setDefaultRandomizationUnit, useLdSession, type LdInviteRole } from '../lib/ld.ts';
import { store } from '../lib/store.ts';
import type { MigrationSelection } from '../lib/migration.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

/** The repository copy of docs/RUNBOOK.md: the plan around this guide (preparation, cutover criteria, recovery). */
const RUNBOOK_URL = 'https://github.com/briannorman-ld/ld-migration-console/blob/main/docs/RUNBOOK.md';

export interface GuideNav {
  connections: () => void;
  ld: () => void;
  mapping: () => void;
  unitTypes: () => void;
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
  const g = useMemo(() => computeGuide({ ...input, ...(workspace.accountAccess ? { access: workspace.accountAccess } : {}) }), [input, workspace.accountAccess]);
  const [opened, setOpened] = useState<Partial<Record<StepKey, boolean>>>({});
  const isOpen = (k: StepKey) => opened[k] ?? k === g.current;

  // Segments and experiments in the chosen LD environment are read on demand (what a plan needs).
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!m?.connected) return;
    const missing = g.ldEnvs.filter((e) => !m.ld.segments?.[e] && !asked.current.has(e));
    if (!missing.length) return;
    missing.forEach((e) => asked.current.add(e));
    void refreshLdState(workspaceId, { segmentEnvs: missing, reuseFlagsWithinMs: FRESH_LD_LISTING_MS }).catch(() => undefined);
  }, [m, g.ldEnvs, workspaceId]);

  const doneCount = STEP_ORDER.filter((k) => g.done[k]).length;

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h2 className="font-display text-xl font-semibold tracking-tight">Migration guide</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Teams and the people who join them are account-level and can be done at any time: the environment steps do not wait for them, and a later sync adds the maintainers that
          appeared. Then one environment at a time in dependency order: context kinds, then segments, then the flags that use them, then experiments. Each step runs only what you
          confirm; repeat from step {STEP_ORDER.indexOf(LOOP_STEP) + 1} for the next environment. Before the first run, read the{' '}
          <a href={RUNBOOK_URL} target="_blank" rel="noreferrer" className="text-link hover:underline">
            runbook
          </a>
          : what to settle before opening the console, the cutover criteria, and what to do when a run fails.
        </p>
      </div>
      <ol className="space-y-3">
        {STEP_ORDER.map((k, i) => {
          const provider = ACCOUNT_WIDE_STEPS.has(k) ? provisionedBy(k, g.people.access) : undefined;
          return (
          <Step key={k} n={i + 1} title={STEP_TITLE[k]} done={g.done[k]} current={g.current === k} open={isOpen(k)} onToggle={() => setOpened((o) => ({ ...o, [k]: !isOpen(k) }))} summary={summaryFor(k, g, input)} accountWide={ACCOUNT_WIDE_STEPS.has(k) && !provider} {...(provider ? { waitingFor: provider } : {})}>
            {ACCOUNT_WIDE_STEPS.has(k) && (provider ? <ProvisionedBy provider={provider} what={k === 'teams' ? 'Teams' : 'Members'} /> : <AccountWide projectKey={input.m?.ld.projectKey} what={k === 'teams' ? 'Teams' : 'Members and invitations'} />)}
            {k === 'connect' && <Connect workspaceId={workspaceId} workspace={workspace} g={g} input={input} nav={nav} />}
            {k === 'environment' && <Environment workspaceId={workspaceId} g={g} m={m} onEnvChange={onEnvChange} nav={nav} />}
            {k === 'teams' && <Teams workspaceId={workspaceId} g={g} m={m} />}
            {k === 'people' && <People workspaceId={workspaceId} g={g} m={m} nav={nav} />}
            {k === 'contexts' && <Contexts workspaceId={workspaceId} g={g} m={m} nav={nav} onMigrate={onMigrate} />}
            {k === 'segments' && <Items workspaceId={workspaceId} g={g} tallies={[g.segments]} noun="segment" nav={nav} onMigrate={onMigrate} toSelection={(uids) => ({ gates: [], autotunes: [], segments: uids })} />}
            {k === 'flags' && (
              <Items
                workspaceId={workspaceId}
                g={g}
                tallies={g.aiConfigsAvailable ? [g.gates, g.configs, g.prompts] : [g.gates, g.configs]}
                noun="flag"
                nav={nav}
                onMigrate={onMigrate}
                toSelection={(uids) => ({ gates: uids.filter((u) => g.gates.toMigrate.includes(u)), configs: uids.filter((u) => g.configs.toMigrate.includes(u)), prompts: uids.filter((u) => g.prompts.toMigrate.includes(u)), autotunes: [] })}
              />
            )}
            {k === 'experiments' && <Experiments g={g} nav={nav} onMigrate={onMigrate} />}
            {k === 'cutover' && <CutOver workspaceId={workspaceId} g={g} input={input} workspace={workspace} nav={nav} doneCount={doneCount} />}
          </Step>
          );
        })}
      </ol>
    </div>
  );
}

function summaryFor(k: StepKey, g: GuideModel, input: GuideInput): string {
  switch (k) {
    case 'connect':
      return `${g.synced} source${g.synced === 1 ? '' : 's'} synced · LaunchDarkly ${g.connected ? `project “${input.m?.ld.projectKey ?? ''}”` : g.connecting ? 'connecting…' : 'not connected'}`;
    case 'environment':
      return g.env ? (g.ldEnvs.length ? `${g.env} → LaunchDarkly ${g.ldEnvs.join(', ')}` : `${g.env} is not mapped to a LaunchDarkly environment yet`) : 'No environment chosen';
    case 'teams': {
      const missing = g.people.teams.filter((t) => t.status === 'missing').length;
      if (!g.people.teams.length) return 'No teams in the sources';
      const total = `${g.people.teams.length} team${g.people.teams.length === 1 ? '' : 's'}`;
      if (!missing) return `${total}, all in LaunchDarkly`;
      const provider = provisionedBy('teams', g.people.access);
      return provider ? `${total} · ${missing} group${missing === 1 ? '' : 's'} to push from ${provider}` : `${total} (${missing} not in LaunchDarkly)`;
    }
    case 'people': {
      const missing = g.people.owners.filter((o) => o.status === 'missing').length;
      if (!g.people.owners.length) return 'No owners in the sources';
      const total = `${g.people.owners.length} owner${g.people.owners.length === 1 ? '' : 's'}`;
      if (!missing) return `${total}, all in LaunchDarkly`;
      const provider = provisionedBy('people', g.people.access);
      return provider ? `${total} · ${missing} waiting for ${provider}` : `${total} (${missing} not in LaunchDarkly)`;
    }
    case 'contexts':
      return g.contexts.unitTypes.length === 0 ? 'No unit types in this environment' : g.contexts.open.length ? `${g.contexts.open.length} unit type${g.contexts.open.length === 1 ? '' : 's'} need${g.contexts.open.length === 1 ? 's' : ''} a context kind` : `${g.contexts.unitTypes.length} unit type${g.contexts.unitTypes.length === 1 ? '' : 's'} mapped`;
    case 'segments':
      return describeTally(g.segments, 'segment');
    case 'flags':
      return `Gates: ${describeTally(g.gates, 'gate')} Dynamic configs: ${describeTally(g.configs, 'dynamic config')}${g.prompts.total ? ` AI Configs: ${describeTally(g.prompts, 'AI Config')}` : ''}`;
    case 'experiments':
      return `Autotunes: ${describeTally(g.autotunes, 'autotune')}${g.endInSource.length ? ` · ${g.endInSource.map((x) => `${x.count} ${KIND_LABEL[x.kind].toLowerCase()}`).join(', ')} end in StatSig` : ''}`;
    case 'cutover':
      return input.monitoring.loaded ? (input.monitoring.attention ? `${input.monitoring.attention} item${input.monitoring.attention === 1 ? '' : 's'} need attention` : `${input.monitoring.rows} migrated item${input.monitoring.rows === 1 ? '' : 's'} monitored`) : 'Monitoring starts once something is migrated';
  }
}

/**
 * Most of the migration writes into one LD project. Members and teams belong to the account and
 * are shared by every project in it, so those steps say so in their header and again inside,
 * where the buttons are.
 */
/** Why the environment steps run without Teams or People finished, shown on both. */
const NOT_BLOCKING = 'The environment steps do not wait for this one: a flag whose owner is not in LaunchDarkly yet is created without a maintainer, shows as changed once they are, and takes them as maintainer on the next sync.';

function AccountWide({ projectKey, what }: { projectKey?: string; what: string }) {
  return (
    <Callout tone="amber">
      <span className="font-semibold">Account-wide.</span> {what} belong to your LaunchDarkly <em>account</em>, not to the project{projectKey ? ` “${projectKey}”` : ''}: what you create or
      invite here is visible in every project of the account. {NOT_BLOCKING}
    </Callout>
  );
}

/** An identity provider creates what this step would otherwise create: the step only watches for it. */
function ProvisionedBy({ provider, what }: { provider: string; what: string }) {
  return (
    <Callout tone="blue">
      <span className="font-semibold">Provisioned by {provider}.</span> {what} are created by {provider}, not from here; this step only lists what is still missing and re-checks. {NOT_BLOCKING}
    </Callout>
  );
}

function Step({ n, title, done, current, open, onToggle, summary, accountWide, waitingFor, children }: { n: number; title: string; done: boolean; current: boolean; open: boolean; onToggle: () => void; summary: string; accountWide?: boolean; waitingFor?: string; children: ReactNode }) {
  const waiting = !!waitingFor && !done;
  return (
    <li>
      <Card className={cx('overflow-hidden', current && 'border-accent ring-1 ring-accent/40')}>
        <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover" onClick={onToggle} aria-expanded={open}>
          <span aria-hidden className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-success-fill text-on-accent' : current ? 'bg-accent text-on-accent' : waiting ? 'border border-dashed border-line text-fg-subtle' : 'border border-line text-fg-muted')}>
            {done ? '✓' : waiting ? '…' : n}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-semibold">{title}</span>
              {accountWide && (
                <Badge tone="amber" title="Writes to the LaunchDarkly account, shared by every project, not just the target project">
                  account-wide
                </Badge>
              )}
              {waitingFor && (
                <Badge tone="slate" title={`${waitingFor} provisions these; nothing is written to LaunchDarkly from this step`}>
                  {done ? `provisioned by ${waitingFor}` : `waiting for ${waitingFor}`}
                </Badge>
              )}
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

function Connect({ workspaceId, workspace, g, input, nav }: { workspaceId: string; workspace: WorkspaceRecord; g: GuideModel; input: GuideInput; nav: GuideNav }) {
  const access = workspace.accountAccess;
  return (
    <>
      <p className="text-fg-muted">A source project to read from, the LaunchDarkly project to write to, and how the LaunchDarkly account's members and teams are managed. Nothing is written until you ask for it in a later step.</p>
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
        <li className="flex flex-wrap items-center gap-2">
          <Mark ok={!!access} />
          <label className="flex flex-wrap items-center gap-2">
            Members and teams are managed
            <Select aria-label="How members and teams are managed" className="py-1 text-xs" value={access ?? ''} onChange={(e) => void store.updateWorkspace(workspaceId, { accountAccess: e.target.value as AccountAccess })}>
              <option value="" disabled>
                choose…
              </option>
              {(Object.keys(ACCESS_LABEL) as AccountAccess[]).map((k) => (
                <option key={k} value={k}>
                  {ACCESS_LABEL[k].label}
                </option>
              ))}
            </Select>
          </label>
        </li>
      </ul>
      <p className="text-xs text-fg-muted">
        {access
          ? ACCESS_LABEL[access].note
          : 'With SSO and SCIM provisioning, members (and with Okta team sync, teams) come from your identity provider; the console must not invite or create them. Say so here and the Teams and People steps wait for the provider instead.'}
      </p>
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
              <Spinner /> Connecting to LaunchDarkly… the LaunchDarkly environments appear when the connection is up.
            </span>
          ) : (
            'Connect LaunchDarkly (step 1) to map it to a LaunchDarkly environment.'
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
                    aria-label={`LaunchDarkly environment for ${source.label} ${g.env}`}
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
                      {creating === source.id ? <Spinner /> : null} Create “{sanitizeKey(g.env).toLowerCase()}” in LaunchDarkly
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

/** Account-level writes the Teams and People steps trigger by hand; errors show inline. */
function useAccountWrites(m: MigrationContext | null) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const saveProfile = (fn: (prof: MappingProfile) => void) => {
    if (!m) return;
    const next: MappingProfile = structuredClone(m.profile);
    fn(next);
    void m.saveProfile(next);
  };
  return { busy, error, run, saveProfile };
}

/**
 * StatSig teams → LD teams (edge case 1.11), a step of its own so every team can be created
 * before anyone is invited. A team gets the members that already exist in LD; people invited
 * later join it on the next sync.
 */
function Teams({ workspaceId, g, m }: { workspaceId: string; g: GuideModel; m: MigrationContext | null }) {
  const { busy, error, run, saveProfile } = useAccountWrites(m);
  const p = g.people;
  const missing = p.teams.filter((t) => t.status === 'missing');
  // Under Okta team sync there is nothing to do per team but skip it, so the list waits behind a toggle.
  const waiting = p.access === 'scim_team_sync';
  const [showAll, setShowAll] = useState(false);
  const create = (t: TeamRow) => createLdTeam(workspaceId, { key: teamKeyFor(t.name), name: t.name, ...(t.description ? { description: t.description } : {}), memberIDs: t.ldMemberIds });
  // One at a time, so a failure stops at the team that failed and the ones before it stay created.
  const createAll = async () => {
    for (const t of missing) await create(t);
  };
  return (
    <>
      <p className="text-fg-muted">
        {p.access === 'scim_team_sync'
          ? 'Okta team sync is on, so LaunchDarkly teams are created and filled only by Okta Group Push. The console lists the groups to push and matches them by name; nothing is created from here.'
          : 'StatSig teams become LaunchDarkly teams with the members that already exist in LaunchDarkly. Teams come first so invitations can place people straight into them, and a flag whose owner is not a LaunchDarkly member can take its team as maintainer. Creating a team sends no email.'}
      </p>
      {!g.connected && <Callout tone="blue">Connect LaunchDarkly (step 1) to see which teams it already has.</Callout>}
      {g.connected && p.access === 'scim_team_sync' && missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3 text-xs">
          <span className="font-medium">
            {missing.length} team{missing.length === 1 ? ' is' : 's are'} not in LaunchDarkly yet.
          </span>
          <Button variant="secondary" className="py-1 text-xs" disabled={!!busy} onClick={() => void run('team:recheck', () => refreshLdPeople(workspaceId))}>
            {busy === 'team:recheck' ? <Spinner /> : null} Re-check
          </Button>
          <span className="text-fg-muted">
            In Okta, push a group for each: <code className="font-mono">{missing.map((t) => t.name).join('</code>, <code className="font-mono">')}</code>. Team sync links an existing LaunchDarkly team of the same name. Skip the ones you do not want in LaunchDarkly.
          </span>
        </div>
      )}
      {g.connected && missing.length > 0 && p.canCreateTeams && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3 text-xs">
          <span className="font-medium">
            {missing.length} team{missing.length === 1 ? ' is' : 's are'} not in LaunchDarkly.
          </span>
          <Button className="py-1 text-xs" disabled={!!busy} onClick={() => void run('team:all', createAll)}>
            {busy === 'team:all' ? <Spinner /> : null} Create all {missing.length} team{missing.length === 1 ? '' : 's'}
          </Button>
          <span className="text-fg-muted">Each team gets the members that already exist in LaunchDarkly; nobody is emailed.</span>
        </div>
      )}
      {g.connected && p.teams.length > 0 && waiting && (
        <Button variant="ghost" className="py-1 text-xs" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? 'Hide the teams' : `Show all ${p.teams.length} team${p.teams.length === 1 ? '' : 's'}`}
        </Button>
      )}
      {g.connected && p.teams.length > 0 && (!waiting || showAll) && (
        <ul className="divide-y divide-line-soft">
          {p.teams.map((t) => (
            <TeamLine
              key={t.name}
              t={t}
              canCreate={p.canCreateTeams}
              busy={busy === `team:${t.name}` || busy === 'team:all'}
              onCreate={() => void run(`team:${t.name}`, () => create(t))}
              onSkip={(skip) => saveProfile((prof) => void (prof.teams = { ...(prof.teams ?? {}), [t.name]: skip ? null : teamKeyFor(t.name) }))}
              onUnskip={() =>
                saveProfile((prof) => {
                  if (prof.teams) delete prof.teams[t.name];
                })
              }
            />
          ))}
        </ul>
      )}
      {g.connected && !p.canCreateTeams && p.access !== 'scim_team_sync' && missing.length > 0 && <p className="text-xs text-fg-muted">Teams are a LaunchDarkly Enterprise feature{p.teamsReadable ? '' : ' and this token cannot read them'}: create them in LaunchDarkly by hand, or skip them here.</p>}
      {g.connected && p.teams.length === 0 && <p className="text-xs text-fg-muted">The sources carry no teams: nothing to create.</p>}
      {error && <Callout tone="red">{error}</Callout>}
    </>
  );
}

/**
 * Owners → maintainers, once per person (PLAN §8.3, edge case 1.5). Inviting sends an email from
 * LaunchDarkly, so inviting everyone at once asks for a typed confirmation first.
 */
function People({ workspaceId, g, m, nav }: { workspaceId: string; g: GuideModel; m: MigrationContext | null; nav: GuideNav }) {
  const { busy, error, run, saveProfile } = useAccountWrites(m);
  const [role, setRole] = useState<LdInviteRole>('reader');
  const [confirmAll, setConfirmAll] = useState(false);
  const p = g.people;
  const missing = p.owners.filter((o) => o.status === 'missing');
  const choose = (email: string, choice: MappingProfile['maintainers'] extends Record<string, infer C> | undefined ? C | null : never) =>
    saveProfile((prof) => {
      prof.maintainers ??= {};
      if (choice === null) delete prof.maintainers[email];
      else prof.maintainers[email] = choice;
    });
  const members = m?.ld.members ?? [];
  const provisioned = p.access !== 'launchdarkly';
  // When SCIM provisions members there is nothing to do per owner but the fallback, so the table waits behind a toggle.
  const [showAll, setShowAll] = useState(false);
  // Teams were created on the previous step, so an invitation can place the person into them at once.
  const invitee = (o: OwnerRow) => {
    const teamKeys = teamKeysFor(o, p.teams);
    return { email: o.email, ...(o.name ? { name: o.name } : {}), ...(teamKeys.length ? { teamKeys } : {}) };
  };
  return (
    <>
      <p className="text-fg-muted">
        {provisioned
          ? 'A LaunchDarkly maintainer must be a member of the account. Members come from your identity provider over SCIM, so nobody is invited from here: owners are matched by email as they are provisioned, and until then their items can take the team as maintainer or go without one.'
          : 'A LaunchDarkly maintainer must be a member of the account, so each StatSig owner is matched by email before any flag is written. Owners without a LaunchDarkly member can be invited (LaunchDarkly emails them, they join the teams created in the previous step, and they become maintainers on the next sync), handed to their team, or left unassigned.'}
      </p>
      {!g.connected && <Callout tone="blue">Connect LaunchDarkly (step 1) to match owners against its members.</Callout>}
      {g.connected && !p.membersReadable && (
        <Callout tone="amber">
          This token cannot list the account's members, so owners cannot be matched: flags are created without a maintainer (the owner email stays in a custom property). Connect with a token that may read
          members, or leave every owner unassigned below.
        </Callout>
      )}
      {g.connected && provisioned && missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3 text-xs">
          <span className="font-medium">
            {missing.length} {missing.length === 1 ? 'person is' : 'people are'} not provisioned yet.
          </span>
          <Button variant="secondary" className="py-1 text-xs" disabled={!!busy} onClick={() => void run('people:recheck', () => refreshLdPeople(workspaceId))}>
            {busy === 'people:recheck' ? <Spinner /> : null} Re-check
          </Button>
          <Button variant="secondary" className="py-1 text-xs" disabled={!!busy} onClick={() => saveProfile((prof) => void (prof.maintainers = { ...(prof.maintainers ?? {}), ...Object.fromEntries(missing.map((o) => [o.email, 'unassigned' as const])) }))}>
            Leave all {missing.length} unassigned
          </Button>
          <span className="text-fg-muted">Have your identity provider assign these people to LaunchDarkly, then re-check. Inviting from here would create members outside SCIM.</span>
        </div>
      )}
      {g.connected && !provisioned && missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-line p-3 text-xs">
          <span className="font-medium">
            {missing.length} {missing.length === 1 ? 'person is' : 'people are'} not in LaunchDarkly.
          </span>
          {p.canInvite && (
            <>
              <label className="flex items-center gap-1">
                Invite as
                <Select value={role} onChange={(e) => setRole(e.target.value as LdInviteRole)} aria-label="Role for invited members" className="py-0.5 text-xs">
                  <option value="reader">reader</option>
                  <option value="writer">writer</option>
                </Select>
              </label>
              <Button className="py-1 text-xs" disabled={!!busy} onClick={() => setConfirmAll(true)}>
                {busy === 'invite:all' ? <Spinner /> : null} Invite all {missing.length} {missing.length === 1 ? 'person' : 'people'}…
              </Button>
            </>
          )}
          <Button variant="secondary" className="py-1 text-xs" disabled={!!busy} onClick={() => saveProfile((prof) => void (prof.maintainers = { ...(prof.maintainers ?? {}), ...Object.fromEntries(missing.map((o) => [o.email, 'unassigned' as const])) }))}>
            Leave all {missing.length} unassigned
          </Button>
          <span className="text-fg-muted">Inviting sends each person an email from LaunchDarkly{p.canInvite ? '' : '; this token may not invite (Admin or createMember needed), so ask a LaunchDarkly admin'}.</span>
        </div>
      )}
      {g.connected && p.owners.length > 0 && provisioned && (
        <Button variant="ghost" className="py-1 text-xs" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? 'Hide the owners' : `Show all ${p.owners.length} owner${p.owners.length === 1 ? '' : 's'}`}
        </Button>
      )}
      {g.connected && p.owners.length > 0 && (!provisioned || showAll) && (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-fg-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">StatSig owner</th>
              <th className="py-1 pr-3 font-medium">Items</th>
              <th className="py-1 pr-3 font-medium">Team</th>
              <th className="py-1 font-medium">In LaunchDarkly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {p.owners.map((o) => (
              <OwnerLine key={o.email} o={o} teams={p.teams} members={members} busy={busy === `invite:${o.email}`} canInvite={p.canInvite} onInvite={() => void run(`invite:${o.email}`, () => inviteLdMembers(workspaceId, [invitee(o)], role))} onChoose={(c) => choose(o.email, c)} />
            ))}
          </tbody>
        </table>
      )}
      {confirmAll && (
        <InviteAllModal
          people={missing}
          teams={p.teams}
          role={role}
          onClose={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            void run('invite:all', () => inviteLdMembers(workspaceId, missing.map(invitee), role));
          }}
        />
      )}
      {g.connected && p.owners.length === 0 && <p className="text-xs text-fg-muted">The sources carry no owners: nothing to match.</p>}
      {error && <Callout tone="red">{error}</Callout>}
      <p className="text-xs text-fg-muted">
        Per-item answers to “owner is not a LaunchDarkly member” live on the{' '}
        <button type="button" className="text-link hover:underline" onClick={nav.decisions}>
          Decisions
        </button>{' '}
        page; a choice made here answers them for every item of that owner.
      </p>
    </>
  );
}

/** The word to type before every missing owner is invited at once; emails cannot be unsent. */
export const INVITE_ALL_PHRASE = 'invite';

/**
 * Typed confirmation before inviting everyone: the full list of addresses, the role, and the
 * word to type. A click on the wrong button must not email a whole organization.
 */
function InviteAllModal({ people, teams, role, onClose, onConfirm }: { people: OwnerRow[]; teams: TeamRow[]; role: LdInviteRole; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === INVITE_ALL_PHRASE;
  return (
    <Modal title={`Invite ${people.length} ${people.length === 1 ? 'person' : 'people'} to LaunchDarkly`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Callout tone="amber">
          <span className="font-semibold">Account-wide.</span> These people join your whole LaunchDarkly account, with access to every project in it as <code className="font-mono">{role}</code>, not just
          the project you are migrating into.
        </Callout>
        <p className="text-fg-muted">
          LaunchDarkly will email an invitation to each address below. Invitations cannot be unsent from here; each person becomes an account member when they accept, and joins the teams
          listed next to them right away.
        </p>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-line p-2 font-mono text-xs">
          {people.map((o) => (
            <li key={o.email}>
              {o.email}
              {o.name ? <span className="text-fg-muted"> · {o.name}</span> : null}
              {teamKeysFor(o, teams).length ? <span className="text-fg-muted"> → {teamKeysFor(o, teams).join(', ')}</span> : null}
            </li>
          ))}
        </ul>
        <label className="block text-xs text-fg-muted">
          Type <code className="font-mono text-fg">{INVITE_ALL_PHRASE}</code> to confirm
          <Input
            aria-label="Confirmation"
            className="mt-1 font-mono"
            value={typed}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={INVITE_ALL_PHRASE}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && matches && onConfirm()}
          />
        </label>
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!matches} onClick={onConfirm}>
            Invite {people.length} {people.length === 1 ? 'person' : 'people'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function OwnerLine({ o, teams, members, busy, canInvite, onInvite, onChoose }: { o: OwnerRow; teams: TeamRow[]; members: { _id: string; email: string; firstName?: string | null; lastName?: string | null }[]; busy: boolean; canInvite: boolean; onInvite: () => void; onChoose: (c: { memberId: string } | { teamKey: string } | 'unassigned' | null) => void }) {
  const team = o.team ? teams.find((t) => t.name === o.team) : undefined;
  const label = (m: { _id: string; email: string; firstName?: string | null; lastName?: string | null }) => [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email;
  return (
    <tr>
      <td className="py-1.5 pr-3">
        <span className="font-mono text-xs">{o.email}</span>
        {o.name && <span className="ml-2 text-xs text-fg-muted">{o.name}</span>}
      </td>
      <td className="py-1.5 pr-3 text-xs text-fg-muted">{o.items}</td>
      <td className="py-1.5 pr-3 text-xs text-fg-muted">{o.team ?? '—'}</td>
      <td className="py-1.5">
        {o.status === 'member' && (
          <span className="flex items-center gap-2 text-xs">
            <Mark ok /> LaunchDarkly member{o.pendingInvite ? <Badge tone="amber">invite pending</Badge> : null}
          </span>
        )}
        {o.status === 'chosen_member' && (
          <span className="flex items-center gap-2 text-xs">
            <Mark ok /> Maintainer: {label(members.find((m) => m._id === o.memberId) ?? { _id: o.memberId!, email: o.memberId! })}
            <button type="button" className="text-link hover:underline" onClick={() => onChoose(null)}>
              change
            </button>
          </span>
        )}
        {o.status === 'chosen_team' && (
          <span className="flex items-center gap-2 text-xs">
            <Mark ok /> Team “{o.teamKey}” is the maintainer
            <button type="button" className="text-link hover:underline" onClick={() => onChoose(null)}>
              change
            </button>
          </span>
        )}
        {o.status === 'unassigned' && (
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <Mark ok /> No maintainer (owner kept in a custom property)
            <button type="button" className="text-link hover:underline" onClick={() => onChoose(null)}>
              change
            </button>
          </span>
        )}
        {o.status === 'missing' && (
          <span className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge tone="amber">not in LaunchDarkly</Badge>
            {canInvite && (
              <Button variant="secondary" className="py-0.5 text-xs" disabled={busy} onClick={onInvite}>
                {busy ? <Spinner /> : null} Invite
              </Button>
            )}
            {team?.ldKey && (
              <Button variant="ghost" className="py-0.5 text-xs" onClick={() => onChoose({ teamKey: team.ldKey! })}>
                Assign team “{team.ldKey}”
              </Button>
            )}
            {/* No "pick another member" here: an owner who is not in LD is invited or left unassigned, never mapped onto an existing member. */}
            <Button variant="ghost" className="py-0.5 text-xs" onClick={() => onChoose('unassigned')}>
              Leave unassigned
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

function TeamLine({ t, canCreate, busy, onCreate, onSkip, onUnskip }: { t: TeamRow; canCreate: boolean; busy: boolean; onCreate: () => void; onSkip: (skip: boolean) => void; onUnskip: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
      <span className="font-medium">{t.name}</span>
      <span className="text-fg-muted">
        {t.items} item{t.items === 1 ? '' : 's'}
        {t.memberEmails.length ? ` · ${t.memberEmails.length} member${t.memberEmails.length === 1 ? '' : 's'} in StatSig, ${t.ldMemberIds.length} in LaunchDarkly` : ''}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {t.status === 'exists' && (
          <>
            <Mark ok /> LaunchDarkly team <code className="font-mono">{t.ldKey}</code>
          </>
        )}
        {t.status === 'skipped' && (
          <>
            <span className="text-fg-muted">No LaunchDarkly team</span>
            <button type="button" className="text-link hover:underline" onClick={onUnskip}>
              change
            </button>
          </>
        )}
        {t.status === 'missing' && (
          <>
            <Badge tone="amber">not in LaunchDarkly</Badge>
            {canCreate && (
              <Button variant="secondary" className="py-0.5 text-xs" disabled={busy} onClick={onCreate}>
                {busy ? <Spinner /> : null} Create “{teamKeyFor(t.name)}” in LaunchDarkly
              </Button>
            )}
            <Button variant="ghost" className="py-0.5 text-xs" onClick={() => onSkip(true)}>
              Skip
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

function Contexts({ workspaceId, g, m, nav, onMigrate }: { workspaceId: string; g: GuideModel; m: MigrationContext | null; nav: GuideNav; onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void }) {
  const [probing, setProbing] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [defaultError, setDefaultError] = useState<string>();
  const kinds = g.contexts.toCreate;
  const du = g.contexts.defaultUnit;
  return (
    <>
      <p className="text-fg-muted">
        StatSig buckets and targets by unit types; LaunchDarkly by context kinds. Decide where each unit type goes before anything else, because every rule, rollout and target refers
        to it: a new context kind (created on the first migration), an attribute of the user context, or a kind another unit type already uses.
      </p>
      {du && g.connected && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Mark ok={du.isDefault} /> StatSig's default unit type is <code className="font-mono">{du.unitType}</code>
          {du.isDefault ? (
            <span className="text-fg-muted">
              and <code className="font-mono">{du.kind}</code> is the default randomization unit in LaunchDarkly.
            </span>
          ) : (
            <>
              <span className="text-fg-muted">
                → make <code className="font-mono">{du.kind}</code> the default randomization unit for LaunchDarkly experiments{du.readable ? '' : ' (experimentation settings not readable: needs the Experimentation add-on)'}.
              </span>
              {du.readable && (
                <Button
                  variant="secondary"
                  className="py-0.5 text-xs"
                  disabled={settingDefault}
                  onClick={() => {
                    setSettingDefault(true);
                    setDefaultError(undefined);
                    void setDefaultRandomizationUnit(workspaceId, du.kind)
                      .catch((e: Error) => setDefaultError(e.message))
                      .finally(() => setSettingDefault(false));
                  }}
                >
                  {settingDefault ? <Spinner /> : null} Set as default
                </Button>
              )}
            </>
          )}
          {defaultError && <span className="text-error">{defaultError}</span>}
        </div>
      )}
      {g.contexts.unitTypes.length === 0 && <Callout tone="blue">{g.ldEnvs.length ? 'The sources in this environment declare no unit types; userID maps to the user context.' : `Map the environment first (step ${ENV_STEP}).`}</Callout>}
      {g.contexts.open.length > 0 && (
        <p className="text-xs text-fg-muted">
          Answer here per item, or set every unit type once on the{' '}
          <button type="button" className="text-link hover:underline" onClick={nav.unitTypes}>
            Unit types
          </button>{' '}
          page.
        </p>
      )}
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
                Create {kinds.length} context kind{kinds.length === 1 ? '' : 's'} in LaunchDarkly…
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
          <button type="button" className="text-link hover:underline" onClick={nav.unitTypes}>
            Unit types
          </button>{' '}
          page.
        </p>
      )}
    </>
  );
}

function Items({ workspaceId, g, tallies, noun, nav, onMigrate, toSelection }: { workspaceId: string; g: GuideModel; tallies: Tally[]; noun: string; nav: GuideNav; onMigrate: (selection: MigrationSelection, ldEnvs: string[]) => void; toSelection: (uids: string[]) => MigrationSelection }) {
  // Whether a read is in flight comes from the live session: the guide model is built from the
  // session's data view, which does not follow a read's progress.
  const refreshing = !!useLdSession(workspaceId).refreshing;
  const uids = tallies.flatMap((t) => t.toMigrate);
  const blocked = tallies.reduce((n, t) => n + t.blocked, 0);
  const total = tallies.reduce((n, t) => n + t.total, 0);
  const unknown = tallies.some((t) => t.ldUnknown);
  return (
    <>
      <p className="text-fg-muted">
        {noun === 'segment'
          ? 'Segments go first: flags reference them, so a flag migrated later finds its segments already in place. Big ID lists import as big segments where the plan allows. Not every segment has to come: open Segments (View) to see which gates and configs use each one, tick the ones to bring, and set aside the rest; a migrated flag still brings the segments it needs.'
          : 'Gates become boolean flags and dynamic configs become JSON flags, with rules, rollouts and overrides translated. A gate used as a prerequisite migrates before the flags that depend on it. StatSig prompts become AI Configs: the shell only, because the Console API does not expose prompt versions.'}
      </p>
      {noun === 'flag' && !g.aiConfigsAvailable && g.prompts.total > 0 && <Callout tone="amber">{g.prompts.total} StatSig prompt{g.prompts.total === 1 ? '' : 's'} cannot be written: AI Configs are not available to this LaunchDarkly project or token. Recreate them in LaunchDarkly by hand.</Callout>}
      {!g.ldEnvs.length && <Callout tone="blue">Map the environment first (step {ENV_STEP}).</Callout>}
      {g.ldEnvs.length > 0 && (
        <>
          {g.ldAsOf && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted" role="status">
              {refreshing ? (
                <>
                  <Spinner /> Reading LaunchDarkly…
                </>
              ) : (
                <>
                  LaunchDarkly as read {timeAgo(g.ldAsOf.at)}
                  {g.ldAsOf.failed ? '; the latest read failed (see step 1)' : ''}.
                  <button type="button" className="text-link hover:underline" onClick={() => void refreshLdState(workspaceId, { segmentEnvs: g.ldEnvs }).catch(() => undefined)}>
                    Re-read
                  </button>
                  <span>Plans read it afresh before a run.</span>
                </>
              )}
            </p>
          )}
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
                {x.count} {KIND_LABEL[x.kind].toLowerCase()}: end in StatSig, start new in LaunchDarkly.
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

function CutOver({ workspaceId, g, input, workspace, nav, doneCount }: { workspaceId: string; g: GuideModel; input: GuideInput; workspace: WorkspaceRecord; nav: GuideNav; doneCount: number }) {
  void workspace;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const approvals = g.cutover.approvals.filter((a) => a.sourceRequires);
  return (
    <>
      <p className="text-fg-muted">Once {g.env || 'an environment'} is migrated, point that environment's SDKs at LaunchDarkly, keep StatSig running until its checks go quiet, then repeat from step 2 for the next environment.</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>Swap the SDK in the apps that run in this environment and watch Monitoring: LaunchDarkly traffic rising, StatSig checks falling to zero.</li>
        <li>Re-sync when StatSig changes; Monitoring flags drift from either side, and the plan shows exactly what a re-sync would change.</li>
        <li>When StatSig checks have been at zero for a while, archive the gates there, and stop syncing this environment.</li>
        <li>Then the next environment, production last.</li>
      </ol>
      {approvals.length > 0 && (
        <div className="space-y-1 rounded-md border border-line p-3">
          <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Reviews → approvals</div>
          <p className="text-xs text-fg-muted">StatSig requires reviews for changes in {g.env}. Turn on required approvals in the LaunchDarkly environment after the migration writes are done, or every sync files an approval request.</p>
          <ul className="space-y-1 text-xs">
            {approvals.map((a) => (
              <li key={a.ldEnv} className="flex flex-wrap items-center gap-2">
                <Mark ok={a.ldRequires === true} /> LaunchDarkly <code className="font-mono">{a.ldEnv}</code>
                {a.ldRequires === true ? (
                  <span className="text-fg-muted">requires approvals.</span>
                ) : (
                  <>
                    <span className="text-fg-muted">{a.ldRequires === false ? 'does not require approvals yet.' : 'approval settings not reported (Enterprise feature off, or not probed).'}</span>
                    {g.cutover.canSetApprovals && (
                      <Button
                        variant="secondary"
                        className="py-0.5 text-xs"
                        disabled={!!busy}
                        onClick={() => {
                          setBusy(a.ldEnv);
                          setError(undefined);
                          void requireLdApprovals(workspaceId, a.ldEnv)
                            .catch((e: Error) => setError(e.message))
                            .finally(() => setBusy(undefined));
                        }}
                      >
                        {busy === a.ldEnv ? <Spinner /> : null} Require approvals in {a.ldEnv}
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
          {error && <Callout tone="red">{error}</Callout>}
        </div>
      )}
      {g.cutover.alerts.length > 0 && (
        <div className="space-y-1 rounded-md border border-line p-3">
          <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Topline alerts to recreate</div>
          <p className="text-xs text-fg-muted">StatSig topline alerts have no LaunchDarkly equivalent. Recreate the ones that matter as LaunchDarkly Observability alerts or as experiment guardrails once the metrics exist in LaunchDarkly.</p>
          <ul className="space-y-0.5 text-xs">
            {g.cutover.alerts.map(({ alias, alert }) => (
              <li key={`${alias}/${alert.id}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{alert.name}</span>
                <span className="text-fg-muted">
                  {alert.alertType ?? 'alert'} on {alert.metrics.length ? alert.metrics.join(', ') : 'a metric'}
                  {alert.condition && alert.threshold !== undefined ? ` (${alert.condition.replace(/_/g, ' ')} ${alert.threshold})` : ''}
                  {alert.subscribers ? ` · ${alert.subscribers} subscriber${alert.subscribers === 1 ? '' : 's'}` : ''}
                  {alias ? ` · ${alias}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
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

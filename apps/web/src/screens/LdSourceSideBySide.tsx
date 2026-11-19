import { indexByKey } from '../lib/indexByKey.ts';
import { Fragment, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { neutralDesignIteration, type CanonicalSnapshot, type NeutralAttribute, type NeutralExperiment, type NeutralFlag, type NeutralHoldout, type NeutralIteration, type NeutralLayer, type NeutralMetric, type NeutralMetricGroup, type NeutralSegment, type SourceKind } from '@sslm/canonical';
import { optionLabel, type DecisionType, type DesiredExperiment, type NeutralExperimentMapResult, type NeutralFlagMapResult, type NeutralHoldoutMapResult, type NeutralLayerMapResult, type NeutralMetricGroupMapResult, type NeutralMetricMapResult, type NeutralSegmentMapResult } from '@sslm/mapper';
import { migrationStatus, ownsSegment, type MigrationStatus } from '@sslm/planner';
import type { SourceRecord } from '@sslm/store';
import { DecisionCard, FIDELITY_TONE } from '../components/DecisionCard.tsx';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { MigrateButton, ReadinessLine, readinessSteps } from '../components/Readiness.tsx';
import { LdTargeting } from '../components/Targeting.tsx';
import { Badge, Button, Callout, Card, cx, Input, Select } from '../components/ui.tsx';
import { SOURCE_BADGE } from '../lib/kinds.ts';
import { TagFilter } from '../components/TagFilter.tsx';
import { MappingExplainer } from '../components/MappingExplainer.tsx';
import { matchesTags, pruneTags, tagOptions } from '../lib/tags.ts';
import { ldFlagState, mapNeutralExperimentFor, mapNeutralFlagFor, mapNeutralHoldoutFor, mapNeutralLayerFor, mapNeutralMetricFor, mapNeutralMetricGroupFor, mapNeutralSegmentFor } from '../lib/migration.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import type { ExplorerNav } from './AutotunesSideBySide.tsx';
import { STATUS } from './GatesSideBySide.tsx';

/** `metric` lists metrics and metric groups; `experiment` lists experiments, holdouts and layers (PLAN §20.5). */
export type LdSourceResource = 'flag' | 'segment' | 'metric' | 'experiment';
type Filter = 'all' | 'open' | 'blocking' | 'not_migrated' | 'in_sync' | 'changed';

interface FlagRow {
  kind: 'flag';
  sourceId: string;
  sourceKind: SourceKind;
  alias: string;
  entity: NeutralFlag;
  result: NeutralFlagMapResult;
  ldEnv: string | null;
  strip: { ldEnv: string; status: MigrationStatus }[];
  /** The flag's maintainer as the source states it, with the display name from the snapshot's member list (a PostHog flag names only its creator's email). */
  owner?: FlagOwner;
}

interface FlagOwner {
  email?: string;
  name?: string;
  teamKey?: string;
}

/** What the detail shows as the flag's owner: nothing for a maintainer the source gave only as a member ID (it belongs to the source account; the mapper notes it). */
export function flagOwner(flag: NeutralFlag, users: CanonicalSnapshot['users'] | undefined): FlagOwner | undefined {
  const mt = flag.maintainer;
  if (!mt || (!mt.email && !mt.teamKey)) return undefined;
  const email = mt.email?.trim().toLowerCase();
  const name = email ? users?.find((u) => u.email?.trim().toLowerCase() === email)?.name : undefined;
  return { ...(email ? { email } : {}), ...(name ? { name } : {}), ...(mt.teamKey ? { teamKey: mt.teamKey } : {}) };
}
interface SegmentRow {
  kind: 'segment';
  sourceId: string;
  sourceKind: SourceKind;
  alias: string;
  entity: NeutralSegment;
  result: NeutralSegmentMapResult;
  ldEnv: string | null;
  strip: { ldEnv: string; status: MigrationStatus }[];
}
interface BaseRow {
  sourceId: string;
  sourceKind: SourceKind;
  alias: string;
  ldEnv: string | null;
  strip: { ldEnv: string; status: MigrationStatus }[];
}
interface MetricRow extends BaseRow {
  kind: 'metric';
  entity: NeutralMetric;
  result: NeutralMetricMapResult;
  owner?: FlagOwner;
}
interface MetricGroupRow extends BaseRow {
  kind: 'metric_group';
  entity: NeutralMetricGroup;
  result: NeutralMetricGroupMapResult;
  owner?: FlagOwner;
}
interface ExperimentRow extends BaseRow {
  kind: 'experiment';
  entity: NeutralExperiment;
  result: NeutralExperimentMapResult;
  owner?: FlagOwner;
}
interface HoldoutRow extends BaseRow {
  kind: 'holdout';
  entity: NeutralHoldout;
  result: NeutralHoldoutMapResult;
  owner?: FlagOwner;
}
interface LayerRow extends BaseRow {
  kind: 'layer';
  entity: NeutralLayer;
  result: NeutralLayerMapResult;
}
type Row = FlagRow | SegmentRow | MetricRow | MetricGroupRow | ExperimentRow | HoldoutRow | LayerRow;

const WORDS: Record<LdSourceResource, { title: string; one: string; many: string }> = {
  flag: { title: 'Flags (source projects)', one: 'flag', many: 'flags' },
  segment: { title: 'Segments and cohorts', one: 'segment', many: 'segments' },
  metric: { title: 'Metrics and metric groups (source projects)', one: 'metric', many: 'metrics' },
  experiment: { title: 'Experiments, holdouts and layers (source projects)', one: 'experiment', many: 'experiments' },
};

const KIND_BADGE: Record<Row['kind'], string | null> = { flag: null, segment: null, metric: 'metric', metric_group: 'metric group', experiment: 'experiment', holdout: 'holdout', layer: 'layer' };

/** Tags of a row's entity (holdouts have none). */
const tagsOf = (r: Row): string[] => ('tags' in r.entity ? r.entity.tags : []);
const ownerOf = (m: { email?: string; teamKey?: string } | undefined, users: CanonicalSnapshot['users'] | undefined): FlagOwner | undefined => {
  if (!m || (!m.email && !m.teamKey)) return undefined;
  const email = m.email?.trim().toLowerCase();
  const name = email ? users?.find((u) => u.email?.trim().toLowerCase() === email)?.name : undefined;
  return { ...(email ? { email } : {}), ...(name ? { name } : {}), ...(m.teamKey ? { teamKey: m.teamKey } : {}) };
};

const isPostHogKind = (k: SourceKind) => k === 'posthog' || k === 'posthog_payload';

/**
 * Side-by-side explorer for every source read onto the neutral model (an LD project, PLAN §20;
 * a PostHog project or payload, PLAN §22): the source flag or segment on the left, what the
 * console would write into the target on the right, the per environment status strip from
 * target provenance, open decisions inline, and Migrate.
 */
export function LdSourceSideBySide({
  resource,
  sources,
  snapshots,
  env,
  m,
  onMigrate,
  nav,
  readOnly = false,
  selected,
  setSelected,
}: {
  resource: LdSourceResource;
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  /** Source environment key selected in the header. */
  env: string;
  m: MigrationContext;
  onMigrate: (selection: { flags?: string[]; segments?: string[]; metrics?: string[]; metricGroups?: string[]; experiments?: string[]; holdouts?: string[]; layers?: string[] }, ldEnvs: string[]) => void;
  nav: ExplorerNav;
  readOnly?: boolean;
  /** The workspace-wide selection (lib/selection.ts): ticks here add to it, so a pick survives switching views. */
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string>();
  const words = WORDS[resource];
  // Any source whose snapshot carries a neutral block, whatever vocabulary it was read from.
  const neutralSources = useMemo(() => sources.filter((s) => !!snapshots[s.id]?.neutral), [sources, snapshots]);
  const ldFlags = useMemo(() => new Map((m.ld.flags?.items ?? []).map((f) => [f.key, f])), [m.ld.flags]);
  const ldEnvOf = (sourceId: string, sourceEnv: string) => (m.connected ? (m.profile.sources[sourceId]?.envMapping[sourceEnv] ?? null) : null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const s of neutralSources) {
      const snap = snapshots[s.id]!;
      const ldEnv = ldEnvOf(s.id, env);
      const envPairs = m.connected
        ? m.ldEnvs.map((le) => ({ le: le.key, se: Object.entries(m.profile.sources[s.id]?.envMapping ?? {}).find(([, v]) => v === le.key)?.[0] }))
        : [];
      // Project-level resources (metrics, metric groups, layers) carry one pill: whether the target project has one of ours.
      const projectStrip = (key: string, list: { key: string; tags?: string[] | null }[] | undefined, byFooter?: { key: string; description?: string | null }[]): { ldEnv: string; status: MigrationStatus }[] => {
        if (!m.connected) return [];
        const existing = list ? indexByKey(list).get(key) : byFooter?.find((x) => x.key === key);
        const owned = existing && ('tags' in existing && existing.tags ? ownsSegment({ key: existing.key, tags: existing.tags }, snap.source.alias) : (existing as { description?: string | null }).description?.includes(`src=${snap.source.alias}`));
        return [{ ldEnv: 'project', status: !existing ? 'not_in_ld' : owned ? 'in_sync' : 'foreign' }];
      };
      const envStrip = (key: string, lists: Record<string, { key: string; tags?: string[] | null; description?: string | null }[]> | undefined, byFooter: boolean): { ldEnv: string; status: MigrationStatus }[] =>
        envPairs.map(({ le, se }) => {
          const existing = lists?.[le]?.find((x) => x.key === key);
          const owned = existing && (byFooter ? existing.description?.includes(`src=${snap.source.alias}`) : ownsSegment({ key: existing.key, tags: existing.tags ?? [] }, snap.source.alias));
          const status: MigrationStatus = !se ? 'not_in_ld' : !existing ? 'not_in_ld' : owned ? 'in_sync' : 'foreign';
          return { ldEnv: le, status };
        });
      if (resource === 'flag') {
        for (const f of snap.neutral!.flags) {
          const result = mapNeutralFlagFor(snap, f, { statsig: env, ld: ldEnv ?? env }, m);
          const strip = envPairs.map(({ le, se }) => {
            if (!se) return { ldEnv: le, status: 'not_in_ld' as MigrationStatus };
            const r = se === env ? result : mapNeutralFlagFor(snap, f, { statsig: se, ld: le }, m);
            const lf = ldFlags.get(r.flagKey);
            return { ldEnv: le, status: migrationStatus(lf && ldFlagState(lf), le, r, { id: f.key, source: snap.source.alias }).status };
          });
          const owner = flagOwner(f, snap.users);
          out.push({ kind: 'flag', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: f, result, ldEnv, strip, ...(owner ? { owner } : {}) });
        }
      } else if (resource === 'segment') {
        for (const g of snap.neutral!.segments) {
          const result = mapNeutralSegmentFor(snap, g, { statsig: env, ld: ldEnv ?? env }, m);
          // Segments carry no sync record: the strip says whether the target has one of ours in each environment.
          const strip = envPairs.map(({ le, se }) => {
            const list = m.ld.segments?.[le];
            const existing = list ? indexByKey(list).get(g.key) : undefined;
            const status: MigrationStatus = !se ? 'not_in_ld' : !existing ? 'not_in_ld' : ownsSegment({ key: existing.key, tags: existing.tags ?? [] }, snap.source.alias) ? 'in_sync' : 'foreign';
            return { ldEnv: le, status };
          });
          out.push({ kind: 'segment', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: g, result, ldEnv, strip });
        }
      } else if (resource === 'metric') {
        for (const mt of snap.neutral!.metrics ?? []) {
          const owner = ownerOf(mt.maintainer, snap.users);
          out.push({ kind: 'metric', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: mt, result: mapNeutralMetricFor(snap, mt, m), ldEnv, strip: projectStrip(mt.key, m.ld.metrics), ...(owner ? { owner } : {}) });
        }
        for (const g of snap.neutral!.metricGroups ?? []) {
          const owner = ownerOf(g.maintainer, snap.users);
          out.push({ kind: 'metric_group', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: g, result: mapNeutralMetricGroupFor(snap, g, m), ldEnv, strip: projectStrip(g.key, m.ld.metricGroups), ...(owner ? { owner } : {}) });
        }
      } else {
        for (const x of snap.neutral!.experiments ?? []) {
          const owner = ownerOf(x.environments.find((e) => e.env === env)?.maintainer ?? x.environments[0]?.maintainer, snap.users);
          out.push({ kind: 'experiment', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: x, result: mapNeutralExperimentFor(snap, x, { statsig: env, ld: ldEnv ?? env }, m), ldEnv, strip: envStrip(x.key, m.ld.experiments, false), ...(owner ? { owner } : {}) });
        }
        for (const h of snap.neutral!.holdouts ?? []) {
          const owner = ownerOf(h.environments.find((e) => e.env === env)?.maintainer ?? h.environments[0]?.maintainer, snap.users);
          out.push({ kind: 'holdout', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: h, result: mapNeutralHoldoutFor(snap, h, { statsig: env, ld: ldEnv ?? env }, m), ldEnv, strip: envStrip(h.key, m.ld.holdouts as Record<string, { key: string; description?: string | null }[]> | undefined, true), ...(owner ? { owner } : {}) });
        }
        for (const l of snap.neutral!.layers ?? []) {
          out.push({ kind: 'layer', sourceId: s.id, sourceKind: s.kind, alias: s.alias, entity: l, result: mapNeutralLayerFor(snap, l, m), ldEnv, strip: projectStrip(l.key, undefined, m.ld.layers) });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the rows read of `m` (see GatesSideBySide)
  }, [neutralSources, snapshots, env, m.inputs, m.connected, m.ldEnvs, m.ld.segments, m.ld.metrics, m.ld.metricGroups, m.ld.experiments, m.ld.holdouts, m.ld.layers, ldFlags, resource]);

  const tagChoices = useMemo(() => tagOptions(rows.map((r) => ({ tags: tagsOf(r) }))), [rows]);
  const chosenTags = useMemo(() => pruneTags(tags, tagChoices), [tags, tagChoices]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!showArchived && r.entity.archived) return false;
        if (q && !r.entity.key.toLowerCase().includes(q.toLowerCase()) && !r.entity.name.toLowerCase().includes(q.toLowerCase())) return false;
        if (!matchesTags(tagsOf(r), chosenTags)) return false;
        const here = r.strip.find((s) => s.ldEnv === r.ldEnv)?.status;
        switch (filter) {
          case 'open':
            return r.result.unresolved.length > 0;
          case 'blocking':
            return r.result.unresolved.some((d) => d.severity === 'blocking');
          case 'not_migrated':
            return !here || here === 'not_in_ld' || here === 'not_migrated';
          case 'in_sync':
            return here === 'in_sync';
          case 'changed':
            return here === 'statsig_changed' || here === 'decisions_changed';
          default:
            return true;
        }
      }),
    [rows, showArchived, q, filter, chosenTags],
  );
  const pager = usePager(visible);
  const selectable = visible.filter((r) => !r.entity.archived && !r.result.skipped);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.entity.uid));
  const selectedRows = rows.filter((r) => selected.has(r.entity.uid));
  const blockingIn = (rs: Row[]) => rs.reduce((n, r) => n + r.result.unresolved.filter((d) => d.severity === 'blocking').length, 0);
  const mappedHere = [...new Set(neutralSources.map((s) => ldEnvOf(s.id, env)).filter((x): x is string => !!x))];
  const steps = readinessSteps({ m, env, mappedHere, hasSnapshot: neutralSources.length > 0, kindLabel: words.many, selected: selectedRows.length, blockingSelected: blockingIn(selectedRows), blockingAll: blockingIn(visible), nav });
  const toggle = (uid: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  const migrate = () => {
    const sel: Parameters<typeof onMigrate>[0] = {};
    const field: Record<Row['kind'], keyof typeof sel> = { flag: 'flags', segment: 'segments', metric: 'metrics', metric_group: 'metricGroups', experiment: 'experiments', holdout: 'holdouts', layer: 'layers' };
    for (const r of selectedRows) (sel[field[r.kind]] ??= []).push(r.entity.uid);
    onMigrate(sel, mappedHere);
  };
  // Only this explorer's items: other kinds stay selected across views.
  const selectAll = () =>
    setSelected((x) => {
      const n = new Set(x);
      for (const r of selectable) if (allSelected) n.delete(r.entity.uid); else n.add(r.entity.uid);
      return n;
    });

  // The explainer speaks for one vocabulary: the PostHog one when every source here is PostHog, else LD's.
  const explainerKey = resource === 'metric' ? 'ld_metric' : resource === 'experiment' ? 'ld_experiment' : neutralSources.length > 0 && neutralSources.every((s) => isPostHogKind(s.kind)) ? (resource === 'flag' ? 'ph_flag' : 'ph_segment') : resource === 'flag' ? 'ld_flag' : 'ld_segment';
  const attributes = neutralSources.flatMap((s) => (snapshots[s.id]?.neutral?.attributes ?? []).map((a) => ({ ...a, alias: s.alias })));

  if (neutralSources.length === 0) return <Callout tone="blue">No LaunchDarkly or PostHog source is attached. Add one under Connections to compare a source project with the target.</Callout>;

  return (
    <div className="pb-20">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">{words.title}</h2>
        <Badge>{visible.length}</Badge>
        <span className="text-sm text-fg-muted">
          source <b>{env}</b>
          {mappedHere.length > 0 && (
            <>
              {' '}
              → target <b>{mappedHere.join(', ')}</b>
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter by status">
            <option value="all">All</option>
            <option value="open">Open decisions</option>
            <option value="blocking">Blocking decisions</option>
            <option value="not_migrated">Not migrated here</option>
            <option value="in_sync">In sync</option>
            <option value="changed">Changed since sync</option>
          </Select>
          <TagFilter options={tagChoices} chosen={chosenTags} onChange={setTags} noun={words.many} />
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived
          </label>
          <Input placeholder="Filter by key or name" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" aria-label={`Filter ${words.many}`} />
          {!readOnly && <MigrateButton steps={steps} onClick={migrate} label={selectedRows.length ? `Migrate ${selectedRows.length.toLocaleString()} ${selectedRows.length === 1 ? words.one : words.many}…` : 'Migrate…'} />}
        </div>
      </div>
      <MappingExplainer resource={explainerKey} onOpenCoverage={nav?.coverage} className="mb-3" />
      {attributes.length > 0 && <AttributesPanel attributes={attributes} showAlias={neutralSources.length > 1} />}
      {!readOnly && <ReadinessLine steps={steps} />}
      {m.ld.status !== 'connected' && (
        <div className="mb-3">
          <Callout tone="blue">Connect the target LaunchDarkly project to see what is already there and to migrate. Decisions can be made without it.</Callout>
        </div>
      )}
      <PagerBar pager={pager} label={words.many} className="mb-2" />
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs tracking-wide text-fg-muted uppercase">
            <tr>
              <th className="w-8 px-3 py-2">
                {!readOnly && (
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={selectAll}
                  />
                )}
              </th>
              <th className="px-3 py-2">Source {words.one}</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Fidelity</th>
              <th className="px-3 py-2">Decisions</th>
              <th className="px-3 py-2">Status by environment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {pager.slice.map((r) => {
              const isOpen = open === r.entity.uid;
              const blocking = r.result.unresolved.filter((d) => d.severity === 'blocking').length;
              return (
                <Fragment key={r.entity.uid}>
                  <tr className={cx('cursor-pointer hover:bg-surface-hover', isOpen && 'bg-surface-2')} onClick={() => setOpen(isOpen ? undefined : r.entity.uid)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      {!readOnly && !r.entity.archived && !r.result.skipped && <input type="checkbox" aria-label={`Select ${r.entity.key}`} checked={selected.has(r.entity.uid)} onChange={() => toggle(r.entity.uid)} />}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px]">{r.entity.key}</span>
                        {neutralSources.length > 1 && (
                          <Badge tone={SOURCE_BADGE[r.sourceKind].tone} title={SOURCE_BADGE[r.sourceKind].label}>
                            {r.alias}
                          </Badge>
                        )}
                        {r.kind === 'flag' && <Badge tone="slate">{r.entity.flagKind}</Badge>}
                        {r.kind === 'segment' && r.entity.environments.some((e) => e.unbounded) && <Badge tone="violet">big segment</Badge>}
                        {KIND_BADGE[r.kind] && <Badge tone="slate">{KIND_BADGE[r.kind]}</Badge>}
                        {r.kind === 'metric' && <Badge tone="violet">{r.entity.metricKind}{r.entity.isNumeric ? ', numeric' : ''}</Badge>}
                        {r.kind === 'metric_group' && <Badge tone="violet">{r.entity.groupKind}</Badge>}
                        {r.kind === 'experiment' && <ExperimentStateBadge x={r.entity} env={env} />}
                        {r.kind === 'holdout' && <Badge tone="amber">{r.entity.environments.find((e) => e.env === env)?.status ?? r.entity.environments[0]?.status}</Badge>}
                        {r.entity.archived && <Badge>archived</Badge>}
                        {r.kind === 'flag' && r.entity.deprecated && <Badge tone="amber">deprecated</Badge>}
                      </div>
                      <div className="truncate text-xs text-fg-muted">{r.entity.name !== r.entity.key ? r.entity.name : r.entity.description}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[13px]">{r.result.skipped ? <span className="text-fg-subtle">—</span> : r.entity.key}</td>
                    <td className="px-3 py-2">
                      <Badge tone={FIDELITY_TONE[r.result.fidelity.overall]}>{r.result.fidelity.overall}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      {r.result.unresolved.length > 0 ? (
                        <span className="flex gap-1">
                          {blocking > 0 && <Badge tone="red">{blocking} blocking</Badge>}
                          {r.result.unresolved.length - blocking > 0 && <Badge tone="amber">{r.result.unresolved.length - blocking} open</Badge>}
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">none</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.strip.map((s) => (
                          <span key={s.ldEnv} className="flex items-center gap-1 rounded border border-line-soft px-1.5 py-0.5 text-xs" title={`${s.ldEnv}: ${STATUS[s.status].label}`}>
                            <span className={cx('h-1.5 w-1.5 rounded-full', STATUS[s.status].dot)} />
                            {s.ldEnv}
                          </span>
                        ))}
                        {r.strip.length === 0 && <span className="text-xs text-fg-subtle">connect LaunchDarkly</span>}
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-surface-2">
                      <td colSpan={6} className="px-4 py-3">
                        <Detail row={r} m={m} readOnly={readOnly} sourceEnv={env} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-xs text-fg-muted">
                  {rows.length === 0 ? `No ${words.many} in the source project.` : 'No matches.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <PagerBar pager={pager} label={words.many} className="mt-2" />
    </div>
  );
}

function Detail({ row, m, readOnly, sourceEnv }: { row: Row; m: MigrationContext; readOnly: boolean; sourceEnv: string }) {
  const r = row.result;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">
          Source ({SOURCE_BADGE[row.sourceKind].label} {row.alias})
        </div>
        {row.kind === 'flag' ? (
          <SourceFlag flag={row.entity} env={sourceEnv} />
        ) : row.kind === 'segment' ? (
          <SourceSegment segment={row.entity} env={sourceEnv} />
        ) : row.kind === 'metric' ? (
          <SourceMetric metric={row.entity} />
        ) : row.kind === 'metric_group' ? (
          <SourceMetricGroup group={row.entity} />
        ) : row.kind === 'experiment' ? (
          <SourceExperiment experiment={row.entity} env={sourceEnv} />
        ) : row.kind === 'holdout' ? (
          <SourceHoldout holdout={row.entity} env={sourceEnv} />
        ) : (
          <SourceLayer layer={row.entity} />
        )}
        {row.kind !== 'segment' && row.kind !== 'layer' && row.owner && (
          <div className="mt-1.5 text-xs text-fg-subtle" data-testid="flag-owner">
            owner:{' '}
            {row.owner.email ? (
              <>
                {row.owner.name && <span className="text-fg-muted">{row.owner.name} </span>}
                <span className="font-mono">{row.owner.email}</span>
              </>
            ) : null}
            {row.owner.teamKey && <span>{row.owner.email ? ' · ' : ''}team “{row.owner.teamKey}”</span>}
          </div>
        )}
      </div>
      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Target {row.ldEnv ? `(${row.ldEnv})` : ''}</div>
        {r.skipped ? (
          <Callout tone="amber">Not migrated: {r.skipped}.</Callout>
        ) : row.kind === 'flag' ? (
          <LdTargeting env={row.result.env} variations={row.result.shell.variations} />
        ) : row.kind === 'segment' ? (
          <TargetSegment result={row.result} />
        ) : row.kind === 'experiment' ? (
          <TargetExperiment desired={row.result.desired} />
        ) : (
          <TargetSummary result={row.result} />
        )}
        {r.fidelity.notes.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs">
            {r.fidelity.notes.map((n, i) => (
              <li key={i} className="flex gap-1.5">
                <Badge tone={FIDELITY_TONE[n.fidelity]}>{n.fidelity}</Badge>
                <span>
                  {n.message}
                  {n.location && <span className="text-fg-subtle"> · {n.location}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {r.unresolved.length > 0 && (
        <div className="md:col-span-2">
          <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Decisions</div>
          <div className="grid gap-2 md:grid-cols-2">
            {r.unresolved.map((d) => (
              <DecisionCard key={d.id} decision={d} compact onChoose={(optionKey) => (readOnly ? undefined : void m.resolve([d], optionKey))} onPolicy={(optionKey) => (readOnly ? undefined : void m.setPolicy(d.type as DecisionType, optionKey))} />
            ))}
          </div>
        </div>
      )}
      {r.applied.length > 0 && (
        <div className="text-xs text-fg-muted md:col-span-2">
          Decided: {r.applied.map((a) => `${a.decision.type} → ${optionLabel(a.decision, a.optionKey)}${a.via === 'policy' ? ' (policy)' : ''}`).join('; ')}
          {!readOnly && (
            <Button variant="ghost" className="ml-2 py-0.5 text-xs" onClick={() => void m.clear(r.applied.filter((a) => a.via === 'resource').map((a) => a.decision.id))}>
              Reconsider
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The source's declared attribute schema (PLAN §21.4 / §22.4: PostHog property definitions, typed
 * per context kind), collapsed by default: it says what the clauses compare against.
 */
function AttributesPanel({ attributes, showAlias }: { attributes: (NeutralAttribute & { alias: string })[]; showAlias: boolean }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...attributes].sort((a, b) => a.contextKind.localeCompare(b.contextKind) || a.name.localeCompare(b.name)), [attributes]);
  return (
    <div className="mb-3 rounded-md border border-line bg-surface text-sm" data-testid="source-attributes">
      <button type="button" aria-expanded={open} onClick={() => setOpen((x) => !x)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-surface-hover">
        <span className="font-medium">Attributes</span>
        <Badge>{attributes.length}</Badge>
        <span className="text-xs text-fg-muted">the properties the source declares, by context kind</span>
        <span className="ml-auto text-xs text-fg-subtle">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="max-h-64 overflow-auto border-t border-line-soft px-3 py-2">
          <table className="w-full text-xs">
            <thead className="text-left text-fg-muted">
              <tr>
                <th className="py-1 pr-3 font-semibold">Name</th>
                <th className="py-1 pr-3 font-semibold">Context kind</th>
                <th className="py-1 pr-3 font-semibold">Type</th>
                {showAlias && <th className="py-1 font-semibold">Source</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {sorted.map((a, i) => (
                <tr key={`${a.alias}:${a.contextKind}:${a.name}:${i}`}>
                  <td className="py-1 pr-3 font-mono">
                    {a.name}
                    {a.identifier && <Badge tone="slate">identifier</Badge>}
                  </td>
                  <td className="py-1 pr-3">{a.contextKind}</td>
                  <td className="py-1 pr-3 text-fg-muted">{a.type ?? 'unknown'}</td>
                  {showAlias && <td className="py-1 text-fg-muted">{a.alias}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SourceFlag({ flag, env }: { flag: NeutralFlag; env: string }) {
  const c = flag.environments.find((e) => e.env === env);
  const v = (i: number | undefined) => {
    const x = flag.variations[i ?? 0];
    return x ? (x.name ?? JSON.stringify(x.value)) : '?';
  };
  if (!c) return <p className="text-xs text-fg-muted">No configuration in environment “{env}”.</p>;
  return (
    <div className="space-y-1.5 text-xs">
      <div>
        <Badge tone={c.on ? 'green' : 'slate'}>{c.on ? 'on' : 'off'}</Badge> <span className="text-fg-subtle">off serves</span> <b>{v(c.offVariation)}</b>
        {c.prerequisites.length > 0 && (
          <span className="ml-2 text-fg-subtle">
            prerequisites: {c.prerequisites.map((p) => `${p.key} = ${p.variation}`).join(', ')}
          </span>
        )}
      </div>
      {c.targets.map((t, i) => (
        <div key={i}>
          <span className="text-fg-subtle">{t.contextKind} targets</span> {t.values.length.toLocaleString()} → <b>{v(t.variation)}</b>
        </div>
      ))}
      {c.rules.map((r, i) => (
        <div key={i} className={cx(r.disabled && 'opacity-60')}>
          <span className="font-medium">{r.description || `rule ${i + 1}`}</span>
          {r.disabled && <Badge tone="slate">disabled</Badge>}: {r.clauses.map((cl) => `${cl.contextKind}.${cl.attribute} ${cl.negate ? 'not ' : ''}${cl.op} ${JSON.stringify(cl.values)}`).join(' AND ')} →{' '}
          <b>{r.rollout ? r.rollout.variations.map((w) => `${w.weight / 1000}% ${v(w.variation)}`).join(' / ') : v(r.variation)}</b>
        </div>
      ))}
      <div>
        <span className="text-fg-subtle">default</span> → <b>{c.fallthrough.rollout ? c.fallthrough.rollout.variations.map((w) => `${w.weight / 1000}% ${v(w.variation)}`).join(' / ') : v(c.fallthrough.variation)}</b>
        {c.fallthrough.rollout?.bucketBy && <span className="text-fg-subtle"> by {c.fallthrough.rollout.contextKind}.{c.fallthrough.rollout.bucketBy}</span>}
      </div>
      {flag.tags.length > 0 && <div className="text-fg-subtle">tags: {flag.tags.join(', ')}</div>}
      {Object.keys(flag.customProperties).length > 0 && <div className="text-fg-subtle">custom properties: {Object.values(flag.customProperties).map((p) => `${p.name} = ${p.value.join(', ')}`).join('; ')}</div>}
    </div>
  );
}

function SourceSegment({ segment, env }: { segment: NeutralSegment; env: string }) {
  const c = segment.environments.find((e) => e.env === env);
  if (!c) return <p className="text-xs text-fg-muted">Not present in environment “{env}”. Exists in: {segment.environments.map((e) => e.env).join(', ') || 'none'}.</p>;
  return (
    <div className="space-y-1.5 text-xs">
      {c.unbounded && <Badge tone="violet">big segment on {c.unbounded.contextKind} (membership not readable)</Badge>}
      {c.included.map((i) => (
        <div key={`i-${i.contextKind}`}>
          <span className="text-fg-subtle">included {i.contextKind}</span> {i.values.length.toLocaleString()}
        </div>
      ))}
      {c.excluded.map((i) => (
        <div key={`e-${i.contextKind}`}>
          <span className="text-fg-subtle">excluded {i.contextKind}</span> {i.values.length.toLocaleString()}
        </div>
      ))}
      {c.rules.map((r, i) => (
        <div key={i}>
          <span className="font-medium">{r.description || `rule ${i + 1}`}</span>: {r.clauses.map((cl) => `${cl.contextKind}.${cl.attribute} ${cl.negate ? 'not ' : ''}${cl.op} ${JSON.stringify(cl.values)}`).join(' AND ')}
          {r.weight !== undefined && <b> ({r.weight / 1000}% by {r.rolloutContextKind ?? 'user'}{r.bucketBy ? `.${r.bucketBy}` : ''})</b>}
        </div>
      ))}
      {segment.tags.length > 0 && <div className="text-fg-subtle">tags: {segment.tags.join(', ')}</div>}
    </div>
  );
}

function TargetSegment({ result }: { result: NeutralSegmentMapResult }) {
  const d = result.desired;
  if (!d) return null;
  return (
    <div className="space-y-1.5 text-xs">
      {d.unbounded && <Badge tone="violet">big segment on {d.unbounded.contextKind}{d.unbounded.manual ? ', created empty' : ''}</Badge>}
      {d.included.length > 0 && (
        <div>
          <span className="text-fg-subtle">included user</span> {d.included.length.toLocaleString()}
        </div>
      )}
      {d.includedContexts.map((c) => (
        <div key={`i-${c.contextKind}`}>
          <span className="text-fg-subtle">included {c.contextKind}</span> {c.values.length.toLocaleString()}
        </div>
      ))}
      {(d.excluded?.length ?? 0) > 0 && (
        <div>
          <span className="text-fg-subtle">excluded user</span> {d.excluded!.length.toLocaleString()}
        </div>
      )}
      {(d.excludedContexts ?? []).map((c) => (
        <div key={`e-${c.contextKind}`}>
          <span className="text-fg-subtle">excluded {c.contextKind}</span> {c.values.length.toLocaleString()}
        </div>
      ))}
      {d.rules.map((r, i) => (
        <div key={i}>
          <span className="font-medium">{r.description || `rule ${i + 1}`}</span>: {r.clauses.map((cl) => `${cl.contextKind}.${cl.attribute} ${cl.negate ? 'not ' : ''}${cl.op} ${JSON.stringify(cl.values)}`).join(' AND ')}
          {r.weight !== undefined && <b> ({r.weight / 1000}% by {r.rolloutContextKind}{r.bucketBy ? `.${r.bucketBy}` : ''})</b>}
        </div>
      ))}
      <div className="text-fg-subtle">tags: {d.tags.join(', ')}</div>
    </div>
  );
}

function ExperimentStateBadge({ x, env }: { x: NeutralExperiment; env: string }) {
  const e = x.environments.find((v) => v.env === env);
  if (!e) return <Badge tone="slate">not in {env}</Badge>;
  const it = neutralDesignIteration(e);
  const status = it?.status ?? 'no iteration';
  return (
    <>
      {e.experimentType === 'mab' && <Badge tone="violet">bandit</Badge>}
      <Badge tone={status === 'running' ? 'green' : status === 'stopped' ? 'amber' : 'slate'}>{status.replace('_', ' ')}</Badge>
    </>
  );
}

function Iteration({ it, flagName }: { it: NeutralIteration; flagName: (flagKey: string, i: number | undefined) => string }) {
  return (
    <div className="space-y-1">
      <div>
        <span className="text-fg-subtle">hypothesis</span> {it.hypothesis || '—'}
      </div>
      <div>
        <span className="text-fg-subtle">randomizes by</span> <b>{it.randomizationUnit}</b>
        {it.attributes?.length ? <span className="text-fg-subtle"> · attributes {it.attributes.join(', ')}</span> : null}
        {it.reallocationFrequencyMillis ? <span className="text-fg-subtle"> · reallocates every {Math.round(it.reallocationFrequencyMillis / 60_000)} min</span> : null}
      </div>
      {it.flags.map((f) => (
        <div key={f.flagKey}>
          <span className="text-fg-subtle">on flag</span> <span className="font-mono">{f.flagKey}</span> <span className="text-fg-subtle">{f.ruleId === 'fallthrough' ? 'default rule' : `rule “${f.ruleDescription ?? f.ruleId}”`}</span>
          {f.notInExperimentVariation !== undefined && <span className="text-fg-subtle"> · outside the experiment: {flagName(f.flagKey, f.notInExperimentVariation)}</span>}
        </div>
      ))}
      {it.treatments.map((t) => (
        <div key={t.name}>
          <span className="font-medium">{t.name}</span> {t.allocationPercent}%{t.baseline && <Badge tone="slate">baseline</Badge>} → <b>{t.parameters.map((p) => flagName(p.flagKey, p.variation)).join(', ') || '—'}</b>
        </div>
      ))}
      <div>
        <span className="text-fg-subtle">metrics</span> {it.metrics.map((m) => `${m.key}${m.isGroup ? ' (group)' : ''}${it.primary?.key === m.key ? ' ★' : ''}`).join(', ') || '—'}
      </div>
      {(it.startedAt || it.endedAt) && (
        <div className="text-fg-subtle">
          {it.startedAt ? `started ${new Date(it.startedAt).toISOString().slice(0, 10)}` : ''}
          {it.endedAt ? ` · ended ${new Date(it.endedAt).toISOString().slice(0, 10)}` : ''}
          {it.winningTreatment?.name ? ` · winner “${it.winningTreatment.name}”` : ''}
          {it.winningReason ? ` (${it.winningReason})` : ''}
        </div>
      )}
    </div>
  );
}

function SourceExperiment({ experiment, env }: { experiment: NeutralExperiment; env: string }) {
  const e = experiment.environments.find((v) => v.env === env);
  if (!e) return <p className="text-xs text-fg-muted">Not present in environment “{env}”. Exists in: {experiment.environments.map((v) => v.env).join(', ') || 'none'}.</p>;
  const it = neutralDesignIteration(e);
  const flagName = (_flagKey: string, i: number | undefined) => (i === undefined ? '?' : `variation ${i}`);
  return (
    <div className="space-y-1.5 text-xs">
      <div>
        <Badge tone="slate">{e.experimentType}</Badge> {e.methodology && <span className="text-fg-subtle">{e.methodology}</span>}
        {e.holdout && <span className="text-fg-subtle"> · holdout {e.holdout.key ?? e.holdout.id}</span>}
        {e.layer && <span className="text-fg-subtle"> · layer {e.layer.key} ({e.layer.reservationPercent}%)</span>}
        {e.dataSource && <span className="text-fg-subtle"> · data source {e.dataSource}</span>}
      </div>
      {e.description && <div className="text-fg-muted">{e.description}</div>}
      {it ? <Iteration it={it} flagName={flagName} /> : <div className="text-fg-muted">No iteration.</div>}
      {e.previousIterations.length > 0 && <div className="text-fg-subtle">{e.previousIterations.length} earlier iteration{e.previousIterations.length === 1 ? '' : 's'} (stay in the source)</div>}
      {e.analysisConfig && <div className="text-fg-subtle">analysis: {Object.entries(e.analysisConfig).map(([k, v]) => `${k} ${String(v)}`).join(', ')}</div>}
      {e.tags.length > 0 && <div className="text-fg-subtle">tags: {e.tags.join(', ')}</div>}
    </div>
  );
}

function TargetExperiment({ desired }: { desired: DesiredExperiment | null }) {
  if (!desired) return null;
  return (
    <div className="space-y-1.5 text-xs">
      <div>
        <Badge tone="slate">draft, not started</Badge> <Badge tone="slate">{desired.type}</Badge>
        {desired.holdoutKey && <span className="text-fg-subtle"> · holdout {desired.holdoutKey}</span>}
        {desired.layer && <span className="text-fg-subtle"> · layer {desired.layer.key} ({desired.layer.reservationPercent}%)</span>}
      </div>
      <div>
        <span className="text-fg-subtle">hypothesis</span> {desired.hypothesis}
      </div>
      <div>
        <span className="text-fg-subtle">randomizes by</span> <b>{desired.randomizationUnit}</b>
      </div>
      {desired.flags.map((f) => (
        <div key={f.flagKey}>
          <span className="text-fg-subtle">on flag</span> <span className="font-mono">{f.flagKey}</span> <span className="text-fg-subtle">{f.rule.kind === 'fallthrough' ? 'default rule' : `rule “${f.rule.description || `#${f.rule.index + 1}`}”`}</span>
        </div>
      ))}
      {desired.treatments.map((t) => (
        <div key={t.name}>
          <span className="font-medium">{t.name}</span> {t.allocationPercent}%{t.baseline && <Badge tone="slate">baseline</Badge>} → <b>{t.parameters.map((p) => `variation ${p.variation}`).join(', ')}</b>
        </div>
      ))}
      <div>
        <span className="text-fg-subtle">metrics</span> {desired.metrics.map((m) => `${m.key}${m.isGroup ? ' (group)' : ''}${desired.primary.key === m.key ? ' ★' : ''}`).join(', ')}
      </div>
      <div className="text-fg-subtle">tags: {desired.tags.join(', ')}</div>
    </div>
  );
}

function SourceMetric({ metric: mt }: { metric: NeutralMetric }) {
  const facts: [string, string | undefined][] = [
    ['kind', `${mt.metricKind}${mt.isNumeric ? ' (numeric)' : ''}`],
    ['event', mt.eventKey],
    ['selector', mt.selector],
    ['URLs', mt.urls?.length ? `${mt.urls.length}` : undefined],
    ['success', mt.successCriteria],
    ['unit', mt.unit],
    ['analysis units', mt.analysisUnits.join(', ')],
    ['aggregation', mt.unitAggregationType],
    ['analysis', mt.analysisType ? `${mt.analysisType}${mt.percentileValue != null ? ` p${mt.percentileValue}` : ''}` : undefined],
    ['filter', mt.filters ? `${mt.filters.attribute ?? mt.filters.type} ${mt.filters.negate ? 'not ' : ''}${mt.filters.op} ${JSON.stringify(mt.filters.values)}` : undefined],
    ['data source', mt.dataSource ? `${mt.dataSource.name ?? mt.dataSource.key}${mt.dataSource.environmentKey ? ` (${mt.dataSource.environmentKey})` : ''}` : undefined],
    ['denominator', mt.denominator ? JSON.stringify(mt.denominator) : undefined],
    ['winsorize', mt.winsorLowerPercentile != null || mt.winsorUpperPercentile != null ? `${mt.winsorLowerPercentile ?? 0}–${mt.winsorUpperPercentile ?? 100}` : undefined],
  ];
  return (
    <div className="space-y-1 text-xs">
      {mt.description && <div className="text-fg-muted">{mt.description}</div>}
      {facts.filter(([, v]) => v).map(([k, v]) => (
        <div key={k}>
          <span className="text-fg-subtle">{k}</span> {v}
        </div>
      ))}
      {mt.tags.length > 0 && <div className="text-fg-subtle">tags: {mt.tags.join(', ')}</div>}
    </div>
  );
}

function SourceMetricGroup({ group }: { group: NeutralMetricGroup }) {
  return (
    <div className="space-y-1 text-xs">
      {group.description && <div className="text-fg-muted">{group.description}</div>}
      <div>
        <span className="text-fg-subtle">{group.groupKind}</span>
      </div>
      <ol className="list-decimal pl-4">
        {group.metrics.map((m) => (
          <li key={m.key}>
            <span className="font-mono">{m.key}</span> <span className="text-fg-subtle">as “{m.nameInGroup}”</span>
          </li>
        ))}
      </ol>
      {group.tags.length > 0 && <div className="text-fg-subtle">tags: {group.tags.join(', ')}</div>}
    </div>
  );
}

function SourceHoldout({ holdout, env }: { holdout: NeutralHoldout; env: string }) {
  const h = holdout.environments.find((v) => v.env === env);
  if (!h) return <p className="text-xs text-fg-muted">Not present in environment “{env}”. Exists in: {holdout.environments.map((v) => v.env).join(', ') || 'none'}.</p>;
  return (
    <div className="space-y-1 text-xs">
      {h.description && <div className="text-fg-muted">{h.description}</div>}
      <div>
        <Badge tone="amber">{h.status}</Badge> <b>{h.holdoutAmount}%</b> <span className="text-fg-subtle">of {h.randomizationUnit} contexts held out</span>
      </div>
      <div>
        <span className="text-fg-subtle">metrics</span> {h.metrics.map((m) => `${m.key}${m.isGroup ? ' (group)' : ''}${h.primaryMetricKey === m.key ? ' ★' : ''}`).join(', ') || '—'}
      </div>
      {h.prerequisiteFlagKey && (
        <div>
          <span className="text-fg-subtle">prerequisite flag</span> <span className="font-mono">{h.prerequisiteFlagKey}</span>
        </div>
      )}
      <div>
        <span className="text-fg-subtle">experiments</span> {h.experiments.join(', ') || 'none'}
      </div>
    </div>
  );
}

function SourceLayer({ layer }: { layer: NeutralLayer }) {
  return (
    <div className="space-y-1 text-xs">
      {layer.description && <div className="text-fg-muted">{layer.description}</div>}
      {layer.randomizationUnit && (
        <div>
          <span className="text-fg-subtle">randomizes by</span> <b>{layer.randomizationUnit}</b>
        </div>
      )}
      {layer.environments.map((e) => (
        <div key={e.env}>
          <span className="text-fg-subtle">{e.env}</span> {e.reservations.length ? e.reservations.map((r) => `${r.experimentKey} ${r.reservationPercent}%`).join(', ') : 'no reservations'}
        </div>
      ))}
    </div>
  );
}

/** The target side of a metric, metric group, holdout or layer: the fields the console writes, as a list. */
function TargetSummary({ result }: { result: NeutralMetricMapResult | NeutralMetricGroupMapResult | NeutralHoldoutMapResult | NeutralLayerMapResult }) {
  const d = result.desired as Record<string, unknown> | null;
  if (!d) return null;
  const skip = new Set(['key', 'ldEnv', 'statsigEnv']);
  return (
    <div className="space-y-0.5 text-xs">
      {Object.entries(d)
        .filter(([k, v]) => !skip.has(k) && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => (
          <div key={k}>
            <span className="text-fg-subtle">{k}</span> {typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : JSON.stringify(v)}
          </div>
        ))}
    </div>
  );
}

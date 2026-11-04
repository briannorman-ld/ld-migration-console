import { indexByKey } from '../lib/indexByKey.ts';
import { Fragment, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { CanonicalSnapshot, NeutralFlag, NeutralSegment } from '@sslm/canonical';
import { optionLabel, type DecisionType, type NeutralFlagMapResult, type NeutralSegmentMapResult } from '@sslm/mapper';
import { migrationStatus, ownsSegment, type MigrationStatus } from '@sslm/planner';
import type { SourceRecord } from '@sslm/store';
import { DecisionCard, FIDELITY_TONE } from '../components/DecisionCard.tsx';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { MigrateButton, ReadinessLine, readinessSteps } from '../components/Readiness.tsx';
import { LdTargeting } from '../components/Targeting.tsx';
import { Badge, Button, Callout, Card, cx, Input, Select } from '../components/ui.tsx';
import { TagFilter } from '../components/TagFilter.tsx';
import { MappingExplainer } from '../components/MappingExplainer.tsx';
import { matchesTags, pruneTags, tagOptions } from '../lib/tags.ts';
import { ldFlagState, mapNeutralFlagFor, mapNeutralSegmentFor } from '../lib/migration.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import type { ExplorerNav } from './AutotunesSideBySide.tsx';
import { STATUS } from './GatesSideBySide.tsx';

export type LdSourceResource = 'flag' | 'segment';
type Filter = 'all' | 'open' | 'blocking' | 'not_migrated' | 'in_sync' | 'changed';

interface FlagRow {
  kind: 'flag';
  sourceId: string;
  alias: string;
  entity: NeutralFlag;
  result: NeutralFlagMapResult;
  ldEnv: string | null;
  strip: { ldEnv: string; status: MigrationStatus }[];
}
interface SegmentRow {
  kind: 'segment';
  sourceId: string;
  alias: string;
  entity: NeutralSegment;
  result: NeutralSegmentMapResult;
  ldEnv: string | null;
  strip: { ldEnv: string; status: MigrationStatus }[];
}
type Row = FlagRow | SegmentRow;

const WORDS: Record<LdSourceResource, { title: string; one: string; many: string }> = {
  flag: { title: 'Flags (LaunchDarkly source)', one: 'flag', many: 'flags' },
  segment: { title: 'Segments (LaunchDarkly source)', one: 'segment', many: 'segments' },
};

/**
 * Side-by-side explorer for an LD project attached as a source (PLAN §20): the source flag or
 * segment on the left, what the console would write into the target on the right, the per
 * environment status strip from target provenance, open decisions inline, and Migrate.
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
  onMigrate: (selection: { flags: string[]; segments: string[] }, ldEnvs: string[]) => void;
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
  const ldSources = useMemo(() => sources.filter((s) => s.kind === 'launchdarkly' && snapshots[s.id]?.neutral), [sources, snapshots]);
  const ldFlags = useMemo(() => new Map((m.ld.flags?.items ?? []).map((f) => [f.key, f])), [m.ld.flags]);
  const ldEnvOf = (sourceId: string, sourceEnv: string) => (m.connected ? (m.profile.sources[sourceId]?.envMapping[sourceEnv] ?? null) : null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const s of ldSources) {
      const snap = snapshots[s.id]!;
      const ldEnv = ldEnvOf(s.id, env);
      const envPairs = m.connected
        ? m.ldEnvs.map((le) => ({ le: le.key, se: Object.entries(m.profile.sources[s.id]?.envMapping ?? {}).find(([, v]) => v === le.key)?.[0] }))
        : [];
      if (resource === 'flag') {
        for (const f of snap.neutral!.flags) {
          const result = mapNeutralFlagFor(snap, f, { statsig: env, ld: ldEnv ?? env }, m);
          const strip = envPairs.map(({ le, se }) => {
            if (!se) return { ldEnv: le, status: 'not_in_ld' as MigrationStatus };
            const r = se === env ? result : mapNeutralFlagFor(snap, f, { statsig: se, ld: le }, m);
            const lf = ldFlags.get(r.flagKey);
            return { ldEnv: le, status: migrationStatus(lf && ldFlagState(lf), le, r, { id: f.key, source: snap.source.alias }).status };
          });
          out.push({ kind: 'flag', sourceId: s.id, alias: s.alias, entity: f, result, ldEnv, strip });
        }
      } else {
        for (const g of snap.neutral!.segments) {
          const result = mapNeutralSegmentFor(snap, g, { statsig: env, ld: ldEnv ?? env }, m);
          // Segments carry no sync record: the strip says whether the target has one of ours in each environment.
          const strip = envPairs.map(({ le, se }) => {
            const list = m.ld.segments?.[le];
            const existing = list ? indexByKey(list).get(g.key) : undefined;
            const status: MigrationStatus = !se ? 'not_in_ld' : !existing ? 'not_in_ld' : ownsSegment({ key: existing.key, tags: existing.tags ?? [] }, snap.source.alias) ? 'in_sync' : 'foreign';
            return { ldEnv: le, status };
          });
          out.push({ kind: 'segment', sourceId: s.id, alias: s.alias, entity: g, result, ldEnv, strip });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the rows read of `m` (see GatesSideBySide)
  }, [ldSources, snapshots, env, m.inputs, m.connected, m.ldEnvs, m.ld.segments, ldFlags, resource]);

  const tagChoices = useMemo(() => tagOptions(rows.map((r) => r.entity)), [rows]);
  const chosenTags = useMemo(() => pruneTags(tags, tagChoices), [tags, tagChoices]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!showArchived && r.entity.archived) return false;
        if (q && !r.entity.key.toLowerCase().includes(q.toLowerCase()) && !r.entity.name.toLowerCase().includes(q.toLowerCase())) return false;
        if (!matchesTags(r.entity.tags, chosenTags)) return false;
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
  const mappedHere = [...new Set(ldSources.map((s) => ldEnvOf(s.id, env)).filter((x): x is string => !!x))];
  const steps = readinessSteps({ m, env, mappedHere, hasSnapshot: ldSources.length > 0, kindLabel: words.many, selected: selectedRows.length, blockingSelected: blockingIn(selectedRows), blockingAll: blockingIn(visible), nav });
  const toggle = (uid: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  const migrate = () => {
    const uids = selectedRows.map((r) => r.entity.uid);
    onMigrate(resource === 'flag' ? { flags: uids, segments: [] } : { flags: [], segments: uids }, mappedHere);
  };
  // Only this explorer's items: other kinds stay selected across views.
  const selectAll = () =>
    setSelected((x) => {
      const n = new Set(x);
      for (const r of selectable) if (allSelected) n.delete(r.entity.uid); else n.add(r.entity.uid);
      return n;
    });

  if (ldSources.length === 0) return <Callout tone="blue">No LaunchDarkly source is attached. Add one under Connections to compare a source LaunchDarkly project with the target.</Callout>;

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
      <MappingExplainer resource={resource === 'flag' ? 'ld_flag' : 'ld_segment'} onOpenCoverage={nav?.coverage} className="mb-3" />
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
                        {ldSources.length > 1 && <Badge>{r.alias}</Badge>}
                        {r.kind === 'flag' && <Badge tone="slate">{r.entity.flagKind}</Badge>}
                        {r.kind === 'segment' && r.entity.environments.some((e) => e.unbounded) && <Badge tone="violet">big segment</Badge>}
                        {r.entity.archived && <Badge>archived</Badge>}
                        {r.kind === 'flag' && r.entity.deprecated && <Badge tone="amber">deprecated</Badge>}
                      </div>
                      <div className="truncate text-xs text-fg-muted">{r.entity.name !== r.entity.key ? r.entity.name : r.entity.description}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-[13px]">{r.result.skipped ? <span className="text-fg-subtle">—</span> : r.kind === 'flag' ? r.result.flagKey : r.result.segmentKey}</td>
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
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Source (LaunchDarkly {row.alias})</div>
        {row.kind === 'flag' ? <SourceFlag flag={row.entity} env={sourceEnv} /> : <SourceSegment segment={row.entity} env={sourceEnv} />}
      </div>
      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Target {row.ldEnv ? `(${row.ldEnv})` : ''}</div>
        {r.skipped ? (
          <Callout tone="amber">Not migrated: {r.skipped}.</Callout>
        ) : row.kind === 'flag' ? (
          <LdTargeting env={row.result.env} variations={row.result.shell.variations} />
        ) : (
          <TargetSegment result={row.result} />
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

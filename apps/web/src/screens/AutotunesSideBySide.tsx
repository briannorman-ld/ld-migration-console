import { Fragment, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { matchAcrossSources, type Autotune, type CanonicalSnapshot } from '@sslm/canonical';
import { LD_INSTANCES } from '@sslm/ld-client';
import type { AutotuneMapResult, AutotuneState, DecisionType } from '@sslm/mapper';
import { migrationStatus, type MigrationStatus } from '@sslm/planner';
import type { SourceRecord } from '@sslm/store';
import { DecisionCard, FIDELITY_TONE, TYPE_LABEL } from '../components/DecisionCard.tsx';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { MigrateButton, ReadinessLine, readinessSteps } from '../components/Readiness.tsx';
import { LdTargeting } from '../components/Targeting.tsx';
import { Badge, Button, Callout, Card, cx, Input, Select } from '../components/ui.tsx';
import { summarizeDecisions } from '../lib/decisionSummary.ts';
import { ldFlagState, mapAutotuneFor, type DecisionInstance } from '../lib/migration.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { STATUS } from './GatesSideBySide.tsx';

const STATE: Record<AutotuneState, { label: string; tone: 'green' | 'amber' | 'slate' | 'blue' }> = {
  not_started: { label: 'not started', tone: 'slate' },
  running: { label: 'running', tone: 'blue' },
  concluded: { label: 'winner picked', tone: 'green' },
};

type Filter = 'all' | 'open' | 'blocking' | 'not_migrated' | 'in_sync' | 'changed';

interface Row {
  sourceId: string;
  autotune: Autotune;
  shared: number;
  ldEnv: string | null;
  result: AutotuneMapResult;
  strip: { ldEnv: string; status: MigrationStatus }[];
}

export interface ExplorerNav {
  connections: () => void;
  ld: () => void;
  mapping: () => void;
  unitTypes: () => void;
  decisions: () => void;
}

/**
 * Side-by-side autotunes (PLAN §11 "Autotune"): StatSig arms and success event on the left; the
 * LD JSON flag, success metric and drafted multi-armed bandit on the right, with the same status
 * strip, fidelity, decisions and Migrate action as gates.
 */
export function AutotunesSideBySide({
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
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  env: string;
  m: MigrationContext;
  onMigrate: (autotuneUids: string[], ldEnvs: string[]) => void;
  nav: ExplorerNav;
  readOnly?: boolean;
  /** The workspace-wide selection (lib/selection.ts): ticks here add to it, so a pick survives switching views. */
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<string>();
  const [targetEnvs, setTargetEnvs] = useState<string[] | null>(null);
  const { ld } = m;
  const snaps = useMemo(() => sources.map((s) => snapshots[s.id]!).filter(Boolean), [sources, snapshots]);
  const matched = useMemo(() => matchAcrossSources(snaps, 'autotune'), [snaps]);
  const aliasOf = (sourceId: string) => sources.find((s) => s.id === sourceId)?.alias ?? sourceId;
  const ldFlags = useMemo(() => new Map((ld.flags?.items ?? []).map((f) => [f.key, f])), [ld.flags]);
  const ldEnvOf = (sourceId: string, statsigEnv: string) => (m.connected ? (m.profile.sources[sourceId]?.envMapping[statsigEnv] ?? null) : null);

  const rows: Row[] = useMemo(
    () =>
      matched.flatMap((mr) =>
        Object.entries(mr.bySource).map(([sourceId, e]) => {
          const autotune = e as Autotune;
          const snap = snapshots[sourceId]!;
          const ldEnv = ldEnvOf(sourceId, env);
          const result = mapAutotuneFor(snap, autotune, { statsig: env, ld: ldEnv ?? env }, m);
          const strip = m.connected
            ? m.ldEnvs.map((le) => {
                const se = Object.entries(m.profile.sources[sourceId]?.envMapping ?? {}).find(([, v]) => v === le.key)?.[0];
                if (!se) return { ldEnv: le.key, status: 'not_in_ld' as MigrationStatus };
                const r = se === env ? result : mapAutotuneFor(snap, autotune, { statsig: se, ld: le.key }, m);
                const f = ldFlags.get(r.flagKey);
                return { ldEnv: le.key, status: migrationStatus(f && ldFlagState(f), le.key, r, { id: autotune.id, source: snap.source.alias }).status };
              })
            : [];
          return { sourceId, autotune, shared: Object.keys(mr.bySource).length, ldEnv, result, strip };
        }),
      ),
    [matched, snapshots, env, m, ldFlags],
  );

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (q && !r.autotune.id.toLowerCase().includes(q.toLowerCase())) return false;
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
    [rows, q, filter],
  );
  const pager = usePager(visible);
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.autotune.uid)), [rows, selected]);
  const bulk = useMemo(() => {
    const instances: DecisionInstance[] = selectedRows.flatMap((r) => r.result.unresolved.map((d) => ({ decision: d, entityId: r.autotune.id, envs: [] as string[] })));
    return { rows: summarizeDecisions(instances, {}), instances };
  }, [selectedRows]);
  const decideSelected = (type: DecisionType, optionKey: string) => void m.resolve(bulk.instances.filter((x) => x.decision.type === type).map((x) => x.decision), optionKey);
  const selectable = visible.filter((r) => !r.autotune.archived);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.autotune.uid));
  const mappedHere = [...new Set(sources.map((s) => ldEnvOf(s.id, env)).filter((x): x is string => !!x))];
  const envChoice = targetEnvs ?? mappedHere;
  const blocking = (rs: Row[]) => rs.reduce((n, r) => n + r.result.unresolved.filter((d) => d.severity === 'blocking').length, 0);
  const steps = readinessSteps({ m, env, mappedHere, hasSnapshot: snaps.length > 0, kindLabel: 'autotunes', selected: selectedRows.length, blockingSelected: blocking(selectedRows), blockingAll: blocking(visible), nav });
  const migrate = () => onMigrate(selectedRows.map((r) => r.autotune.uid), envChoice);
  // Only this explorer's items: other kinds stay selected across views.
  const selectAll = () =>
    setSelected((x) => {
      const n = new Set(x);
      for (const r of selectable) if (allSelected) n.delete(r.autotune.uid); else n.add(r.autotune.uid);
      return n;
    });
  const clearOwn = () => {
    const own = new Set(rows.map((r) => r.autotune.uid));
    setSelected((x) => new Set([...x].filter((uid) => !own.has(uid))));
  };
  const toggle = (uid: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });

  return (
    <div className="pb-20">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">Autotunes</h2>
        <Badge>{visible.length}</Badge>
        <span className="text-sm text-fg-muted">
          StatSig <b>{env}</b>
          {mappedHere.length > 0 && (
            <>
              {' '}
              → LaunchDarkly <b>{mappedHere.join(', ')}</b>
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
          <Input placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" aria-label="Filter autotunes" />
          {!readOnly && <MigrateButton steps={steps} onClick={migrate} label={selectedRows.length ? `Migrate ${selectedRows.length} autotune${selectedRows.length === 1 ? '' : 's'}…` : 'Migrate…'} />}
        </div>
      </div>
      {!readOnly && <ReadinessLine steps={steps} />}
      <Callout tone="blue">
        An autotune becomes a JSON flag (one variation per arm), a custom metric for its success event and a LaunchDarkly <b>multi-armed bandit</b> created as a draft (PLAN §11). Nothing is moved mid-flight: a
        running autotune waits for its winner unless you choose to pre-stage it, and a concluded one becomes a flag serving the winner.
      </Callout>
      <PagerBar pager={pager} label="autotunes" className="my-2" />
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-surface-2 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
            <tr>
              <th className="w-9 px-3 py-2">
                {!readOnly && (
                  <input type="checkbox" aria-label="Select all" title={`Select all ${selectable.length.toLocaleString()} matching autotunes`} checked={allSelected} onChange={selectAll} />
                )}
              </th>
              <th className="w-[36%] px-3 py-2">StatSig</th>
              <th className="w-[14%] px-3 py-2">Arms</th>
              <th className="w-[16%] px-3 py-2">Mapping</th>
              <th className="px-3 py-2">LaunchDarkly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {pager.slice.map((row) => {
              const { sourceId, autotune: a, shared, result: r } = row;
              const key = `${sourceId}/${a.id}`;
              const flag = ldFlags.get(r.flagKey);
              const blockingCount = r.unresolved.filter((d) => d.severity === 'blocking').length;
              const here = row.strip.find((s) => s.ldEnv === row.ldEnv);
              return (
                <Fragment key={key}>
                  <tr className={cx('cursor-pointer align-top hover:bg-surface-hover', open === key && 'bg-surface-2')} onClick={() => setOpen(open === key ? undefined : key)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      {!readOnly && <input type="checkbox" aria-label={`Select ${a.id}`} disabled={a.archived} checked={selected.has(a.uid)} onChange={() => toggle(a.uid)} />}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px] font-medium">{a.id}</span>
                        {sources.length > 1 && <Badge tone="slate">{aliasOf(sourceId)}</Badge>}
                        {shared > 1 && (
                          <Badge tone="violet" title="Same name in more than one source (consolidation, M8)">
                            in {shared} sources
                          </Badge>
                        )}
                        <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
                        {a.archived && <Badge tone="slate">archived</Badge>}
                        {a.idType !== 'userID' && <Badge tone="blue">{a.idType}</Badge>}
                      </div>
                      {a.description && <div className="mt-0.5 truncate text-xs text-fg-muted">{a.description}</div>}
                      <div className="mt-0.5 text-xs text-fg-subtle">
                        {a.successEvent ? (
                          <>
                            success event <code>{a.successEvent}</code>
                          </>
                        ) : (
                          'no success event'
                        )}
                        {a.owner?.email && ` · ${a.owner.email}`}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">
                      <div>
                        {a.variants.length} variant{a.variants.length === 1 ? '' : 's'}
                      </div>
                      {a.winner && <div className="text-success">winner: {a.winner.name}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {blockingCount === 0 && <Badge tone={FIDELITY_TONE[r.fidelity.overall]}>{r.skipped ? 'not migrated' : r.fidelity.overall}</Badge>}
                        {blockingCount > 0 && <Badge tone="red">{blockingCount} blocking</Badge>}
                        {r.unresolved.length - blockingCount > 0 && <Badge tone="amber">{r.unresolved.length - blockingCount} to decide</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {ld.status !== 'connected' || !ld.flags ? (
                        <span className="text-xs text-fg-subtle">—</span>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {flag ? <span className="font-mono text-[13px]">{r.flagKey}</span> : <span className="text-xs text-fg-muted">not in LaunchDarkly</span>}
                            {r.bandit && !r.skipped && <Badge tone="violet">+ bandit draft</Badge>}
                            {here && here.status !== 'not_in_ld' && <Badge tone={STATUS[here.status].tone}>{STATUS[here.status].label}</Badge>}
                          </div>
                          <div className="flex gap-2.5 text-[11px] text-fg-muted">
                            {row.strip.map((s) => (
                              <span key={s.ldEnv} className="flex items-center gap-1" title={`${s.ldEnv}: ${STATUS[s.status].label}`}>
                                <span className={cx('h-2 w-2 rounded-full', STATUS[s.status].dot)} />
                                {s.ldEnv}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                  {open === key && (
                    <tr className="bg-surface-2">
                      <td colSpan={5} className="px-3 pb-4">
                        <Detail row={row} m={m} readOnly={readOnly} flagUrl={flag && ld.projectKey && row.ldEnv ? `${LD_INSTANCES[ld.instance ?? 'us'].origin}/${ld.projectKey}/${row.ldEnv}/features/${flag.key}` : undefined} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-xs text-fg-muted">
                  {rows.length === 0 ? 'No autotunes in the selected sources.' : 'No matches.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <PagerBar pager={pager} label="autotunes" className="mt-2" />

      {selectedRows.length > 0 && !readOnly && (
        <div className="fixed right-0 bottom-0 left-72 z-40 border-t border-line bg-surface/95 px-5 py-3 shadow-raised backdrop-blur">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="flex items-center gap-3 pt-1">
              <span className="text-sm font-medium">
                {selectedRows.length.toLocaleString()} autotune{selectedRows.length === 1 ? '' : 's'} selected
                {selected.size > selectedRows.length && <span className="font-normal text-fg-muted"> · {selected.size.toLocaleString()} in all</span>}
              </span>
              <button className="text-sm text-fg-muted hover:text-fg" onClick={clearOwn}>
                Clear
              </button>
            </div>
            {bulk.rows.length > 0 ? (
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Decide for the selected autotunes</div>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {bulk.rows.map((r) => (
                    <label key={r.type} className="flex items-center gap-2 text-sm">
                      <span>
                        {TYPE_LABEL[r.type] ?? r.type}
                        <span className="ml-1 text-xs text-fg-muted tabular-nums">
                          {r.open.toLocaleString()} in {r.openItems.toLocaleString()}
                        </span>
                      </span>
                      <Select value="" onChange={(e) => e.target.value && decideSelected(r.type, e.target.value)} aria-label={`Decide ${TYPE_LABEL[r.type] ?? r.type} for the selected autotunes`} className="max-w-xs py-1 text-xs">
                        <option value="">Choose an answer…</option>
                        {r.options.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                            {o.covers < r.open ? ` (covers ${o.covers.toLocaleString()} of ${r.open.toLocaleString()})` : ''}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <span className="pt-1 text-sm text-fg-muted">No open decisions on the selected autotunes.</span>
            )}
            {m.connected && m.ldEnvs.length > 0 ? (
              <div className="flex items-center gap-3 pt-1 text-sm">
                <span className="text-fg-muted">Migrate to LaunchDarkly:</span>
                {m.ldEnvs.map((e) => (
                  <label key={e.key} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={envChoice.includes(e.key)} onChange={() => setTargetEnvs(envChoice.includes(e.key) ? envChoice.filter((x) => x !== e.key) : [...envChoice, e.key])} />
                    {e.key}
                    {e.critical && <Badge tone="red">critical</Badge>}
                  </label>
                ))}
                <Button disabled={envChoice.length === 0} onClick={migrate}>
                  Plan migration…
                </Button>
              </div>
            ) : (
              <span className="pt-1 text-xs text-fg-subtle">Connect LaunchDarkly to migrate the selection.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ row, m, flagUrl, readOnly }: { row: Row; m: MigrationContext; flagUrl?: string; readOnly?: boolean }) {
  const { autotune: a, result: r } = row;
  const stale = new Map(r.stale.map((s) => [s.decision.id, s.previous]));
  return (
    <div className="space-y-3 pt-1">
      <div className="grid grid-cols-2 gap-3">
        <Card className="p-3">
          <div className="mb-2 text-xs font-semibold text-fg-muted">StatSig · autotune</div>
          <div className="space-y-1.5 text-xs">
            <Line label="state">
              <Badge tone={STATE[r.state].tone}>{STATE[r.state].label}</Badge>
              {a.winner && (
                <>
                  {' '}
                  winner <b>{a.winner.name}</b>
                </>
              )}
            </Line>
            <Line label="success event">{a.successEvent ? <code>{a.successEvent}</code> : <span className="text-fg-subtle">none{a.completeness.missing.includes('metrics') ? ' (not in config specs)' : ''}</span>}</Line>
            <Line label="unit">{a.idType}</Line>
            {a.variants.map((v) => (
              <Line key={v.id} label={v.name}>
                {v.size !== undefined && <span className="text-fg-subtle">{v.size}% · </span>}
                <code className="break-all">{trim(JSON.stringify(v.json))}</code>
              </Line>
            ))}
          </div>
        </Card>
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg-muted">
            <span>
              LaunchDarkly · {r.skipped ? 'not migrated' : row.ldEnv ? `proposed for ${row.ldEnv}` : m.connected ? 'proposed (environment not mapped)' : 'proposed'}
              {r.unresolved.length > 0 && !r.skipped && ' (preview with recommended answers)'}
            </span>
            {flagUrl && (
              <a href={flagUrl} target="_blank" rel="noreferrer" className="ml-auto font-normal text-link hover:underline">
                Open in LaunchDarkly ↗
              </a>
            )}
          </div>
          {r.skipped ? (
            <p className="text-xs text-fg-muted">{r.skipped}</p>
          ) : (
            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 font-semibold text-fg-muted">
                  JSON flag <code>{r.flagKey}</code>
                </div>
                <LdTargeting env={r.env} variations={r.shell.variations.map((v) => ({ value: v.name, name: v.name }))} />
              </div>
              {r.metric && (
                <div>
                  <div className="mb-1 font-semibold text-fg-muted">Metric</div>
                  <Line label={r.metric.key}>
                    custom conversion on event <code>{r.metric.eventKey}</code>, higher is better
                  </Line>
                </div>
              )}
              <div>
                <div className="mb-1 font-semibold text-fg-muted">Multi-armed bandit</div>
                {r.bandit ? (
                  <div className="space-y-1">
                    <Line label="draft">
                      <code>{r.bandit.key}</code> on the flag's default rule, by <b>{r.bandit.randomizationUnit}</b>, reallocating every {Math.round(r.bandit.reallocationFrequencyMillis / 60_000)} min
                    </Line>
                    <Line label="optimizes">
                      <code>{r.bandit.metricKey}</code>
                    </Line>
                    {r.bandit.treatments.map((t) => (
                      <Line key={t.name} label={t.baseline ? `${t.name} (baseline)` : t.name}>
                        {t.allocationPercent}% to start
                      </Line>
                    ))}
                  </div>
                ) : (
                  <p className="text-fg-muted">{r.state === 'concluded' ? 'None: the winner is served at 100%.' : 'None: see the fidelity notes.'}</p>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
      {r.fidelity.notes.length > 0 && (
        <Card className="p-3">
          <div className="mb-1.5 text-xs font-semibold text-fg-muted">Fidelity</div>
          <ul className="space-y-1 text-xs">
            {r.fidelity.notes.map((n, i) => (
              <li key={i} className="flex gap-2">
                <Badge tone={FIDELITY_TONE[n.fidelity]}>{n.fidelity}</Badge>
                <span>{n.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {(r.unresolved.length > 0 || r.applied.length > 0) && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-fg-muted">
            Decisions
            {readOnly && <span className="ml-2 font-normal">(viewing a past snapshot: answer them on the latest sync)</span>}
          </div>
          {r.unresolved.map((d) => (
            <DecisionCard key={d.id} decision={d} stale={stale.get(d.id)} compact onChoose={(o) => !readOnly && void m.resolve([d], o)} {...(readOnly ? {} : { onPolicy: (o: string) => void m.setPolicy(d.type, o) })} />
          ))}
          {r.applied.map((x) => (
            <DecisionCard key={x.decision.id} decision={x.decision} current={{ optionKey: x.optionKey, via: x.via }} compact onChoose={(o) => !readOnly && void m.resolve([x.decision], o)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 truncate text-fg-subtle" title={label}>
        {label}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function trim(s: string): string {
  return s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

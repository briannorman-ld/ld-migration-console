import { useMemo, useState } from 'react';
import {
  describeDefaults,
  EXPERIMENT_FATE_LABEL,
  LAYER_FATE_LABEL,
  layerReport,
  layerReportCsv,
  sortLayerRows,
  type CanonicalSnapshot,
  type ExperimentFate,
  type LayerFate,
  type LayerReport,
  type LayerReportExperiment,
  type LayerReportRow,
  type LayerSortKey,
} from '@sslm/canonical';
import type { SourceRecord } from '@sslm/store';
import { MappingExplainer } from '../components/MappingExplainer.tsx';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { Value } from '../components/Targeting.tsx';
import { Badge, Button, Card, cx, Input, Select, type Tone } from '../components/ui.tsx';
import { download } from '../lib/migration.ts';

/**
 * The layers and experiments report: every StatSig layer with the experiments attached to it,
 * its default parameters, each experiment's targeting, and what the migration does with each
 * (PLAN §11). Layers sort by live experiment count so the ones that matter come first; the ones
 * the migration can leave behind (implicit, or nothing left to keep exclusive) and the archived
 * items are counted apart. All verdicts come from `layerReport` in @sslm/canonical, which the
 * CSV export shares, so the file says what the screen says.
 */

type Filter = 'all' | 'skippable' | 'create' | 'running' | 'implicit';

interface Row {
  s: SourceRecord;
  row: LayerReportRow;
}

const LAYER_TONE: Record<LayerFate, Tone> = { create: 'green', skip_implicit: 'slate', skip_empty: 'slate', never: 'slate' };
const EXPERIMENT_TONE: Record<ExperimentFate, Tone> = { draft: 'blue', wait: 'amber', serve_shipped: 'green', stopped: 'violet', never: 'slate' };
const STATUS_TONE: Record<string, Tone> = { active: 'amber', setup: 'blue', decision_made: 'green', experiment_stopped: 'violet', assignment_stopped: 'violet' };

export function LayersReport({
  sources,
  snapshots,
  onOpenCoverage,
}: {
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  /** Opens the "What migrates" page at a coverage row. */
  onOpenCoverage?: (focus: string) => void;
}) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<LayerSortKey>('experiments');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState<Filter>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);

  const reports = useMemo(() => sources.flatMap((s) => (snapshots[s.id] ? [{ s, report: layerReport(snapshots[s.id]!) }] : [])), [sources, snapshots]);
  const totals = useMemo(() => {
    const t: LayerReport['totals'] = { layers: 0, archivedLayers: 0, implicitLayers: 0, skippableLayers: 0, experiments: 0, archivedExperiments: 0, runningExperiments: 0, skippableExperiments: 0 };
    for (const { report } of reports) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += report.totals[k];
    return t;
  }, [reports]);
  const layerRows = useMemo<Row[]>(() => reports.flatMap(({ s, report }) => report.rows.map((row) => ({ s, row }))), [reports]);
  const unlayered = useMemo<Row[]>(() => reports.flatMap(({ s, report }) => (report.unlayered.experiments.length ? [{ s, row: report.unlayered }] : [])), [reports]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = (r: Row) => {
      if (!needle) return true;
      const l = r.row.layer;
      if (l && (l.id.toLowerCase().includes(needle) || (l.description ?? '').toLowerCase().includes(needle))) return true;
      return r.row.experiments.some((x) => x.experiment.id.toLowerCase().includes(needle));
    };
    const passes = (r: Row) => {
      const { fate, experiments } = r.row;
      switch (filter) {
        case 'skippable':
          return fate === 'skip_implicit' || fate === 'skip_empty';
        case 'create':
          return fate === 'create';
        case 'implicit':
          return !!r.row.layer?.isImplicit;
        case 'running':
          return experiments.some((x) => !x.archived && x.fate === 'wait');
        default:
          return true;
      }
    };
    const rows = layerRows.filter((r) => (showArchived || !r.row.layer!.archived) && passes(r) && matches(r));
    // Sorting is per source so the order stays meaningful when a workspace consolidates several projects.
    const bySource = new Map<string, Row[]>();
    for (const r of rows) bySource.set(r.s.id, [...(bySource.get(r.s.id) ?? []), r]);
    return [...bySource.values()].flatMap((group) => sortLayerRows(group.map((r) => r.row), sort, dir).map((row) => group.find((r) => r.row === row)!));
  }, [layerRows, q, filter, showArchived, sort, dir]);
  const pager = usePager(visible);

  const unlayeredVisible = useMemo(() => {
    if (filter === 'skippable' || filter === 'create' || filter === 'implicit') return [];
    const needle = q.trim().toLowerCase();
    return unlayered
      .map((r) => ({ ...r, row: { ...r.row, experiments: r.row.experiments.filter((x) => (!needle || x.experiment.id.toLowerCase().includes(needle)) && (filter !== 'running' || (!x.archived && x.fate === 'wait'))) } }))
      .filter((r) => r.row.experiments.length > 0);
  }, [unlayered, q, filter]);

  const keyOf = (r: Row) => `${r.s.id}/${r.row.layer?.uid ?? 'unlayered'}`;
  const isOpen = (r: Row) => (allOpen ? !open.has(keyOf(r)) : open.has(keyOf(r)));
  const toggleRow = (r: Row) =>
    setOpen((prev) => {
      const n = new Set(prev);
      const k = keyOf(r);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleAll = () => {
    setAllOpen((v) => !v);
    setOpen(new Set());
  };

  const exportCsv = () => {
    const multi = reports.length > 1;
    const parts = reports.map(({ s, report }, i) => {
      const csv = layerReportCsv(report, multi ? { source: s.alias } : {});
      return i === 0 ? csv : csv.slice(csv.indexOf('\n') + 1);
    });
    download('layers-report.csv', parts.join(''), 'text/csv');
  };

  const card = (label: string, value: string, note: string, target?: Filter) => (
    <button
      type="button"
      onClick={() => target && setFilter(filter === target ? 'all' : target)}
      disabled={!target}
      aria-pressed={target ? filter === target : undefined}
      className={cx('rounded-md bg-surface-2 px-3 py-2 text-left', target && 'hover:bg-surface-hover', target && filter === target && 'ring-2 ring-info-line')}
    >
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-fg-muted">{note}</div>
    </button>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">Layers and experiments</h2>
        <Badge>{totals.layers}</Badge>
        <Select value={`${sort}:${dir}`} onChange={(e) => { const [k, d] = e.target.value.split(':') as [LayerSortKey, 'asc' | 'desc']; setSort(k); setDir(d); }} aria-label="Sort layers" className="py-1">
          <option value="experiments:desc">Sort: experiments, most first</option>
          <option value="experiments:asc">Sort: experiments, fewest first</option>
          <option value="running:desc">Sort: running experiments</option>
          <option value="parameters:desc">Sort: parameters, most first</option>
          <option value="name:asc">Sort: name</option>
        </Select>
        <Select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter layers" className="py-1">
          <option value="all">All layers</option>
          <option value="create">Will be created in LaunchDarkly</option>
          <option value="skippable">Could be skipped</option>
          <option value="running">Has running experiments</option>
          <option value="implicit">Implicit layers</option>
        </Select>
        {(totals.archivedLayers > 0 || totals.archivedExperiments > 0) && (
          <label className="flex items-center gap-1.5 text-sm text-fg-muted" title="Archived in StatSig: never migrated">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived ({totals.archivedLayers + totals.archivedExperiments})
          </label>
        )}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search layers and experiments…" aria-label="Search layers and experiments" className="ml-auto w-64 py-1" />
        <Button variant="secondary" className="py-1 text-xs" onClick={toggleAll}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </Button>
        <Button variant="secondary" className="py-1 text-xs" onClick={exportCsv} disabled={reports.length === 0} title="One row per experiment, plus one per layer without experiments">
          Export CSV
        </Button>
      </div>
      <MappingExplainer resource="layer" onOpenCoverage={onOpenCoverage} className="mb-3" />

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {card('Layers', String(totals.layers), `${totals.implicitLayers} implicit · ${totals.archivedLayers} archived`)}
        {card('Experiments', String(totals.experiments), `${totals.archivedExperiments} archived · ${totals.skippableExperiments} abandoned`)}
        {card('Running in StatSig', String(totals.runningExperiments), 'migrate after they end', 'running')}
        {card('Could be skipped', `${totals.skippableLayers} ${totals.skippableLayers === 1 ? 'layer' : 'layers'}`, `+ ${totals.skippableExperiments} ${totals.skippableExperiments === 1 ? 'experiment' : 'experiments'} never migrated`, 'skippable')}
      </div>

      <PagerBar pager={pager} label="layers" className="mb-2" />
      <Card>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)_4rem_minmax(0,1.6fr)] gap-x-3 border-b border-line-soft px-3 py-1.5 text-xs text-fg-muted">
          <div>Layer</div>
          <div>Experiments</div>
          <div className="text-right">Params</div>
          <div>Migration</div>
        </div>
        <ul className="divide-y divide-line-soft text-sm">
          {pager.slice.map((r) => (
            <LayerRow key={keyOf(r)} r={r} multi={sources.length > 1} open={isOpen(r)} onToggle={() => toggleRow(r)} showArchived={showArchived} onOpenCoverage={onOpenCoverage} />
          ))}
          {unlayeredVisible.map((r) => (
            <LayerRow key={keyOf(r)} r={r} multi={sources.length > 1} open={isOpen(r)} onToggle={() => toggleRow(r)} showArchived={showArchived} onOpenCoverage={onOpenCoverage} />
          ))}
          {visible.length === 0 && unlayeredVisible.length === 0 && (
            <li className="px-3 py-3 text-xs text-fg-muted">
              {layerRows.length + unlayered.length > 0 ? 'No matches.' : 'No layers or experiments in this snapshot.'}
            </li>
          )}
        </ul>
      </Card>
      <PagerBar pager={pager} label="layers" className="mt-2" />
    </div>
  );
}

function LayerRow({ r, multi, open, onToggle, showArchived, onOpenCoverage }: { r: Row; multi: boolean; open: boolean; onToggle: () => void; showArchived: boolean; onOpenCoverage?: (focus: string) => void }) {
  const { row, s } = r;
  const l = row.layer;
  const experiments = showArchived ? row.experiments : row.experiments.filter((x) => !x.archived);
  const counts = [`${row.counts.live} live`, row.counts.ended ? `${row.counts.ended} ended` : '', row.counts.archived ? `${row.counts.archived} archived` : ''].filter(Boolean).join(' · ');
  return (
    <li className={cx(l?.archived && 'opacity-70')}>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)_4rem_minmax(0,1.6fr)] items-start gap-x-3 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${l?.id ?? 'experiments not in a layer'}`} className="text-fg-muted hover:text-fg">
            {open ? '▾' : '▸'}
          </button>
          {l ? <span className="font-mono text-[13px]">{l.id}</span> : <span className="text-fg-muted">Not in a layer</span>}
          {multi && <Badge>{s.alias}</Badge>}
          {l?.isImplicit && <Badge title="A one-experiment layer StatSig created implicitly">implicit</Badge>}
          {l?.archived && <Badge>archived</Badge>}
          {l && <span className="text-xs text-fg-muted">{l.idType}{l.owner?.name ? ` · ${l.owner.name}` : ''}</span>}
        </div>
        <div className="text-xs tabular-nums text-fg-muted">{counts}</div>
        <div className="text-right text-xs tabular-nums text-fg-muted">{l ? l.parameters.length : '–'}</div>
        <div className="flex flex-wrap items-center gap-2">
          {row.fate ? <Badge tone={LAYER_TONE[row.fate]} title={row.reason}>{LAYER_FATE_LABEL[row.fate]}</Badge> : <span className="text-xs text-fg-muted">per experiment</span>}
          {row.unknownExperimentIds.length > 0 && (
            <Badge tone="amber" title={`Listed on the layer but not in this snapshot: ${row.unknownExperimentIds.join(', ')}`}>
              {row.unknownExperimentIds.length} not synced
            </Badge>
          )}
        </div>
        {l?.description && <div className="col-span-4 mt-0.5 truncate text-xs text-fg-muted">{l.description}</div>}
      </div>
      {open && (
        <div className="space-y-3 border-t border-line-soft bg-surface-2/40 px-3 py-3 pl-9 text-xs">
          <p className="text-fg-muted">
            {row.reason}{' '}
            {onOpenCoverage && (
              <button type="button" className="text-link hover:underline" onClick={() => onOpenCoverage('experiments.layers')}>
                why?
              </button>
            )}
          </p>
          {l && (
            <section>
              <h3 className="mb-1 font-medium text-fg">Default parameters</h3>
              {l.parameters.length === 0 ? (
                <p className="text-fg-muted">No parameters.</p>
              ) : (
                <table className="w-full text-left" aria-label={`Default parameters of ${l.id}`}>
                  <thead className="text-fg-muted">
                    <tr>
                      <th className="py-0.5 pr-3 font-normal">Parameter</th>
                      <th className="py-0.5 pr-3 font-normal">Type</th>
                      <th className="py-0.5 font-normal">Default</th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.parameters.map((p) => (
                      <tr key={p.name} className="border-t border-line-soft">
                        <td className="py-0.5 pr-3 font-mono">{p.name}</td>
                        <td className="py-0.5 pr-3 text-fg-muted">{p.type ?? '–'}</td>
                        <td className="py-0.5 font-mono">
                          <Value v={p.defaultValue} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="sr-only">{describeDefaults(l)}</p>
            </section>
          )}
          <section>
            <h3 className="mb-1 font-medium text-fg">Experiments</h3>
            {experiments.length === 0 ? (
              <p className="text-fg-muted">{row.experiments.length ? `${row.experiments.length} archived (hidden)` : 'No experiments in this snapshot.'}</p>
            ) : (
              <table className="w-full text-left" aria-label={`Experiments in ${l?.id ?? 'no layer'}`}>
                <thead className="text-fg-muted">
                  <tr>
                    <th className="py-0.5 pr-3 font-normal">Experiment</th>
                    <th className="py-0.5 pr-3 font-normal">Status</th>
                    <th className="py-0.5 pr-3 text-right font-normal">Alloc</th>
                    <th className="py-0.5 pr-3 font-normal">Targeting</th>
                    <th className="py-0.5 font-normal">Migration</th>
                  </tr>
                </thead>
                <tbody>
                  {experiments.map((x) => (
                    <ExperimentRow key={x.experiment.uid} x={x} />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </li>
  );
}

function ExperimentRow({ x }: { x: LayerReportExperiment }) {
  const e = x.experiment;
  const t = x.targeting;
  return (
    <tr className={cx('border-t border-line-soft align-top', x.archived && 'text-fg-muted')}>
      <td className="py-1 pr-3">
        <span className="font-mono">{e.id}</span>
        {x.missingLayerId && (
          <span className="ml-1 text-fg-muted" title="The layer this experiment names is not in the snapshot">
            (layer {x.missingLayerId} not synced)
          </span>
        )}
        {e.idType && e.idType !== 'userID' && <span className="ml-1 text-fg-muted">· {e.idType}</span>}
      </td>
      <td className="py-1 pr-3">
        <Badge tone={x.archived ? 'slate' : (STATUS_TONE[e.status] ?? 'slate')}>{x.archived ? 'archived' : e.status.replace(/_/g, ' ')}</Badge>
      </td>
      <td className="py-1 pr-3 text-right tabular-nums">{e.allocation}%</td>
      <td className="py-1 pr-3">
        {t.text === 'none' ? (
          <span className="text-fg-muted">none</span>
        ) : (
          <div className="space-y-0.5">
            {t.gate && (
              <div>
                gate <span className="font-mono">{t.gate.id}</span>
                {!t.gate.found ? <span className="text-fg-muted"> (not in this snapshot)</span> : t.gate.archived ? <Badge tone="amber">gate archived</Badge> : !t.gate.enabled ? <Badge tone="amber">gate disabled</Badge> : null}
                {t.gate.rules.length > 0 && <div className="text-fg-muted">{t.gate.rules.join('; ')}</div>}
              </div>
            )}
            {t.inlineRules.map((r, i) => (
              <div key={i} className="text-fg-muted">
                rule: {r}
              </div>
            ))}
            {t.overrideIds > 0 && <div className="text-fg-muted">{t.overrideIds} forced ID{t.overrideIds === 1 ? '' : 's'}</div>}
            {t.holdoutIds.length > 0 && <div className="text-fg-muted">holdout {t.holdoutIds.join(', ')}</div>}
          </div>
        )}
      </td>
      <td className="py-1">
        <Badge tone={EXPERIMENT_TONE[x.fate]} title={x.reason}>
          {EXPERIMENT_FATE_LABEL[x.fate]}
        </Badge>
      </td>
    </tr>
  );
}

import { Fragment, useMemo, useState } from 'react';
import type { CanonicalSnapshot, EntityKind } from '@sslm/canonical';
import { AREAS, COVERAGE, countByStatus, STATUS_DESCRIPTION, STATUS_LABEL, summarizeInventory, type CoverageArea, type CoverageEntry, type CoverageStatus } from '@sslm/coverage';
import type { SourceRecord } from '@sslm/store';
import { TYPE_LABEL } from '../components/DecisionCard.tsx';
import { Badge, Button, Callout, Card, cx, Input, PageTitle, Select } from '../components/ui.tsx';
import { KIND_LABEL } from '../lib/kinds.ts';
import { COVERAGE_TONE } from './coverageTone.ts';

export { COVERAGE_TONE };

const ORDER: CoverageStatus[] = ['migrates', 'decisions', 'guided', 'planned', 'none'];

/**
 * "What migrates": the full StatSig → LaunchDarkly coverage matrix (packages/coverage), filtered by
 * status and area, with the workspace's own inventory counted against it. The same matrix
 * generates docs/LIMITATIONS.md, so what a customer reads here is what the doc says.
 */
export function CoverageView({
  sources,
  snapshots,
  focus,
  onOpenResource,
}: {
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  /** Coverage row id to scroll to and expand (from an item's guidance link). */
  focus?: string;
  onOpenResource: (kind: EntityKind) => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<CoverageStatus | 'all'>('all');
  const [area, setArea] = useState<CoverageArea | 'all'>('all');
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const snaps = useMemo(() => sources.map((s) => snapshots[s.id]).filter((s): s is CanonicalSnapshot => !!s), [sources, snapshots]);
  const inventory = useMemo(() => summarizeInventory(snaps), [snaps]);
  const counts = countByStatus();

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return COVERAGE.filter((e) => (status === 'all' || e.status === status) && (area === 'all' || e.area === area)).filter(
      (e) => !needle || [e.statsig, e.ld, e.how, e.detail ?? '', ...(e.decisions ?? [])].some((s) => s.toLowerCase().includes(needle)),
    );
  }, [q, status, area]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="max-w-6xl space-y-5">
      <PageTitle eyebrow="Coverage">What migrates</PageTitle>
      <p className="max-w-3xl text-sm text-fg-muted">
        Every StatSig construct, what it becomes in LaunchDarkly, and how completely this console gets it there. Rows that say <b>Migrates with decisions</b>{' '}
        are written automatically once you answer the Decision; rows marked <b>No LaunchDarkly equivalent</b> are the real limitations. The same list is published as{' '}
        <code>docs/LIMITATIONS.md</code>.
      </p>

      <div className="grid gap-3 sm:grid-cols-5">
        {ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(status === s ? 'all' : s)}
            className={cx(
              'rounded-lg border p-3 text-left transition-colors hover:bg-surface-hover',
              status === s ? 'border-focus ring-2 ring-focus/25' : 'border-line bg-surface',
            )}
            aria-pressed={status === s}
          >
            <div className="flex items-center justify-between gap-2">
              <Badge tone={COVERAGE_TONE[s]}>{STATUS_LABEL[s]}</Badge>
              <span className="font-display text-lg font-semibold tabular-nums">{counts[s]}</span>
            </div>
            <p className="mt-1.5 text-xs text-fg-muted">{STATUS_DESCRIPTION[s]}</p>
            {inventory.total > 0 && (
              <p className="mt-1.5 text-xs text-fg">
                <span className="font-semibold tabular-nums">{inventory.byStatus[s]}</span> of your {inventory.total} items
              </p>
            )}
          </button>
        ))}
      </div>

      {inventory.total > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold">Your inventory against the matrix</h3>
          <p className="mb-3 text-xs text-fg-muted">
            Live items in the connected sources, by what happens to each ({inventory.archived} archived item{inventory.archived === 1 ? '' : 's'} skipped). Click a
            kind to open its list; every item there carries the same verdict.
          </p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(inventory.byKind) as EntityKind[]).map((k) => {
              const c = inventory.byKind[k]!;
              const total = ORDER.reduce((n, s) => n + c[s], 0);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => onOpenResource(k)}
                  className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-xs hover:bg-surface-hover"
                >
                  <span className="font-medium">{KIND_LABEL[k]}</span>
                  <span className="text-fg-muted tabular-nums">{total}</span>
                  {ORDER.filter((s) => c[s] > 0).map((s) => (
                    <Badge key={s} tone={COVERAGE_TONE[s]} title={STATUS_LABEL[s]}>
                      {c[s]}
                    </Badge>
                  ))}
                </button>
              );
            })}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search constructs, decisions…" aria-label="Search coverage" className="w-72 py-1" />
        <Select value={area} onChange={(e) => setArea(e.target.value as CoverageArea | 'all')} aria-label="Area" className="py-1">
          <option value="all">All areas</option>
          {AREAS.map((a) => (
            <option key={a.area} value={a.area}>
              {a.title}
            </option>
          ))}
        </Select>
        {(status !== 'all' || area !== 'all' || q) && (
          <Button
            variant="ghost"
            className="py-1 text-xs"
            onClick={() => {
              setStatus('all');
              setArea('all');
              setQ('');
            }}
          >
            Clear filters
          </Button>
        )}
        <span className="ml-auto text-xs text-fg-muted tabular-nums">
          {rows.length} of {COVERAGE.length} rows
        </span>
      </div>

      {rows.length === 0 && <Callout tone="blue">No rows match these filters.</Callout>}

      {AREAS.map((a) => {
        const inArea = rows.filter((e) => e.area === a.area);
        if (!inArea.length) return null;
        return (
          <section key={a.area} id={`coverage-${a.area}`} className="space-y-2">
            <div>
              <h3 className="font-display text-base font-semibold tracking-tight">{a.title}</h3>
              <p className="text-xs text-fg-muted">{a.summary}</p>
            </div>
            <Card>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-fg-muted">
                  <tr className="border-b border-line-soft">
                    <th className="w-44 px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">{a.sourceLabel ?? 'StatSig'}</th>
                    <th className="px-3 py-2 font-medium">LaunchDarkly</th>
                    <th className="w-8 px-2 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {inArea.map((e) => (
                    <Row key={e.id} entry={e} open={open.has(e.id)} onToggle={() => toggle(e.id)} highlight={e.id === focus} count={e.kind ? kindCount(inventory.byKind[e.kind]) : undefined} />
                  ))}
                </tbody>
              </table>
            </Card>
          </section>
        );
      })}
    </div>
  );
}

function kindCount(c: Record<CoverageStatus, number> | undefined): number | undefined {
  return c ? ORDER.reduce((n, s) => n + c[s], 0) : undefined;
}

function Row({ entry: e, open, onToggle, highlight, count }: { entry: CoverageEntry; open: boolean; onToggle: () => void; highlight: boolean; count?: number }) {
  return (
    <Fragment>
      <tr
        id={`coverage-${e.id}`}
        className={cx('cursor-pointer align-top hover:bg-surface-hover', highlight && 'bg-info-bg')}
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="px-3 py-2">
          <Badge tone={COVERAGE_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
        </td>
        <td className="px-3 py-2">
          <div className="font-medium">{e.statsig}</div>
          {count !== undefined && count > 0 && <div className="mt-0.5 text-xs text-fg-muted tabular-nums">{count} in your sources</div>}
        </td>
        <td className="px-3 py-2">
          <div>{e.ld}</div>
          <div className="mt-0.5 text-xs text-fg-muted">{e.how}</div>
        </td>
        <td className="px-2 py-2 text-fg-muted" aria-hidden>
          {open ? '▾' : '▸'}
        </td>
      </tr>
      {open && (
        <tr className="bg-surface-2/40">
          <td colSpan={4} className="px-4 pt-1 pb-3 text-sm">
            {e.detail && <p className="mb-2 max-w-3xl text-fg">{e.detail}</p>}
            <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
              {e.decisions?.length ? (
                <>
                  <dt className="text-fg-muted">Decisions</dt>
                  <dd className="flex flex-wrap gap-1">
                    {e.decisions.map((d) => (
                      <Badge key={d} tone="slate" title={d}>
                        {TYPE_LABEL[d] ?? d}
                      </Badge>
                    ))}
                  </dd>
                </>
              ) : null}
              {e.edgeCases?.length ? (
                <>
                  <dt className="text-fg-muted">Edge cases</dt>
                  <dd className="text-fg-muted">
                    docs/KNOWN-EDGE-CASES.md rows {e.edgeCases.join(', ')}
                  </dd>
                </>
              ) : null}
              {e.docs?.statsig || e.docs?.ld ? (
                <>
                  <dt className="text-fg-muted">Docs</dt>
                  <dd className="flex gap-3">
                    {e.docs.statsig && (
                      <a className="text-link hover:underline" href={e.docs.statsig} target="_blank" rel="noreferrer">
                        StatSig ↗
                      </a>
                    )}
                    {e.docs.ld && (
                      <a className="text-link hover:underline" href={e.docs.ld} target="_blank" rel="noreferrer">
                        LaunchDarkly ↗
                      </a>
                    )}
                  </dd>
                </>
              ) : null}
            </dl>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

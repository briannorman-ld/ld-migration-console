import { useMemo, useState } from 'react';
import { entitiesOf, type CanonicalSnapshot, type EntityKind } from '@sslm/canonical';
import { coverageFor, guidanceFor, STATUS_LABEL, type CoverageStatus } from '@sslm/coverage';
import type { SourceRecord } from '@sslm/store';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { Badge, Callout, Card, Input, Select } from '../components/ui.tsx';
import { TagFilter } from '../components/TagFilter.tsx';
import { matchesTags, pruneTags, tagOptions } from '../lib/tags.ts';
import { COVERAGE_TONE } from './coverageTone.ts';

/**
 * Inventory for resource kinds without a side-by-side explorer yet. Every item carries a verdict
 * from the coverage matrix (what will happen to it and why), so nothing is a bare name in a list.
 */
export function EntityList({
  kind,
  label,
  sources,
  snapshots,
  onOpenCoverage,
}: {
  kind: EntityKind;
  label: string;
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  /** Opens the "What migrates" page at a coverage row. */
  onOpenCoverage?: (focus: string) => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<CoverageStatus | 'all'>('all');
  const [tags, setTags] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () => sources.flatMap((s) => entitiesOf(snapshots[s.id]!, kind).map((e) => ({ s, e, g: guidanceFor(e) }))),
    [sources, snapshots, kind],
  );
  const tagChoices = useMemo(() => tagOptions(rows.map((r) => r.e)), [rows]);
  const chosenTags = useMemo(() => pruneTags(tags, tagChoices), [tags, tagChoices]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter(({ g }) => status === 'all' || g.status === status)
      .filter(({ e }) => matchesTags(e.tags, chosenTags))
      .filter(({ e }) => !needle || e.id.toLowerCase().includes(needle) || (e.description ?? '').toLowerCase().includes(needle));
  }, [rows, q, status, chosenTags]);
  const pager = usePager(filtered);
  const coverage = coverageFor(kind);
  const counts = useMemo(() => {
    const out: Partial<Record<CoverageStatus, number>> = {};
    for (const { g } of rows) out[g.status] = (out[g.status] ?? 0) + 1;
    return out;
  }, [rows]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">{label}</h2>
        <Badge>{rows.length}</Badge>
        <Select value={status} onChange={(e) => setStatus(e.target.value as CoverageStatus | 'all')} aria-label="Filter by what happens" className="py-1">
          <option value="all">Everything</option>
          {(Object.keys(counts) as CoverageStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]} ({counts[s]})
            </option>
          ))}
        </Select>
        <TagFilter options={tagChoices} chosen={chosenTags} onChange={setTags} noun={label.toLowerCase()} />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}…`} aria-label={`Search ${label}`} className="ml-auto w-64 py-1" />
      </div>
      {coverage.length > 0 && (
        <div className="mb-3">
          <Callout tone="blue">
            <span className="font-medium">{coverage[0]!.statsig}</span> → {coverage[0]!.ld}. {coverage[0]!.how}{' '}
            {onOpenCoverage && (
              <button type="button" className="text-link hover:underline" onClick={() => onOpenCoverage(coverage[0]!.id)}>
                Details and limitations
              </button>
            )}
          </Callout>
        </div>
      )}
      <PagerBar pager={pager} label={label.toLowerCase()} className="mb-2" />
      <Card>
        <ul className="divide-y divide-line-soft text-sm">
          {pager.slice.map(({ s, e, g }) => (
            <li key={e.uid} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-mono text-[13px]">{e.id}</span>
              {sources.length > 1 && <Badge>{s.alias}</Badge>}
              {e.archived && <Badge>archived</Badge>}
              {'status' in e && typeof e.status === 'string' && <Badge tone="blue">{e.status}</Badge>}
              {e.completeness.missing.includes('idListMembers') && (
                <Badge tone="amber" title="IDs not fetched yet / hashed">
                  IDs pending
                </Badge>
              )}
              <Badge tone={COVERAGE_TONE[g.status]} title={STATUS_LABEL[g.status]}>
                {g.verdict}
              </Badge>
              <span className="ml-2 truncate text-xs text-fg-muted">{e.description}</span>
              <span className="basis-full text-xs text-fg-muted">
                {g.detail}{' '}
                {onOpenCoverage && (
                  <button type="button" className="text-link hover:underline" onClick={() => onOpenCoverage(g.coverageId)}>
                    why?
                  </button>
                )}
              </span>
            </li>
          ))}
          {filtered.length === 0 && <li className="px-3 py-3 text-xs text-fg-muted">{rows.length === 0 ? 'Nothing here.' : 'No matches.'}</li>}
        </ul>
      </Card>
      <PagerBar pager={pager} label={label.toLowerCase()} className="mt-2" />
    </div>
  );
}

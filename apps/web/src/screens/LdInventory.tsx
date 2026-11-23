import { Fragment, useEffect, useMemo, useState } from 'react';
import { ldReadScope, LD_RESOURCE_INFO, LD_RESOURCE_KINDS, type CanonicalSnapshot, type LdResourceKind, type NeutralInventoryItem } from '@sslm/canonical';
import { COVERAGE, STATUS_LABEL } from '@sslm/coverage';
import type { SourceRecord } from '@sslm/store';
import { LdScopePicker } from '../components/LdScopePicker.tsx';
import { PagerBar, usePager } from '../components/Pager.tsx';
import { Badge, Button, Callout, Card, cx, Input, Spinner } from '../components/ui.tsx';
import { SOURCE_BADGE } from '../lib/kinds.ts';
import { COVERAGE_TONE } from './coverageTone.ts';

/** Kinds this explorer lists: everything an LD source reads that has no explorer of its own (PLAN §20.6). */
export const INVENTORY_KINDS: LdResourceKind[] = LD_RESOURCE_KINDS.filter((k) => LD_RESOURCE_INFO[k].handling !== 'migrates');

/** Snapshots taken before the read scope existed (2026-11-23) read flags, segments and experimentation. */
const LEGACY_SCOPE: LdResourceKind[] = ['flags', 'segments', 'metrics', 'metric_groups', 'experiments', 'holdouts', 'layers'];

export function snapshotReadScope(snap: CanonicalSnapshot | undefined): LdResourceKind[] {
  return snap?.neutral?.readScope ? ldReadScope(snap.neutral.readScope) : LEGACY_SCOPE;
}

interface Row {
  source: SourceRecord;
  item: NeutralInventoryItem;
  ownerName?: string;
}

/**
 * Every other resource type of a LaunchDarkly source (PLAN §20.6): AI Configs, releases, views,
 * scheduled changes, triggers, workflows, links, environment settings and the account's teams,
 * members, roles, webhooks, Relay configurations, code reference repositories, workflow
 * templates and applications. Each kind is a chip with its count; a kind the scope did not read
 * says so and the scope editor widens it. Rows carry the facts the source gave and the coverage
 * verdict for the kind, so nothing in the source is a bare name or a surprise at cut-over.
 */
export function LdInventory({
  sources,
  snapshots,
  focus,
  onOpenCoverage,
  onChangeScope,
  syncing,
  readOnly = false,
}: {
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  /** Kind to open on; defaults to the first with items. */
  focus?: LdResourceKind;
  onOpenCoverage?: (focus: string) => void;
  /** Save a new read scope for the source and refresh it. */
  onChangeScope?: (source: SourceRecord, resources: LdResourceKind[]) => void | Promise<void>;
  /** Sources being refreshed right now, by id. */
  syncing?: Set<string>;
  readOnly?: boolean;
}) {
  const ldSources = useMemo(() => sources.filter((s) => s.kind === 'launchdarkly' && !!snapshots[s.id]?.neutral), [sources, snapshots]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of ldSources) {
      const snap = snapshots[s.id]!;
      const names = new Map((snap.users ?? []).filter((u) => u.email && u.name).map((u) => [u.email.trim().toLowerCase(), u.name!]));
      for (const item of snap.neutral!.inventory ?? []) {
        const email = item.maintainer?.email?.trim().toLowerCase();
        const ownerName = email ? names.get(email) : undefined;
        out.push({ source: s, item, ...(ownerName ? { ownerName } : {}) });
      }
    }
    return out;
  }, [ldSources, snapshots]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(INVENTORY_KINDS.map((k) => [k, 0])) as Record<LdResourceKind, number>;
    for (const r of rows) if (r.item.resourceKind in c) c[r.item.resourceKind as LdResourceKind]++;
    return c;
  }, [rows]);
  // A kind counts as read when any source read it; the chip says which sources did not.
  const readBy = useMemo(() => {
    const m = new Map<LdResourceKind, SourceRecord[]>();
    for (const s of ldSources) for (const k of snapshotReadScope(snapshots[s.id])) (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    return m;
  }, [ldSources, snapshots]);

  const [kind, setKind] = useState<LdResourceKind>(() => focus ?? INVENTORY_KINDS.find((k) => counts[k] > 0) ?? INVENTORY_KINDS[0]!);
  useEffect(() => {
    if (focus) setKind(focus);
  }, [focus]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string>();
  const [editingScope, setEditingScope] = useState(false);
  const [scopeDraft, setScopeDraft] = useState<Record<string, Set<LdResourceKind>>>({});
  const info = LD_RESOURCE_INFO[kind];
  const coverage = COVERAGE.find((e) => e.id === info.coverageId);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => r.item.resourceKind === kind && (!needle || r.item.key.toLowerCase().includes(needle) || r.item.name.toLowerCase().includes(needle) || (r.item.flagKey ?? '').toLowerCase().includes(needle) || r.item.facts.some((f) => f.value.toLowerCase().includes(needle))));
  }, [rows, kind, q]);
  const pager = usePager(visible);
  const notRead = ldSources.filter((s) => !snapshotReadScope(snapshots[s.id]).includes(kind));
  const envCount = (s: SourceRecord) => snapshots[s.id]?.environments.length;
  const flagCount = (s: SourceRecord) => snapshots[s.id]?.neutral?.flags.length;

  if (ldSources.length === 0) return <Callout tone="blue">No LaunchDarkly source is attached. Add one under Connections to list what its project and account hold.</Callout>;

  return (
    <div className="pb-20">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">Other resources (source projects)</h2>
        <Badge>{rows.length}</Badge>
        <div className="ml-auto flex items-center gap-3">
          <Input placeholder="Filter by key, name, flag or fact" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" aria-label="Filter other resources" />
          {!readOnly && onChangeScope && (
            <Button variant="secondary" onClick={() => setEditingScope((x) => !x)}>
              {editingScope ? 'Hide read scope' : 'Read scope…'}
            </Button>
          )}
        </div>
      </div>

      {editingScope && onChangeScope && (
        <Card className="mb-3 space-y-4 p-4">
          {ldSources.map((s) => {
            const current = scopeDraft[s.id] ?? new Set(ldReadScope(s.ld?.resources));
            const busy = syncing?.has(s.id) ?? false;
            return (
              <div key={s.id} className="space-y-3">
                {ldSources.length > 1 && (
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Badge tone={SOURCE_BADGE[s.kind].tone}>{s.alias}</Badge> {s.label}
                  </div>
                )}
                <LdScopePicker value={current} onChange={(next) => setScopeDraft((d) => ({ ...d, [s.id]: next }))} idPrefix={`scope-${s.id}`} counts={{ ...(flagCount(s) != null ? { flags: flagCount(s) } : {}), ...(envCount(s) != null ? { environments: envCount(s) } : {}) }} disabled={busy} />
                <div className="flex items-center gap-3">
                  <Button
                    disabled={busy || current.size === 0}
                    onClick={() => {
                      void onChangeScope(s, LD_RESOURCE_KINDS.filter((k) => current.has(k)));
                      setScopeDraft((d) => {
                        const { [s.id]: _drop, ...rest } = d;
                        return rest;
                      });
                    }}
                  >
                    {busy && <Spinner />} {busy ? 'Refreshing…' : 'Save and refresh'}
                  </Button>
                  <span className="text-xs text-fg-muted">Saves the scope on this source and reads the project again with it. The current snapshot stays until the new one is in.</span>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Resource kinds">
        {INVENTORY_KINDS.map((k) => {
          const read = (readBy.get(k)?.length ?? 0) > 0;
          const i = LD_RESOURCE_INFO[k];
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              title={read ? i.description : `${i.label}: not read by this source’s scope. Widen the read scope and refresh.`}
              onClick={() => setKind(k)}
              className={cx('flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs', kind === k ? 'border-fg bg-surface-2 font-medium' : 'border-line hover:bg-surface-hover', !read && 'opacity-60')}
            >
              {i.label}
              <span className={cx('tabular-nums', read ? 'text-fg-muted' : 'text-fg-subtle')}>{read ? counts[k] : '—'}</span>
            </button>
          );
        })}
      </div>

      {coverage && (
        <div className="mb-3">
          <Callout tone={coverage.status === 'migrates' || coverage.status === 'decisions' ? 'green' : coverage.status === 'none' ? 'amber' : 'blue'}>
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={COVERAGE_TONE[coverage.status]}>{STATUS_LABEL[coverage.status]}</Badge>
              <span>
                <b>{info.label}:</b> {coverage.how}
              </span>
              {onOpenCoverage && (
                <button type="button" className="text-link hover:underline" onClick={() => onOpenCoverage(coverage.id)}>
                  What migrates →
                </button>
              )}
            </span>
          </Callout>
        </div>
      )}
      {notRead.length > 0 && (
        <div className="mb-3">
          <Callout tone="blue">
            {info.label} {notRead.length === ldSources.length ? 'were not read' : `were not read from ${notRead.map((s) => s.alias).join(', ')}`}: the source’s read scope leaves them out{' '}
            {info.requires?.length ? `(they need ${info.requires.map((r) => LD_RESOURCE_INFO[r].label.toLowerCase()).join(', ')}, ${info.requests === 'per_flag_environment' ? 'one request per flag per environment' : 'one request per flag'})` : ''}
            {!readOnly && onChangeScope ? (
              <>
                {' '}
                <button type="button" className="font-medium underline" onClick={() => setEditingScope(true)}>
                  Widen the read scope
                </button>{' '}
                and refresh to list them.
              </>
            ) : (
              '.'
            )}
          </Callout>
        </div>
      )}

      <PagerBar pager={pager} label={info.label.toLowerCase()} className="mb-2" />
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs tracking-wide text-fg-muted uppercase">
            <tr>
              <th className="px-3 py-2">{info.label.replace(/s$/, '')}</th>
              <th className="px-3 py-2">Where</th>
              <th className="px-3 py-2">Facts</th>
              <th className="px-3 py-2">Owner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {pager.slice.map((r) => {
              const isOpen = open === r.item.uid;
              return (
                <Fragment key={r.item.uid}>
                  <tr className={cx('cursor-pointer hover:bg-surface-hover', isOpen && 'bg-surface-2')} onClick={() => setOpen(isOpen ? undefined : r.item.uid)}>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px]">{r.item.key}</span>
                        {ldSources.length > 1 && (
                          <Badge tone={SOURCE_BADGE[r.source.kind].tone} title={SOURCE_BADGE[r.source.kind].label}>
                            {r.source.alias}
                          </Badge>
                        )}
                        {r.item.archived && <Badge>archived</Badge>}
                      </div>
                      <div className="truncate text-xs text-fg-muted">{r.item.name !== r.item.key ? r.item.name : r.item.description}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.item.env && <Badge tone="slate">{r.item.env}</Badge>}
                        {r.item.flagKey && (
                          <Badge tone="blue" title="Flag">
                            {r.item.flagKey}
                          </Badge>
                        )}
                        {!r.item.env && !r.item.flagKey && <span className="text-xs text-fg-subtle">{info.scope}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">
                      {r.item.facts.slice(0, 3).map((f) => (
                        <span key={f.label} className="mr-3 inline-block">
                          <span className="text-fg-subtle">{f.label}:</span> {f.value}
                        </span>
                      ))}
                      {r.item.facts.length > 3 && <span className="text-fg-subtle">+{r.item.facts.length - 3}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">{r.ownerName ?? r.item.maintainer?.email ?? (r.item.maintainer?.id ? <span title="Member id of the source account; the email was not readable">member {r.item.maintainer.id}</span> : <span className="text-fg-subtle">—</span>)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-surface-2">
                      <td colSpan={4} className="px-4 py-3">
                        <ItemDetail item={r.item} coverageDetail={coverage?.detail} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-fg-muted">
                  {notRead.length === ldSources.length ? `Not read: widen the read scope to list ${info.label.toLowerCase()}.` : q ? `No ${info.label.toLowerCase()} match.` : `The source has no ${info.label.toLowerCase()}.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ItemDetail({ item, coverageDetail }: { item: NeutralInventoryItem; coverageDetail?: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">{item.name}</div>
        {item.description && <p className="mb-2 text-sm">{item.description}</p>}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          {item.facts.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-fg-muted">{f.label}</dt>
              <dd className="break-words">{f.value}</dd>
            </Fragment>
          ))}
          {item.tags.length > 0 && (
            <>
              <dt className="text-fg-muted">Tags</dt>
              <dd>{item.tags.join(', ')}</dd>
            </>
          )}
          {item.createdAt != null && (
            <>
              <dt className="text-fg-muted">Created</dt>
              <dd>{new Date(item.createdAt).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </div>
      <div>
        {coverageDetail && <p className="mb-2 text-xs text-fg-muted">{coverageDetail}</p>}
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-muted">As LaunchDarkly returned it (credentials removed)</summary>
          <pre className="mt-1 max-h-80 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] leading-snug">{JSON.stringify(item.raw, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

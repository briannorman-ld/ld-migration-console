import { indexByKey } from "../lib/indexByKey.ts";
import { Fragment, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  describeSegmentUsers,
  matchAcrossSources,
  parseFooter,
  resolveRulesForEnvironment,
  segmentReferences,
  type CanonicalSnapshot,
  type Segment,
  type SegmentReference,
} from "@sslm/canonical";
import type { DecisionType, SegmentMapResult } from "@sslm/mapper";
import { ownsSegment, type MigrationStatus } from "@sslm/planner";
import type { ExclusionRecord, SourceRecord } from "@sslm/store";
import { DecisionCard, FIDELITY_TONE, TYPE_LABEL } from "../components/DecisionCard.tsx";
import { PagerBar, usePager } from "../components/Pager.tsx";
import { MigrateButton, ReadinessLine, readinessSteps } from "../components/Readiness.tsx";
import { StatsigRules } from "../components/Targeting.tsx";
import { Badge, Button, Callout, Card, cx, Input, Select } from "../components/ui.tsx";
import { summarizeDecisions } from "../lib/decisionSummary.ts";
import { mapSegmentFor, type DecisionInstance } from "../lib/migration.ts";
import { timeAgo } from "../lib/time.ts";
import type { MigrationContext } from "../lib/useMigration.ts";
import type { ExplorerNav } from "./AutotunesSideBySide.tsx";
import { STATUS } from "./GatesSideBySide.tsx";

/** Where a segment stands in one LD environment; `unknown` while that environment's list has not been read. */
type SegmentStatus = MigrationStatus | "unknown";

type StatusFilter = "all" | "unused" | "used" | "open" | "blocking" | "not_migrated" | "in_sync" | "changed" | "set_aside";

const TYPE_BADGE: Record<Segment["segmentType"], string> = { rule_based: "rules", id_list: "ID list", analysis_list: "analysis list", user_store_id_list: "user store list" };

/** The reason "Don't migrate" carries when every selected segment is unused. */
export const UNUSED_REASON = "Not used by any gate, dynamic config or segment";

interface Row {
  sourceId: string;
  seg: Segment;
  shared: number;
  ldEnv: string | null;
  result: SegmentMapResult;
  /** Per LD environment, for the status strip. */
  strip: { ldEnv: string; status: SegmentStatus }[];
  refs: SegmentReference[];
  /** Live (not archived) users. */
  used: boolean;
  setAside?: ExclusionRecord;
}

/**
 * Segments explorer (PLAN §9, §10.4): StatSig on the left with who uses each segment, LD on the
 * right with the per-environment status read from the segment list and its provenance footer. The
 * point of the page is the choice: tick the segments to migrate, set aside the ones nothing uses,
 * and plan the rest. Segments a migrated flag needs are pulled into its plan regardless.
 */
export function SegmentsSideBySide({
  sources,
  snapshots,
  env,
  m,
  onMigrate,
  onOpenMapping,
  nav,
  readOnly = false,
  selected,
  setSelected,
}: {
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  env: string;
  m: MigrationContext;
  onMigrate: (uids: string[], ldEnvs: string[]) => void;
  onOpenMapping: () => void;
  nav?: ExplorerNav;
  readOnly?: boolean;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [decisionType, setDecisionType] = useState<DecisionType | "all">("all");
  const [open, setOpen] = useState<string>();
  const [targetEnvs, setTargetEnvs] = useState<string[] | null>(null);
  const { ld } = m;
  const snaps = useMemo(() => sources.map((s) => snapshots[s.id]!).filter(Boolean), [sources, snapshots]);
  const matched = useMemo(() => matchAcrossSources(snaps, "segment"), [snaps]);
  const references = useMemo(() => new Map(snaps.map((s) => [s.source.sourceId, segmentReferences(s)])), [snaps]);
  const aliasOf = (sourceId: string) => sources.find((s) => s.id === sourceId)?.alias ?? sourceId;
  const ldEnvOf = (sourceId: string, statsigEnv: string) => (m.connected ? (m.profile.sources[sourceId]?.envMapping[statsigEnv] ?? null) : null);

  const rows: Row[] = useMemo(
    () =>
      matched.flatMap((mr) =>
        Object.entries(mr.bySource).map(([sourceId, e]) => {
          const seg = e as Segment;
          const snap = snapshots[sourceId]!;
          const ldEnv = ldEnvOf(sourceId, env);
          const result = mapSegmentFor(snap, seg, { statsig: env, ld: ldEnv ?? env }, m);
          const strip = m.connected
            ? m.ldEnvs.map((le) => {
                const se = Object.entries(m.profile.sources[sourceId]?.envMapping ?? {}).find(([, v]) => v === le.key)?.[0];
                if (!se) return { ldEnv: le.key, status: "not_in_ld" as SegmentStatus };
                const r = se === env ? result : mapSegmentFor(snap, seg, { statsig: se, ld: le.key }, m);
                return { ldEnv: le.key, status: segmentStatus(ld.segments?.[le.key], r, snap.source.alias) };
              })
            : [];
          const refs = references.get(sourceId)?.get(seg.id) ?? [];
          const setAside = m.exclusions.get(seg.uid);
          return { sourceId, seg, shared: Object.keys(mr.bySource).length, ldEnv, result, strip, refs, used: refs.some((r) => !r.archived), ...(setAside ? { setAside } : {}) };
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the rows read of `m` (see GatesSideBySide)
    [matched, snapshots, env, m.inputs, m.connected, m.ldEnvs, m.exclusions, references, ld.segments],
  );
  const unusedCount = useMemo(() => rows.filter((r) => !r.seg.archived && !r.used && !r.setAside).length, [rows]);
  const setAsideCount = useMemo(() => rows.filter((r) => !r.seg.archived && r.setAside).length, [rows]);

  const decisionTypes = useMemo(() => {
    const counts = new Map<DecisionType, number>();
    for (const r of rows) for (const t of new Set(r.result.unresolved.map((d) => d.type))) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  useEffect(() => {
    if (decisionType !== "all" && !decisionTypes.some(([t]) => t === decisionType)) setDecisionType("all");
  }, [decisionTypes, decisionType]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!showArchived && r.seg.archived) return false;
        if (q && !r.seg.id.toLowerCase().includes(q.toLowerCase())) return false;
        if (decisionType !== "all" && !r.result.unresolved.some((d) => d.type === decisionType)) return false;
        const here = r.strip.find((s) => s.ldEnv === r.ldEnv)?.status;
        switch (filter) {
          case "unused":
            return !r.used;
          case "used":
            return r.used;
          case "open":
            return r.result.unresolved.length > 0;
          case "blocking":
            return r.result.unresolved.some((d) => d.severity === "blocking");
          case "not_migrated":
            return !here || here === "not_in_ld" || here === "not_migrated" || here === "unknown";
          case "in_sync":
            return here === "in_sync";
          case "changed":
            return here === "statsig_changed" || here === "decisions_changed";
          case "set_aside":
            return !!r.setAside;
          default:
            return true;
        }
      }),
    [rows, showArchived, q, filter, decisionType],
  );
  const pager = usePager(visible);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.seg.uid) && !r.setAside), [rows, selected]);
  const bulk = useMemo(() => {
    const instances: DecisionInstance[] = selectedRows.flatMap((r) => r.result.unresolved.map((d) => ({ decision: d, entityId: r.seg.id, envs: [] as string[] })));
    return { rows: summarizeDecisions(instances, {}), instances };
  }, [selectedRows]);
  const decideSelected = (type: DecisionType, optionKey: string) => void m.resolve(bulk.instances.filter((x) => x.decision.type === type).map((x) => x.decision), optionKey);
  const selectable = visible.filter((r) => !r.seg.archived && !r.setAside);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.seg.uid));
  const mappedHere = [...new Set(sources.map((s) => ldEnvOf(s.id, env)).filter((x): x is string => !!x))];
  const envChoice = targetEnvs ?? mappedHere;
  const unmappedSources = m.connected ? sources.filter((s) => !ldEnvOf(s.id, env)) : [];

  const toggle = (uid: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  const blockingIn = (rs: Row[]) => rs.reduce((n, r) => n + r.result.unresolved.filter((d) => d.severity === "blocking").length, 0);
  const steps = readinessSteps({
    m,
    env,
    mappedHere,
    hasSnapshot: snaps.length > 0,
    kindLabel: "segments",
    selected: selectedRows.length,
    blockingSelected: blockingIn(selectedRows),
    blockingAll: blockingIn(visible),
    nav: nav ?? { connections: onOpenMapping, ld: onOpenMapping, mapping: onOpenMapping, decisions: onOpenMapping },
  });
  const migrate = () => onMigrate(selectedRows.map((r) => r.seg.uid), envChoice);
  const selectAll = () =>
    setSelected((x) => {
      const n = new Set(x);
      for (const r of selectable) if (allSelected) n.delete(r.seg.uid); else n.add(r.seg.uid);
      return n;
    });
  const clearOwn = () => {
    const own = new Set(rows.map((r) => r.seg.uid));
    setSelected((x) => new Set([...x].filter((uid) => !own.has(uid))));
  };
  const setAsideSelected = async () => {
    const uids = selectedRows.map((r) => r.seg.uid);
    await m.exclude(uids, selectedRows.every((r) => !r.used) ? UNUSED_REASON : undefined);
    const gone = new Set(uids);
    setSelected((x) => new Set([...x].filter((uid) => !gone.has(uid))));
  };

  return (
    <div className="pb-20">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">Segments</h2>
        <Badge>{visible.length}</Badge>
        <span className="text-sm text-fg-muted">
          StatSig <b>{env}</b>
          {mappedHere.length > 0 && (
            <>
              {" "}
              → LD <b>{mappedHere.join(", ")}</b>
            </>
          )}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <Select value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)} aria-label="Filter by status">
            <option value="all">All</option>
            <option value="unused">Not used by anything{unusedCount ? ` (${unusedCount.toLocaleString()})` : ""}</option>
            <option value="used">Used by a gate, config or segment</option>
            <option value="open">Open decisions</option>
            <option value="blocking">Blocking decisions</option>
            <option value="not_migrated">Not migrated here</option>
            <option value="in_sync">In sync</option>
            <option value="changed">Changed since sync</option>
            <option value="set_aside">Set aside{setAsideCount ? ` (${setAsideCount.toLocaleString()})` : ""}</option>
          </Select>
          {decisionTypes.length > 0 && (
            <Select value={decisionType} onChange={(e) => setDecisionType(e.target.value as DecisionType | "all")} aria-label="Filter by open decision" title="Only segments with this decision still open">
              <option value="all">Any decision</option>
              {decisionTypes.map(([t, n]) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t] ?? t} ({n})
                </option>
              ))}
            </Select>
          )}
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived
          </label>
          <Input placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" aria-label="Filter segments" />
          {!readOnly && <MigrateButton steps={steps} onClick={migrate} label={selectedRows.length ? `Migrate ${selectedRows.length.toLocaleString()} segment${selectedRows.length === 1 ? "" : "s"}…` : "Migrate…"} />}
        </div>
      </div>
      {!readOnly && <ReadinessLine steps={steps} />}
      {ld.status !== "connected" && (
        <div className="mb-3">
          <Callout tone="blue">Connect LaunchDarkly to see which segments already exist there and to migrate. Decisions can be made without it.</Callout>
        </div>
      )}
      {filter === "unused" && !readOnly && (
        <div className="mb-3">
          <Callout tone="blue">
            {visible.length === 0
              ? "Every segment is used by at least one gate, dynamic config or segment."
              : `${visible.length.toLocaleString()} segment${visible.length === 1 ? " is" : "s are"} not referenced by any gate, dynamic config or segment in this source. Tick the ones to leave behind and choose “Don't migrate these”; a segment a migrated flag turns out to need is still created with that flag.`}
          </Callout>
        </div>
      )}
      {unmappedSources.length > 0 && (
        <div className="mb-3">
          <Callout>
            StatSig <b>{env}</b> isn't mapped to a LaunchDarkly environment for {unmappedSources.map((s) => s.label).join(", ")}, so it can't be migrated.{" "}
            <button className="font-medium underline" onClick={onOpenMapping}>
              Map environments
            </button>
          </Callout>
        </div>
      )}
      <PagerBar pager={pager} label="segments" className="mb-2" />
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-surface-2 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
            <tr>
              <th className="w-9 px-3 py-2">{!readOnly && <input type="checkbox" aria-label="Select all" title={`Select all ${selectable.length.toLocaleString()} matching segments`} checked={allSelected} onChange={selectAll} />}</th>
              <th className="w-[30%] px-3 py-2">StatSig</th>
              <th className="w-[17%] px-3 py-2" title="Gates, dynamic configs and segments whose rules pass or fail this segment">
                Used by
              </th>
              <th className="w-[10%] px-3 py-2">In {env}</th>
              <th className="w-[14%] px-3 py-2">Mapping</th>
              <th className="px-3 py-2">LaunchDarkly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {pager.slice.map((row) => {
              const { sourceId, seg, shared, result: r } = row;
              const key = `${sourceId}/${seg.id}`;
              const res = resolveRulesForEnvironment(seg.rules, env);
              const blocking = r.unresolved.filter((d) => d.severity === "blocking").length;
              return (
                <Fragment key={key}>
                  <tr className={cx("cursor-pointer align-top hover:bg-surface-hover", open === key && "bg-surface-2", row.setAside && "opacity-70")} onClick={() => setOpen(open === key ? undefined : key)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      {!readOnly && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${seg.id}`}
                          disabled={seg.archived || !!row.setAside}
                          title={row.setAside ? "Set aside: open the row to migrate it after all" : undefined}
                          checked={selected.has(seg.uid) && !row.setAside}
                          onChange={() => toggle(seg.uid)}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px] font-medium">{seg.id}</span>
                        {sources.length > 1 && <Badge tone="slate">{aliasOf(sourceId)}</Badge>}
                        {shared > 1 && <Badge tone="violet" title="Same name in more than one source">in {shared} sources</Badge>}
                        <Badge tone="slate" title={seg.segmentType}>
                          {TYPE_BADGE[seg.segmentType]}
                          {seg.idList?.count !== undefined ? ` · ${seg.idList.count.toLocaleString()} IDs` : ""}
                        </Badge>
                        {!seg.enabled && <Badge tone="red">disabled</Badge>}
                        {seg.archived && <Badge tone="slate">archived</Badge>}
                        {row.setAside && (
                          <Badge tone="slate" title={`Don't migrate${row.setAside.reason ? `: ${row.setAside.reason}` : ""} (marked ${timeAgo(row.setAside.markedAt)})`}>
                            set aside
                          </Badge>
                        )}
                        {seg.idType !== "userID" && <Badge tone="blue">{seg.idType}</Badge>}
                      </div>
                      {seg.description && <div className="mt-0.5 truncate text-xs text-fg-muted">{seg.description}</div>}
                      <div className="mt-0.5 text-xs text-fg-subtle">
                        {seg.owner?.email ?? "no owner"}
                        {seg.tags.length > 0 && ` · ${seg.tags.join(", ")}`}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <UsersCell row={row} />
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">
                      <div>
                        {res.rules.length} rule{res.rules.length === 1 ? "" : "s"}
                      </div>
                      {res.dropped.length > 0 && <div className="text-fg-subtle">{res.dropped.length} not here</div>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {blocking === 0 && <Badge tone={FIDELITY_TONE[r.fidelity.overall]}>{r.skipped ? "not migrated" : r.fidelity.overall}</Badge>}
                        {blocking > 0 && <Badge tone="red">{blocking} blocking</Badge>}
                        {r.unresolved.length - blocking > 0 && <Badge tone="amber">{r.unresolved.length - blocking} to decide</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <LdCell row={row} connected={ld.status === "connected"} />
                    </td>
                  </tr>
                  {open === key && (
                    <tr className="bg-surface-2">
                      <td colSpan={6} className="px-3 pb-4">
                        <Detail row={row} m={m} env={env} res={res} readOnly={readOnly} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Card>
      <PagerBar pager={pager} label="segments" className="mt-2" />

      {selectedRows.length > 0 && !readOnly && (
        <div className="fixed right-0 bottom-0 left-72 z-40 border-t border-line bg-surface/95 px-5 py-3 shadow-raised backdrop-blur">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="flex items-center gap-3 pt-1">
              <span className="text-sm font-medium">
                {selectedRows.length.toLocaleString()} segment{selectedRows.length === 1 ? "" : "s"} selected
                {selected.size > selectedRows.length && <span className="font-normal text-fg-muted"> · {selected.size.toLocaleString()} in all</span>}
              </span>
              <button className="text-sm text-fg-muted hover:text-fg" onClick={clearOwn}>
                Clear
              </button>
              <button className="text-sm text-fg-muted hover:text-fg" onClick={() => void setAsideSelected()} title="Mark the selected segments as not to be migrated. They stay listed; the guide and plans leave them out until you migrate them after all.">
                Don't migrate these
              </button>
            </div>
            {bulk.rows.length > 0 ? (
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Decide for the selected segments</div>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {bulk.rows.map((r) => (
                    <label key={r.type} className="flex items-center gap-2 text-sm">
                      <span>
                        {TYPE_LABEL[r.type] ?? r.type}
                        <span className="ml-1 text-xs text-fg-muted tabular-nums">
                          {r.open.toLocaleString()} in {r.openItems.toLocaleString()} segment{r.openItems === 1 ? "" : "s"}
                        </span>
                      </span>
                      <Select value="" onChange={(e) => e.target.value && decideSelected(r.type, e.target.value)} aria-label={`Decide ${TYPE_LABEL[r.type] ?? r.type} for the selected segments`} className="max-w-xs py-1 text-xs">
                        <option value="">Choose an answer…</option>
                        {r.options.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                            {o.covers < r.open ? ` (covers ${o.covers.toLocaleString()} of ${r.open.toLocaleString()})` : ""}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <span className="pt-1 text-sm text-fg-muted">No open decisions on the selected segments.</span>
            )}
            {m.connected && m.ldEnvs.length > 0 ? (
              <div className="flex items-center gap-3 pt-1 text-sm">
                <span className="text-fg-muted">Migrate to LD:</span>
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

/** Where a segment stands in one LD environment, from that environment's segment list and the provenance footer. */
export function segmentStatus(list: { key: string; tags?: string[] | null; description?: string | null }[] | undefined, r: Pick<SegmentMapResult, "segmentKey" | "statsigFingerprint" | "decisionSetHash">, alias: string): SegmentStatus {
  if (!list) return "unknown";
  const existing = indexByKey(list).get(r.segmentKey);
  if (!existing) return "not_in_ld";
  if (!ownsSegment({ key: existing.key, tags: existing.tags ?? [] }, alias)) return "foreign";
  const f = parseFooter(existing.description);
  if (!f) return "not_migrated";
  if (f.fp !== r.statsigFingerprint) return "statsig_changed";
  if (f.d !== undefined && f.d !== r.decisionSetHash) return "decisions_changed";
  return "in_sync";
}

const UNKNOWN = { label: "reading LaunchDarkly…", tone: "slate" as const, dot: "bg-neutral-fill" };
const statusOf = (s: SegmentStatus) => (s === "unknown" ? UNKNOWN : STATUS[s]);

function UsersCell({ row }: { row: Row }) {
  const title = row.refs.length ? row.refs.map((r) => `${r.kind} ${r.id}${r.archived ? " (archived)" : !r.enabled ? " (disabled)" : ""}`).join("\n") : "No gate, dynamic config or segment rule passes or fails this segment.";
  if (!row.used) {
    return (
      <Badge tone={row.seg.archived ? "slate" : "amber"} title={title}>
        {describeSegmentUsers(row.refs)}
      </Badge>
    );
  }
  return (
    <span className="text-fg-muted" title={title}>
      {describeSegmentUsers(row.refs)}
    </span>
  );
}

function LdCell({ row, connected }: { row: Row; connected: boolean }) {
  if (!connected) return <span className="text-xs text-fg-subtle">—</span>;
  const here = row.strip.find((s) => s.ldEnv === row.ldEnv);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {here && here.status !== "not_in_ld" && here.status !== "unknown" ? <span className="font-mono text-[13px]">{row.result.segmentKey}</span> : <span className="text-xs text-fg-muted">{here?.status === "unknown" ? "reading…" : "not in LD"}</span>}
        {here && here.status !== "not_in_ld" && here.status !== "unknown" && <Badge tone={statusOf(here.status).tone}>{statusOf(here.status).label}</Badge>}
      </div>
      <div className="flex gap-2.5 text-[11px] text-fg-muted">
        {row.strip.map((s) => (
          <span key={s.ldEnv} className="flex items-center gap-1" title={`${s.ldEnv}: ${statusOf(s.status).label}`}>
            <span className={cx("h-2 w-2 rounded-full", statusOf(s.status).dot)} />
            {s.ldEnv}
          </span>
        ))}
      </div>
    </div>
  );
}

function SetAsideCard({ row, m }: { row: Row; m: MigrationContext }) {
  const [reason, setReason] = useState(row.used ? "" : UNUSED_REASON);
  if (row.setAside) {
    return (
      <Card className="flex flex-wrap items-center gap-3 p-3 text-xs">
        <Badge tone="slate">set aside</Badge>
        <span>
          Not to be migrated{row.setAside.reason ? <>: <b>{row.setAside.reason}</b></> : ""} · marked {timeAgo(row.setAside.markedAt)}. It is left out of “Select all”, the guide and plans; a migrated flag that needs it still brings it along.
        </span>
        <Button variant="ghost" className="ml-auto py-1 text-xs" onClick={() => void m.include([row.seg.uid])}>
          Migrate it after all
        </Button>
      </Card>
    );
  }
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3 text-xs">
      <span className="text-fg-muted">{describeSegmentUsers(row.refs)}.</span>
      <Input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-72 py-1 text-xs" aria-label={`Reason not to migrate ${row.seg.id}`} />
      <Button variant="ghost" className="py-1 text-xs" onClick={() => void m.exclude([row.seg.uid], reason.trim() || undefined)}>
        Don't migrate this segment
      </Button>
    </Card>
  );
}

function Detail({ row, m, env, res, readOnly }: { row: Row; m: MigrationContext; env: string; res: ReturnType<typeof resolveRulesForEnvironment>; readOnly?: boolean }) {
  const r = row.result;
  const d = r.desired;
  const stale = new Map(r.stale.map((s) => [s.decision.id, s.previous]));
  const live = row.refs.filter((x) => !x.archived);
  const archived = row.refs.filter((x) => x.archived);
  return (
    <div className="space-y-3 pt-1">
      {!readOnly && !row.seg.archived && <SetAsideCard row={row} m={m} />}
      <div className="grid grid-cols-2 gap-3">
        <Card className="p-3">
          <div className="mb-2 text-xs font-semibold text-fg-muted">StatSig · rules applying in {env}</div>
          {row.seg.segmentType !== "rule_based" && (
            <p className="mb-2 text-xs text-fg-muted">
              {TYPE_BADGE[row.seg.segmentType]}
              {row.seg.idList?.count !== undefined ? ` of ${row.seg.idList.count.toLocaleString()} IDs` : ""}
              {row.seg.idList?.ids ? " (loaded)" : row.seg.idList?.hashed ? " (hashed; a raw-ID upload or Console key is needed)" : ""}.
            </p>
          )}
          <StatsigRules rules={res.rules} overrides={[]} enabled={row.seg.enabled} />
        </Card>
        <Card className="p-3">
          <div className="mb-2 text-xs font-semibold text-fg-muted">
            LaunchDarkly · {r.skipped ? "not migrated" : row.ldEnv ? `proposed for ${row.ldEnv}` : m.connected ? "proposed (environment not mapped)" : "proposed"}
            {r.unresolved.length > 0 && !r.skipped && " (preview with recommended answers)"}
          </div>
          {r.skipped || !d ? (
            <p className="text-xs text-fg-muted">{r.skipped ?? "Nothing to write."}</p>
          ) : (
            <ul className="space-y-1 text-xs">
              <li>
                Key <span className="font-mono">{d.key}</span>
                {d.unbounded && <Badge tone="violet" title="Above LaunchDarkly's 15,000-ID limit for standard segments: a big segment filled by CSV import">big segment</Badge>}
              </li>
              <li>
                {d.rules.length} rule{d.rules.length === 1 ? "" : "s"}
                {d.unbounded ? `, ${d.unbounded.ids.length.toLocaleString()} ${d.unbounded.contextKind} IDs imported` : `, ${(d.included.length + d.includedContexts.reduce((n, c) => n + c.values.length, 0)).toLocaleString()} IDs included`}
              </li>
              {d.tags.length > 0 && <li className="text-fg-muted">tags {d.tags.join(", ")}</li>}
            </ul>
          )}
        </Card>
      </div>
      <Card className="p-3">
        <div className="mb-1.5 text-xs font-semibold text-fg-muted">Used by</div>
        {row.refs.length === 0 ? (
          <p className="text-xs text-fg-muted">No gate, dynamic config or segment rule passes or fails this segment. Unless something outside StatSig's rules reads it, it can be set aside.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5 text-xs">
            {[...live, ...archived].map((x) => (
              <li key={x.uid}>
                <Badge tone={x.archived ? "slate" : x.enabled ? "blue" : "amber"} title={`${x.kind}${x.archived ? ", archived" : x.enabled ? "" : ", disabled"}`}>
                  {x.kind} {x.id}
                  {x.archived ? " · archived" : !x.enabled ? " · disabled" : ""}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {r.fidelity.notes.length > 0 && (
        <Card className="p-3">
          <div className="mb-1.5 text-xs font-semibold text-fg-muted">Fidelity</div>
          <ul className="space-y-1 text-xs">
            {r.fidelity.notes.map((n, i) => (
              <li key={i} className="flex gap-2">
                <Badge tone={FIDELITY_TONE[n.fidelity]}>{n.fidelity}</Badge>
                <span>
                  {n.message}
                  {n.location && <span className="text-fg-subtle"> · {n.location}</span>}
                </span>
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
          {r.unresolved.map((dp) => (
            <DecisionCard key={dp.id} decision={dp} stale={stale.get(dp.id)} compact onChoose={(o) => !readOnly && void m.resolve([dp], o)} {...(readOnly ? {} : { onPolicy: (o: string) => void m.setPolicy(dp.type, o) })} />
          ))}
          {r.applied.map((a) => (
            <DecisionCard key={a.decision.id} decision={a.decision} current={{ optionKey: a.optionKey, via: a.via }} compact onChoose={(o) => !readOnly && void m.resolve([a.decision], o)} />
          ))}
        </div>
      )}
    </div>
  );
}

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import {
  diffSnapshots,
  type EntityKind,
  type SnapshotDiff,
} from "@sslm/canonical";
import {
  WorkspaceStore,
  type SnapshotRecord,
  type SourceRecord,
  type WorkspaceRecord,
} from "@sslm/store";
import {
  Badge,
  Button,
  Callout,
  Card,
  cx,
  PageTitle,
  Select,
  Spinner,
} from "../components/ui.tsx";
import { SOURCE_BADGE, KIND_LABEL } from "../lib/kinds.ts";
import { store } from "../lib/store.ts";
import { timeAgo } from "../lib/time.ts";

type SnapshotRow = Omit<SnapshotRecord, "canonical">;
const RETENTION_CHOICES = [3, 5, 10, 25, 50, 100];

/**
 * Snapshot history per source (PLAN §4.2 "every sync is a new immutable snapshot"). Lists past
 * syncs with size and what used them, lets you view one read-only or compare two, and holds the
 * retention rule that keeps IndexedDB from growing without bound.
 */
export function SnapshotsView({
  workspace,
  sources,
  initialSourceId,
  viewing,
  onView,
}: {
  workspace: WorkspaceRecord;
  sources: SourceRecord[];
  initialSourceId?: string;
  /** sourceId → snapshot id currently pinned for read-only viewing. */
  viewing: Record<string, string>;
  onView: (sourceId: string, snapshotId: string | null) => void;
}) {
  const [sourceId, setSourceId] = useState(
    initialSourceId ?? sources[0]?.id ?? "",
  );
  const source = sources.find((s) => s.id === sourceId);
  const rows = useLiveQuery(
    () =>
      sourceId
        ? store.listSnapshots(sourceId)
        : Promise.resolve([] as SnapshotRow[]),
    [sourceId],
  );
  const runs = useLiveQuery(() => store.listRuns(workspace.id), [workspace.id]);
  const allRows = useLiveQuery(
    async () =>
      (await Promise.all(sources.map((s) => store.listSnapshots(s.id)))).flat(),
    [sources],
  );
  const [pick, setPick] = useState<string[]>([]);
  const [diff, setDiff] = useState<
    { older: SnapshotRow; newer: SnapshotRow; result: SnapshotDiff } | "loading"
  >();
  const estimate = useStorageEstimate(allRows?.length);
  const retention =
    workspace.snapshotRetention ?? WorkspaceStore.DEFAULT_SNAPSHOT_RETENTION;

  const usedBy = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of runs ?? [])
      for (const s of r.snapshots ?? [])
        out.set(
          `${s.sourceId}@${s.takenAt}`,
          (out.get(`${s.sourceId}@${s.takenAt}`) ?? 0) + 1,
        );
    return out;
  }, [runs]);
  const sourceBytes = (rows ?? []).reduce((n, r) => n + (r.bytes ?? 0), 0);
  const workspaceBytes = (allRows ?? []).reduce(
    (n, r) => n + (r.bytes ?? 0),
    0,
  );

  const compare = async (olderId: string, newerId: string) => {
    setDiff("loading");
    const [a, b] = await Promise.all([
      store.getSnapshot(olderId),
      store.getSnapshot(newerId),
    ]);
    if (!a || !b) return setDiff(undefined);
    const [older, newer] = a.takenAt <= b.takenAt ? [a, b] : [b, a];
    const { canonical: _o, ...olderRow } = older;
    const { canonical: _n, ...newerRow } = newer;
    setDiff({
      older: olderRow,
      newer: newerRow,
      result: diffSnapshots(older.canonical, newer.canonical),
    });
  };
  const togglePick = (id: string) =>
    setPick((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2),
    );
  const setRetention = async (n: number) => {
    await store.updateWorkspace(workspace.id, { snapshotRetention: n });
    for (const s of sources) await store.pruneSnapshots(workspace.id, s.id, n);
  };

  return (
    <div className="max-w-5xl space-y-4">
      <PageTitle eyebrow="Workspace">Snapshots</PageTitle>
      <p className="max-w-3xl text-sm text-fg-muted">
        Every sync saves an immutable snapshot of the source. Decisions, mapping
        and migration always use the latest one; older snapshots are kept here
        to look back at or compare. Everything is stored in this browser only.
      </p>

      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-sm">
        <span>
          <span className="text-fg-muted">This workspace:</span>{" "}
          <b className="tabular-nums">{formatBytes(workspaceBytes)}</b>{" "}
          <span className="text-fg-muted">
            in {(allRows ?? []).length} snapshot
            {(allRows ?? []).length === 1 ? "" : "s"}
          </span>
        </span>
        {estimate && (
          <span>
            <span className="text-fg-muted">This site in the browser:</span>{" "}
            <b className="tabular-nums">{formatBytes(estimate.usage)}</b>
            {estimate.quota > 0 && (
              <span className="text-fg-muted">
                {" "}
                of {formatBytes(estimate.quota)} allowed
              </span>
            )}
          </span>
        )}
        <label className="ml-auto flex items-center gap-2">
          <span className="text-fg-muted">Keep the last</span>
          <Select
            value={String(retention)}
            onChange={(e) => void setRetention(Number(e.target.value))}
            aria-label="Snapshots to keep per source"
            className="py-1"
          >
            {RETENTION_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <span className="text-fg-muted">per source, plus any a run used</span>
        </label>
      </Card>

      {sources.length > 1 && (
        <div
          className="flex rounded-md border border-line text-sm"
          role="tablist"
          aria-label="Source"
        >
          {sources.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === sourceId}
              onClick={() => {
                setSourceId(s.id);
                setPick([]);
                setDiff(undefined);
              }}
              className={cx(
                "px-3 py-1.5 first:rounded-l-md last:rounded-r-md",
                s.id === sourceId
                  ? "bg-accent text-on-accent"
                  : "hover:bg-surface-hover",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {!source && (
        <Callout tone="blue">
          Add a StatSig source to start collecting snapshots.
        </Callout>
      )}
      {source && rows && rows.length === 0 && (
        <Callout tone="blue">
          No snapshots yet for {source.label}. Sync it to take the first one.
        </Callout>
      )}

      {source && rows && rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-3 py-2 text-xs text-fg-muted">
            <span>
              {rows.length} snapshot{rows.length === 1 ? "" : "s"} ·{" "}
              {formatBytes(sourceBytes)}
            </span>
            <span className="ml-auto">Tick two to compare them</span>
            <Button
              variant="secondary"
              className="py-1 text-xs"
              disabled={pick.length !== 2}
              onClick={() =>
                pick.length === 2 && void compare(pick[0]!, pick[1]!)
              }
            >
              Compare selected
            </Button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
              <tr>
                <th className="w-9 px-3 py-2" />
                <th className="px-3 py-2">Taken</th>
                <th className="px-3 py-2">Contents</th>
                <th className="px-3 py-2 text-right">Size</th>
                <th className="px-3 py-2">Used by</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((r, i) => {
                const latest = i === 0;
                const viewingThis = viewing[sourceId] === r.id;
                const runsUsing = usedBy.get(`${sourceId}@${r.takenAt}`) ?? 0;
                const previous = rows[i + 1];
                return (
                  <tr
                    key={r.id}
                    className={cx(viewingThis && "bg-selected/40")}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select snapshot from ${new Date(r.takenAt).toLocaleString()} for comparison`}
                        checked={pick.includes(r.id)}
                        onChange={() => togglePick(r.id)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="tabular-nums">
                          {new Date(r.takenAt).toLocaleString()}
                        </span>
                        {latest && <Badge tone="green">latest</Badge>}
                        {viewingThis && <Badge tone="blue">viewing</Badge>}
                        <Badge tone="slate">{SOURCE_BADGE[r.sourceKind].label}</Badge>
                      </div>
                      <div className="text-xs text-fg-subtle">
                        {timeAgo(r.takenAt)}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">
                      {r.summary.gates} gates · {r.summary.configs} configs ·{" "}
                      {r.summary.segments} segments · {r.summary.experiments}{" "}
                      experiments
                      {r.summary.warnings > 0 && (
                        <span className="text-warning">
                          {" "}
                          · {r.summary.warnings} warnings
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-xs tabular-nums">
                      {r.bytes ? formatBytes(r.bytes) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {runsUsing > 0 ? (
                        <Badge
                          tone="violet"
                          title="Kept regardless of the retention rule"
                        >
                          {runsUsing} run{runsUsing === 1 ? "" : "s"}
                        </Badge>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {previous && (
                          <Button
                            variant="ghost"
                            className="py-1 text-xs"
                            onClick={() => void compare(previous.id, r.id)}
                            title="What changed since the snapshot before this one"
                          >
                            Changes
                          </Button>
                        )}
                        {viewingThis ? (
                          <Button
                            variant="secondary"
                            className="py-1 text-xs"
                            onClick={() => onView(sourceId, null)}
                          >
                            Back to latest
                          </Button>
                        ) : (
                          !latest && (
                            <Button
                              variant="ghost"
                              className="py-1 text-xs"
                              onClick={() => onView(sourceId, r.id)}
                              title="Browse the workspace as it was at this snapshot (read-only)"
                            >
                              View
                            </Button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {diff === "loading" && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Comparing…
        </div>
      )}
      {diff && diff !== "loading" && (
        <DiffPanel diff={diff} onClose={() => setDiff(undefined)} />
      )}
    </div>
  );
}

function DiffPanel({
  diff,
  onClose,
}: {
  diff: { older: SnapshotRow; newer: SnapshotRow; result: SnapshotDiff };
  onClose: () => void;
}) {
  const { result } = diff;
  const total =
    result.added.length + result.removed.length + result.changed.length;
  const byKind = <T extends { kind: EntityKind }>(xs: T[]) => {
    const out = new Map<EntityKind, T[]>();
    for (const x of xs) out.set(x.kind, [...(out.get(x.kind) ?? []), x]);
    return [...out.entries()];
  };
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">
          Changes from {new Date(diff.older.takenAt).toLocaleString()} to{" "}
          {new Date(diff.newer.takenAt).toLocaleString()}
        </h3>
        <Badge tone="green">{result.added.length} added</Badge>
        <Badge tone="red">{result.removed.length} removed</Badge>
        <Badge tone="amber">{result.changed.length} changed</Badge>
        <Button
          variant="ghost"
          className="ml-auto py-1 text-xs"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
      {total === 0 && (
        <p className="mt-2 text-sm text-fg-muted">
          {result.onlyTimeChanged
            ? "Nothing changed apart from timestamps."
            : "No differences."}
        </p>
      )}
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <ChangeList
          title="Added"
          tone="green"
          groups={byKind(result.added)}
          render={(x) => <code>{x.id}</code>}
        />
        <ChangeList
          title="Removed"
          tone="red"
          groups={byKind(result.removed)}
          render={(x) => <code>{x.id}</code>}
        />
        <ChangeList
          title="Changed"
          tone="amber"
          groups={byKind(result.changed)}
          render={(x) => (
            <>
              <code>{x.id}</code>
              <span className="text-fg-subtle">
                {x.targetingChangedIn.length > 0 &&
                  ` targeting in ${x.targetingChangedIn.join(", ")}`}
                {x.targetingChangedIn.length > 0 && x.otherChanged && ";"}
                {x.otherChanged && " settings or metadata"}
              </span>
            </>
          )}
        />
      </div>
    </Card>
  );
}

const SHOW_STEP = 50;

function ChangeList<T extends { kind: EntityKind; id: string }>({
  title,
  tone,
  groups,
  render,
}: {
  title: string;
  tone: "green" | "red" | "amber";
  groups: [EntityKind, T[]][];
  render: (x: T) => React.ReactNode;
}) {
  const [limit, setLimit] = useState(SHOW_STEP);
  const flat = groups.flatMap(([kind, xs]) => xs.map((x) => ({ kind, x })));
  if (flat.length === 0) return null;
  let shown = 0;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-fg-muted">
        <Badge tone={tone}>{title}</Badge> {flat.length}
      </div>
      <ul className="space-y-1 text-xs">
        {groups.map(([kind, xs]) => {
          const remaining = Math.max(0, limit - shown);
          const slice = xs.slice(0, remaining);
          shown += slice.length;
          if (slice.length === 0) return null;
          return (
            <li key={kind}>
              <div className="text-fg-subtle">{KIND_LABEL[kind]}</div>
              <ul className="ml-2 space-y-0.5">
                {slice.map((x) => (
                  <li key={x.id} className="flex flex-wrap gap-1">
                    {render(x)}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      {flat.length > limit && (
        <button
          className="mt-1 text-xs text-fg-muted hover:text-fg"
          onClick={() => setLimit((n) => n + SHOW_STEP)}
        >
          Show {Math.min(SHOW_STEP, flat.length - limit)} more
        </button>
      )}
    </div>
  );
}

/** navigator.storage.estimate(), refreshed when the snapshot count changes. Absent where unsupported. */
function useStorageEstimate(
  dep: number | undefined,
): { usage: number; quota: number } | undefined {
  const [est, setEst] = useState<{ usage: number; quota: number }>();
  useEffect(() => {
    let cancelled = false;
    navigator.storage
      ?.estimate?.()
      .then(
        (e) =>
          !cancelled && setEst({ usage: e.usage ?? 0, quota: e.quota ?? 0 }),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dep]);
  return est;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

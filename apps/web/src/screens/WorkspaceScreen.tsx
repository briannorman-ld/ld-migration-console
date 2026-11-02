import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  countsByKind,
  ENTITY_KINDS,
  type CanonicalSnapshot,
  type EntityKind,
} from "@sslm/canonical";
import type { SourceRecord } from "@sslm/store";
import { LdMark } from "../components/Brand.tsx";
import { UnlockKeysBar } from "../components/DeviceVault.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import {
  appendLog,
  describeProgress,
  describeTransportEvent,
  SyncActivity,
  type SyncLogEntry,
} from "../components/SyncActivity.tsx";
import {
  Badge,
  Button,
  Callout,
  cx,
  Dot,
  Select,
  Spinner,
} from "../components/ui.tsx";
import { describeScope, KIND_LABEL, refreshable, secretKindOf, SOURCE_BADGE } from "../lib/kinds.ts";
import { timeAgo } from "../lib/time.ts";
import { useLdSession } from "../lib/ld.ts";
import { secrets } from "../lib/secrets.ts";
import {
  collectDecisions,
  fetchDeferredIdLists,
  isInterrupted,
  type MigrationSelection,
} from "../lib/migration.ts";
import { monitoredItems, useMonitoring, useMonitorNotifications, useMonitorSchedule } from "../lib/monitor.ts";
import { store } from "../lib/store.ts";
import { syncSource } from "../lib/sync.ts";
import { useMigration } from "../lib/useMigration.ts";
import { AddSource } from "./AddSource.tsx";
import { AutotunesSideBySide } from "./AutotunesSideBySide.tsx";
import { ConnectionsView } from "./ConnectionsView.tsx";
import { CoverageView } from "./CoverageView.tsx";
import { DecisionsView } from "./DecisionsView.tsx";
import { EntityList } from "./EntityList.tsx";
import { FlagSideBySide } from "./GatesSideBySide.tsx";
import { LdPanel } from "./LdPanel.tsx";
import { LdSourceSideBySide, type LdSourceResource } from "./LdSourceSideBySide.tsx";
import { MappingView } from "./MappingView.tsx";
import { MigrateModal } from "./MigrateModal.tsx";
import { MonitoringView } from "./MonitoringView.tsx";
import { RunsView } from "./RunsView.tsx";
import { SnapshotsView } from "./SnapshotsView.tsx";
import { WarningsView } from "./WarningsView.tsx";

export type View =
  | { kind: "resource"; resource: EntityKind }
  /** Flags or segments of an LD project attached as a source (PLAN §20). */
  | { kind: "ld-source"; resource: LdSourceResource }
  | { kind: "connections" }
  | { kind: "ld" }
  | { kind: "warnings" }
  | { kind: "add-source" }
  | { kind: "decisions" }
  | { kind: "mapping" }
  | { kind: "runs" }
  | { kind: "monitoring" }
  | { kind: "snapshots"; sourceId?: string }
  | { kind: "coverage"; focus?: string };

interface SyncState {
  running: boolean;
  done?: number;
  total?: number;
  endpoint?: string;
  /** Live request log; kept after a failure so the last requests explain the error. */
  log: SyncLogEntry[];
  error?: string;
}

export function WorkspaceScreen({
  workspaceId,
  onExit,
}: {
  workspaceId: string;
  onExit: () => void;
}) {
  // Wrapped so "still loading" and "no such workspace" (a stale URL after the workspace was
  // deleted) can be told apart; the latter goes back to the start screen.
  const workspaceQuery = useLiveQuery(
    async () => ({ ws: await store.getWorkspace(workspaceId) }),
    [workspaceId],
  );
  const workspace = workspaceQuery?.ws;
  useEffect(() => {
    if (workspaceQuery && !workspaceQuery.ws) onExit();
  }, [workspaceQuery, onExit]);
  const sources = useLiveQuery(
    () => store.listSources(workspaceId),
    [workspaceId],
  );
  // sourceId → snapshot id pinned for read-only viewing of a past sync (Snapshots view). Empty = latest.
  const [viewing, setViewing] = useState<Record<string, string>>({});
  const snapshotQuery = useLiveQuery(async () => {
    const out: Record<string, CanonicalSnapshot | undefined> = {};
    for (const s of sources ?? []) {
      const pinned = viewing[s.id];
      out[s.id] = (
        pinned
          ? await store.getSnapshot(pinned)
          : await store.latestSnapshot(s.id)
      )?.canonical;
    }
    return { for: sources, viewing, snapshots: out };
  }, [sources, viewing]);
  // Only trust a result computed for the current source list and pin set (useLiveQuery returns the
  // previous result while re-querying, which made the demo re-sync on every open).
  const snapshots =
    snapshotQuery &&
    snapshotQuery.for === sources &&
    snapshotQuery.viewing === viewing
      ? snapshotQuery.snapshots
      : undefined;
  const viewingPast = Object.keys(viewing).length > 0;
  const pastLabel = (sources ?? [])
    .filter((s) => viewing[s.id])
    .map(
      (s) =>
        `${s.label} as of ${snapshots?.[s.id] ? new Date(snapshots[s.id]!.takenAt).toLocaleString() : "…"}`,
    )
    .join("; ");
  const [view, setView] = useState<View>({
    kind: "resource",
    resource: "gate",
  });
  const [env, setEnv] = useState<string>("");
  const [sync, setSync] = useState<Record<string, SyncState>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const ld = useLdSession(workspaceId);
  const autoSynced = useRef(new Set<string>());
  const [migrate, setMigrate] = useState<{
    selection: MigrationSelection;
    ldEnvs: string[];
  }>();
  const runs = useLiveQuery(() => store.listRuns(workspaceId), [workspaceId]);

  const runSync = async (s: SourceRecord) => {
    const patch = (f: (cur: SyncState) => SyncState) =>
      setSync((x) => ({
        ...x,
        [s.id]: f(x[s.id] ?? { running: true, log: [] }),
      }));
    const push = (e: SyncLogEntry) =>
      patch((cur) => ({ ...cur, log: appendLog(cur.log, e) }));
    setSync((x) => ({ ...x, [s.id]: { running: true, log: [] } }));
    try {
      await syncSource(workspaceId, s, {
        onProgress: (p) => {
          patch((cur) => ({
            ...cur,
            running: true,
            done: p.done,
            total: p.total,
            endpoint: p.endpoint,
          }));
          push(describeProgress(p));
        },
        onTransport: (e) => push(describeTransportEvent(e)),
      });
      setSync((x) => ({ ...x, [s.id]: { running: false, log: [] } }));
    } catch (e) {
      patch((cur) => ({ ...cur, running: false, error: (e as Error).message }));
    }
  };

  // Removing a source drops its snapshots and fetched ID lists from this browser and forgets its
  // key. Nothing in the source or in LaunchDarkly changes; the source can be added again later.
  const removeSource = async (s: SourceRecord) => {
    const synced = snapshots?.[s.id];
    if (
      !window.confirm(
        `Remove "${s.label}" from this workspace?${synced ? " Its synced snapshot is deleted from this browser." : ""} The source project itself is not touched.`,
      )
    )
      return;
    const secretKind = secretKindOf(s);
    if (secretKind) secrets.forget(secretKind, s.id);
    await store.removeSource(s.id);
    setSync((x) => {
      const { [s.id]: _, ...rest } = x;
      return rest;
    });
    setHidden((h) => (h.has(s.id) ? toggle(h, s.id) : h));
    setViewing(({ [s.id]: _p, ...rest }) => rest);
  };

  // A workspace with no sources yet (just created) opens on Connections: one place to connect
  // StatSig and one to connect LaunchDarkly. Decided once, when the source list first loads.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !sources) return;
    landed.current = true;
    if (sources.length === 0) setView({ kind: "connections" });
  }, [sources]);

  // First open of a demo workspace: sync every live demo source that has no snapshot yet.
  useEffect(() => {
    if (!sources || !snapshots) return;
    for (const s of sources) {
      if (
        refreshable(s) &&
        s.isDemo &&
        !snapshots[s.id] &&
        !autoSynced.current.has(s.id)
      ) {
        autoSynced.current.add(s.id);
        void runSync(s);
      }
    }
  }, [sources, snapshots]);

  const visible = useMemo(
    () => (sources ?? []).filter((s) => !hidden.has(s.id) && snapshots?.[s.id]),
    [sources, snapshots, hidden],
  );
  // Memoized: every heavy memo below (envs, counts, decisions, the migration context) keys on this
  // array, and rebuilding it per render made each click re-map the whole project.
  const visibleSnaps = useMemo(
    () => visible.map((s) => snapshots![s.id]!),
    [visible, snapshots],
  );
  const envs = useMemo(() => {
    const names = new Set<string>();
    for (const sn of visibleSnaps)
      for (const e of sn.environments) names.add(e.name);
    return [...names];
  }, [visibleSnaps]);
  useEffect(() => {
    if (envs.length && !envs.includes(env))
      setEnv(envs.includes("production") ? "production" : envs[0]!);
  }, [envs, env]);

  const counts = useMemo(() => {
    const out = Object.fromEntries(ENTITY_KINDS.map((k) => [k, 0])) as Record<
      EntityKind,
      number
    >;
    for (const sn of visibleSnaps) {
      const c = countsByKind(sn);
      for (const k of ENTITY_KINDS) out[k] += c[k];
    }
    return out;
  }, [visibleSnaps]);
  const warningCount = visibleSnaps.reduce((n, s) => n + s.warnings.length, 0);
  // Resources of LD-source projects (PLAN §20) live in the snapshot's neutral block, not in the StatSig kinds.
  const neutralCounts = useMemo(
    () => visibleSnaps.reduce((acc, s) => ({ flags: acc.flags + (s.neutral?.flags.length ?? 0), segments: acc.segments + (s.neutral?.segments.length ?? 0) }), { flags: 0, segments: 0 }),
    [visibleSnaps],
  );
  const hasLdSource = visibleSnaps.some((s) => s.neutral);
  const m = useMigration(workspaceId, visibleSnaps);
  const openDecisions = useMemo(
    () =>
      m
        ? collectDecisions(visibleSnaps, m.profile, m.connected, m).filter(
            (d) => !d.resolvedWith,
          )
        : [],
    [m, visibleSnaps],
  );
  const blockingCount = openDecisions.filter(
    (d) => d.decision.severity === "blocking",
  ).length;
  const interrupted = (runs ?? []).filter((r) => isInterrupted(r, workspaceId));

  // Monitoring (PLAN §14): a read-only LD check on connect and every 15 minutes while the tab is
  // open; drift rows come from the same memoized mapping results the explorers use.
  const monitorItems = useMemo(
    () => (m ? monitoredItems(visibleSnaps, m, m.connected) : []),
    [m, visibleSnaps],
  );
  const monitoring = useMonitoring(workspaceId, monitorItems, ld);
  useMonitorSchedule(workspaceId, ld, visibleSnaps, !viewingPast);
  useMonitorNotifications(workspaceId, monitoring);

  // Load deferred ID lists (≤15k IDs) once per snapshot, so small list segments don't sit behind an
  // "ID list not loaded" decision. Bigger lists (big segments) load on request from Source warnings.
  const fetchedFor = useRef(new Set<string>());
  useEffect(() => {
    if (!m || !sources) return;
    const pending = visibleSnaps.filter(
      (sn) => !fetchedFor.current.has(`${sn.source.sourceId}@${sn.takenAt}`),
    );
    if (!pending.length) return;
    pending.forEach((sn) =>
      fetchedFor.current.add(`${sn.source.sourceId}@${sn.takenAt}`),
    );
    void fetchDeferredIdLists(workspaceId, sources, pending, m.idLists).catch(
      () => undefined,
    );
  }, [m, visibleSnaps, sources, workspaceId]);

  const explorerNav = {
    connections: () => setView({ kind: "connections" }),
    ld: () => setView({ kind: "ld" }),
    mapping: () => setView({ kind: "mapping" }),
    decisions: () => setView({ kind: "decisions" }),
  };

  if (!workspace)
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-fg-muted">
        <Spinner /> Loading…
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <button
          type="button"
          onClick={onExit}
          title="All workspaces"
          className="flex items-center gap-2.5 rounded-md py-1 pr-2 pl-1 transition-colors hover:bg-surface-hover"
        >
          <LdMark className="h-5 w-5 text-logo" />
          <span className="font-display text-[13px] font-semibold tracking-tight text-fg">
            Migration Console
          </span>
        </button>
        <span aria-hidden className="h-5 w-px bg-line" />
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-fg">
            {workspace.name}
          </h1>
          {workspace.isDemo && <Badge tone="violet">demo</Badge>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {envs.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              Environment
              <Select
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                aria-label="Environment"
                className="py-1"
              >
                {envs.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <button
            type="button"
            onClick={() => setView({ kind: "ld" })}
            className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm text-fg shadow-card transition-colors hover:border-line-strong hover:bg-surface-hover"
          >
            <Dot
              tone={
                ld.status === "connected"
                  ? "green"
                  : ld.status === "error"
                    ? "red"
                    : "slate"
              }
            />
            {ld.status === "connected"
              ? ld.projectKey
                ? `LD · ${ld.projectKey}`
                : "LD · choose project"
              : "Connect LaunchDarkly"}
            {ld.matrix && (
              <Badge tone="blue">
                {
                  ld.matrix.capabilities.filter((c) => c.status === "available")
                    .length
                }{" "}
                capabilities
              </Badge>
            )}
          </button>
          <ThemeToggle />
        </div>
      </header>

      <UnlockKeysBar workspaceId={workspaceId} workspace={workspace} />
      {viewingPast && (
        <div
          className="flex flex-wrap items-center gap-3 border-b border-warning-line bg-warning-fill/10 px-4 py-2 text-sm"
          role="status"
        >
          <Badge tone="amber">past snapshot</Badge>
          <span>
            Viewing <b>{pastLabel}</b>. Read-only: decisions, mapping and
            migration use the latest sync.
          </span>
          <Button
            variant="secondary"
            className="ml-auto py-1 text-xs"
            onClick={() => setViewing({})}
          >
            Back to latest
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          className="w-72 shrink-0 overflow-y-auto border-r border-line bg-surface p-3"
          aria-label="Workspace"
        >
          <SectionTitle>Sources</SectionTitle>
          <ul className="space-y-1.5">
            {(sources ?? []).map((s) => {
              const sn = snapshots?.[s.id];
              const st = sync[s.id];
              return (
                <li
                  key={s.id}
                  className="rounded-md border border-line p-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!hidden.has(s.id)}
                      aria-label={`Include ${s.label}`}
                      onChange={() => setHidden((h) => toggle(h, s.id))}
                    />
                    <span className="font-medium">{s.label}</span>
                    <Badge tone={SOURCE_BADGE[s.kind].tone}>
                      {SOURCE_BADGE[s.kind].label}
                    </Badge>
                    <span className="ml-auto flex items-center gap-1">
                      {refreshable(s) && (
                        <button
                          type="button"
                          className="rounded px-1 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40"
                          title={`Refresh from ${SOURCE_BADGE[s.kind].label}`}
                          aria-label={`Refresh ${s.label} from ${SOURCE_BADGE[s.kind].label}`}
                          disabled={st?.running}
                          onClick={() => runSync(s)}
                        >
                          ↻
                        </button>
                      )}
                      <button
                        type="button"
                        className="rounded px-1 text-fg-muted hover:bg-surface-hover hover:text-error disabled:opacity-40"
                        title="Remove this source"
                        aria-label={`Remove ${s.label}`}
                        disabled={st?.running}
                        onClick={() => void removeSource(s)}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    {st?.running ? (
                      <span className="flex items-center gap-1.5">
                        <Spinner /> {st.done ?? 0}/{st.total ?? "…"}{" "}
                        {st.endpoint}
                      </span>
                    ) : sn ? (
                      <>
                        {sn.projectName && (
                          <span
                            className="block truncate"
                            title={s.kind === "launchdarkly" ? `LaunchDarkly project “${sn.projectName}” (${s.ld?.projectKey ?? ""} on ${s.ld?.instance ?? "us"})` : `StatSig project “${sn.projectName}” (one Console key reads one project)`}
                          >
                            project {sn.projectName}
                          </span>
                        )}
                        synced {timeAgo(sn.takenAt)}
                        {sn.isWarehouseNative ? " · Warehouse Native" : ""}
                      </>
                    ) : (
                      "not synced"
                    )}
                    {s.resources && (
                      <div
                        className="mt-0.5 truncate"
                        title={`Reads only: ${describeScope(s.resources)}`}
                      >
                        reads {describeScope(s.resources)}
                      </div>
                    )}
                    {sn && (
                      <button
                        type="button"
                        className="mt-0.5 block text-link hover:underline"
                        onClick={() =>
                          setView({ kind: "snapshots", sourceId: s.id })
                        }
                      >
                        {viewing[s.id] ? "viewing a past snapshot" : "history"}
                      </button>
                    )}
                  </div>
                  {st?.error && (
                    <div className="mt-1 text-xs text-error">{st.error}</div>
                  )}
                  {st && (st.running || (st.error && st.log.length > 0)) && (
                    <SyncActivity
                      log={st.log}
                      running={st.running}
                      className="mt-2"
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <Button
            variant="ghost"
            className="mt-1.5 w-full justify-start text-sm"
            onClick={() => setView({ kind: "add-source" })}
          >
            + Add source
          </Button>

          <SectionTitle>Resources</SectionTitle>
          <ul>
            {ENTITY_KINDS.map((k) => (
              <li key={k}>
                <NavItem
                  active={view.kind === "resource" && view.resource === k}
                  onClick={() => setView({ kind: "resource", resource: k })}
                >
                  <span>{KIND_LABEL[k]}</span>
                  <span className="text-fg-muted tabular-nums">
                    {counts[k]}
                  </span>
                </NavItem>
              </li>
            ))}
          </ul>

          {hasLdSource && (
            <>
              <SectionTitle>LaunchDarkly source</SectionTitle>
              <ul>
                {(["flag", "segment"] as const).map((k) => (
                  <li key={k}>
                    <NavItem
                      active={view.kind === "ld-source" && view.resource === k}
                      onClick={() => setView({ kind: "ld-source", resource: k })}
                    >
                      <span>{k === "flag" ? "Flags" : "Segments"}</span>
                      <span className="text-fg-muted tabular-nums">
                        {k === "flag" ? neutralCounts.flags : neutralCounts.segments}
                      </span>
                    </NavItem>
                  </li>
                ))}
              </ul>
            </>
          )}

          <SectionTitle>Migration</SectionTitle>
          <NavItem
            active={view.kind === "decisions"}
            onClick={() => setView({ kind: "decisions" })}
          >
            <span>Decisions</span>
            {openDecisions.length > 0 && (
              <span className="flex gap-1">
                {blockingCount > 0 && <Badge tone="red">{blockingCount}</Badge>}
                <Badge tone="amber">
                  {openDecisions.length - blockingCount}
                </Badge>
              </span>
            )}
          </NavItem>
          <NavItem
            active={view.kind === "mapping"}
            onClick={() => setView({ kind: "mapping" })}
          >
            <span>Mapping</span>
          </NavItem>
          <NavItem
            active={view.kind === "runs"}
            onClick={() => setView({ kind: "runs" })}
          >
            <span>Runs</span>
            {interrupted.length > 0 ? (
              <Badge tone="amber">interrupted</Badge>
            ) : runs?.length ? (
              <span className="text-fg-muted tabular-nums">{runs.length}</span>
            ) : null}
          </NavItem>
          <NavItem
            active={view.kind === "monitoring"}
            onClick={() => setView({ kind: "monitoring" })}
          >
            <span>Monitoring</span>
            {monitoring.attention > 0 && (
              <Badge tone="amber">{monitoring.attention}</Badge>
            )}
          </NavItem>
          <NavItem
            active={view.kind === "coverage"}
            onClick={() => setView({ kind: "coverage" })}
          >
            <span>What migrates</span>
          </NavItem>

          <SectionTitle>Workspace</SectionTitle>
          <NavItem
            active={view.kind === "connections"}
            onClick={() => setView({ kind: "connections" })}
          >
            <span>Connections</span>
            {(sources ?? []).length === 0 || ld.status !== "connected" ? (
              <Badge tone="amber">setup</Badge>
            ) : null}
          </NavItem>
          <NavItem
            active={view.kind === "ld"}
            onClick={() => setView({ kind: "ld" })}
          >
            <span>LaunchDarkly & capabilities</span>
          </NavItem>
          <NavItem
            active={view.kind === "warnings"}
            onClick={() => setView({ kind: "warnings" })}
          >
            <span>Source warnings</span>
            {warningCount > 0 && <Badge tone="amber">{warningCount}</Badge>}
          </NavItem>
          <NavItem
            active={view.kind === "snapshots"}
            onClick={() => setView({ kind: "snapshots" })}
          >
            <span>Snapshots</span>
            {viewingPast && <Badge tone="amber">past</Badge>}
          </NavItem>
          <p className="mt-6 px-2 text-xs text-fg-subtle">
            Gates, dynamic configs, segments and autotunes (as drafted bandits)
            migrate from StatSig; flags and segments migrate from another
            LaunchDarkly project.{" "}
            <button
              type="button"
              className="text-link hover:underline"
              onClick={() => setView({ kind: "coverage" })}
            >
              See what else migrates, and what doesn’t.
            </button>
          </p>
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {interrupted.length > 0 && view.kind !== "runs" && (
            <div className="mb-3">
              <Callout>
                A migration run was interrupted (the tab closed while it ran).{" "}
                <button
                  className="font-medium underline"
                  onClick={() => setView({ kind: "runs" })}
                >
                  Review and resume
                </button>
              </Callout>
            </div>
          )}
          {visible.length === 0 &&
            (view.kind === "resource" ||
              view.kind === "ld-source" ||
              view.kind === "decisions" ||
              view.kind === "mapping" ||
              view.kind === "monitoring") && (
              <Callout tone="blue">
                {(sources ?? []).length === 0 ? (
                  <>
                    <button
                      className="font-medium underline"
                      onClick={() => setView({ kind: "connections" })}
                    >
                      Connect a source
                    </button>{" "}
                    to get started.
                  </>
                ) : (
                  "Waiting for the first sync…"
                )}
              </Callout>
            )}
          {view.kind === "resource" &&
            visible.length > 0 &&
            (view.resource === "gate" || view.resource === "config" ? (
              m && (
                <FlagSideBySide
                  kind={view.resource}
                  sources={visible}
                  snapshots={snapshots ?? {}}
                  env={env}
                  m={m}
                  readOnly={viewingPast}
                  onMigrate={(uids, ldEnvs) =>
                    setMigrate({
                      selection:
                        view.resource === "config"
                          ? { gates: [], configs: uids, autotunes: [] }
                          : { gates: uids, autotunes: [] },
                      ldEnvs,
                    })
                  }
                  onOpenMapping={() => setView({ kind: "mapping" })}
                  nav={explorerNav}
                />
              )
            ) : view.resource === "autotune" ? (
              m && (
                <AutotunesSideBySide
                  sources={visible}
                  snapshots={snapshots ?? {}}
                  env={env}
                  m={m}
                  readOnly={viewingPast}
                  onMigrate={(autotunes, ldEnvs) =>
                    setMigrate({ selection: { gates: [], autotunes }, ldEnvs })
                  }
                  nav={explorerNav}
                />
              )
            ) : (
              <EntityList
                kind={view.resource}
                label={KIND_LABEL[view.resource]}
                sources={visible}
                snapshots={snapshots ?? {}}
                onOpenCoverage={(focus) => setView({ kind: "coverage", focus })}
              />
            ))}
          {view.kind === "ld-source" && visible.length > 0 && m && (
            <LdSourceSideBySide
              resource={view.resource}
              sources={visible}
              snapshots={snapshots ?? {}}
              env={env}
              m={m}
              readOnly={viewingPast}
              onMigrate={(sel, ldEnvs) =>
                setMigrate({ selection: { gates: [], autotunes: [], ...sel }, ldEnvs })
              }
              nav={explorerNav}
            />
          )}
          {viewingPast &&
            (view.kind === "decisions" ||
              view.kind === "mapping" ||
              view.kind === "runs" ||
              view.kind === "monitoring") && (
              <Callout>
                You are viewing a past snapshot. Decisions, mapping and runs
                always work on the latest sync.{" "}
                <button
                  className="font-medium underline"
                  onClick={() => setViewing({})}
                >
                  Back to latest
                </button>
              </Callout>
            )}
          {!viewingPast &&
            view.kind === "decisions" &&
            m &&
            visible.length > 0 && (
              <DecisionsView
                snapshots={visibleSnaps}
                m={m}
                workspaceName={workspace.name}
                env={env}
              />
            )}
          {!viewingPast &&
            view.kind === "mapping" &&
            m &&
            visible.length > 0 && (
              <MappingView
              workspaceId={workspaceId}
              sources={visible}
                snapshots={snapshots ?? {}}
                m={m}
                onConnect={() => setView({ kind: "ld" })}
              />
            )}
          {!viewingPast && view.kind === "runs" && m && (
            <RunsView workspaceId={workspaceId} m={m} />
          )}
          {!viewingPast && view.kind === "monitoring" && m && (
            <MonitoringView
              workspaceId={workspaceId}
              workspace={workspace}
              sources={visible}
              snapshots={visibleSnaps}
              m={m}
              data={monitoring}
              onMigrate={(selection, ldEnvs) => setMigrate({ selection, ldEnvs })}
              onResyncSource={(s) => void runSync(s)}
            />
          )}
          {view.kind === "snapshots" && (
            <SnapshotsView
              workspace={workspace}
              sources={sources ?? []}
              {...(view.sourceId ? { initialSourceId: view.sourceId } : {})}
              viewing={viewing}
              onView={(sourceId, snapshotId) => {
                setViewing((v) => {
                  const { [sourceId]: _old, ...rest } = v;
                  return snapshotId
                    ? { ...rest, [sourceId]: snapshotId }
                    : rest;
                });
                if (snapshotId) setView({ kind: "resource", resource: "gate" });
              }}
            />
          )}
          {view.kind === "connections" && (
            <ConnectionsView
              workspace={workspace}
              sources={sources ?? []}
              snapshots={snapshots ?? {}}
              ld={ld}
              onAddSource={() => setView({ kind: "add-source" })}
              onRemoveSource={removeSource}
              onOpenLd={() => setView({ kind: "ld" })}
              onOpenGates={() =>
                setView({ kind: "resource", resource: "gate" })
              }
            />
          )}
          {view.kind === "ld" && (
            <LdPanel workspaceId={workspaceId} workspace={workspace} />
          )}
          {view.kind === "coverage" && (
            <CoverageView
              sources={sources ?? []}
              snapshots={snapshots ?? {}}
              focus={view.focus}
              onOpenResource={(resource) =>
                setView({ kind: "resource", resource })
              }
            />
          )}
          {view.kind === "warnings" && (
            <WarningsView
              workspaceId={workspaceId}
              sources={visible}
              snapshots={snapshots ?? {}}
              m={m}
              onResync={(s) => void runSync(s)}
            />
          )}
          {view.kind === "add-source" && (
            <AddSource
              workspaceId={workspaceId}
              onDone={() =>
                setView(
                  ld.status === "connected"
                    ? { kind: "resource", resource: "gate" }
                    : { kind: "connections" },
                )
              }
            />
          )}
        </main>
      </div>
      {migrate && m && (
        <MigrateModal
          workspaceId={workspaceId}
          selection={migrate.selection}
          ldEnvs={migrate.ldEnvs}
          sources={visible}
          snapshots={visibleSnaps}
          m={m}
          onClose={() => setMigrate(undefined)}
        />
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-4 mb-1.5 px-2 text-xs font-semibold tracking-wide text-fg-muted uppercase first:mt-0">
      {children}
    </h2>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150",
        active
          ? "bg-selected font-medium text-selected-fg"
          : "text-fg-muted hover:bg-surface-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function toggle(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

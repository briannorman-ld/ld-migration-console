import { Fragment, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  matchAcrossSources,
  overridesForEnvironment,
  resolveRulesForEnvironment,
  type CanonicalSnapshot,
  type Config,
  type Gate,
} from "@sslm/canonical";
import { LD_INSTANCES } from "@sslm/ld-client";
import type { ConfigMapResult, DecisionType, GateMapResult } from "@sslm/mapper";
import { migrationStatus, type MigrationStatus } from "@sslm/planner";
import type { SourceRecord } from "@sslm/store";
import {
  DecisionCard,
  FIDELITY_TONE,
  TYPE_LABEL,
} from "../components/DecisionCard.tsx";
import { PagerBar, usePager } from "../components/Pager.tsx";
import {
  MigrateButton,
  ReadinessLine,
  readinessSteps,
} from "../components/Readiness.tsx";
import { summarizeDecisions } from "../lib/decisionSummary.ts";
import type { DecisionInstance } from "../lib/migration.ts";
import { LdTargeting, StatsigRules } from "../components/Targeting.tsx";
import {
  Badge,
  Button,
  Callout,
  Card,
  cx,
  Input,
  Select,
} from "../components/ui.tsx";
import { ldFlagState, mapConfigFor, mapGateFor, type MappingInputs } from "../lib/migration.ts";
import type { MigrationContext } from "../lib/useMigration.ts";
import type { ExplorerNav } from "./AutotunesSideBySide.tsx";

export const STATUS: Record<
  MigrationStatus,
  {
    label: string;
    tone: "slate" | "green" | "amber" | "red" | "violet";
    dot: string;
  }
> = {
  not_in_ld: { label: "not migrated", tone: "slate", dot: "bg-neutral-fill" },
  not_migrated: {
    label: "not migrated here",
    tone: "slate",
    dot: "bg-neutral-fill",
  },
  in_sync: { label: "in sync", tone: "green", dot: "bg-success-fill" },
  statsig_changed: {
    label: "StatSig changed",
    tone: "amber",
    dot: "bg-warning-fill",
  },
  decisions_changed: {
    label: "decisions changed",
    tone: "amber",
    dot: "bg-warning-fill",
  },
  foreign: { label: "existing LD key", tone: "red", dot: "bg-error-fill" },
  other_source: {
    label: "migrated from another source",
    tone: "violet",
    dot: "bg-purple-fill",
  },
};

type StatusFilter =
  "all" | "open" | "blocking" | "not_migrated" | "in_sync" | "changed";

/** The two StatSig resources that become plain LD flags: gates (boolean) and dynamic configs (JSON). */
export type FlagKind = "gate" | "config";
type FlagEntity = Gate | Config;
type FlagMapResult = GateMapResult | ConfigMapResult;

const LABEL: Record<FlagKind, { title: string; one: string; many: string }> = {
  gate: { title: "Gates", one: "gate", many: "gates" },
  config: { title: "Dynamic configs", one: "config", many: "configs" },
};

function mapFlagFor(
  snap: CanonicalSnapshot,
  entity: FlagEntity,
  env: { statsig: string; ld: string },
  i: MappingInputs,
): FlagMapResult {
  return entity.kind === "config"
    ? mapConfigFor(snap, entity, env, i)
    : mapGateFor(snap, entity, env, i);
}

interface Row {
  sourceId: string;
  gate: FlagEntity;
  shared: number;
  ldEnv: string | null;
  result: FlagMapResult;
  /** Per LD environment, for the status strip. */
  strip: { ldEnv: string; status: MigrationStatus }[];
}

/**
 * Side-by-side gates and dynamic configs (PLAN §9): StatSig on the left, LD on the right, with the
 * per-environment status strip read from LD provenance, fidelity and open decisions, and the
 * Migrate action. Gates become boolean flags; configs become JSON flags whose variations are the
 * default value plus every distinct rule value (PLAN §10.1).
 */
export function FlagSideBySide({
  kind,
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
  kind: FlagKind;
  sources: SourceRecord[];
  snapshots: Record<string, CanonicalSnapshot | undefined>;
  env: string;
  m: MigrationContext;
  onMigrate: (uids: string[], ldEnvs: string[]) => void;
  onOpenMapping: () => void;
  /** Where the readiness line sends people to fix a missing precondition. */
  nav?: ExplorerNav;
  /** Viewing a past snapshot: no selection, no migration, no answering decisions. */
  readOnly?: boolean;
  /** The workspace-wide selection (lib/selection.ts): ticks here add to it, so a pick survives switching views. */
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
  const words = LABEL[kind];
  const snaps = useMemo(
    () => sources.map((s) => snapshots[s.id]!).filter(Boolean),
    [sources, snapshots],
  );
  const matched = useMemo(() => matchAcrossSources(snaps, kind), [snaps, kind]);
  const aliasOf = (sourceId: string) =>
    sources.find((s) => s.id === sourceId)?.alias ?? sourceId;
  const ldFlags = useMemo(
    () => new Map((ld.flags?.items ?? []).map((f) => [f.key, f])),
    [ld.flags],
  );
  const ldEnvOf = (sourceId: string, statsigEnv: string) =>
    m.connected
      ? (m.profile.sources[sourceId]?.envMapping[statsigEnv] ?? null)
      : null;

  const rows: Row[] = useMemo(
    () =>
      matched.flatMap((mr) =>
        Object.entries(mr.bySource).map(([sourceId, e]) => {
          const gate = e as FlagEntity;
          const snap = snapshots[sourceId]!;
          const ldEnv = ldEnvOf(sourceId, env);
          const result = mapFlagFor(
            snap,
            gate,
            { statsig: env, ld: ldEnv ?? env },
            m,
          );
          const strip = m.connected
            ? m.ldEnvs.map((le) => {
                const se = Object.entries(
                  m.profile.sources[sourceId]?.envMapping ?? {},
                ).find(([, v]) => v === le.key)?.[0];
                if (!se)
                  return {
                    ldEnv: le.key,
                    status: "not_in_ld" as MigrationStatus,
                  };
                const r =
                  se === env
                    ? result
                    : mapFlagFor(snap, gate, { statsig: se, ld: le.key }, m);
                const f = ldFlags.get(r.flagKey);
                return {
                  ldEnv: le.key,
                  status: migrationStatus(f && ldFlagState(f), le.key, r, {
                    id: gate.id,
                    source: snap.source.alias,
                  }).status,
                };
              })
            : [];
          return {
            sourceId,
            gate,
            shared: Object.keys(mr.bySource).length,
            ldEnv,
            result,
            strip,
          };
        }),
      ),
    [matched, snapshots, env, m, ldFlags],
  );

  // Open decision types across all items, with how many items raise each: the "decision" filter.
  const decisionTypes = useMemo(() => {
    const counts = new Map<DecisionType, number>();
    for (const r of rows)
      for (const t of new Set(r.result.unresolved.map((d) => d.type)))
        counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Once every item's decision of the filtered type is answered, the filter has nothing to show: fall back to all.
  useEffect(() => {
    if (
      decisionType !== "all" &&
      !decisionTypes.some(([t]) => t === decisionType)
    )
      setDecisionType("all");
  }, [decisionTypes, decisionType]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!showArchived && r.gate.archived) return false;
        if (q && !r.gate.id.toLowerCase().includes(q.toLowerCase()))
          return false;
        if (
          decisionType !== "all" &&
          !r.result.unresolved.some((d) => d.type === decisionType)
        )
          return false;
        const here = r.strip.find((s) => s.ldEnv === r.ldEnv)?.status;
        switch (filter) {
          case "open":
            return r.result.unresolved.length > 0;
          case "blocking":
            return r.result.unresolved.some((d) => d.severity === "blocking");
          case "not_migrated":
            return !here || here === "not_in_ld" || here === "not_migrated";
          case "in_sync":
            return here === "in_sync";
          case "changed":
            return here === "statsig_changed" || here === "decisions_changed";
          default:
            return true;
        }
      }),
    [rows, showArchived, q, filter, decisionType],
  );
  const pager = usePager(visible);

  // Bulk answers for the selection: the open decisions of the selected items, rolled up by type.
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.gate.uid)),
    [rows, selected],
  );
  const bulk = useMemo(() => {
    const instances: DecisionInstance[] = selectedRows.flatMap((r) =>
      r.result.unresolved.map((d) => ({
        decision: d,
        entityId: r.gate.id,
        envs: [] as string[],
      })),
    );
    return { rows: summarizeDecisions(instances, {}), instances };
  }, [selectedRows]);
  const decideSelected = (type: DecisionType, optionKey: string) =>
    void m.resolve(
      bulk.instances
        .filter((x) => x.decision.type === type)
        .map((x) => x.decision),
      optionKey,
    );
  const selectable = visible.filter((r) => !r.gate.archived);
  const allSelected =
    selectable.length > 0 && selectable.every((r) => selected.has(r.gate.uid));
  const mappedHere = [
    ...new Set(
      sources.map((s) => ldEnvOf(s.id, env)).filter((x): x is string => !!x),
    ),
  ];
  const envChoice = targetEnvs ?? mappedHere;
  const unmappedSources = m.connected
    ? sources.filter((s) => !ldEnvOf(s.id, env))
    : [];

  const toggle = (uid: string) =>
    setSelected((x) => {
      const n = new Set(x);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  const blockingIn = (rs: Row[]) =>
    rs.reduce(
      (n, r) =>
        n + r.result.unresolved.filter((d) => d.severity === "blocking").length,
      0,
    );
  const steps = readinessSteps({
    m,
    env,
    mappedHere,
    hasSnapshot: snaps.length > 0,
    kindLabel: words.many,
    selected: selectedRows.length,
    blockingSelected: blockingIn(selectedRows),
    blockingAll: blockingIn(visible),
    nav: nav ?? {
      connections: onOpenMapping,
      ld: onOpenMapping,
      mapping: onOpenMapping,
      decisions: onOpenMapping,
    },
  });
  const migrate = () => onMigrate(selectedRows.map((r) => r.gate.uid), envChoice);
  // Only this explorer's items: other kinds stay selected across views.
  const selectAll = () =>
    setSelected((x) => {
      const n = new Set(x);
      for (const r of selectable) if (allSelected) n.delete(r.gate.uid); else n.add(r.gate.uid);
      return n;
    });
  const clearOwn = () => setSelected((x) => new Set([...x].filter((uid) => !rows.some((r) => r.gate.uid === uid))));

  return (
    <div className="pb-20">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {words.title}
        </h2>
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
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as StatusFilter)}
            aria-label="Filter by status"
          >
            <option value="all">All</option>
            <option value="open">Open decisions</option>
            <option value="blocking">Blocking decisions</option>
            <option value="not_migrated">Not migrated here</option>
            <option value="in_sync">In sync</option>
            <option value="changed">Changed since sync</option>
          </Select>
          {decisionTypes.length > 0 && (
            <Select
              value={decisionType}
              onChange={(e) =>
                setDecisionType(e.target.value as DecisionType | "all")
              }
              aria-label="Filter by open decision"
              title={`Only ${words.many} with this decision still open`}
            >
              <option value="all">Any decision</option>
              {decisionTypes.map(([t, n]) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t] ?? t} ({n})
                </option>
              ))}
            </Select>
          )}
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />{" "}
            archived
          </label>
          <Input
            placeholder="Filter by name"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-48"
            aria-label={`Filter ${words.many}`}
          />
          {!readOnly && (
            <MigrateButton
              steps={steps}
              onClick={migrate}
              label={
                selectedRows.length
                  ? `Migrate ${selectedRows.length.toLocaleString()} ${selectedRows.length === 1 ? words.one : words.many}…`
                  : "Migrate…"
              }
            />
          )}
        </div>
      </div>
      {!readOnly && <ReadinessLine steps={steps} />}
      {ld.status !== "connected" && (
        <div className="mb-3">
          <Callout tone="blue">
            Connect LaunchDarkly to see what's already in LD and to migrate.
            Decisions can be made without it.
          </Callout>
        </div>
      )}
      {decisionType !== "all" && selectedRows.length === 0 && !readOnly && (
        <div className="mb-3">
          <Callout tone="blue">
            Showing the {visible.length.toLocaleString()}{" "}
            {visible.length === 1 ? words.one : words.many} with an open{" "}
            <b>{TYPE_LABEL[decisionType] ?? decisionType}</b> decision. Tick
            “Select all” to answer it for every one of them at once.
          </Callout>
        </div>
      )}
      {unmappedSources.length > 0 && (
        <div className="mb-3">
          <Callout>
            StatSig <b>{env}</b> isn't mapped to an LD environment for{" "}
            {unmappedSources.map((s) => s.label).join(", ")}, so it can't be
            migrated.{" "}
            <button className="font-medium underline" onClick={onOpenMapping}>
              Map environments
            </button>
          </Callout>
        </div>
      )}
      <PagerBar pager={pager} label={words.many} className="mb-2" />
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead className="bg-surface-2 text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
            <tr>
              <th className="w-9 px-3 py-2">
                {!readOnly && (
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    title={`Select all ${selectable.length.toLocaleString()} matching ${words.many}`}
                    checked={allSelected}
                    onChange={selectAll}
                  />
                )}
              </th>
              <th className="w-[38%] px-3 py-2">StatSig</th>
              <th className="w-[10%] px-3 py-2">In {env}</th>
              <th className="w-[18%] px-3 py-2">Mapping</th>
              <th className="px-3 py-2">LaunchDarkly</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {pager.slice.map((row) => {
              const { sourceId, gate, shared, result: r } = row;
              const key = `${sourceId}/${gate.id}`;
              const res = resolveRulesForEnvironment(gate.rules, env);
              const overrides = overridesForEnvironment(gate.overrides, env);
              const flag = ldFlags.get(r.flagKey);
              const blocking = r.unresolved.filter(
                (d) => d.severity === "blocking",
              ).length;
              return (
                <Fragment key={key}>
                  <tr
                    className={cx(
                      "cursor-pointer align-top hover:bg-surface-hover",
                      open === key && "bg-surface-2",
                    )}
                    onClick={() => setOpen(open === key ? undefined : key)}
                  >
                    <td
                      className="px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {!readOnly && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${gate.id}`}
                          disabled={gate.archived}
                          checked={selected.has(gate.uid)}
                          onChange={() => toggle(gate.uid)}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[13px] font-medium">
                          {gate.id}
                        </span>
                        {sources.length > 1 && (
                          <Badge tone="slate">{aliasOf(sourceId)}</Badge>
                        )}
                        {shared > 1 && (
                          <Badge
                            tone="violet"
                            title="Same name in more than one source (consolidation, M8)"
                          >
                            in {shared} sources
                          </Badge>
                        )}
                        {!gate.enabled && <Badge tone="red">disabled</Badge>}
                        {gate.archived && <Badge tone="slate">archived</Badge>}
                        {gate.lifecycle?.type === "STALE" && (
                          <Badge
                            tone="amber"
                            title={`${gate.lifecycle.typeReason}: consider hard-coding instead of migrating`}
                          >
                            stale
                          </Badge>
                        )}
                        {gate.idType !== "userID" && (
                          <Badge tone="blue">{gate.idType}</Badge>
                        )}
                        {gate.kind === "config" && gate.schema && (
                          <Badge
                            tone="slate"
                            title="Rule values are schema-validated in StatSig; LD JSON variations are not"
                          >
                            schema
                          </Badge>
                        )}
                      </div>
                      {gate.description && (
                        <div className="mt-0.5 truncate text-xs text-fg-muted">
                          {gate.description}
                        </div>
                      )}
                      <div className="mt-0.5 text-xs text-fg-subtle">
                        {gate.owner?.email ?? "no owner"}
                        {gate.tags.length > 0 && ` · ${gate.tags.join(", ")}`}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-fg-muted">
                      <div>
                        {res.rules.length} rule
                        {res.rules.length === 1 ? "" : "s"}
                      </div>
                      {gate.kind === "config" && (
                        <div
                          title="Distinct values besides the default: each becomes an LD variation"
                        >
                          {r.shell.variations.length - 1} value
                          {r.shell.variations.length === 2 ? "" : "s"} + default
                        </div>
                      )}
                      {res.dropped.length > 0 && (
                        <div className="text-fg-subtle">
                          {res.dropped.length} not here
                        </div>
                      )}
                      {overrides.length > 0 && (
                        <div>
                          {overrides.reduce((n, o) => n + o.ids.length, 0)}{" "}
                          overrides
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {/* Fidelity is only meaningful once nothing is blocking. */}
                        {blocking === 0 && (
                          <Badge tone={FIDELITY_TONE[r.fidelity.overall]}>
                            {r.skipped ? "not migrated" : r.fidelity.overall}
                          </Badge>
                        )}
                        {blocking > 0 && (
                          <Badge tone="red">{blocking} blocking</Badge>
                        )}
                        {r.unresolved.length - blocking > 0 && (
                          <Badge tone="amber">
                            {r.unresolved.length - blocking} to decide
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <LdCell
                        row={row}
                        connected={ld.status === "connected" && !!ld.flags}
                        flagExists={!!flag}
                        on={
                          row.ldEnv
                            ? (flag?.environments?.[row.ldEnv]?.on ?? undefined)
                            : undefined
                        }
                      />
                    </td>
                  </tr>
                  {open === key && (
                    <tr className="bg-surface-2">
                      <td colSpan={5} className="px-3 pb-4">
                        <Detail
                          row={row}
                          m={m}
                          env={env}
                          res={res}
                          overrides={overrides}
                          readOnly={readOnly}
                          flagUrl={
                            flag && ld.projectKey && row.ldEnv
                              ? `${LD_INSTANCES[ld.instance ?? "us"].origin}/${ld.projectKey}/${row.ldEnv}/features/${flag.key}`
                              : undefined
                          }
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </Card>
      <PagerBar pager={pager} label={words.many} className="mt-2" />

      {selectedRows.length > 0 && !readOnly && (
        <div className="fixed right-0 bottom-0 left-72 z-40 border-t border-line bg-surface/95 px-5 py-3 shadow-raised backdrop-blur">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="flex items-center gap-3 pt-1">
              <span className="text-sm font-medium">
                {selectedRows.length.toLocaleString()}{" "}
                {selectedRows.length === 1 ? words.one : words.many} selected
                {selected.size > selectedRows.length && <span className="font-normal text-fg-muted"> · {selected.size.toLocaleString()} in all</span>}
              </span>
              <button
                className="text-sm text-fg-muted hover:text-fg"
                onClick={clearOwn}
              >
                Clear
              </button>
            </div>

            {bulk.rows.length > 0 ? (
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">
                  Decide for the selected {words.many}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {bulk.rows.map((r) => (
                    <label
                      key={r.type}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span>
                        {TYPE_LABEL[r.type] ?? r.type}
                        <span className="ml-1 text-xs text-fg-muted tabular-nums">
                          {r.open.toLocaleString()} in{" "}
                          {r.openItems.toLocaleString()}{" "}
                          {r.openItems === 1 ? words.one : words.many}
                        </span>
                      </span>
                      <Select
                        value=""
                        onChange={(e) =>
                          e.target.value &&
                          decideSelected(r.type, e.target.value)
                        }
                        aria-label={`Decide ${TYPE_LABEL[r.type] ?? r.type} for the selected ${words.many}`}
                        className="max-w-xs py-1 text-xs"
                      >
                        <option value="">Choose an answer…</option>
                        {r.options.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                            {o.covers < r.open
                              ? ` (covers ${o.covers.toLocaleString()} of ${r.open.toLocaleString()})`
                              : ""}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ))}
                </div>
              </div>
            ) : (
              <span className="pt-1 text-sm text-fg-muted">
                No open decisions on the selected {words.many}.
              </span>
            )}

            {m.connected && m.ldEnvs.length > 0 ? (
              <div className="flex items-center gap-3 pt-1 text-sm">
                <span className="text-fg-muted">Migrate to LD:</span>
                {m.ldEnvs.map((e) => (
                  <label key={e.key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={envChoice.includes(e.key)}
                      onChange={() =>
                        setTargetEnvs(
                          envChoice.includes(e.key)
                            ? envChoice.filter((x) => x !== e.key)
                            : [...envChoice, e.key],
                        )
                      }
                    />
                    {e.key}
                    {e.critical && <Badge tone="red">critical</Badge>}
                  </label>
                ))}
                <Button
                  disabled={envChoice.length === 0}
                  onClick={migrate}
                >
                  Plan migration…
                </Button>
              </div>
            ) : (
              <span className="pt-1 text-xs text-fg-subtle">
                Connect LaunchDarkly to migrate the selection.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LdCell({
  row,
  connected,
  flagExists,
  on,
}: {
  row: Row;
  connected: boolean;
  flagExists: boolean;
  on?: boolean;
}) {
  if (!connected) return <span className="text-xs text-fg-subtle">—</span>;
  const here = row.strip.find((s) => s.ldEnv === row.ldEnv);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {flagExists ? (
          <span className="font-mono text-[13px]">{row.result.flagKey}</span>
        ) : (
          <span className="text-xs text-fg-muted">not in LD</span>
        )}
        {on !== undefined && (
          <Badge tone={on ? "green" : "slate"}>{on ? "on" : "off"}</Badge>
        )}
        {here && here.status !== "not_in_ld" && (
          <Badge tone={STATUS[here.status].tone}>
            {STATUS[here.status].label}
          </Badge>
        )}
      </div>
      <div className="flex gap-2.5 text-[11px] text-fg-muted">
        {row.strip.map((s) => (
          <span
            key={s.ldEnv}
            className="flex items-center gap-1"
            title={`${s.ldEnv}: ${STATUS[s.status].label}`}
          >
            <span
              className={cx("h-2 w-2 rounded-full", STATUS[s.status].dot)}
            />
            {s.ldEnv}
          </span>
        ))}
      </div>
    </div>
  );
}

function Detail({
  row,
  m,
  env,
  res,
  overrides,
  flagUrl,
  readOnly,
}: {
  row: Row;
  m: MigrationContext;
  env: string;
  res: ReturnType<typeof resolveRulesForEnvironment>;
  overrides: FlagEntity["overrides"];
  flagUrl?: string;
  readOnly?: boolean;
}) {
  const r = row.result;
  const stale = new Map(r.stale.map((s) => [s.decision.id, s.previous]));
  return (
    <div className="space-y-3 pt-1">
      <div className="grid grid-cols-2 gap-3">
        <Card className="p-3">
          <div className="mb-2 text-xs font-semibold text-fg-muted">
            StatSig · rules applying in {env}
          </div>
          <StatsigRules
            rules={res.rules}
            overrides={overrides}
            enabled={row.gate.enabled}
            {...(row.gate.kind === "config"
              ? { config: { defaultValue: row.gate.defaultValue } }
              : {})}
          />
        </Card>
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg-muted">
            <span>
              LaunchDarkly ·{" "}
              {r.skipped
                ? "not migrated"
                : row.ldEnv
                  ? `proposed for ${row.ldEnv}`
                  : m.connected
                    ? "proposed (environment not mapped)"
                    : "proposed"}
              {r.unresolved.length > 0 &&
                !r.skipped &&
                " (preview with recommended answers)"}
            </span>
            {flagUrl && (
              <a
                href={flagUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto font-normal text-link hover:underline"
              >
                Open in LD ↗
              </a>
            )}
          </div>
          {r.skipped ? (
            <p className="text-xs text-fg-muted">{r.skipped}</p>
          ) : (
            <LdTargeting env={r.env} variations={r.shell.variations} />
          )}
        </Card>
      </div>
      {r.fidelity.notes.length > 0 && (
        <Card className="p-3">
          <div className="mb-1.5 text-xs font-semibold text-fg-muted">
            Fidelity
          </div>
          <ul className="space-y-1 text-xs">
            {r.fidelity.notes.map((n, i) => (
              <li key={i} className="flex gap-2">
                <Badge tone={FIDELITY_TONE[n.fidelity]}>{n.fidelity}</Badge>
                <span>
                  {n.message}
                  {n.location && (
                    <span className="text-fg-subtle"> · {n.location}</span>
                  )}
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
            {readOnly && (
              <span className="ml-2 font-normal">
                (viewing a past snapshot: answer them on the latest sync)
              </span>
            )}
          </div>
          {r.unresolved.map((d) => (
            <DecisionCard
              key={d.id}
              decision={d}
              stale={stale.get(d.id)}
              compact
              onChoose={(o) => !readOnly && void m.resolve([d], o)}
              {...(readOnly
                ? {}
                : { onPolicy: (o: string) => void m.setPolicy(d.type, o) })}
            />
          ))}
          {r.applied.map((a) => (
            <DecisionCard
              key={a.decision.id}
              decision={a.decision}
              current={{ optionKey: a.optionKey, via: a.via }}
              compact
              onChoose={(o) => !readOnly && void m.resolve([a.decision], o)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

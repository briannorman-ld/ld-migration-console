import { useEffect, useMemo, useState } from "react";
import type { CanonicalSnapshot } from "@sslm/canonical";
import type { RunRecord, StepStatus } from "@sslm/executor";
import { LD_INSTANCES } from "@sslm/ld-client";
import type { DecisionPoint } from "@sslm/mapper";
import { recommendedResolutions, type ItemStatus } from "@sslm/planner";
import type { SourceRecord } from "@sslm/store";
import { DecisionCard, FIDELITY_TONE } from "../components/DecisionCard.tsx";
import {
  Badge,
  Button,
  Callout,
  Card,
  CloseButton,
  cx,
  Input,
  Spinner,
} from "../components/ui.tsx";
import { refreshLdState } from "../lib/ld.ts";
import {
  buildPlan,
  cancelRun,
  describeSelection,
  executePlan,
  fetchDeferredIdLists,
  snapshotRefs,
  undoRun,
  useActiveRun,
  useCancelling,
  type MigrationSelection,
} from "../lib/migration.ts";
import type { MigrationContext } from "../lib/useMigration.ts";

const ITEM_TONE: Record<ItemStatus, "green" | "red" | "slate" | "amber"> = {
  ready: "green",
  blocked: "amber",
  skipped: "slate",
  error: "red",
};
export const STEP_TONE: Record<
  StepStatus,
  "green" | "red" | "slate" | "amber" | "blue" | "violet"
> = {
  pending: "slate",
  running: "blue",
  done: "green",
  pending_approval: "violet",
  failed: "red",
  skipped: "amber",
  undone: "slate",
};

type Phase =
  | { kind: "loading"; message: string }
  | { kind: "plan" }
  | { kind: "running"; dryRun: boolean }
  | { kind: "result"; run: RunRecord }
  | { kind: "error"; message: string };

/** The migrate flow (PLAN §9): plan → resolve decisions → dry run → confirm → execute → results/undo. */
export function MigrateModal({
  workspaceId,
  selection,
  ldEnvs: initialLdEnvs,
  sources,
  snapshots,
  m,
  onClose,
}: {
  workspaceId: string;
  selection: MigrationSelection;
  /** The LD environments to start with (what the header environment maps to); changeable in the modal. */
  ldEnvs: string[];
  sources: SourceRecord[];
  snapshots: CanonicalSnapshot[];
  m: MigrationContext;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({
    kind: "loading",
    message: "Reading the LD project…",
  });
  const [confirm, setConfirm] = useState("");
  const [showSteps, setShowSteps] = useState(false);
  const [lastDry, setLastDry] = useState<RunRecord>();
  // Target LD environments: segments, rollouts and targets are per environment, so the user picks
  // exactly which ones this run writes to. Only environments a source maps to can be chosen.
  const [ldEnvs, setLdEnvs] = useState<string[]>(initialLdEnvs);
  const envOptions = useMemo(() => envChoices(m, sources), [m, sources]);
  const activeRun = useActiveRun(workspaceId);
  const cancelling = useCancelling(workspaceId);

  // Load what the plan needs: segments in the target environments and deferred ID lists.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refreshLdState(workspaceId, { segmentEnvs: ldEnvs });
        await fetchDeferredIdLists(
          workspaceId,
          sources,
          snapshots,
          m.idLists,
          (message) => !cancelled && setPhase({ kind: "loading", message }),
        );
        if (!cancelled) setPhase({ kind: "plan" });
      } catch (e) {
        if (!cancelled)
          setPhase({ kind: "error", message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // An environment added later needs its LD segments too; the plan rebuilds when they arrive.
  useEffect(() => {
    const missing = ldEnvs.filter((e) => !m.ld.segments?.[e]);
    if (missing.length) void refreshLdState(workspaceId, { segmentEnvs: missing }).catch(() => undefined);
  }, [ldEnvs, m.ld.segments, workspaceId]);

  const plan = useMemo(
    () =>
      phase.kind === "loading"
        ? null
        : buildPlan({ ...m, selection, ldEnvs, snapshots }),
    [phase.kind, selection, ldEnvs, snapshots, m],
  );
  const requested = plan?.items.filter((i) => !i.dependency) ?? [];
  const deps = plan?.items.filter((i) => i.dependency) ?? [];
  const groups = useMemo(() => {
    const g = new Map<string, DecisionPoint[]>();
    for (const d of plan?.decisions ?? [])
      g.set(`${d.type}|${d.fingerprint}`, [
        ...(g.get(`${d.type}|${d.fingerprint}`) ?? []),
        d,
      ]);
    return [...g.values()].sort(
      (a, b) =>
        ["blocking", "choice", "acknowledge"].indexOf(a[0]!.severity) -
        ["blocking", "choice", "acknowledge"].indexOf(b[0]!.severity),
    );
  }, [plan]);
  const stale = new Map(
    (plan?.stale ?? []).map((s) => [s.decision.id, s.previous]),
  );
  const choiceCount = (plan?.decisions ?? []).filter(
    (d) => d.severity === "choice" && d.recommended,
  ).length;
  const ackCount = (plan?.decisions ?? []).filter(
    (d) => d.severity === "acknowledge",
  ).length;
  const needsConfirm = plan?.confirmEnvs ?? [];
  const confirmed =
    needsConfirm.length === 0 || confirm.trim() === needsConfirm.join(", ");
  const label = `${describeSelection(selection)} → ${ldEnvs.join(", ")}`;
  const seconds = Math.max(1, Math.round(((plan?.requests ?? 0) * 0.5) / 1));
  const ldBase = m.ld.projectKey
    ? `${LD_INSTANCES[m.ld.instance ?? "us"].origin}/${m.ld.projectKey}`
    : undefined;

  const run = async (dryRun: boolean) => {
    if (!plan) return;
    setPhase({ kind: "running", dryRun });
    try {
      const r = await executePlan(workspaceId, m.ld, plan, {
        dryRun,
        label: `${dryRun ? "Dry run: " : ""}${label}`,
        snapshots: snapshotRefs(snapshots),
      });
      if (dryRun) setLastDry(r);
      setPhase({ kind: "result", run: r });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const undo = async (r: RunRecord) => {
    setPhase({ kind: "running", dryRun: false });
    try {
      setPhase({ kind: "result", run: await undoRun(workspaceId, m.ld, r) });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const busy = phase.kind === "running" || phase.kind === "loading";
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-overlay p-6 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Migrate to LaunchDarkly"
    >
      <Card className="flex w-full max-w-5xl flex-col overflow-hidden shadow-raised">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Migrate {label}
          </h2>
          {m.ld.projectKey && <Badge tone="blue">LD · {m.ld.projectKey}</Badge>}
          <CloseButton
            onClick={onClose}
            disabled={phase.kind === "running"}
            className="ml-auto"
          />
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {phase.kind === "loading" && (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner /> {phase.message}
            </div>
          )}
          {phase.kind === "error" && (
            <Callout tone="red">{phase.message}</Callout>
          )}

          {plan && (phase.kind === "plan" || phase.kind === "error") && (
            <>
              <EnvChooser options={envOptions} chosen={ldEnvs} onChange={setLdEnvs} disabled={busy} />
              {plan.errors.map((e) => (
                <Callout key={e} tone="red">
                  {e}
                </Callout>
              ))}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Items</h3>
                <ItemsTable items={requested} />
                {deps.length > 0 && (
                  <>
                    <h4 className="mt-3 mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">
                      Pulled in as dependencies
                    </h4>
                    <ItemsTable items={deps} />
                  </>
                )}
              </section>

              {groups.length > 0 && (
                <section className="space-y-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-sm font-semibold">
                      {plan.decisions.length} decision
                      {plan.decisions.length === 1 ? "" : "s"} needed before
                      these items can migrate
                    </h3>
                    <Button
                      variant="secondary"
                      className="ml-auto py-1.5"
                      disabled={!choiceCount}
                      onClick={() =>
                        void m.saveResolutions(
                          recommendedResolutions(
                            plan.decisions,
                            new Date().toISOString(),
                          ),
                        )
                      }
                    >
                      Use recommended for {choiceCount} choice
                      {choiceCount === 1 ? "" : "s"}
                    </Button>
                  </div>
                  {ackCount > 0 && choiceCount === 0 && (
                    <p className="text-xs text-fg-muted">
                      Acknowledgements and blocking decisions always need an
                      explicit answer.
                    </p>
                  )}
                  {groups.map((xs) => (
                    <DecisionCard
                      key={xs[0]!.id}
                      decision={xs[0]!}
                      count={xs.length}
                      {...(stale.get(xs[0]!.id)
                        ? { stale: stale.get(xs[0]!.id)! }
                        : {})}
                      compact
                      onChoose={(o) => void m.resolve(xs, o)}
                      onPolicy={(o) => void m.setPolicy(xs[0]!.type, o)}
                    />
                  ))}
                </section>
              )}

              <section>
                <button
                  className="text-sm font-semibold"
                  onClick={() => setShowSteps((x) => !x)}
                >
                  {showSteps ? "▾" : "▸"} {plan.steps.length} operation
                  {plan.steps.length === 1 ? "" : "s"}
                  <span className="ml-2 font-normal text-fg-muted">
                    about {plan.requests} LD requests, ~
                    {seconds < 60
                      ? `${seconds}s`
                      : `${Math.round(seconds / 60)} min`}
                  </span>
                </button>
                {showSteps && (
                  <ol className="mt-2 list-decimal space-y-0.5 pl-6 font-mono text-xs text-fg-muted">
                    {plan.steps.map((s) => (
                      <li key={s.id}>
                        {s.id}
                        {"exists" in s && s.exists && (
                          <span className="text-warning">
                            {" "}
                            (exists{s.adopt ? ", adopting" : ""})
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {lastDry && (
                <Callout
                  tone={
                    lastDry.steps.some((s) => s.status === "failed")
                      ? "red"
                      : "green"
                  }
                >
                  Last dry run:{" "}
                  {lastDry.steps.filter((s) => s.status === "done").length}/
                  {lastDry.steps.length} operations OK
                  {lastDry.steps.some((s) => s.status === "failed") &&
                    `, ${lastDry.steps.filter((s) => s.status === "failed").length} failed`}
                  .
                </Callout>
              )}

              {needsConfirm.length > 0 && plan.steps.length > 0 && (
                <Card className="border-error-line/60 p-3">
                  <label className="block text-sm">
                    This writes to <b>{needsConfirm.join(", ")}</b>. Type{" "}
                    <code className="rounded bg-surface-2 px-1">
                      {needsConfirm.join(", ")}
                    </code>{" "}
                    to confirm.
                    <Input
                      className="mt-2 w-64 font-mono"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      aria-label="Type the environment to confirm"
                    />
                  </label>
                </Card>
              )}
            </>
          )}

          {phase.kind === "running" && (
            <RunProgress
              run={activeRun}
              title={
                phase.dryRun
                  ? "Dry run (LD validates, nothing is saved)"
                  : "Migrating"
              }
              onCancel={() => cancelRun(workspaceId)}
              cancelling={cancelling}
            />
          )}

          {phase.kind === "result" && (
            <>
              <RunSummary run={phase.run} />
              <RunProgress run={phase.run} title="Operations" ldBase={ldBase} />
            </>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line bg-surface-2 px-5 py-3">
          {plan && phase.kind === "plan" && (
            <>
              <span className="text-sm text-fg-muted">
                {plan.ready ? (
                  "Ready."
                ) : plan.steps.length ? (
                  <>
                    {requested.filter((i) => i.status !== "ready").length}{" "}
                    item(s) aren't ready; the ready ones can go now.
                  </>
                ) : (
                  "Resolve the decisions above to continue."
                )}
              </span>
              <Button
                variant="secondary"
                className="ml-auto"
                disabled={busy || plan.steps.length === 0 || ldEnvs.length === 0}
                onClick={() => void run(true)}
              >
                Dry run
              </Button>
              <Button
                disabled={
                  busy ||
                  plan.steps.length === 0 ||
                  ldEnvs.length === 0 ||
                  !confirmed ||
                  plan.errors.length > 0
                }
                onClick={() => void run(false)}
              >
                Migrate{" "}
                {plan.steps.length ? `(${plan.steps.length} operations)` : ""}
              </Button>
            </>
          )}
          {phase.kind === "result" && (
            <>
              {phase.run.dryRun ? (
                <Button
                  variant="secondary"
                  onClick={() => setPhase({ kind: "plan" })}
                >
                  Back to plan
                </Button>
              ) : (
                (phase.run.status === "done" ||
                  phase.run.status === "failed") && (
                  <Button variant="danger" onClick={() => void undo(phase.run)}>
                    Undo this run
                  </Button>
                )
              )}
              <Button className="ml-auto" onClick={onClose}>
                Close
              </Button>
            </>
          )}
          {phase.kind === "error" && (
            <Button
              className="ml-auto"
              onClick={() => setPhase({ kind: "plan" })}
            >
              Back to plan
            </Button>
          )}
        </footer>
      </Card>
    </div>
  );
}

function ItemsTable({
  items,
}: {
  items: NonNullable<ReturnType<typeof buildPlan>>["items"];
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-fg-muted">
        <tr>
          <th className="py-1 pr-3 font-medium">Item</th>
          <th className="py-1 pr-3 font-medium">LD env</th>
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 font-medium">Details</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line-soft">
        {items.map((i) => (
          <tr key={`${i.uid}|${i.ldEnv}`} className="align-top">
            <td className="py-1.5 pr-3">
              <span className="font-mono text-[13px]">{i.ldKey}</span>{" "}
              <Badge>{i.kind}</Badge>
              {i.exists && <Badge tone="amber">exists in LD</Badge>}
            </td>
            <td className="py-1.5 pr-3 font-mono text-xs">
              {i.ldEnv}
              {i.statsigEnv && i.statsigEnv !== i.ldEnv && (
                <span className="text-fg-subtle"> ← {i.statsigEnv}</span>
              )}
            </td>
            <td className="py-1.5 pr-3">
              <Badge tone={ITEM_TONE[i.status]}>{i.status}</Badge>{" "}
              {i.fidelity && i.status === "ready" && (
                <Badge tone={FIDELITY_TONE[i.fidelity.overall]}>
                  {i.fidelity.overall}
                </Badge>
              )}
            </td>
            <td className="py-1.5 text-xs text-fg-muted">
              {i.reason ??
                (i.fidelity?.notes
                  .filter((n) => n.fidelity !== "full")
                  .map((n) => n.message)
                  .join(" ") ||
                  "—")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunSummary({ run }: { run: RunRecord }) {
  const count = (s: StepStatus) =>
    run.steps.filter((x) => x.status === s).length;
  const failed = count("failed");
  const tone =
    run.status === "done" || run.status === "undone"
      ? "green"
      : run.status === "failed" ||
          run.status === "undo_failed" ||
          run.status === "stopped"
        ? "red"
        : "blue";
  const what = run.dryRun
    ? "Dry run"
    : run.status === "undone"
      ? "Undone"
      : "Run";
  return (
    <Callout tone={tone}>
      <b>
        {what} {run.status === "undone" ? "" : run.status}
      </b>
      : {count("done")} done{failed ? `, ${failed} failed` : ""}
      {count("pending_approval")
        ? `, ${count("pending_approval")} pending approval`
        : ""}
      {count("skipped") ? `, ${count("skipped")} skipped` : ""}
      {count("undone") ? `, ${count("undone")} undone` : ""}.
      {count("pending_approval") > 0 &&
        " Those environments require approvals, so the targeting went into LaunchDarkly approval requests; use “Check approvals” on the Runs page once a reviewer has applied them, and the sync status follows."}
      {run.stopReason
        ? ` ${run.stopReason}`
        : run.status === "stopped" &&
          " The run stopped on an authentication, rate-limit or connection error. Fix it (or give LaunchDarkly a minute), then resume from Runs."}
    </Callout>
  );
}

/**
 * Step-by-step progress of a run. With `onCancel`, a Cancel button shows while the run is in
 * progress: the executor finishes the write in flight, journals it and records the run as
 * stopped, so it can be resumed from Runs.
 */
export function RunProgress({
  run,
  title,
  ldBase,
  onCancel,
  cancelling,
}: {
  run?: RunRecord;
  title: string;
  ldBase?: string;
  onCancel?: () => void;
  cancelling?: boolean;
}) {
  if (!run)
    return (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner /> Starting…
      </div>
    );
  const done = run.steps.filter(
    (s) => s.status !== "pending" && s.status !== "running",
  ).length;
  const inProgress = run.status === "running" || run.status === "undoing";
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-fg-muted">
          {done}/{run.steps.length}
        </span>
        {inProgress && <Spinner />}
        {inProgress && cancelling && (
          <span className="text-fg-muted">
            Cancelling after the current step…
          </span>
        )}
        {inProgress && onCancel && (
          <Button
            variant="secondary"
            className="ml-auto py-1"
            disabled={cancelling}
            onClick={onCancel}
          >
            {run.status === "undoing" ? "Cancel undo" : "Cancel run"}
          </Button>
        )}
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded bg-surface-2">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${(done / Math.max(run.steps.length, 1)) * 100}%` }}
        />
      </div>
      <ul className="space-y-1 text-xs">
        {run.steps.map((s) => (
          <li
            key={s.id}
            className={cx(
              "flex gap-2",
              s.status === "pending" && "text-fg-subtle",
            )}
          >
            <Badge tone={STEP_TONE[s.status]}>{s.status}</Badge>
            <span className="min-w-0">
              <span className="font-medium">{s.label}</span>
              {s.message && (
                <span className="text-fg-muted"> · {s.message}</span>
              )}
              {s.error && <span className="text-error"> · {s.error}</span>}
              {ldBase &&
                s.status === "done" &&
                !run.dryRun &&
                s.step.op === "update_flag_env" && (
                  <a
                    className="ml-1 text-link hover:underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`${ldBase}/${s.step.ldEnv}/features/${s.step.key}`}
                  >
                    open ↗
                  </a>
                )}
              {ldBase &&
                s.status === "done" &&
                !run.dryRun &&
                s.step.op === "create_bandit" && (
                  <a
                    className="ml-1 text-link hover:underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`${ldBase}/${s.step.ldEnv}/experiments/${s.step.key}`}
                  >
                    open ↗
                  </a>
                )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface EnvChoice {
  key: string;
  name: string;
  critical: boolean;
  /** "acme-web staging, acme-mobile staging": which source environments land here. Empty = no source maps to it. */
  mappedFrom: string[];
}

/** Every LD environment of the target project, with the source environments mapped to it. */
export function envChoices(m: Pick<MigrationContext, "ldEnvs" | "profile">, sources: SourceRecord[]): EnvChoice[] {
  return m.ldEnvs.map((e) => ({
    key: e.key,
    name: e.name,
    critical: e.critical,
    mappedFrom: sources.flatMap((s) =>
      Object.entries(m.profile.sources[s.id]?.envMapping ?? {})
        .filter(([, ld]) => ld === e.key)
        .map(([src]) => (sources.length > 1 ? `${s.label} ${src}` : src)),
    ),
  }));
}

/**
 * Which LD environments the run writes to. Segments, rollouts and individual targets are
 * per environment, so this is where "only staging" or "test and production" is decided; an
 * environment no source maps to cannot be chosen (map it first).
 */
export function EnvChooser({ options, chosen, onChange, disabled }: { options: EnvChoice[]; chosen: string[]; onChange: (keys: string[]) => void; disabled?: boolean }) {
  const toggle = (key: string) => onChange(chosen.includes(key) ? chosen.filter((k) => k !== key) : options.filter((o) => o.key === key || chosen.includes(o.key)).map((o) => o.key));
  return (
    <section aria-label="Target environments">
      <h3 className="mb-2 text-sm font-semibold">Environments</h3>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = chosen.includes(o.key);
          const mappable = o.mappedFrom.length > 0;
          return (
            <label
              key={o.key}
              className={cx("flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm", on ? "border-accent bg-selected" : "border-line", !mappable && "opacity-60")}
              title={mappable ? `From ${o.mappedFrom.join(", ")}` : "No source environment is mapped to it (Mapping)"}
            >
              <input type="checkbox" checked={on} disabled={disabled || !mappable} onChange={() => toggle(o.key)} aria-label={`Migrate to ${o.key}`} />
              <span className="font-mono">{o.key}</span>
              {o.critical && <Badge tone="red">critical</Badge>}
              <span className="text-xs text-fg-muted">{mappable ? `from ${o.mappedFrom.join(", ")}` : "not mapped"}</span>
            </label>
          );
        })}
      </div>
      {chosen.length === 0 && <p className="mt-1.5 text-xs text-warning">Choose at least one environment.</p>}
    </section>
  );
}

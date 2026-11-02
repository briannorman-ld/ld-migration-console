import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import type { RunRecord } from "@sslm/executor";
import { LD_INSTANCES } from "@sslm/ld-client";
import { Badge, Button, Callout, Card, cx } from "../components/ui.tsx";
import {
  checkRunApprovals,
  cancelRun,
  isInterrupted,
  pendingApprovals,
  resumeRun,
  undoRun,
  useActiveRun,
  useCancelling,
} from "../lib/migration.ts";
import { store } from "../lib/store.ts";
import type { MigrationContext } from "../lib/useMigration.ts";
import { RunProgress, RunSummary } from "./MigrateModal.tsx";
import { timeAgo } from "../lib/time.ts";

const RUN_TONE: Record<
  RunRecord["status"],
  "green" | "red" | "amber" | "blue" | "slate"
> = {
  running: "blue",
  done: "green",
  failed: "red",
  stopped: "amber",
  undoing: "blue",
  undone: "slate",
  undo_failed: "red",
};

/** Run history from the journal (PLAN §9 step 7): results, undo, and resume after a closed tab. */
export function RunsView({
  workspaceId,
  m,
}: {
  workspaceId: string;
  m: MigrationContext;
}) {
  const runs =
    useLiveQuery(() => store.listRuns(workspaceId), [workspaceId]) ?? [];
  const active = useActiveRun(workspaceId);
  const cancelling = useCancelling(workspaceId);
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmUndo, setConfirmUndo] = useState<string>();
  const [checking, setChecking] = useState<string>();
  const ldBase = m.ld.projectKey
    ? `${LD_INSTANCES[m.ld.instance ?? "us"].origin}/${m.ld.projectKey}`
    : undefined;
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="max-w-5xl space-y-4">
      <h2 className="font-display text-xl font-semibold tracking-tight">
        Runs
      </h2>
      <p className="text-sm text-fg-muted">
        Every migration and dry run, journaled in this browser. The LaunchDarkly audit log
        has the authoritative write history; each write's comment names the run.
      </p>
      {error && <Callout tone="red">{error}</Callout>}
      {runs.length === 0 && (
        <Callout tone="blue">
          No runs yet. Select gates and choose “Plan migration”.
        </Callout>
      )}
      {runs.map((stored) => {
        const run = active?.id === stored.id ? active : stored;
        const interrupted = isInterrupted(run, workspaceId);
        const awaiting = pendingApprovals(run);
        // A stopped run (cancelled, 401, 429, offline) picks up where it left off, like an interrupted one.
        const resumable =
          interrupted ||
          (run.status === "stopped" &&
            run.steps.some((s) => s.status === "pending"));
        const createdFlags = new Set(
          run.steps
            .filter((s) => s.created && s.step.op === "upsert_flag_shell")
            .map((s) => s.step.key),
        );
        const created = run.steps.filter(
          (s) => s.created && s.status === "done",
        ).length;
        // Targeting on a flag this run created isn't "restored": the flag is deleted.
        const updated = run.steps.filter(
          (s) =>
            !s.created &&
            s.preImage &&
            s.status === "done" &&
            !createdFlags.has(s.step.key),
        ).length;
        return (
          <Card key={run.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="font-medium hover:underline"
                onClick={() => setOpen(open === run.id ? undefined : run.id)}
              >
                {run.label}
              </button>
              <Badge tone={RUN_TONE[run.status]}>
                {interrupted ? "interrupted" : run.status}
              </Badge>
              {run.dryRun && <Badge tone="violet">dry run</Badge>}
              {awaiting > 0 && (
                <Badge tone="violet" title="Writes filed as LaunchDarkly approval requests; provenance is recorded once a reviewer applies them">
                  {awaiting} pending approval
                </Badge>
              )}
              <span className="text-xs text-fg-muted">
                {timeAgo(run.startedAt)} · #{run.id.slice(0, 8)} ·{" "}
                {run.steps.length} operations
              </span>
              <div className="ml-auto flex gap-2">
                {awaiting > 0 && !interrupted && (
                  <Button
                    variant="secondary"
                    className="py-1.5"
                    disabled={!m.connected || !!active || checking === run.id}
                    onClick={() => {
                      setChecking(run.id);
                      void act(() => checkRunApprovals(workspaceId, m.ld, run)).finally(() => setChecking(undefined));
                    }}
                    title="Re-read the approval requests this run is waiting on"
                  >
                    Check approvals
                  </Button>
                )}
                {resumable && (
                  <Button
                    variant="secondary"
                    className="py-1.5"
                    disabled={!m.connected || !!active}
                    onClick={() =>
                      void act(() => resumeRun(workspaceId, m.ld, run))
                    }
                  >
                    Resume
                  </Button>
                )}
                {!run.dryRun &&
                  (run.status === "done" ||
                    run.status === "failed" ||
                    run.status === "stopped" ||
                    run.status === "undo_failed") &&
                  !interrupted && (
                    <Button
                      variant="danger"
                      className="py-1.5"
                      disabled={!m.connected || !!active}
                      onClick={() => setConfirmUndo(run.id)}
                    >
                      Undo…
                    </Button>
                  )}
              </div>
            </div>
            {confirmUndo === run.id && (
              <div className="mt-3">
                <Callout tone="red">
                  Undo deletes the {created} resource{created === 1 ? "" : "s"}{" "}
                  this run created (context kinds are archived, since LaunchDarkly can't
                  delete them)
                  {updated > 0 &&
                    ` and restores the ${updated} it updated to their state before the run`}
                  .
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="danger"
                      className="py-1.5"
                      onClick={() => {
                        setConfirmUndo(undefined);
                        void act(() => undoRun(workspaceId, m.ld, run));
                      }}
                    >
                      Undo the run
                    </Button>
                    <Button
                      variant="ghost"
                      className="py-1.5"
                      onClick={() => setConfirmUndo(undefined)}
                    >
                      Cancel
                    </Button>
                  </div>
                </Callout>
              </div>
            )}
            {!m.connected &&
              !run.dryRun &&
              (interrupted || run.status !== "undone") && (
                <p className="mt-2 text-xs text-fg-muted">
                  Connect LaunchDarkly to resume or undo.
                </p>
              )}
            {(open === run.id || active?.id === run.id) && (
              <div className={cx("mt-3 space-y-3")}>
                <RunSummary run={run} />
                <RunProgress
                  run={run}
                  title="Operations"
                  {...(ldBase ? { ldBase } : {})}
                  {...(active?.id === run.id
                    ? {
                        onCancel: () => cancelRun(workspaceId),
                        cancelling,
                      }
                    : {})}
                />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

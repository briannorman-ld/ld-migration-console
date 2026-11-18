import type { BulkSave } from "../lib/useMigration.ts";

/**
 * The bar for a decision save that takes a while (useMigration `bulk`): how many answers are
 * written so far, then "Saved" for a moment. Drawn where the bulk button was, so what the click
 * started stays in view until it is really on disk.
 */
export function BulkProgress({
  bulk,
  what = "answers",
  className,
}: {
  bulk: BulkSave;
  /** What is being saved, plural ("answers", "decisions"). */
  what?: string;
  className?: string;
}) {
  const pct = bulk.total === 0 ? 100 : Math.round((bulk.done / bulk.total) * 100);
  const label =
    bulk.phase === "saved"
      ? `Saved ${bulk.total.toLocaleString()} ${what}.`
      : `Saving ${what}… ${bulk.done.toLocaleString()} of ${bulk.total.toLocaleString()}`;
  return (
    <div className={className ?? "min-w-56"} role="status" data-testid="bulk-progress">
      <div className="mb-1 flex justify-between gap-3 text-xs text-fg-muted">
        <span>{label}</span>
        {bulk.phase === "saving" && <span>{pct}%</span>}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <div
          className={`h-full transition-all duration-300 ${bulk.phase === "saved" ? "bg-success" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {bulk.phase === "saving" && (
        <p className="mt-1 text-xs text-fg-muted">Keep this tab open until it finishes.</p>
      )}
    </div>
  );
}

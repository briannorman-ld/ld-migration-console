import type { Journal, RunRecord } from '@sslm/executor';

/**
 * The run journal the executor writes to, twice per step (PLAN §9 step 6). Each write stores the
 * whole run record, which on a run of thousands of segments is tens of megabytes (every step
 * carries its desired segment, member IDs included): cloned and serialised twice per step, that
 * was about as long as the LaunchDarkly requests themselves. Writes are coalesced: while the run
 * is in flight the record is written at most once per `intervalMs` (the latest state wins, since
 * the executor passes the same record), and a terminal state (done, failed, stopped, undone) is
 * written at once and awaited, as is a save the executor marks `immediate` (a pre-image just
 * captured, a scheduled change just created: resume could recover neither). A tab that dies loses
 * at most one interval of the other journaling; resume re-checks a step that ran unjournaled,
 * through the create's 409 and the existence read.
 */
export function coalescedJournal(write: (run: RunRecord) => Promise<void>, opts: { intervalMs?: number } = {}): Journal & { flush(): Promise<void> } {
  const intervalMs = opts.intervalMs ?? 2000;
  let latest: RunRecord | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let lastWrite = 0;
  const flush = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const run = latest;
    latest = undefined;
    if (!run) return chain;
    lastWrite = Date.now();
    // A failed earlier write must not swallow this one: the chain restarts after an error.
    chain = chain.catch(() => undefined).then(() => write(run));
    return chain;
  };
  return {
    save(run, opts) {
      latest = run;
      if (opts?.immediate || (run.status !== 'running' && run.status !== 'undoing')) return flush();
      if (timer === undefined) {
        const due = Math.max(0, lastWrite + intervalMs - Date.now());
        timer = setTimeout(() => void flush().catch(() => undefined), due);
      }
      return Promise.resolve();
    },
    flush,
  };
}

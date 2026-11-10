import type { RunRecord, StepRecord } from '@sslm/executor';
import { csvCell } from '@sslm/monitoring';

/**
 * The failures of a run, grouped so a run of thousands of steps reads as a handful of problems:
 * "At least two variations must be defined" × 605 is one line, not six hundred. Grouping is by
 * the error text with the quoted names (“…”) and resource paths taken out, so the same cause on
 * different items lands in one group; the first error's full text labels the group.
 */
export interface RunErrorGroup {
  /** The normalised text the group is keyed on. */
  key: string;
  /** A representative error, as LaunchDarkly or the executor worded it. */
  message: string;
  steps: StepRecord[];
}

export function normalizeError(message: string): string {
  return message
    .replace(/“[^”]*”/g, '“…”')
    .replace(/(\/(?:flags|segments|metrics|experiments|ai-configs|projects)\/)[^\s:]+/g, '$1…')
    .trim();
}

export function groupRunErrors(run: Pick<RunRecord, 'steps'>): RunErrorGroup[] {
  const groups = new Map<string, RunErrorGroup>();
  for (const s of run.steps) {
    if (s.status !== 'failed') continue;
    const text = s.error ?? 'Failed without an error message.';
    const key = normalizeError(text);
    const g = groups.get(key) ?? { key, message: text, steps: [] };
    g.steps.push(s);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.steps.length - a.steps.length);
}

/** The failed steps and the distinct problems behind them, for the progress header. */
export function runErrorCounts(run: Pick<RunRecord, 'steps'>): { failed: number; distinct: number } {
  const groups = groupRunErrors(run);
  return { failed: groups.reduce((n, g) => n + g.steps.length, 0), distinct: groups.length };
}

/** A Markdown report of the run's failures: one section per problem, the affected steps listed. */
export function runErrorReport(run: RunRecord): string {
  const groups = groupRunErrors(run);
  const lines = [`# ${run.dryRun ? 'Dry run' : 'Run'} ${run.id.slice(0, 8)}: ${run.label}`, '', `Started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}. Status: ${run.status}.`, '', `${groups.reduce((n, g) => n + g.steps.length, 0)} failed step(s), ${groups.length} distinct error(s).`, ''];
  for (const g of groups) {
    lines.push(`## ${g.message}`, '', `${g.steps.length} step(s):`, '');
    for (const s of g.steps) lines.push(`- ${s.label}${s.error !== g.message ? ` — ${s.error}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** CSV with one row per failed step: step id, label, operation, key, environment, error. */
export function runErrorCsv(run: RunRecord): string {
  const rows = [['step', 'label', 'operation', 'key', 'ldEnv', 'error'].join(',')];
  for (const s of run.steps) {
    if (s.status !== 'failed') continue;
    rows.push([s.id, s.label, s.step.op, s.step.key, 'ldEnv' in s.step ? s.step.ldEnv : '', s.error ?? ''].map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

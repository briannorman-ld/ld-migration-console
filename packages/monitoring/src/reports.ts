import { describeLifecycle, describeStatus, funnel } from './status.ts';
import type { Lifecycle, MonitorRow } from './types.ts';

/**
 * One CSV cell, quoted. A leading `=`, `+`, `-`, `@`, tab or CR is a formula trigger in Excel and
 * Sheets (CSV injection), and StatSig names, ids and LaunchDarkly error text all land in these
 * files, so such a cell is prefixed with an apostrophe. Plain numbers are left alone.
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');

const COLUMNS = ['kind', 'statsig_id', 'source', 'statsig_env', 'ld_flag', 'ld_env', 'fidelity', 'open_decisions', 'status', 'synced_at', 'ld_on', 'ld_traffic', 'ld_last_requested', 'statsig_checks_per_hour', 'lifecycle', 'ld_change_evidence'] as const;

function values(r: MonitorRow): unknown[] {
  return [r.kind, r.id, r.sourceAlias, r.statsigEnv, r.flagKey, r.ldEnv, r.fidelity, r.openDecisions, r.status, r.syncedAt ?? '', r.ldOn === undefined ? '' : r.ldOn ? 'on' : 'off', r.traffic, r.lastRequested ?? '', r.checksPerHour ?? '', r.lifecycle, r.ldChangeEvidence ?? ''];
}

/** Inventory with fidelity and migration status (PLAN §14 "Reports"): one row per (item, LD environment). */
export function statusCsv(rows: readonly MonitorRow[]): string {
  return [COLUMNS.join(','), ...rows.map((r) => values(r).map(csvCell).join(','))].join('\n') + '\n';
}

const STAGES: Lifecycle[] = ['not_migrated', 'migrated', 'dual_running', 'cut_over', 'ld_authoritative'];

export function statusMarkdown(workspaceName: string, rows: readonly MonitorRow[], opts: { now: string; lastCheckedAt?: string; ldProject?: string }): string {
  const drifted = rows.filter((r) => r.status === 'statsig_changed' || r.status === 'decisions_changed' || r.status === 'ld_changed' || r.status === 'conflict');
  const retire = rows.filter((r) => r.status === 'archived_in_statsig' || r.status === 'missing_in_statsig');
  const lines = [
    `# Migration status: ${workspaceName}`,
    '',
    `Exported ${opts.now}.${opts.lastCheckedAt ? ` LaunchDarkly last checked ${opts.lastCheckedAt}.` : ''}${opts.ldProject ? ` LaunchDarkly project \`${opts.ldProject}\`.` : ''} ${rows.length} item-environment pairs; ${drifted.length} drifted; ${retire.length} to retire.`,
    '',
    '## Cutover funnel',
    '',
    `| LaunchDarkly environment | ${STAGES.map((s) => describeLifecycle(s)).join(' | ')} | Total |`,
    `|---|${STAGES.map(() => '---:').join('|')}|---:|`,
    ...funnel(rows).map((f) => `| ${f.ldEnv} | ${STAGES.map((s) => f.counts[s]).join(' | ')} | ${f.total} |`),
    '',
    '## Drift',
    '',
    ...(drifted.length
      ? ['| Item | LaunchDarkly environment | Status | Synced | Detail |', '|---|---|---|---|---|', ...drifted.map((r) => `| ${cell(r.kind)} ${cell(r.id)} (${cell(r.sourceAlias)}) | ${cell(r.ldEnv)} | ${describeStatus(r.status)} | ${cell(r.syncedAt ?? '')} | ${cell(r.ldChangeEvidence ?? '')} |`)]
      : ['Nothing has drifted since the last sync.']),
    '',
    '## Retire in LaunchDarkly',
    '',
    ...(retire.length
      ? ['| Item | LaunchDarkly flag | LaunchDarkly environment | Why |', '|---|---|---|---|', ...retire.map((r) => `| ${cell(r.kind)} ${cell(r.id)} (${cell(r.sourceAlias)}) | ${cell(r.flagKey)} | ${cell(r.ldEnv)} | ${describeStatus(r.status)} |`)]
      : ['Nothing to retire.']),
    '',
    '## Inventory',
    '',
    '| Kind | StatSig ID | Source | LaunchDarkly flag | LaunchDarkly env | Fidelity | Open decisions | Status | LaunchDarkly traffic | StatSig checks/h | Lifecycle |',
    '|---|---|---|---|---|---|---:|---|---|---:|---|',
    ...rows.map((r) => `| ${r.kind} | ${cell(r.id)} | ${cell(r.sourceAlias)} | ${cell(r.flagKey)} | ${cell(r.ldEnv)} | ${r.fidelity} | ${r.openDecisions} | ${describeStatus(r.status)} | ${r.traffic}${r.lastRequested ? ` (${r.lastRequested})` : ''} | ${r.checksPerHour ?? ''} | ${describeLifecycle(r.lifecycle)} |`),
    '',
  ];
  return lines.join('\n');
}

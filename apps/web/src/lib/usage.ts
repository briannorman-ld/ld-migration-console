/**
 * Recent StatSig traffic for a gate or dynamic config, read from `Usage` (the Console API's
 * `/exposure_count` and `/gates/{id}/checks`, PLAN §14) and summarized for the explorers: the
 * usage column, its filter and the reason suggested when items are set aside. Pure.
 *
 * Exposure counts come from SDK exposure events, so a gate checked with exposure logging off
 * shows no exposures while it is in use; the production-checks flag (gates only) is the second
 * opinion, and "unused" is claimed only when both say nothing happened.
 */
import type { Config, Gate } from '@sslm/canonical';

export type UsageLevel =
  /** Exposure events in the past 7 days. */
  | 'active'
  /** No exposure events in 7 days; production checks are still seen, or could not be read. */
  | 'no_exposures'
  /** No exposure events and no production checks in 7 days. */
  | 'unused'
  /** Not read (archived, not synced since the usage read was added, or the route was not readable). */
  | 'unknown'
  /** Config-spec sources carry no counts. */
  | 'needs_key';

export interface UsageSummary {
  level: UsageLevel;
  /** Short text for the cell, e.g. "1.2M in 7 d" or "no checks in 7 days". */
  label: string;
  /** One or two sentences for the tooltip. */
  detail: string;
  exposuresPast7Days: number | null;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function describeUsage(e: Pick<Gate | Config, 'usage' | 'completeness' | 'archived' | 'source'>): UsageSummary {
  const u = e.usage;
  if (e.source.sourceKind === 'config_spec' || e.completeness.missing.includes('checks')) {
    return { level: 'needs_key', label: 'needs Console key', detail: 'Config-spec sources carry no exposure counts; attach a Console API key to see StatSig traffic.', exposuresPast7Days: null };
  }
  if (!u) {
    return { level: 'unknown', label: 'unknown', detail: e.archived ? 'Archived in StatSig: not evaluated, so no usage is read.' : 'Not read yet: sync the source again to read exposure counts.', exposuresPast7Days: null };
  }
  const n = u.exposuresPast7Days;
  if (n === null) return { level: 'unknown', label: 'unknown', detail: 'The Console API key could not read /exposure_count (see Source warnings).', exposuresPast7Days: null };
  if (n <= 0) {
    if (u.productionChecksPast7Days === false) {
      return { level: 'unused', label: 'no checks in 7 days', detail: 'No exposure events and no production checks in the past 7 days, in any environment. A candidate to set aside or hard-code.', exposuresPast7Days: 0 };
    }
    if (u.productionChecksPast7Days === true) {
      return { level: 'no_exposures', label: 'checked, no exposures', detail: 'No exposure events in the past 7 days, but production SDKs still check it (exposure logging may be off, or checks come from local evaluation).', exposuresPast7Days: 0 };
    }
    return { level: 'no_exposures', label: 'no exposures in 7 days', detail: 'No exposure events in the past 7 days, in any environment. Whether production still checks it could not be read.', exposuresPast7Days: 0 };
  }
  const day = u.exposuresPastDay;
  return {
    level: 'active',
    label: `${compact.format(n)} in 7 d`,
    detail: `${n.toLocaleString()} exposure events in the past 7 days${day !== null ? ` (${day.toLocaleString()} in the past day)` : ''}, all environments together.`,
    exposuresPast7Days: n,
  };
}

/** The usage filter "No exposures in 7 days": both levels where nothing was logged. */
export const isQuiet = (s: UsageSummary): boolean => s.level === 'unused' || s.level === 'no_exposures';

/** The reason written on a "Don't migrate" mark made from the usage column, when every item agrees. */
export function suggestedReason(summaries: UsageSummary[]): string | undefined {
  if (summaries.length === 0) return undefined;
  if (summaries.every((s) => s.level === 'unused')) return 'No checks in StatSig in the past 7 days';
  if (summaries.every(isQuiet)) return 'No exposures in StatSig in the past 7 days';
  return undefined;
}

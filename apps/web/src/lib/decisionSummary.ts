import { optionLabel, type DecisionType, type MappingProfile, type Severity } from '@sslm/mapper';
import type { DecisionInstance } from './migration.ts';

/**
 * One row per decision type (PLAN §8.2 "categorize, then answer in bulk"). A real project raises
 * thousands of decisions, but only a dozen or so *kinds* of them; most are answered once per kind
 * with a workspace policy. `options` is the union of option keys across the type's open decisions,
 * with how many of them each option would cover, since not every option exists everywhere (e.g.
 * "use as prerequisite" only where inlining is possible).
 */
export interface TypeSummary {
  type: DecisionType;
  severity: Severity;
  open: number;
  decided: number;
  /** Distinct subjects (gates, segments, …) with at least one open decision of this type. */
  openItems: number;
  /** Open decisions per subject kind, e.g. { gate: 120, segment: 4 }. */
  kinds: Record<string, number>;
  options: { key: string; label: string; covers: number }[];
  /** Open decisions whose recommended option is set (bulk "use recommended" applies to these). */
  recommendedOpen: number;
  policy?: string;
  /** Label of the policy's option, learned from any decision (open or decided) that offers it. */
  policyLabel?: string;
}

export const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, choice: 1, acknowledge: 2 };

export function summarizeDecisions(all: DecisionInstance[], policies: MappingProfile['policies']): TypeSummary[] {
  const rows = new Map<DecisionType, TypeSummary & { items: Set<string>; optionIndex: Map<string, { label: string; covers: number }> }>();
  for (const inst of all) {
    const d = inst.decision;
    let row = rows.get(d.type);
    if (!row) {
      row = { type: d.type, severity: d.severity, open: 0, decided: 0, openItems: 0, kinds: {}, options: [], recommendedOpen: 0, items: new Set(), optionIndex: new Map() };
      const policy = policies[d.type];
      if (policy) row.policy = policy;
      rows.set(d.type, row);
    }
    // Blocking outranks choice outranks acknowledge if a type ever mixes severities.
    if (SEVERITY_RANK[d.severity] < SEVERITY_RANK[row.severity]) row.severity = d.severity;
    if (row.policy && !row.policyLabel) row.policyLabel = optionLabel(d, row!.policy);
    if (inst.resolvedWith) {
      row.decided++;
      continue;
    }
    row.open++;
    row.items.add(d.subject.uid);
    row.kinds[d.subject.kind] = (row.kinds[d.subject.kind] ?? 0) + 1;
    if (d.recommended) row.recommendedOpen++;
    for (const o of d.options) {
      const e = row.optionIndex.get(o.key);
      if (e) e.covers++;
      else row.optionIndex.set(o.key, { label: o.label, covers: 1 });
    }
  }
  return [...rows.values()]
    .map(({ items, optionIndex, ...row }) => ({
      ...row,
      openItems: items.size,
      options: [...optionIndex.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.covers - a.covers || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.open - a.open || a.type.localeCompare(b.type));
}

export interface DecisionFilters {
  type: DecisionType | 'all';
  severity: Severity | 'all';
  kind: string;
  sourceId: string;
  /** Matches the subject id, rule name, decision title and location, case-insensitively. */
  query: string;
}

export const NO_FILTERS: DecisionFilters = { type: 'all', severity: 'all', kind: 'all', sourceId: 'all', query: '' };

export function filterDecisions(list: DecisionInstance[], f: DecisionFilters): DecisionInstance[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((x) => {
    const d = x.decision;
    if (f.type !== 'all' && d.type !== f.type) return false;
    if (f.severity !== 'all' && d.severity !== f.severity) return false;
    if (f.kind !== 'all' && d.subject.kind !== f.kind) return false;
    if (f.sourceId !== 'all' && d.subject.sourceId !== f.sourceId) return false;
    if (q) {
      const hay = `${d.subject.id} ${d.subject.ruleName ?? ''} ${d.subject.location ?? ''} ${d.title}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

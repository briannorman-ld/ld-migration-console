/**
 * What a resource page says about its mapping: the coverage row for the resource itself (the
 * headline), and the rows that qualify it (caveats: anything that is not a clean `migrates`,
 * grouped by area). Pure, read from the matrix, so the page text and docs/LIMITATIONS.md can never
 * disagree. One entry per resource page; a page for a resource kind the matrix has no row for is a
 * test failure, not a blank panel.
 */
import type { EntityKind } from '@sslm/canonical';
import { AREAS, COVERAGE } from './matrix.ts';
import type { CoverageArea, CoverageAreaInfo, CoverageEntry } from './types.ts';

/** A StatSig resource kind, or a resource of a LaunchDarkly project attached as a source. */
export type ExplainerKey = EntityKind | 'ld_flag' | 'ld_segment';

export interface MappingExplanation {
  /** The row for the resource itself: `statsig → ld`, how, detail. */
  headline: CoverageEntry;
  /** Rows that need a decision, a person, are planned or have no equivalent, grouped by area in matrix order. */
  caveats: { area: CoverageAreaInfo; rows: CoverageEntry[] }[];
  /** Rows that migrate exactly, for a "maps cleanly" line. */
  clean: CoverageEntry[];
}

/** Rows that rules bring along: every gate, config and segment page lists them. */
const RULES: (CoverageArea | string)[] = ['conditions', 'operators', 'structure.unit_types', 'sdk.bucketing'];

/**
 * Per page: the headline row and the related rows, as row ids or whole areas (every row of the
 * area except the headline). Rows display in matrix order, so the page reads like the doc.
 */
const SECTIONS: Record<ExplainerKey, { headline: string; related: (CoverageArea | string)[] }> = {
  gate: { headline: 'gates.boolean', related: ['gates', ...RULES, 'structure.target_apps', 'structure.tags_owners'] },
  config: { headline: 'configs.json', related: ['configs', ...RULES, 'structure.target_apps', 'structure.tags_owners'] },
  segment: { headline: 'segments.rule_based', related: ['segments', ...RULES] },
  autotune: { headline: 'experiments.autotune', related: ['experiments.overrides', 'experiments.contextual_bandit', 'metrics.events', 'structure.tags_owners'] },
  experiment: { headline: 'experiments.setup', related: ['experiments.running', 'experiments.concluded', 'experiments.overrides', 'experiments.analysis', 'experiments.types', 'experiments.layers', 'experiments.holdouts', 'metrics.events', 'operations.results', 'structure.unit_types'] },
  layer: { headline: 'experiments.layers', related: ['experiments.setup', 'experiments.running', 'sdk.code_changes'] },
  holdout: { headline: 'experiments.holdouts', related: ['gates.holdouts', 'sdk.bucketing'] },
  metric: { headline: 'metrics.cloud', related: ['metrics'] },
  param_store: { headline: 'param_stores.static', related: ['configs.per_param', 'sdk.code_changes'] },
  prompt: { headline: 'operations.ai', related: ['structure.tags_owners'] },
  ld_flag: { headline: 'ld_source.flags', related: ['ld_source.targeting', 'ld_source.rollouts', 'ld_source.context_kinds', 'ld_source.prerequisites', 'ld_source.custom_properties', 'ld_source.maintainers', 'ld_source.experiments'] },
  ld_segment: { headline: 'ld_source.segments', related: ['ld_source.big_segments', 'ld_source.context_kinds'] },
};

export const EXPLAINER_KEYS = Object.keys(SECTIONS) as ExplainerKey[];

const byId = new Map(COVERAGE.map((e) => [e.id, e]));
const isArea = (x: string): x is CoverageArea => AREAS.some((a) => a.area === x);

export function explainMapping(key: ExplainerKey): MappingExplanation {
  const section = SECTIONS[key];
  const headline = byId.get(section.headline);
  if (!headline) throw new Error(`coverage explainer ${key}: no matrix row ${section.headline}`);
  const wanted = new Set<string>();
  for (const r of section.related) {
    if (isArea(r)) for (const e of COVERAGE) e.area === r && e.id !== headline.id && wanted.add(e.id);
    else if (byId.has(r)) wanted.add(r);
    else throw new Error(`coverage explainer ${key}: no matrix row ${r}`);
  }
  // Matrix order, so the page reads like the doc.
  const related = COVERAGE.filter((e) => wanted.has(e.id));
  const caveats: MappingExplanation['caveats'] = [];
  for (const area of AREAS) {
    const rows = related.filter((e) => e.area === area.area && e.status !== 'migrates');
    if (rows.length) caveats.push({ area, rows });
  }
  return { headline, caveats, clean: related.filter((e) => e.status === 'migrates') };
}

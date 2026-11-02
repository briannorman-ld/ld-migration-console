import type { EntityKind } from '@sslm/canonical';

/**
 * How completely a StatSig construct reaches LaunchDarkly through the console.
 *
 * - `migrates`   Translated exactly, automatically. At most informational notes.
 * - `decisions`  Migrates, but at least one aspect needs a Decision (PLAN §8) or is acknowledged
 *                as partial fidelity. Nothing is dropped silently.
 * - `guided`     No automatic write. The console produces a checklist, a generated document or
 *                step-by-step guidance; a person finishes it in LD or in code.
 * - `planned`    An LD equivalent exists and the mapping is specified, but the console doesn't
 *                write it yet. The item is inventoried and its blockers are listed.
 * - `none`       LaunchDarkly has no equivalent. StatSig-only, or replaced by a different LD
 *                product. Called out so nobody expects it.
 */
export type CoverageStatus = 'migrates' | 'decisions' | 'guided' | 'planned' | 'none';

export type CoverageArea =
  | 'structure'
  | 'gates'
  | 'configs'
  | 'segments'
  | 'conditions'
  | 'operators'
  | 'experiments'
  | 'metrics'
  | 'param_stores'
  | 'operations'
  | 'sdk'
  /** Another LaunchDarkly project as the source (PLAN §20). */
  | 'ld_source';

export interface CoverageEntry {
  /** Stable id, used as an anchor in the doc and the page: `<area>.<slug>`. */
  id: string;
  area: CoverageArea;
  /** The source construct, in the source's words (StatSig for every area but `ld_source`; the field name predates the second source). */
  statsig: string;
  /** The LaunchDarkly target, in LD's words; `—` when there is none. */
  ld: string;
  status: CoverageStatus;
  /** One sentence: what the console does. */
  how: string;
  /** Optional detail for the expanded row / the doc: caveats, why, what the user must do. */
  detail?: string;
  /** Decision types (packages/mapper `DecisionType`) this construct can raise. */
  decisions?: string[];
  /** Rows of docs/KNOWN-EDGE-CASES.md that go deeper, e.g. `4.8`. */
  edgeCases?: string[];
  /** The canonical entity kind this row counts in a workspace, when there is one. */
  kind?: EntityKind;
  /** Source documentation. */
  docs?: { statsig?: string; ld?: string };
}

export interface CoverageAreaInfo {
  area: CoverageArea;
  title: string;
  /** One or two sentences for the section intro. */
  summary: string;
  /** Column header for the source side; defaults to StatSig. */
  sourceLabel?: string;
}

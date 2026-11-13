/**
 * Per-item guidance for resource kinds the console inventories but does not write yet. Pure:
 * given a canonical entity, say what will happen to it and why, so the explorer never shows a
 * bare list without a verdict (the user asked for "any feature of StatSig", so every item gets
 * an answer, even when the answer is "not yet" or "no equivalent").
 */
import type { Config, Entity, EntityKind, Experiment, Holdout, Layer, Metric, NeutralFlag, NeutralSegment, ParamStore } from '@sslm/canonical';
import { COVERAGE } from './matrix.ts';
import type { CoverageEntry, CoverageStatus } from './types.ts';

export interface ItemGuidance {
  status: CoverageStatus;
  /** Short verdict for a badge, e.g. "waits for StatSig". */
  verdict: string;
  /** One sentence for the row. */
  detail: string;
  /** Coverage row to link to. */
  coverageId: string;
}

export function coverageFor(kind: EntityKind): CoverageEntry[] {
  return COVERAGE.filter((e) => e.kind === kind);
}

const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

export function guidanceFor(entity: Entity): ItemGuidance {
  if (entity.archived) return { status: 'none', verdict: 'archived', detail: 'Archived in StatSig: not migrated.', coverageId: `${entity.kind === 'param_store' ? 'param_stores' : entity.kind}s` };
  switch (entity.kind) {
    case 'experiment':
      return experiment(entity);
    case 'layer':
      return layer(entity);
    case 'holdout':
      return holdout(entity);
    case 'metric':
      return metric(entity);
    case 'param_store':
      return paramStore(entity);
    case 'config':
      return config(entity);
    case 'prompt':
      return { status: 'decisions', verdict: 'shell migrates', detail: `Becomes a LaunchDarkly AI Config with this name, description, tags and maintainer${entity.version !== undefined ? ` (StatSig version ${entity.version})` : ''}; the prompt versions are not readable through the Console API, so the variations are added in LaunchDarkly by hand.`, coverageId: 'operations.ai' };
    default:
      return { status: 'decisions', verdict: 'migrates', detail: 'Open the side-by-side view for the mapping and its decisions.', coverageId: `${entity.kind}s` };
  }
}

function experiment(e: Experiment): ItemGuidance {
  const unit = e.idType && e.idType !== 'userID' ? ` Randomized by ${e.idType}, which must be a randomization unit in LaunchDarkly.` : '';
  const layer = e.layerId ? ` In layer ${e.layerId}.` : '';
  switch (e.status) {
    case 'active':
      return { status: 'guided', verdict: 'running in StatSig', detail: `Ends in StatSig; migrate after the decision is made. Assignments and results never move.${layer}`, coverageId: 'experiments.running' };
    case 'setup':
      return { status: 'planned', verdict: 'draft (planned)', detail: `Will become a JSON flag with ${e.groups.length} variations and a draft LaunchDarkly experiment at ${pct(e.allocation)} allocation.${unit}${layer}`, coverageId: 'experiments.setup' };
    case 'decision_made': {
      const shipped = e.groups.find((g) => g.id === e.launchedGroupId || g.name === e.launchedGroupId);
      return { status: 'planned', verdict: 'concluded (planned)', detail: `Will become a flag serving ${shipped ? `“${shipped.name}”` : 'the shipped group'} at 100%; results are archived, not imported.`, coverageId: 'experiments.concluded' };
    }
    case 'experiment_stopped':
    case 'assignment_stopped':
      return { status: 'planned', verdict: 'stopped (planned)', detail: 'Stopped without a shipped group: will be drafted like a not-started experiment, or skipped.', coverageId: 'experiments.setup' };
    case 'abandoned':
    case 'archived':
    default:
      return { status: 'none', verdict: e.status, detail: 'Abandoned or archived: listed for completeness, not migrated.', coverageId: 'experiments.setup' };
  }
}

function layer(l: Layer): ItemGuidance {
  if (l.isImplicit) return { status: 'none', verdict: 'implicit', detail: 'A one-experiment layer StatSig created implicitly; the experiment migrates on its own.', coverageId: 'experiments.layers' };
  return { status: 'planned', verdict: 'planned', detail: `${l.parameters.length} shared parameter${l.parameters.length === 1 ? '' : 's'}, ${l.experimentIds.length} experiment${l.experimentIds.length === 1 ? '' : 's'}: will become a LaunchDarkly layer; code using getLayer().get() gets a layer_parameters decision.`, coverageId: 'experiments.layers' };
}

function holdout(h: Holdout): ItemGuidance {
  const scope = h.isGlobal ? 'global' : `${h.gateIds.length + h.experimentIds.length + h.layerIds.length} attached item${h.gateIds.length + h.experimentIds.length + h.layerIds.length === 1 ? '' : 's'}`;
  if (!h.enabled) return { status: 'none', verdict: 'disabled', detail: 'Disabled in StatSig: nothing is held out, nothing to migrate.', coverageId: 'experiments.holdouts' };
  return { status: 'planned', verdict: 'planned', detail: `${pct(h.passPercentage)} held out (${scope}). Will become a new LaunchDarkly holdout population per environment; membership is re-randomized. Gates it covers raise holdout_attached today.`, coverageId: 'experiments.holdouts' };
}

function metric(m: Metric): ItemGuidance {
  const t = (m.metricType || '').toLowerCase();
  if (m.isWarehouseNative) return { status: 'guided', verdict: 'warehouse native', detail: 'Needs a LaunchDarkly warehouse-native data source created by a LaunchDarkly admin first; then the SQL definition can be mapped (custom and ratio only).', coverageId: 'metrics.warehouse_native' };
  if (/composite|user_accounting|dau|wau|mau|retention/.test(t)) return { status: 'none', verdict: 'no equivalent', detail: `“${m.metricType}” metrics compose other metrics or users; LaunchDarkly has no such metric type. Rebuild from its parts or as a metric group.`, coverageId: 'metrics.composite' };
  if (/funnel/.test(t)) return { status: 'planned', verdict: 'planned', detail: 'Will become a LaunchDarkly funnel metric; each step’s event must be sent through track().', coverageId: 'metrics.cloud' };
  if (/ratio/.test(t)) return { status: 'planned', verdict: 'planned', detail: 'Will become a LaunchDarkly ratio metric over two custom metrics.', coverageId: 'metrics.cloud' };
  return { status: 'planned', verdict: 'planned', detail: `Will become a LaunchDarkly custom ${/sum|mean|value/.test(t) ? 'numeric' : 'conversion'} metric; the event must be sent through track().`, coverageId: 'metrics.cloud' };
}

function paramStore(p: ParamStore): ItemGuidance {
  const statics = p.parameters.filter((x) => !x.ref).length;
  const refs = p.parameters.length - statics;
  return { status: 'planned', verdict: 'planned', detail: `${statics} static parameter${statics === 1 ? '' : 's'} → one JSON flag; ${refs} reference${refs === 1 ? '' : 's'} to gates, configs or experiments → the migrated flags, with a code change.`, coverageId: 'param_stores.static' };
}

function config(c: Config): ItemGuidance {
  const values = new Set(c.rules.flatMap((r) => [JSON.stringify(r.returnValue), ...(r.variants ?? []).map((v) => JSON.stringify(v.returnValue))])).size;
  return { status: 'decisions', verdict: 'migrates', detail: `JSON flag with the default plus up to ${values} rule value${values === 1 ? '' : 's'} as variations. Open the side-by-side view for the mapping.`, coverageId: 'configs.json' };
}

export interface InventorySummary {
  /** Live (non-archived) items by coverage status, across every snapshot. */
  byStatus: Record<CoverageStatus, number>;
  /** Live items by kind and status. */
  byKind: Partial<Record<EntityKind, Record<CoverageStatus, number>>>;
  /**
   * Live flags and segments of neutral-model sources (a LaunchDarkly or PostHog project, PLAN §20,
   * §22), counted apart because they are not StatSig entity kinds. Present only when a source has them.
   */
  neutral?: { flags: Record<CoverageStatus, number>; segments: Record<CoverageStatus, number> };
  total: number;
  archived: number;
}

/** What happens to a neutral-source flag: every caveat and experiment allocation raises a decision; a purpose-marked flag (survey, …) is skipped. */
export function neutralFlagStatus(f: Pick<NeutralFlag, 'purpose' | 'caveats' | 'experiments' | 'environments'>): CoverageStatus {
  if (f.purpose) return 'none';
  if ((f.caveats?.length ?? 0) > 0 || f.experiments.length > 0) return 'decisions';
  if (f.environments.some((e) => e.rules.some((r) => r.experiment || (r.coverage !== undefined && r.coverage < 1) || (r.prerequisites?.length ?? 0) > 0))) return 'decisions';
  return 'migrates';
}

/** What happens to a neutral-source segment: an unreadable or frozen membership and every other caveat raise a decision. */
export function neutralSegmentStatus(s: Pick<NeutralSegment, 'caveats' | 'environments'>): CoverageStatus {
  if ((s.caveats?.length ?? 0) > 0) return 'decisions';
  if (s.environments.some((e) => e.unbounded)) return 'decisions';
  return 'migrates';
}

type InventorySnapshot = {
  gates: Entity[];
  configs: Entity[];
  segments: Entity[];
  experiments: Entity[];
  layers: Entity[];
  holdouts: Entity[];
  autotunes: Entity[];
  metrics: Entity[];
  paramStores: Entity[];
  prompts?: Entity[];
  neutral?: { flags: NeutralFlag[]; segments: NeutralSegment[] };
};

/** Counts a workspace's inventory against the matrix: what migrates now, what waits, what has no equivalent. */
export function summarizeInventory(snapshots: readonly InventorySnapshot[]): InventorySummary {
  const zero = (): Record<CoverageStatus, number> => ({ migrates: 0, decisions: 0, guided: 0, planned: 0, none: 0 });
  const out: InventorySummary = { byStatus: zero(), byKind: {}, total: 0, archived: 0 };
  for (const s of snapshots) {
    const all: Entity[] = [...s.gates, ...s.configs, ...s.segments, ...s.experiments, ...s.layers, ...s.holdouts, ...s.autotunes, ...s.metrics, ...s.paramStores, ...(s.prompts ?? [])];
    for (const e of all) {
      if (e.archived) {
        out.archived++;
        continue;
      }
      const g = guidanceFor(e);
      out.total++;
      out.byStatus[g.status]++;
      const k = (out.byKind[e.kind] ??= zero());
      k[g.status]++;
    }
    if (s.neutral && (s.neutral.flags.length > 0 || s.neutral.segments.length > 0)) {
      const n = (out.neutral ??= { flags: zero(), segments: zero() });
      for (const f of s.neutral.flags) {
        if (f.archived) {
          out.archived++;
          continue;
        }
        const st = neutralFlagStatus(f);
        out.total++;
        out.byStatus[st]++;
        n.flags[st]++;
      }
      for (const g of s.neutral.segments) {
        if (g.archived) {
          out.archived++;
          continue;
        }
        const st = neutralSegmentStatus(g);
        out.total++;
        out.byStatus[st]++;
        n.segments[st]++;
      }
    }
  }
  return out;
}

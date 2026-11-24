import { gateReadReason, layerReport, MISSING_GATE_LABEL, type ExperimentFate, type LayerReportExperiment, type LayerReportOptions, type MissingGateReason } from './layers.ts';
import type { CanonicalSnapshot, Holdout, Layer, Metric, MetricRef } from './model.ts';

/**
 * The experiment migration kit (PLAN §11): for a set of StatSig experiments the user ticks on the
 * Layers page, everything else that has to exist in LaunchDarkly before they can launch there,
 * deduplicated across the selection. A read-only preview over the snapshot: it asks the planner
 * for nothing, maps nothing and writes nothing. It says what the follow-on experiment mapper
 * will have to create, in the shape the report already uses (one JSON flag per experiment, the
 * layer and its defaults flag, the targeting gate as a segment, metrics, holdouts), so a runbook
 * written from the Markdown export matches what the console will do later.
 *
 * Pure, so the screen and the export read the same items and so it runs in Vitest.
 */

export type KitItemKind = 'layer' | 'flag' | 'segment' | 'metric' | 'holdout';

export type KitItemState =
  /** In the snapshot and not yet in LD: the migration would create it. */
  | 'in_snapshot'
  /** Named by an experiment but not in the snapshot; `missing` says why. */
  | 'missing_from_snapshot'
  /** Archived in StatSig: never migrated. */
  | 'archived'
  /** The LD project already has a resource of this kind under this key (the workspace's LD listing). */
  | 'already_in_ld'
  /** The experiment itself while it runs in StatSig (fate `wait`): its dependencies can go first. */
  | 'blocked_running';

/** How an item got into the kit. */
export type KitItemVia =
  /** The experiment the user selected: its own flag. */
  | 'selected'
  /** The layer the experiment sits in, and that layer's defaults flag. */
  | 'layer'
  /** The experiment's targeting gate. */
  | 'targeting_gate'
  /** A gate a kit gate's rules name (`passes_gate` / `fails_gate`), transitively. */
  | 'gate_reference'
  /** A StatSig segment a kit gate's rules name (`passes_segment` / `fails_segment`). */
  | 'segment_reference'
  | 'metric'
  | 'holdout';

export interface KitItem {
  kind: KitItemKind;
  /** The StatSig id (gate, layer, holdout, experiment id; a metric's name). */
  id: string;
  /** The key it would get in LaunchDarkly. The experiment mapper may still change this. */
  ldKey: string;
  /** What it becomes: "LaunchDarkly layer", "JSON flag · 2 variations", "segment", "ratio metric"… */
  target: string;
  state: KitItemState;
  /** One sentence for the badge tooltip and the export's Note column. */
  reason: string;
  via: KitItemVia;
  /** Selected experiments that need this item (sorted, deduplicated). */
  neededBy: string[];
  /** For a gate or metric missing from the snapshot, the same reasons the report gives. */
  missing?: MissingGateReason;
}

export interface KitSelectedExperiment {
  id: string;
  fate: ExperimentFate;
  layerId: string | null;
  /** The flag item for this experiment (also in `items`). */
  flag: KitItem;
}

export interface ExperimentKit {
  /** Every item once, in kind order (layers, flags, segments, metrics, holdouts) then by id. */
  items: KitItem[];
  byKind: Record<KitItemKind, KitItem[]>;
  counts: Record<KitItemState, number>;
  selected: KitSelectedExperiment[];
  /** Selected ids the kit leaves out, with the reason: archived or abandoned experiments, ids not in the snapshot. */
  excluded: { id: string; reason: string }[];
  /** Things the snapshot cannot say, e.g. a source kind that carries no metrics. */
  notes: string[];
}

/** Keys the workspace's LD project already has, per kind, from the LD listing the console caches. */
export interface LdPresence {
  flags?: Iterable<string>;
  segments?: Iterable<string>;
  metrics?: Iterable<string>;
  layers?: Iterable<string>;
  holdouts?: Iterable<string>;
}

export interface ExperimentKitOptions extends LayerReportOptions {
  ld?: LdPresence;
}

export const KIT_KINDS: KitItemKind[] = ['layer', 'flag', 'segment', 'metric', 'holdout'];
export const KIT_STATES: KitItemState[] = ['in_snapshot', 'already_in_ld', 'blocked_running', 'missing_from_snapshot', 'archived'];

export const KIT_KIND_LABEL: Record<KitItemKind, string> = { layer: 'Layers', flag: 'Flags', segment: 'Segments', metric: 'Metrics', holdout: 'Holdouts' };

export const KIT_STATE_LABEL: Record<KitItemState, string> = {
  in_snapshot: 'to create',
  already_in_ld: 'already in LD',
  blocked_running: 'running in StatSig',
  missing_from_snapshot: 'not in snapshot',
  archived: 'archived',
};

/** The key a layer's defaults flag would get: the layer's parameter defaults as one JSON flag. */
export function layerDefaultsFlagKey(layerId: string): string {
  return `${layerId}_defaults`;
}

export function experimentMigrationKit(snapshot: CanonicalSnapshot, experimentIds: Iterable<string>, opts: ExperimentKitOptions = {}): ExperimentKit {
  const report = layerReport(snapshot, opts);
  const described = new Map<string, LayerReportExperiment>();
  for (const row of [...report.rows, report.unlayered]) for (const x of row.experiments) described.set(x.experiment.id, x);
  const gates = new Map(snapshot.gates.map((g) => [g.id, g]));
  const segments = new Set(snapshot.segments.map((s) => s.id));
  const archivedSegments = new Set(snapshot.segments.filter((s) => s.archived).map((s) => s.id));
  const layers = new Map((snapshot.layers ?? []).map((l) => [l.id, l]));
  const holdouts = new Map((snapshot.holdouts ?? []).map((h) => [h.id, h]));
  const metrics = snapshot.metrics ?? [];
  const gateReads = gateReadReason(snapshot, opts.scope);
  const metricReads = readReason(snapshot, opts.scope, 'metric', '/metrics');
  const ld = {
    flags: new Set(opts.ld?.flags ?? []),
    segments: new Set(opts.ld?.segments ?? []),
    metrics: new Set(opts.ld?.metrics ?? []),
    layers: new Set(opts.ld?.layers ?? []),
    holdouts: new Set(opts.ld?.holdouts ?? []),
  };

  const items = new Map<string, KitItem>();
  const excluded: ExperimentKit['excluded'] = [];
  const notes = new Set<string>();
  const selected: KitSelectedExperiment[] = [];

  /** Adds an item once; a second experiment needing it only joins `neededBy`. */
  const add = (item: Omit<KitItem, 'neededBy'>, by: string): KitItem => {
    const key = `${item.kind}/${item.id}`;
    let existing = items.get(key);
    if (!existing) items.set(key, (existing = { ...item, neededBy: [] }));
    if (!existing.neededBy.includes(by)) existing.neededBy.push(by);
    return existing;
  };
  /** archived > already in LD > in snapshot, for an item the snapshot has. */
  const presence = (archived: boolean, inLd: boolean): KitItemState => (archived ? 'archived' : inLd ? 'already_in_ld' : 'in_snapshot');

  /** The targeting gate and, transitively, the gates and StatSig segments its rules name. */
  const addGateClosure = (gateId: string, by: string, via: 'targeting_gate' | 'gate_reference', referrer?: string) => {
    const seen = new Set<string>();
    const queue: { id: string; via: 'targeting_gate' | 'gate_reference'; referrer?: string }[] = [{ id: gateId, via, referrer }];
    while (queue.length) {
      const { id, via: v, referrer: ref } = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const g = gates.get(id);
      const how = v === 'targeting_gate' ? 'The experiment’s targeting gate: its audience becomes a segment the flag’s experiment rule targets.' : `Named by gate ${ref} (passes_gate / fails_gate): becomes a segment the referring segment matches.`;
      if (!g) {
        add({ kind: 'segment', id, ldKey: id, target: 'segment (from gate)', state: 'missing_from_snapshot', missing: gateReads, reason: `Gate not in this snapshot (${MISSING_GATE_LABEL[gateReads]}). ${how}`, via: v }, by);
        continue;
      }
      add({ kind: 'segment', id, ldKey: id, target: `segment (from gate${g.rules.length ? `, ${g.rules.length} rule${g.rules.length === 1 ? '' : 's'}` : ''})`, state: presence(g.archived, ld.segments.has(id)), reason: g.archived ? `Gate archived in StatSig: never migrated. ${how}` : ld.segments.has(id) ? `The LD project already has a segment “${id}”. ${how}` : how, via: v }, by);
      for (const r of g.rules) {
        for (const c of r.conditions) {
          if (c.type === 'passes_gate' || c.type === 'fails_gate') for (const target of values(c.targetValue)) queue.push({ id: target, via: 'gate_reference', referrer: id });
          else if (c.type === 'passes_segment' || c.type === 'fails_segment') for (const target of values(c.targetValue)) addSegment(target, by, id);
        }
      }
    }
  };
  const addSegment = (id: string, by: string, referrer: string) => {
    const how = `Named by gate ${referrer} (passes_segment / fails_segment): the StatSig segment migrates as a segment.`;
    if (!segments.has(id)) add({ kind: 'segment', id, ldKey: id, target: 'segment', state: 'missing_from_snapshot', missing: readReason(snapshot, opts.scope, 'segment', '/segments'), reason: `Segment not in this snapshot. ${how}`, via: 'segment_reference' }, by);
    else add({ kind: 'segment', id, ldKey: id, target: 'segment', state: presence(archivedSegments.has(id), ld.segments.has(id)), reason: archivedSegments.has(id) ? `Segment archived in StatSig: never migrated. ${how}` : ld.segments.has(id) ? `The LD project already has a segment “${id}”. ${how}` : how, via: 'segment_reference' }, by);
  };
  const addLayer = (l: Layer, by: string) => {
    const inLd = ld.layers.has(l.id);
    add({ kind: 'layer', id: l.id, ldKey: l.id, target: `LaunchDarkly layer (unit type ${l.idType})`, state: presence(l.archived, inLd), reason: l.archived ? 'Layer archived in StatSig: never migrated.' : inLd ? `The LD project already has a layer “${l.id}”; the experiment reserves traffic in it.` : 'Created so the experiments in it stay mutually exclusive; the experiment reserves its allocation in it.', via: 'layer' }, by);
    const dk = layerDefaultsFlagKey(l.id);
    const params = l.parameters.length;
    add({ kind: 'flag', id: dk, ldKey: dk, target: `JSON flag · ${params} layer default${params === 1 ? '' : 's'}`, state: presence(l.archived, ld.flags.has(dk)), reason: l.archived ? 'Its layer is archived in StatSig: never migrated.' : ld.flags.has(dk) ? `The LD project already has a flag “${dk}”.` : `Carries the layer’s parameter defaults${params ? ` (${l.parameters.map((p) => p.name).join(', ')})` : ''} for code that reads getLayer().get(); a layer_parameters decision when the experiments launch.`, via: 'layer' }, by);
  };
  const addMetric = (ref: MetricRef, role: 'primary' | 'secondary', by: string) => {
    const m = findMetric(metrics, ref);
    const how = `${role === 'primary' ? 'Primary' : 'Secondary'} metric of the experiment; new LD experiments need their metrics first (PLAN §11).`;
    if (!m) add({ kind: 'metric', id: ref.name, ldKey: ref.name, target: `${ref.type} metric`, state: 'missing_from_snapshot', missing: metricReads, reason: `Metric not in this snapshot (${METRIC_GAP_LABEL[metricReads]}). ${how}`, via: 'metric' }, by);
    else add({ kind: 'metric', id: m.name, ldKey: m.name, target: `${m.metricType} metric${m.isWarehouseNative ? ' (warehouse native)' : ''}`, state: presence(m.archived, ld.metrics.has(m.name)), reason: m.archived ? `Metric archived in StatSig: never migrated. ${how}` : ld.metrics.has(m.name) ? `The LD project already has a metric “${m.name}”. ${how}` : how, via: 'metric' }, by);
  };
  const addHoldout = (h: Holdout | undefined, id: string, by: string, how: string) => {
    if (!h) add({ kind: 'holdout', id, ldKey: id, target: 'holdout', state: 'missing_from_snapshot', missing: readReason(snapshot, opts.scope, 'holdout', '/holdouts'), reason: `Holdout not in this snapshot. ${how}`, via: 'holdout' }, by);
    else add({ kind: 'holdout', id: h.id, ldKey: h.id, target: `holdout · ${h.passPercentage}%${h.isGlobal ? ' (global)' : ''}`, state: presence(h.archived, ld.holdouts.has(h.id)), reason: h.archived ? `Holdout archived in StatSig: never migrated. ${how}` : ld.holdouts.has(h.id) ? `The LD project already has a holdout “${h.id}”. ${how}` : `${how} Becomes a new holdout population per environment; membership is re-randomized.`, via: 'holdout' }, by);
  };

  const ids = [...new Set(experimentIds)];
  for (const id of ids) {
    const x = described.get(id);
    if (!x) {
      excluded.push({ id, reason: 'Not in this snapshot.' });
      continue;
    }
    if (x.archived || x.fate === 'never') {
      excluded.push({ id, reason: x.reason });
      continue;
    }
    const e = x.experiment;
    const groups = e.groups.length;
    const inLd = ld.flags.has(e.id);
    const flagState: KitItemState = x.fate === 'wait' ? 'blocked_running' : inLd ? 'already_in_ld' : 'in_snapshot';
    const flagReason =
      x.fate === 'wait'
        ? `Running in StatSig: the flag and draft experiment are created after it ends. Everything else in the kit can go first.${inLd ? ` The LD project already has a flag “${e.id}”.` : ''}`
        : inLd
          ? `The LD project already has a flag “${e.id}”; a key_collision decision when the experiment is planned.`
          : x.fate === 'serve_shipped'
            ? `${x.reason} No draft experiment, so no layer reservation, metrics or holdout are needed.`
            : x.reason;
    const flag = add({ kind: 'flag', id: e.id, ldKey: e.id, target: `JSON flag · ${groups} variation${groups === 1 ? '' : 's'}${x.fate === 'serve_shipped' ? ' · serves the shipped group' : ' + draft experiment'}`, state: flagState, reason: flagReason, via: 'selected' }, e.id);
    selected.push({ id: e.id, fate: x.fate, layerId: e.layerId, flag });

    // The audience is needed whatever the experiment's state: a flag serving the shipped group still targets it.
    if (e.targetingGateId) addGateClosure(e.targetingGateId, e.id, 'targeting_gate');
    if (x.fate === 'serve_shipped') continue;

    if (e.layerId) {
      const l = layers.get(e.layerId);
      if (l) addLayer(l, e.id);
      else {
        add({ kind: 'layer', id: e.layerId, ldKey: e.layerId, target: 'LaunchDarkly layer', state: 'missing_from_snapshot', missing: readReason(snapshot, opts.scope, 'layer', '/layers'), reason: 'The experiment names a layer that is not in this snapshot (spec sources and partial crawls); sync it before the layer and its defaults flag can be listed.', via: 'layer' }, e.id);
      }
    }
    if (e.completeness.missing.includes('metrics')) notes.add(`Metrics are not in this snapshot for ${e.id}: its source kind does not carry experiment metrics. Read the project through the Console API, or add them to the runbook by hand.`);
    else if (e.primaryMetrics.length + e.secondaryMetrics.length === 0) notes.add(`${e.id} names no metrics; a LaunchDarkly experiment needs at least one before it can start.`);
    for (const m of e.primaryMetrics) addMetric(m, 'primary', e.id);
    for (const m of e.secondaryMetrics) addMetric(m, 'secondary', e.id);

    const holdoutIds = new Set(e.holdoutIds);
    for (const h of holdouts.values()) {
      if (h.experimentIds.includes(e.id) || (e.layerId && h.layerIds.includes(e.layerId))) holdoutIds.add(h.id);
    }
    for (const hid of holdoutIds) addHoldout(holdouts.get(hid), hid, e.id, holdouts.get(hid)?.layerIds.includes(e.layerId ?? '') && !e.holdoutIds.includes(hid) ? `Attached to the experiment’s layer ${e.layerId}.` : 'Attached to the experiment.');
    for (const h of holdouts.values()) {
      if (h.isGlobal && !holdoutIds.has(h.id) && !h.archived && h.enabled && h.idType === e.idType) addHoldout(h, h.id, e.id, `Global holdout on ${h.idType}: StatSig holds its units out of every new feature of that unit type, so the LD holdout must list the new flag.`);
    }
  }

  const list = [...items.values()];
  for (const it of list) it.neededBy.sort();
  list.sort((a, b) => KIT_KINDS.indexOf(a.kind) - KIT_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));
  const byKind = Object.fromEntries(KIT_KINDS.map((k) => [k, list.filter((i) => i.kind === k)])) as Record<KitItemKind, KitItem[]>;
  const counts = Object.fromEntries(KIT_STATES.map((s) => [s, list.filter((i) => i.state === s).length])) as Record<KitItemState, number>;
  return { items: list, byKind, counts, selected, excluded, notes: [...notes] };
}

/** `passes_gate` carries one gate id; be lenient about arrays, as the mapper is. */
function values(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === '' ? [] : [String(v)];
}

/** A metric reference (name + type) resolved against the snapshot; the Console API ids metrics by `<name>::<type>`, specs by name. */
function findMetric(metrics: Metric[], ref: MetricRef): Metric | undefined {
  return metrics.find((m) => m.name === ref.name && m.metricType === ref.type) ?? metrics.find((m) => m.name === ref.name) ?? metrics.find((m) => m.id === ref.name);
}

/** Why a resource of `kind` an experiment names is not in the snapshot; the same three reasons the report gives for gates. */
function readReason(snapshot: CanonicalSnapshot, scope: LayerReportOptions['scope'], kind: NonNullable<LayerReportOptions['scope']>[number], path: string): MissingGateReason {
  if (scope && !scope.includes(kind)) return 'out_of_scope';
  if ((snapshot.warnings ?? []).some((w) => w.code === 'fetch_skipped' && w.path === path)) return 'not_read';
  return 'not_found';
}

const METRIC_GAP_LABEL: Record<MissingGateReason, string> = {
  out_of_scope: 'metrics are outside this source’s crawl scope',
  not_read: 'the metric list could not be read in this sync',
  not_found: 'not found in StatSig: deleted or renamed',
};

export interface ExperimentKitMarkdownOptions {
  source?: string;
  project?: string;
  takenAt?: string;
}

/**
 * The kit as a Markdown document in the style of the layers report export: the selection, then
 * one table per kind with the item, what it becomes, its state, which experiments need it and the
 * note behind the state. Pastes into a runbook as the "what must exist first" section.
 */
export function experimentKitMarkdown(kit: ExperimentKit, opts: ExperimentKitMarkdownOptions = {}): string {
  const out: string[] = [];
  const scope = [opts.source, opts.project].filter(Boolean).join(' · ');
  out.push(`# Experiment migration kit${scope ? ` — ${scope}` : ''}`, '');
  if (opts.takenAt) out.push(`Snapshot taken ${opts.takenAt}.`, '');
  const c = kit.counts;
  const parts = KIT_STATES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${KIT_STATE_LABEL[s]}`);
  out.push(`${plural(kit.selected.length, 'experiment')} selected · ${plural(kit.items.length, 'item')} to have in LaunchDarkly first${parts.length ? ` (${parts.join(', ')})` : ''}.`, '');
  out.push('A preview over the snapshot: nothing here has been planned or written. Running experiments end in StatSig and launch new in LaunchDarkly; archived items never migrate; items already in LaunchDarkly are reused or raise a key collision when the experiments are planned.', '');
  if (kit.notes.length) {
    for (const n of kit.notes) out.push(`**Note:** ${md(n)}`, '');
  }
  if (kit.excluded.length) {
    out.push(`**Left out (${kit.excluded.length}):** ${kit.excluded.map((x) => `\`${md(x.id)}\` (${md(x.reason.replace(/\.$/, ''))})`).join('; ')}.`, '');
  }
  out.push('## Selected experiments', '');
  if (kit.selected.length === 0) out.push('None.', '');
  else {
    out.push('| Experiment | Layer | Becomes | State | Note |', '|---|---|---|---|---|');
    for (const s of kit.selected) out.push(`| \`${md(s.id)}\` | ${s.layerId ? `\`${md(s.layerId)}\`` : '–'} | ${md(s.flag.target)} | ${KIT_STATE_LABEL[s.flag.state]} | ${md(s.flag.reason)} |`);
    out.push('');
  }
  for (const kind of KIT_KINDS) {
    const list = kit.byKind[kind].filter((i) => !(kind === 'flag' && i.via === 'selected'));
    if (kind !== 'flag' && list.length === 0) continue;
    out.push(`## ${KIT_KIND_LABEL[kind]}${kind === 'flag' ? ' (besides the experiments’ own)' : ''} (${list.length})`, '');
    if (list.length === 0) {
      out.push('None.', '');
      continue;
    }
    out.push('| Item | LD key | Becomes | State | Needed by | Note |', '|---|---|---|---|---|---|');
    for (const i of list) out.push(`| \`${md(i.id)}\` | \`${md(i.ldKey)}\` | ${md(i.target)} | ${KIT_STATE_LABEL[i.state]} | ${i.neededBy.map((id) => `\`${md(id)}\``).join(', ')} | ${md(i.reason)} |`);
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Escapes what would break a Markdown table cell. */
function md(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

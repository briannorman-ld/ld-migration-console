import type { CanonicalSnapshot, Condition, Experiment, Gate, Layer, Rule } from './model.ts';

/**
 * The layers and experiments report (Layers page): which experiments sit in which layer, what
 * happens to each in the migration, and what can be skipped. Pure, so the screen and the CSV
 * export read the same verdicts, and so it runs in Vitest against the demo fixtures.
 *
 * Verdicts follow PLAN §11 and the coverage matrix (`experiments.*` rows): nothing moves
 * mid-flight, archived and abandoned experiments are never migrated, implicit layers are dropped,
 * and a layer is only worth creating while it has an experiment left to keep exclusive.
 */

/** What the migration does with an experiment. */
export type ExperimentFate =
  /** `setup`: JSON flag + draft LaunchDarkly experiment. */
  | 'draft'
  /** `active`: running in StatSig, migrate after it ends. */
  | 'wait'
  /** `decision_made`: the flag serves the shipped group at 100%. */
  | 'serve_shipped'
  /** Stopped without a shipped group: drafted like `setup`, or skipped. */
  | 'stopped'
  /** Abandoned or archived: never migrated. */
  | 'never';

/** What the migration does with a layer. */
export type LayerFate =
  | 'create'
  /** Implicit one-experiment layer: dropped, the experiment migrates on its own. */
  | 'skip_implicit'
  /** No live experiment left to keep exclusive: nothing to reserve. */
  | 'skip_empty'
  /** Archived: never migrated. */
  | 'never';

export interface ExperimentTargetingSummary {
  /** The targeting gate, resolved against the snapshot when it is there. */
  gate: { id: string; found: boolean; archived: boolean; enabled: boolean; rules: string[] } | null;
  /** Inline targeting rules (Console `inlineTargetingRules`), one line each. */
  inlineRules: string[];
  /** Forced-group overrides: how many IDs. */
  overrideIds: number;
  holdoutIds: string[];
  /** One line for a table cell or a CSV field; "none" when the experiment targets everyone. */
  text: string;
}

export interface LayerReportExperiment {
  experiment: Experiment;
  /** Archived in StatSig (the flag or the `archived` status): listed apart, never migrated. */
  archived: boolean;
  /** Needs a place in the layer: not archived, and not yet concluded or abandoned. */
  live: boolean;
  fate: ExperimentFate;
  reason: string;
  targeting: ExperimentTargetingSummary;
  /** The experiment names a layer the snapshot does not have (spec sources, partial crawls). */
  missingLayerId?: string;
  /** Layer parameters this experiment sets, with the value each group gives them. Only for experiments in a layer the snapshot has. */
  parameters?: ParameterOverride[];
}

/** One layer parameter as an experiment sets it: the layer default and the value per group. */
export interface ParameterOverride {
  name: string;
  /** False when the experiment sets a parameter the layer does not declare. */
  declared: boolean;
  defaultValue: unknown;
  /** Group name → value. Groups that leave the parameter alone are absent. */
  byGroup: Record<string, unknown>;
}

export interface LayerReportRow {
  /** `null` for the group of experiments that are not in any layer. */
  layer: Layer | null;
  experiments: LayerReportExperiment[];
  counts: { live: number; ended: number; archived: number };
  /** `null` for the unlayered group. */
  fate: LayerFate | null;
  reason: string;
  /** Experiment IDs the layer lists that the snapshot does not contain. */
  unknownExperimentIds: string[];
  /** Per layer parameter, the non-archived experiments that set it; a parameter no experiment sets is served at its default everywhere. */
  parameterUse: Record<string, string[]>;
}

export interface LayerReportTotals {
  layers: number;
  archivedLayers: number;
  implicitLayers: number;
  /** Live layers the migration can leave behind (implicit, or nothing left to reserve). */
  skippableLayers: number;
  experiments: number;
  archivedExperiments: number;
  runningExperiments: number;
  /** Live experiments the migration never moves (abandoned). */
  skippableExperiments: number;
}

export interface LayerReport {
  /** One row per layer, archived ones included (the screen filters). */
  rows: LayerReportRow[];
  unlayered: LayerReportRow;
  totals: LayerReportTotals;
}

export function layerReport(snapshot: CanonicalSnapshot): LayerReport {
  const gates = new Map(snapshot.gates.map((g) => [g.id, g]));
  const layers = snapshot.layers ?? [];
  const layerIds = new Set(layers.map((l) => l.id));
  const byLayer = new Map<string, LayerReportExperiment[]>();
  const unlayered: LayerReportExperiment[] = [];
  const seen = new Set<string>();
  for (const e of snapshot.experiments ?? []) {
    const item = describeExperiment(e, gates);
    seen.add(e.id);
    if (e.layerId && layerIds.has(e.layerId)) {
      const list = byLayer.get(e.layerId);
      if (list) list.push(item);
      else byLayer.set(e.layerId, [item]);
    } else {
      if (e.layerId) item.missingLayerId = e.layerId;
      unlayered.push(item);
    }
  }
  const rows = layers.map((l): LayerReportRow => {
    const experiments = (byLayer.get(l.id) ?? []).map((x) => ({ ...x, parameters: parameterOverrides(l, x.experiment) }));
    const listed = new Set(experiments.map((x) => x.experiment.id));
    const unknownExperimentIds = l.experimentIds.filter((id) => !listed.has(id) && !seen.has(id));
    const counts = countExperiments(experiments);
    const { fate, reason } = layerFate(l, counts);
    const parameterUse: Record<string, string[]> = Object.fromEntries(l.parameters.map((p) => [p.name, []]));
    for (const x of experiments) if (!x.archived) for (const o of x.parameters ?? []) if (o.declared) parameterUse[o.name]!.push(x.experiment.id);
    return { layer: l, experiments, counts, fate, reason, unknownExperimentIds, parameterUse };
  });
  const unlayeredRow: LayerReportRow = {
    layer: null,
    experiments: unlayered,
    counts: countExperiments(unlayered),
    fate: null,
    reason: 'Experiments outside any layer: each migrates on its own.',
    unknownExperimentIds: [],
    parameterUse: {},
  };
  const all = [...rows.flatMap((r) => r.experiments), ...unlayered];
  const liveLayers = rows.filter((r) => !r.layer!.archived);
  return {
    rows,
    unlayered: unlayeredRow,
    totals: {
      layers: liveLayers.length,
      archivedLayers: rows.length - liveLayers.length,
      implicitLayers: liveLayers.filter((r) => r.layer!.isImplicit).length,
      skippableLayers: liveLayers.filter((r) => r.fate === 'skip_implicit' || r.fate === 'skip_empty').length,
      experiments: all.filter((x) => !x.archived).length,
      archivedExperiments: all.filter((x) => x.archived).length,
      runningExperiments: all.filter((x) => !x.archived && x.fate === 'wait').length,
      skippableExperiments: all.filter((x) => !x.archived && x.fate === 'never').length,
    },
  };
}

function countExperiments(items: LayerReportExperiment[]): LayerReportRow['counts'] {
  let live = 0;
  let ended = 0;
  let archived = 0;
  for (const x of items) {
    if (x.archived) archived++;
    else if (x.live) live++;
    else ended++;
  }
  return { live, ended, archived };
}

function layerFate(l: Layer, counts: LayerReportRow['counts']): { fate: LayerFate; reason: string } {
  if (l.archived) return { fate: 'never', reason: 'Archived in StatSig: never migrated.' };
  if (l.isImplicit) return { fate: 'skip_implicit', reason: 'A one-experiment layer StatSig created implicitly: the layer is dropped and the experiment migrates on its own.' };
  if (counts.live === 0) {
    const parts = [counts.ended ? `${counts.ended} ended` : '', counts.archived ? `${counts.archived} archived` : ''].filter(Boolean);
    return { fate: 'skip_empty', reason: `No experiment left to keep exclusive${parts.length ? ` (${parts.join(', ')})` : ''}: nothing to reserve, so the layer can be skipped.` };
  }
  return { fate: 'create', reason: `Becomes a LaunchDarkly layer reserving traffic for ${counts.live} experiment${counts.live === 1 ? '' : 's'}; code reading getLayer().get() raises a layer_parameters decision.` };
}

function describeExperiment(e: Experiment, gates: Map<string, Gate>): LayerReportExperiment {
  const archived = e.archived || e.status === 'archived';
  const targeting = summarizeTargeting(e, gates);
  const { fate, reason } = experimentFate(e, archived, targeting);
  const live = !archived && (fate === 'draft' || fate === 'wait' || fate === 'stopped');
  return { experiment: e, archived, live, fate, reason, targeting };
}

/** Which of the layer's parameters the experiment overrides, group by group; layer order first, undeclared names after. */
export function parameterOverrides(l: Layer, e: Experiment): ParameterOverride[] {
  const declared = new Map(l.parameters.map((p) => [p.name, p.defaultValue]));
  const seen = new Map<string, ParameterOverride>();
  for (const g of e.groups) {
    for (const [name, value] of Object.entries(g.parameterValues ?? {})) {
      let o = seen.get(name);
      if (!o) seen.set(name, (o = { name, declared: declared.has(name), defaultValue: declared.get(name), byGroup: {} }));
      o.byGroup[g.name] = value;
    }
  }
  const inLayerOrder = l.parameters.map((p) => seen.get(p.name)).filter((o): o is ParameterOverride => !!o);
  const extra = [...seen.values()].filter((o) => !o.declared);
  return [...inLayerOrder, ...extra];
}

/** "cta_text: Control=\"Place order\", Urgent=\"Complete purchase now\"" — undeclared parameters are marked. */
export function describeOverride(o: ParameterOverride): string {
  const groups = Object.entries(o.byGroup).map(([g, v]) => `${g}=${JSON.stringify(v)}`).join(', ');
  return `${o.name}${o.declared ? '' : ' (not on the layer)'}: ${groups}`;
}

function experimentFate(e: Experiment, archived: boolean, t: ExperimentTargetingSummary): { fate: ExperimentFate; reason: string } {
  if (archived) return { fate: 'never', reason: 'Archived in StatSig: never migrated.' };
  switch (e.status) {
    case 'active':
      return { fate: 'wait', reason: `Running in StatSig: migrate after it ends; assignments and results never move.${t.gate ? ` Its targeting gate ${t.gate.id} migrates first.` : ''}` };
    case 'setup':
      return { fate: 'draft', reason: `Not started: becomes a JSON flag with ${e.groups.length} variation${e.groups.length === 1 ? '' : 's'} and a draft LaunchDarkly experiment at ${pct(e.allocation)}.` };
    case 'decision_made': {
      const shipped = e.groups.find((g) => g.id === e.launchedGroupId || g.name === e.launchedGroupId);
      return { fate: 'serve_shipped', reason: `Concluded: the flag serves ${shipped ? `“${shipped.name}”` : 'the shipped group'} at 100%; no layer reservation is needed.` };
    }
    case 'experiment_stopped':
    case 'assignment_stopped':
      return { fate: 'stopped', reason: 'Stopped without a shipped group: drafted like a not-started experiment, or skipped.' };
    case 'abandoned':
      return { fate: 'never', reason: 'Abandoned in StatSig: never migrated.' };
    default:
      return { fate: 'never', reason: `Status “${e.status}”: never migrated.` };
  }
}

export function summarizeTargeting(e: Experiment, gates: Map<string, Gate>): ExperimentTargetingSummary {
  const g = e.targetingGateId ? gates.get(e.targetingGateId) : undefined;
  const gate = e.targetingGateId
    ? g
      ? { id: g.id, found: true, archived: g.archived, enabled: g.enabled, rules: g.rules.map(describeRule) }
      : { id: e.targetingGateId, found: false, archived: false, enabled: true, rules: [] }
    : null;
  const inlineRules = e.targetingRules.map(describeRule);
  const overrideIds = e.overrides.reduce((n, o) => n + o.ids.length, 0);
  const parts: string[] = [];
  if (gate) parts.push(`gate ${gate.id}${gate.found ? (gate.rules.length ? `: ${gate.rules.join('; ')}` : '') : ' (not in this snapshot)'}`);
  if (inlineRules.length) parts.push(`${inlineRules.length === 1 ? 'rule' : `${inlineRules.length} rules`}: ${inlineRules.join('; ')}`);
  if (overrideIds) parts.push(`${overrideIds} forced ID${overrideIds === 1 ? '' : 's'}`);
  if (e.holdoutIds.length) parts.push(`holdout ${e.holdoutIds.join(', ')}`);
  return { gate, inlineRules, overrideIds, holdoutIds: e.holdoutIds, text: parts.length ? parts.join(' · ') : 'none' };
}

/** "country any [US, CA]", "email str_contains_any [@acme.com]", "everyone". */
export function describeCondition(c: Condition): string {
  if (c.type === 'public') return 'everyone';
  const what = c.type === 'custom_field' ? (c.field ?? 'custom_field') : c.type === 'unit_id' ? (c.customID ?? 'unit_id') : c.type;
  const values = Array.isArray(c.targetValue) ? `[${c.targetValue.map(String).join(', ')}]` : c.targetValue === null || c.targetValue === undefined ? '' : String(c.targetValue);
  return [what, c.operator ? String(c.operator) : '', values].filter(Boolean).join(' ');
}

/** Conditions ANDed, plus the pass percentage when it is partial. */
export function describeRule(r: Rule): string {
  const conds = r.conditions.length ? r.conditions.map(describeCondition).join(' and ') : 'everyone';
  return r.passPercentage < 100 ? `${conds} (${r.passPercentage}% pass)` : conds;
}

export type LayerSortKey = 'experiments' | 'running' | 'parameters' | 'name';

/** Layers by live experiment count (default), running experiments, parameter count or name; ties by name. */
export function sortLayerRows(rows: LayerReportRow[], key: LayerSortKey, dir: 'asc' | 'desc' = 'desc'): LayerReportRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: LayerReportRow, b: LayerReportRow) => (a.layer?.id ?? '').localeCompare(b.layer?.id ?? '');
  const metric = (r: LayerReportRow): number =>
    key === 'experiments' ? r.counts.live : key === 'running' ? r.experiments.filter((x) => !x.archived && x.fate === 'wait').length : key === 'parameters' ? (r.layer?.parameters.length ?? 0) : 0;
  return [...rows].sort((a, b) => (key === 'name' ? sign * byName(a, b) : sign * (metric(a) - metric(b)) || byName(a, b)));
}

export const EXPERIMENT_FATE_LABEL: Record<ExperimentFate, string> = {
  draft: 'Draft experiment',
  wait: 'Wait until it ends',
  serve_shipped: 'Flag serves shipped group',
  stopped: 'Draft or skip',
  never: 'Never migrated',
};

export const LAYER_FATE_LABEL: Record<LayerFate, string> = {
  create: 'Create LD layer',
  skip_implicit: 'Skip layer · experiment still migrates',
  skip_empty: 'Skip · nothing left to reserve',
  never: 'Never migrated',
};

/** One CSV row per experiment, plus a row for every layer without experiments, so nothing is lost in the export. `source` adds a leading column (workspaces with several sources). */
export function layerReportCsv(report: LayerReport, opts: { source?: string } = {}): string {
  const sourceCol = opts.source !== undefined ? [opts.source] : [];
  const header = [...(opts.source !== undefined ? ['source'] : []), 'layer', 'layer_fate', 'layer_implicit', 'layer_archived', 'layer_parameters', 'layer_defaults', 'experiment', 'status', 'experiment_archived', 'allocation_pct', 'groups', 'unit_type', 'parameters_overridden', 'targeting', 'experiment_fate', 'reason'];
  const lines: string[][] = [];
  for (const row of [...report.rows, report.unlayered]) {
    const l = row.layer;
    const layerCells = [...sourceCol, l?.id ?? '(not in a layer)', row.fate ? LAYER_FATE_LABEL[row.fate] : '', l ? String(l.isImplicit) : '', l ? String(l.archived) : '', l ? String(l.parameters.length) : '', l ? describeDefaults(l) : ''];
    if (row.experiments.length === 0) {
      lines.push([...layerCells, '', '', '', '', '', '', '', '', '', row.reason]);
      continue;
    }
    for (const x of row.experiments) {
      const e = x.experiment;
      lines.push([...layerCells, e.id, e.status, String(x.archived), String(e.allocation), e.groups.map((g) => `${g.name} ${g.size}%`).join('; '), e.idType, (x.parameters ?? []).map(describeOverride).join('; '), x.targeting.text, EXPERIMENT_FATE_LABEL[x.fate], x.reason]);
    }
  }
  return [header, ...lines].map((cells) => cells.map(csvCell).join(',')).join('\n') + '\n';
}

/** "cta_text=\"Place order\"; show_badges=false" */
export function describeDefaults(l: Layer): string {
  return l.parameters.map((p) => `${p.name}=${JSON.stringify(p.defaultValue)}`).join('; ');
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function pct(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

export interface LayerReportMarkdownOptions {
  /** Source alias, shown in the title. */
  source?: string;
  /** StatSig project name, shown in the title. */
  project?: string;
  /** Snapshot time (ISO), shown under the title. */
  takenAt?: string;
}

/**
 * The report as a Markdown document: one section per layer the migration will create (verdict,
 * default parameters, experiments), live layers first by experiment count, then experiments
 * outside any layer. Layers that are skipped or archived all say the same thing, so they are
 * listed by name with a one-line note each instead of a section apiece. Pastes into wikis and
 * review threads where the CSV's flat rows do not read.
 */
export function layerReportMarkdown(report: LayerReport, opts: LayerReportMarkdownOptions = {}): string {
  const t = report.totals;
  const live = sortLayerRows(report.rows.filter((r) => !r.layer!.archived), 'experiments');
  const created = live.filter((r) => r.fate === 'create');
  const implicit = sortLayerRows(live.filter((r) => r.fate === 'skip_implicit'), 'name', 'asc');
  const empty = sortLayerRows(live.filter((r) => r.fate === 'skip_empty'), 'name', 'asc');
  const archived = sortLayerRows(report.rows.filter((r) => r.layer!.archived), 'name', 'asc');
  const out: string[] = [];
  const scope = [opts.source, opts.project].filter(Boolean).join(' · ');
  out.push(`# Layers and experiments${scope ? ` — ${scope}` : ''}`, '');
  if (opts.takenAt) out.push(`Snapshot taken ${opts.takenAt}.`, '');
  out.push(
    `${plural(t.layers, 'live layer')} (${t.implicitLayers} implicit, ${t.archivedLayers} archived) · ${plural(t.experiments, 'live experiment')} (${t.runningExperiments} running, ${t.skippableExperiments} abandoned, ${t.archivedExperiments} archived) · ${plural(t.skippableLayers, 'layer')} could be skipped.`,
    '',
    'Verdicts follow the migration policy: running experiments end in StatSig and migrate afterwards, archived and abandoned experiments are never migrated, implicit layers are dropped, and a layer is only created while it has an experiment left to keep exclusive.',
    '',
  );
  for (const r of created) out.push(...layerSection(r));
  if (report.unlayered.experiments.length) out.push(...layerSection(report.unlayered));
  if (implicit.length || empty.length) {
    out.push(`## Skipped layers (${implicit.length + empty.length})`, '');
    if (implicit.length) {
      out.push(`**Implicit layers (${implicit.length}):** one-experiment layers StatSig created implicitly. The layer is dropped; the experiment, when it is live, migrates on its own.`, '');
      for (const r of implicit) out.push(layerLine(r));
      out.push('');
    }
    if (empty.length) {
      out.push(`**Nothing left to keep exclusive (${empty.length}):** every experiment has concluded, been abandoned or archived, so there is nothing to reserve.`, '');
      for (const r of empty) out.push(layerLine(r));
      out.push('');
    }
  }
  if (archived.length) {
    out.push(`## Archived layers (${archived.length})`, '', 'Archived in StatSig: never migrated.', '');
    for (const r of archived) out.push(layerLine(r));
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** One bullet for a layer that gets no section: its name, then the experiments in it (or none). */
function layerLine(r: LayerReportRow): string {
  const l = r.layer!;
  const exps = r.experiments.map((x) => `\`${md(x.experiment.id)}\` (${x.archived ? 'archived' : x.experiment.status.replace(/_/g, ' ')})`);
  const unknown = r.unknownExperimentIds.map((id) => `\`${md(id)}\` (not in this snapshot)`);
  const all = [...exps, ...unknown];
  const params = l.parameters.length ? `${plural(l.parameters.length, 'parameter')}` : '';
  const detail = [all.length ? all.join(', ') : 'no experiments in this snapshot', params].filter(Boolean).join(' · ');
  return `- \`${md(l.id)}\` — ${detail}`;
}

function layerSection(r: LayerReportRow, level = 2): string[] {
  const h = '#'.repeat(level);
  const l = r.layer;
  const out: string[] = [];
  out.push(`${h} ${l ? `\`${l.id}\`` : 'Not in a layer'}${r.fate ? ` — ${LAYER_FATE_LABEL[r.fate]}` : ''}`, '');
  if (l) {
    const meta = [l.isImplicit ? 'implicit layer' : '', `unit type: ${l.idType}`, l.owner?.name ? `owner: ${l.owner.name}` : '', l.description ?? ''].filter(Boolean).join(' · ');
    if (meta) out.push(md(meta), '');
  }
  const counts = [`${r.counts.live} live`, r.counts.ended ? `${r.counts.ended} ended` : '', r.counts.archived ? `${r.counts.archived} archived` : ''].filter(Boolean).join(', ');
  out.push(`> ${md(r.reason)} (${counts}${r.unknownExperimentIds.length ? `; not in this snapshot: ${r.unknownExperimentIds.map((id) => `\`${id}\``).join(', ')}` : ''})`, '');
  if (l) {
    out.push('**Default parameters**', '');
    if (l.parameters.length === 0) out.push('No parameters.', '');
    else {
      out.push('| Parameter | Type | Default | Set by |', '|---|---|---|---|');
      for (const p of l.parameters) {
        const users = r.parameterUse[p.name] ?? [];
        out.push(`| \`${md(p.name)}\` | ${p.type ?? '–'} | \`${md(JSON.stringify(p.defaultValue))}\` | ${users.length ? users.map((id) => `\`${md(id)}\``).join(', ') : 'no experiment (default everywhere)'} |`);
      }
      out.push('');
    }
  }
  out.push('**Experiments**', '');
  if (r.experiments.length === 0) out.push('No experiments in this snapshot.', '');
  else {
    const withParams = !!l;
    out.push(withParams ? '| Experiment | Status | Allocation | Unit | Overrides | Targeting | Migration |' : '| Experiment | Status | Allocation | Unit | Targeting | Migration |', withParams ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|');
    for (const x of r.experiments) {
      const e = x.experiment;
      const name = `\`${md(e.id)}\`${x.missingLayerId ? ` (layer \`${md(x.missingLayerId)}\` not synced)` : ''}`;
      const overrides = withParams ? ` ${x.parameters?.length ? x.parameters.map((o) => md(describeOverride(o))).join('<br>') : 'none'} |` : '';
      out.push(`| ${name} | ${x.archived ? 'archived' : e.status.replace(/_/g, ' ')} | ${e.allocation}% | ${md(e.idType)} |${overrides} ${md(x.targeting.text)} | ${EXPERIMENT_FATE_LABEL[x.fate]} |`);
    }
    out.push('');
  }
  return out;
}

/** Escapes what would break a Markdown table cell or start unintended formatting. */
function md(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

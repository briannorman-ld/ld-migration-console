/**
 * Experimentation of a neutral-model source → LaunchDarkly (PLAN §20.5): metrics, metric groups,
 * experiments, holdouts and layers of an LD project attached as a source. Pure and deterministic
 * like the rest of the mapper. The vocabulary is the target's, so a copy is near-identity; what
 * cannot cross projects (results, exposures, iteration history, a running state, account ids)
 * becomes a decision or a note, never a silent drop (CLAUDE.md).
 *
 * Nothing is moved mid-flight (PLAN §11): a copied experiment is created with one iteration as a
 * draft and is started by a person in LaunchDarkly; a copied holdout is created, not started.
 */
import { fingerprint, migratedFromTag, neutralDesignIteration, neutralExperimentEnvOf, neutralHoldoutEnvOf, PROVENANCE_TAG_RE, sanitizeTag, sourceTag, type NeutralExperiment, type NeutralExperimentEnv, type NeutralHoldout, type NeutralHoldoutEnv, type NeutralIteration, type NeutralIterationFlag, type NeutralIterationMetric, type NeutralLayer, type NeutralMaintainer, type NeutralMetric, type NeutralMetricGroup } from '@sslm/canonical';
import { SkipItem, unique } from './conditions.ts';
import { SKIP } from './decisions.ts';
import { report, type MapArgs, type MapOutcome } from './gate.ts';
import { neutralFlagByKey } from './lookup.ts';
import { chooseMaintainer, type MaintainerAssignment } from './maintainer.ts';
import { makeCtx, resolveSourceKind, sourceLabel, type Ctx } from './neutral.ts';
import type { CapabilityState, DesiredExperiment, DesiredHoldout, DesiredLayer, DesiredMetric, DesiredMetricGroup, ExperimentRuleRef, MapperCapabilities } from './types.ts';

export interface NeutralMetricMapResult extends MapOutcome {
  metricKey: string;
  desired: DesiredMetric | null;
}
export interface NeutralMetricGroupMapResult extends MapOutcome {
  groupKey: string;
  desired: DesiredMetricGroup | null;
}
export interface NeutralExperimentMapResult extends MapOutcome {
  experimentKey: string;
  desired: DesiredExperiment | null;
}
export interface NeutralHoldoutMapResult extends MapOutcome {
  holdoutKey: string;
  desired: DesiredHoldout | null;
}
export interface NeutralLayerMapResult extends MapOutcome {
  layerKey: string;
  desired: DesiredLayer | null;
}

const METRIC_KINDS = new Set(['custom', 'pageview', 'click', 'trace']);

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

function outcome(ctx: Ctx, entity: { uid: string; key: string }, fp: string, skipped?: string): MapOutcome {
  return {
    uid: entity.uid,
    entityId: entity.key,
    sourceId: ctx.sourceId,
    fidelity: report(ctx.fidelity, skipped),
    unresolved: ctx.decisions.unresolved,
    applied: ctx.decisions.applied,
    stale: ctx.decisions.stale,
    dependencies: [...ctx.deps.values()].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)),
    statsigFingerprint: fp,
    decisionSetHash: ctx.decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  };
}

/** Provenance tags plus the source's own (sanitized), minus provenance an earlier migration wrote into the source. */
function tagsFor(ctx: Ctx, tags: string[]): string[] {
  const own = tags.filter((t) => !PROVENANCE_TAG_RE.test(t));
  const dropped = tags.length - own.length;
  if (dropped) ctx.fidelity.push({ fidelity: 'full', message: `${dropped} provenance tag${dropped === 1 ? '' : 's'} from an earlier migration into ${sourceLabel(ctx)} not copied.`, location: 'tags' });
  return unique([migratedFromTag(ctx.kind), sourceTag(ctx.snapshot.source.alias), ...own.map(sanitizeTag)].filter(Boolean));
}

/**
 * The target plan or token lacks a feature the item needs (`experimentation_unavailable`,
 * blocking). `unknown` and `available` pass: the first write decides (PLAN §5.2).
 */
function requireCapability(ctx: Ctx, cap: keyof MapperCapabilities, what: string): void {
  const state = ctx.args.capabilities[cap] as CapabilityState | undefined;
  if (state !== 'unavailable' && state !== 'not_permitted') return;
  const choice = ctx.decisions.choose(
    {
      type: 'experimentation_unavailable',
      severity: 'blocking',
      subject: ctx.subject,
      path: `capability:${cap}`,
      title: state === 'not_permitted' ? `This token may not write ${what} in the target project` : `The target plan has no ${what}`,
      explanation: state === 'not_permitted' ? `The capability probe found the ${what} route forbidden for this token. Connect with a token that may write ${what}, then re-plan.` : `The capability probe found no ${what} on the target plan. Add Experimentation to the target, then re-plan; until then this item is skipped.`,
      sourceFragment: { capability: cap, state },
      fingerprintOf: { cap, state },
      options: [SKIP],
    },
    'skip',
  );
  if (choice === 'skip') throw new SkipItem(`the target has no ${what} (${state === 'not_permitted' ? 'token not permitted' : 'not on the plan'})`);
}

/** Owner → maintainer, like a flag's (edge case 1.5 / 18.9). A source that gave only a member id is noted. */
function maintainerFor(ctx: Ctx, m: NeutralMaintainer | undefined, location: string): MaintainerAssignment {
  if (!m) return {};
  if (!m.email && !m.teamKey) {
    if (m.id) ctx.fidelity.push({ fidelity: 'full', message: `Maintainer not carried: ${sourceLabel(ctx)} gave only a member ID, which belongs to the source account.`, location });
    return {};
  }
  const assignment = chooseMaintainer({ profile: ctx.args.profile, ...(ctx.args.directory ? { directory: ctx.args.directory } : {}), decisions: ctx.decisions, subject: ctx.subject, fidelity: ctx.fidelity }, { ...(m.email ? { owner: { id: m.id, email: m.email } } : {}), team: m.teamKey ?? null });
  if (assignment.maintainerId) ctx.decisions.note('maintainer', assignment.maintainerId);
  return assignment;
}

/** A context kind the item randomizes or analyzes by: resolved like a flag's, and enabled as a randomization unit in the target when it is not `user`. */
function randomizationUnit(ctx: Ctx, unit: string): string {
  const kind = resolveSourceKind(ctx, unit);
  if (kind !== 'user') ctx.deps.set(`randomization_unit:${kind}`, { kind: 'randomization_unit', key: kind, entityId: unit });
  return kind;
}

function dependOnMetrics(ctx: Ctx, metrics: NeutralIterationMetric[]): void {
  for (const m of metrics) {
    if (m.isGroup) ctx.deps.set(`metric_group:${m.key}`, { kind: 'metric_group', key: m.key, entityId: m.key });
    else ctx.deps.set(`metric:${m.key}`, { kind: 'metric', key: m.key, entityId: m.key });
  }
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

export function mapNeutralMetric(args: MapArgs<NeutralMetric>): NeutralMetricMapResult {
  const { entity: m } = args;
  const ctx = makeCtx(args, 'metric');
  const fp = fingerprint({ ...m, uid: undefined, tags: [...m.tags].sort() });
  const finish = (desired: DesiredMetric | null, skipped?: string): NeutralMetricMapResult => ({ ...outcome(ctx, m, fp, skipped), metricKey: m.key, desired });
  if (m.archived) return finish(null, `archived in ${sourceLabel(ctx)}`);
  try {
    requireCapability(ctx, 'metrics', 'metrics');
    if (!METRIC_KINDS.has(m.metricKind)) throw new SkipItem(`its kind “${m.metricKind}” is not one LaunchDarkly's API creates`);
    const kind = m.metricKind as DesiredMetric['kind'];
    const analysisUnits = unique(m.analysisUnits.map((u) => randomizationUnit(ctx, u)));
    let dataSource: DesiredMetric['dataSource'];
    if (m.dataSource) {
      const choice = ctx.decisions.choose(
        {
          type: 'metric_data_source',
          severity: 'choice',
          subject: { ...ctx.subject, location: 'data source' },
          path: 'data_source',
          title: `Warehouse-native metric: data source “${m.dataSource.key}” must exist in the target`,
          explanation: `This metric reads from the data source “${m.dataSource.name ?? m.dataSource.key}”${m.dataSource.integrationKey ? ` (${m.dataSource.integrationKey})` : ''} of ${sourceLabel(ctx)}. Data sources are set up per project in the LaunchDarkly UI (they hold warehouse credentials), so the console cannot copy one. The metric can reference a data source of the same key in the target; create it there first or the write fails.`,
          sourceFragment: m.dataSource,
          fingerprintOf: { key: m.dataSource.key },
          options: [
            { key: 'same_key', label: `Reference data source “${m.dataSource.key}” in the target`, explanation: 'The target project must already have a metric data source with this key (and the same environment, when the source names one).', resultingFidelity: 'manual' },
            SKIP,
          ],
          recommended: 'same_key',
        },
        'same_key',
      );
      if (choice === 'skip') throw new SkipItem(`it reads from data source “${m.dataSource.key}”, which the console cannot copy`);
      dataSource = { key: m.dataSource.key, ...(m.dataSource.environmentKey ? { environmentKey: m.dataSource.environmentKey } : {}) };
      ctx.fidelity.push({ fidelity: 'manual', message: `Warehouse-native: set up the data source “${m.dataSource.key}” in the target project before the run, with the same key.`, location: 'data source' });
    }
    if (kind === 'custom' && !m.eventKey && !dataSource) ctx.fidelity.push({ fidelity: 'partial', message: `No event key in ${sourceLabel(ctx)}; the target metric is created without one.`, location: 'event' });
    const maintainer = maintainerFor(ctx, m.maintainer, 'metric settings');
    const desired: DesiredMetric = {
      key: m.key,
      name: m.name || m.key,
      description: m.description,
      kind,
      ...(m.eventKey ? { eventKey: m.eventKey } : {}),
      isNumeric: m.isNumeric ?? false,
      successCriteria: m.successCriteria === 'LowerThanBaseline' ? 'LowerThanBaseline' : 'HigherThanBaseline',
      tags: tagsFor(ctx, m.tags),
      analysisUnits: analysisUnits.length ? analysisUnits : ['user'],
      ...maintainer,
      ...(m.unit ? { unit: m.unit } : {}),
      ...(m.selector ? { selector: m.selector } : {}),
      ...(m.urls?.length ? { urls: m.urls } : {}),
      ...(m.unitAggregationType ? { unitAggregationType: m.unitAggregationType } : {}),
      ...(m.analysisType ? { analysisType: m.analysisType } : {}),
      ...(m.percentileValue != null ? { percentileValue: m.percentileValue } : {}),
      ...(m.eventDefault ? { eventDefault: m.eventDefault } : {}),
      ...(m.filters ? { filters: m.filters } : {}),
      ...(dataSource ? { dataSource } : {}),
      ...(m.windowStartOffset != null ? { windowStartOffset: m.windowStartOffset } : {}),
      ...(m.windowEndOffset != null ? { windowEndOffset: m.windowEndOffset } : {}),
      ...(m.winsorLowerPercentile != null ? { winsorLowerPercentile: m.winsorLowerPercentile } : {}),
      ...(m.winsorUpperPercentile != null ? { winsorUpperPercentile: m.winsorUpperPercentile } : {}),
      ...(m.winsorIncludeImputed != null ? { winsorIncludeImputed: m.winsorIncludeImputed } : {}),
      ...(m.traceQuery ? { traceQuery: m.traceQuery } : {}),
      ...(m.traceValueLocation ? { traceValueLocation: m.traceValueLocation } : {}),
      ...(m.unitAggregationField ? { unitAggregationField: m.unitAggregationField } : {}),
      ...(m.valueColumn ? { valueColumn: m.valueColumn } : {}),
      ...(m.denominator ? { denominator: m.denominator } : {}),
    };
    if (kind === 'custom' && m.eventKey) ctx.fidelity.push({ fidelity: 'full', message: `Event “${m.eventKey}” must be sent to the target project by the SDK (track()) for the metric to have data; events already recorded in ${sourceLabel(ctx)} do not carry over.`, location: 'event' });
    if (m.selector || m.urls?.length) ctx.fidelity.push({ fidelity: 'full', message: 'Click and page view metrics need the target environment’s client-side SDK key in the pages they watch.', location: 'event' });
    return finish(desired);
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

export function mapNeutralMetricGroup(args: MapArgs<NeutralMetricGroup>): NeutralMetricGroupMapResult {
  const { entity: g } = args;
  const ctx = makeCtx(args, 'metric');
  const fp = fingerprint({ ...g, uid: undefined, tags: [...g.tags].sort() });
  const finish = (desired: DesiredMetricGroup | null, skipped?: string): NeutralMetricGroupMapResult => ({ ...outcome(ctx, g, fp, skipped), groupKey: g.key, desired });
  if (g.archived) return finish(null, `archived in ${sourceLabel(ctx)}`);
  try {
    requireCapability(ctx, 'metricGroups', 'metric groups');
    if (g.groupKind !== 'funnel' && g.groupKind !== 'standard') throw new SkipItem(`its kind “${g.groupKind}” is not one LaunchDarkly's API creates`);
    if (g.metrics.length === 0) throw new SkipItem('it has no metrics');
    const metrics = (ctx.snapshot.neutral?.metrics ?? []).filter((m) => g.metrics.some((x) => x.key === m.key));
    const missing = g.metrics.filter((x) => !metrics.some((m) => m.key === x.key));
    if (missing.length) throw new SkipItem(`metric${missing.length === 1 ? '' : 's'} ${missing.map((x) => `“${x.key}”`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the source snapshot`);
    const archived = metrics.filter((m) => m.archived);
    if (archived.length) throw new SkipItem(`metric${archived.length === 1 ? '' : 's'} ${archived.map((m) => `“${m.key}”`).join(', ')} ${archived.length === 1 ? 'is' : 'are'} archived in ${sourceLabel(ctx)} (nothing archived is migrated)`);
    dependOnMetrics(ctx, g.metrics.map((m) => ({ key: m.key, isGroup: false })));
    const maintainer = maintainerFor(ctx, g.maintainer, 'metric group settings');
    if (!maintainer.maintainerId) ctx.fidelity.push({ fidelity: 'partial', message: maintainer.maintainerTeamKey ? 'LaunchDarkly requires a member as metric group maintainer (not a team): the member behind the API token is assigned.' : 'LaunchDarkly requires a metric group maintainer: the member behind the API token is assigned.', location: 'metric group settings' });
    return finish({
      key: g.key,
      name: g.name || g.key,
      description: g.description,
      kind: g.groupKind,
      tags: tagsFor(ctx, g.tags),
      ...(maintainer.maintainerId ? { maintainerId: maintainer.maintainerId } : {}),
      metrics: g.metrics.map((m) => ({ key: m.key, nameInGroup: m.nameInGroup })),
    });
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------------------------

/** Where an iteration's flag rule is in the source flag, as the executor will look for it in the target. */
function ruleRef(ctx: Ctx, f: NeutralIterationFlag, sourceEnv: string): ExperimentRuleRef {
  if (f.ruleId === 'fallthrough') return { kind: 'fallthrough' };
  const flag = neutralFlagByKey(ctx.snapshot).get(f.flagKey);
  const rules = flag?.environments.find((e) => e.env === sourceEnv)?.rules ?? [];
  const i = rules.findIndex((r) => r.id === f.ruleId);
  const rule = rules[i];
  if (rule && !rule.disabled) return { kind: 'rule', index: rules.slice(0, i).filter((r) => !r.disabled).length, description: rule.description, sourceRuleId: f.ruleId };
  const choice = ctx.decisions.choose(
    {
      type: 'experiment_rule_missing',
      severity: 'blocking',
      subject: { ...ctx.subject, location: `flag ${f.flagKey}` },
      path: `rule:${f.flagKey}`,
      title: rule ? `The rule the experiment runs on is disabled in flag “${f.flagKey}”` : `The rule the experiment runs on is gone from flag “${f.flagKey}”`,
      explanation: rule
        ? `The experiment is attached to the rule “${rule.description || f.ruleId}”, which ${sourceLabel(ctx)} keeps disabled; disabled rules are not copied (they do not evaluate). The copy can run on the flag's default rule instead, or wait.`
        : `${sourceLabel(ctx)} records the experiment on rule ${f.ruleId}${f.ruleDescription ? ` (“${f.ruleDescription}”)` : ''} of “${f.flagKey}”, which the flag's current targeting in “${sourceEnv}” no longer has. The copy can run on the flag's default rule instead, or wait.`,
      sourceFragment: { flagKey: f.flagKey, ruleId: f.ruleId, ruleDescription: f.ruleDescription ?? null, disabled: !!rule },
      fingerprintOf: { flagKey: f.flagKey, ruleId: f.ruleId, disabled: !!rule },
      options: [{ key: 'fallthrough', label: 'Run on the default rule', explanation: 'The copied experiment allocates traffic on the default rule of the target flag.', resultingFidelity: 'partial' }, SKIP],
    },
    'skip',
  );
  if (choice === 'skip') throw new SkipItem(`its rule on flag “${f.flagKey}” is ${rule ? 'disabled' : 'gone'} in ${sourceLabel(ctx)}`);
  ctx.fidelity.push({ fidelity: 'partial', message: `Runs on the default rule of “${f.flagKey}” in the target (the source rule is ${rule ? 'disabled' : 'gone'}).`, location: `flag ${f.flagKey}` });
  return { kind: 'fallthrough' };
}

/** The flags an iteration runs on must be in the source and migrate first, with the variation indexes the treatments name. */
function dependOnFlags(ctx: Ctx, it: NeutralIteration, sourceEnv: string): void {
  const flags = neutralFlagByKey(ctx.snapshot);
  const keys = unique([...it.flags.map((f) => f.flagKey), ...it.treatments.flatMap((t) => t.parameters.map((p) => p.flagKey))]);
  for (const key of keys) {
    const flag = flags.get(key);
    if (!flag || flag.archived || !flag.environments.some((e) => e.env === sourceEnv)) {
      const choice = ctx.decisions.choose(
        {
          type: 'missing_reference',
          severity: 'blocking',
          subject: { ...ctx.subject, location: `flag ${key}` },
          path: `flag:${key}`,
          title: `Flag “${key}” is ${!flag ? 'not in the source snapshot' : flag.archived ? `archived in ${sourceLabel(ctx)}` : `absent from “${sourceEnv}”`}`,
          explanation: `The experiment runs on flag “${key}”, which ${!flag ? 'the source snapshot does not have' : flag.archived ? 'is archived and so never migrated' : `has no configuration in environment “${sourceEnv}”`}. An experiment cannot be created without its flag.`,
          sourceFragment: { flagKey: key, archived: flag?.archived ?? null },
          fingerprintOf: { flagKey: key, state: !flag ? 'missing' : flag.archived ? 'archived' : 'no_env' },
          options: [SKIP],
        },
        'skip',
      );
      if (choice === 'skip') throw new SkipItem(`flag “${key}” is ${!flag ? 'not in the source snapshot' : flag.archived ? 'archived' : `absent from “${sourceEnv}”`}`);
      continue;
    }
    for (const t of it.treatments) for (const p of t.parameters) if (p.flagKey === key && p.variation >= flag.variations.length) throw new SkipItem(`treatment “${t.name}” names variation ${p.variation} of “${key}”, which has ${flag.variations.length}`);
    ctx.deps.set(`flag:${key}`, { kind: 'flag', key, entityId: key });
  }
}

function lifecycle(ctx: Ctx, x: NeutralExperimentEnv, it: NeutralIteration): DesiredExperiment['sourceStatus'] {
  if (it.status === 'running') {
    const choice = ctx.decisions.choose(
      {
        type: 'experiment_running',
        severity: 'choice',
        subject: ctx.subject,
        path: 'running',
        title: `Running in ${sourceLabel(ctx)}: copy the design as a draft now, or wait?`,
        explanation: `The experiment has been running since ${it.startedAt ? new Date(it.startedAt).toISOString().slice(0, 10) : 'an unknown date'}. Assignments and results cannot move between projects: the copy is a new experiment with the same hypothesis, treatments, allocation, metrics and randomization unit, created as a not-started draft on the migrated flag. Starting it in the target is a deliberate step in LaunchDarkly; the source keeps running until you stop it.`,
        sourceFragment: { status: it.status, startedAt: it.startedAt ?? null, treatments: it.treatments.map((t) => `${t.name} ${t.allocationPercent}%`) },
        fingerprintOf: { status: it.status, startedAt: it.startedAt ?? null },
        options: [
          { key: 'prestage', label: 'Copy the design as a draft now', explanation: 'The target gets the experiment, not started. Start it there once traffic has moved; stop the source one when you cut over.', resultingFidelity: 'partial' },
          { key: 'skip', label: 'Wait until it ends in the source', explanation: 'Skip for now. Re-plan after the experiment stops, and copy its final design then.', resultingFidelity: 'skipped' },
        ],
        recommended: 'prestage',
      },
      'prestage',
    );
    if (choice === 'skip') throw new SkipItem(`running in ${sourceLabel(ctx)}; copy it after it ends`);
    ctx.fidelity.push({ fidelity: 'partial', message: `Running in ${sourceLabel(ctx)}: the target gets the same design as a not-started draft; assignments and results so far stay in the source.` });
    return 'running';
  }
  if (it.status === 'stopped') {
    const choice = ctx.decisions.choose(
      {
        type: 'experiment_concluded',
        severity: 'choice',
        subject: ctx.subject,
        path: 'concluded',
        title: `Stopped in ${sourceLabel(ctx)}${it.winningTreatment?.name ? ` (winner: ${it.winningTreatment.name})` : ''}: recreate its design as a draft, or skip?`,
        explanation: `The experiment ended${it.endedAt ? ` on ${new Date(it.endedAt).toISOString().slice(0, 10)}` : ''}${it.winningReason ? `: ${it.winningReason}` : ''}. Its results live in ${sourceLabel(ctx)} and cannot be imported. Recreating it keeps the design (hypothesis, treatments, metrics) in the target as a draft that can be re-run; skipping leaves nothing behind. The flag's targeting is copied either way, as it is.`,
        sourceFragment: { status: it.status, endedAt: it.endedAt ?? null, winningTreatment: it.winningTreatment ?? null, winningReason: it.winningReason ?? null },
        fingerprintOf: { status: it.status, endedAt: it.endedAt ?? null },
        options: [
          { key: 'draft', label: 'Recreate the design as a draft', explanation: 'A not-started experiment with the last iteration’s design. The outcome is recorded in its description.', resultingFidelity: 'partial' },
          { key: 'skip', label: 'Skip it', explanation: 'The experiment stays in the source only.', resultingFidelity: 'skipped' },
        ],
        recommended: 'draft',
      },
      'draft',
    );
    if (choice === 'skip') throw new SkipItem(`stopped in ${sourceLabel(ctx)} and not recreated`);
    ctx.fidelity.push({ fidelity: 'partial', message: `Stopped in ${sourceLabel(ctx)}${it.winningTreatment?.name ? `, winner “${it.winningTreatment.name}”` : ''}: the design is recreated as a draft; results and exposures stay in the source.` });
    return 'stopped';
  }
  ctx.fidelity.push({ fidelity: 'full', message: `Not started in ${sourceLabel(ctx)}: the draft is copied as it is.` });
  void x;
  return 'not_started';
}

export function mapNeutralExperiment(args: MapArgs<NeutralExperiment>): NeutralExperimentMapResult {
  const { entity: exp, env } = args;
  const ctx = makeCtx(args, 'experiment');
  const x = neutralExperimentEnvOf(exp, env.statsig);
  const fp = fingerprint(x ? { ...x, layer: x.layer ?? null } : null);
  const finish = (desired: DesiredExperiment | null, skipped?: string): NeutralExperimentMapResult => ({ ...outcome(ctx, exp, fp, skipped), experimentKey: exp.key, desired });
  if (exp.archived) return finish(null, `archived in ${sourceLabel(ctx)}`);
  if (!x) return finish(null, `not present in source environment “${env.statsig}” (exists in: ${exp.environments.map((e) => e.env).join(', ') || 'none'})`);
  if (x.archived) return finish(null, `archived in ${sourceLabel(ctx)} (${env.statsig})`);
  try {
    requireCapability(ctx, 'experimentation', 'experiments');
    if (x.experimentType !== 'experiment' && x.experimentType !== 'mab') throw new SkipItem(`its type “${x.experimentType}” is not one the console copies`);
    const it = neutralDesignIteration(x);
    if (!it) throw new SkipItem('it has no iteration to copy');
    const sourceStatus = lifecycle(ctx, x, it);
    if (it.treatments.length < 2 && x.experimentType === 'experiment') throw new SkipItem(`its iteration has ${it.treatments.length} treatment${it.treatments.length === 1 ? '' : 's'}; LaunchDarkly needs at least two`);
    if (!it.primary) throw new SkipItem('its iteration has no primary metric');
    dependOnFlags(ctx, it, env.statsig);
    const flags = it.flags.map((f) => ({ flagKey: f.flagKey, rule: ruleRef(ctx, f, env.statsig), ...(f.notInExperimentVariation !== undefined ? { notInExperimentVariation: f.notInExperimentVariation } : {}) }));
    if (flags.length === 0) throw new SkipItem('its iteration names no flag');
    dependOnMetrics(ctx, it.metrics);
    const unit = randomizationUnit(ctx, it.randomizationUnit);
    const metrics = it.metrics.map((m) => ({ key: m.key, isGroup: m.isGroup, ...(m.analysisUnit ? { analysisUnit: resolveSourceKind(ctx, m.analysisUnit) } : {}) }));
    let holdoutKey: string | undefined;
    if (x.holdout) {
      if (!x.holdout.key) ctx.fidelity.push({ fidelity: 'partial', message: `Belongs to holdout ${x.holdout.id} in ${sourceLabel(ctx)}, which was not among the holdouts read; the copy is created outside any holdout.`, location: 'holdout' });
      else {
        const h = (ctx.snapshot.neutral?.holdouts ?? []).find((hh) => hh.key === x.holdout!.key);
        if (!h || h.archived || !neutralHoldoutEnvOf(h, env.statsig)) ctx.fidelity.push({ fidelity: 'partial', message: `Belongs to holdout “${x.holdout.key}”, which is ended or absent in ${sourceLabel(ctx)}; the copy is created outside any holdout.`, location: 'holdout' });
        else {
          holdoutKey = h.key;
          ctx.deps.set(`holdout:${h.key}`, { kind: 'holdout', key: h.key, entityId: h.key });
          ctx.fidelity.push({ fidelity: 'full', message: `Joins the copied holdout “${h.key}” (created first in the same environment).`, location: 'holdout' });
        }
      }
    }
    let layer: DesiredExperiment['layer'];
    if (x.layer) {
      const l = (ctx.snapshot.neutral?.layers ?? []).find((ll) => ll.key === x.layer!.key);
      if (!l) ctx.fidelity.push({ fidelity: 'partial', message: `Reserved in layer “${x.layer.key}”, which was not among the layers read; the copy is created outside any layer.`, location: 'layer' });
      else {
        layer = { key: l.key, reservationPercent: x.layer.reservationPercent };
        ctx.deps.set(`layer:${l.key}`, { kind: 'layer', key: l.key, entityId: l.key });
        ctx.fidelity.push({ fidelity: 'partial', message: `Reserves ${x.layer.reservationPercent}% of layer “${l.key}” in the target; the layer buckets contexts afresh, so the reserved population differs from the source's.`, location: 'layer' });
      }
    } else if (it.layerSnapshot) ctx.fidelity.push({ fidelity: 'full', message: `Was in layer “${it.layerSnapshot.key}” when its iteration stopped; the copy is created outside any layer (reserve it in LaunchDarkly if it runs again).`, location: 'layer' });
    if (x.previousIterations.length) ctx.fidelity.push({ fidelity: 'partial', message: `${x.previousIterations.length} earlier iteration${x.previousIterations.length === 1 ? '' : 's'} stay${x.previousIterations.length === 1 ? 's' : ''} in ${sourceLabel(ctx)}: LaunchDarkly has no way to create an experiment with history.`, location: 'iterations' });
    if (x.dataSource) ctx.fidelity.push({ fidelity: 'manual', message: `Analyzed from warehouse “${x.dataSource}” in ${sourceLabel(ctx)}; the copy is created with the same data source, which the target project must have.`, location: 'data source' });
    const maintainer = maintainerFor(ctx, x.maintainer, 'experiment settings');
    ctx.fidelity.push({ fidelity: 'full', message: 'Created as a draft on the migrated flag: nothing is served until someone starts it in LaunchDarkly. Treatments map to the same variations by position; the target flag buckets contexts with its own salt.' });
    const outcomeLine = it.status === 'stopped' ? ` Ended in ${sourceLabel(ctx)}${it.winningTreatment?.name ? `, winner “${it.winningTreatment.name}”` : ''}${it.winningReason ? ` (${it.winningReason})` : ''}.` : '';
    const desired: DesiredExperiment = {
      key: exp.key,
      ldEnv: env.ld,
      statsigEnv: env.statsig,
      name: x.name || exp.key,
      description: `${x.description}${outcomeLine}`.trim(),
      type: x.experimentType,
      tags: tagsFor(ctx, x.tags),
      ...maintainer.maintainerId ? { maintainerId: maintainer.maintainerId } : {},
      ...(x.methodology ? { methodology: x.methodology } : {}),
      ...(x.analysisConfig ? { analysisConfig: x.analysisConfig } : {}),
      ...(holdoutKey ? { holdoutKey } : {}),
      ...(layer ? { layer } : {}),
      hypothesis: it.hypothesis || `Copied from ${sourceLabel(ctx)}.`,
      randomizationUnit: unit,
      ...(it.attributes?.length ? { attributes: it.attributes } : {}),
      canReshuffleTraffic: it.canReshuffleTraffic ?? true,
      ...(x.experimentType === 'mab' ? { reallocationFrequencyMillis: it.reallocationFrequencyMillis ?? 3_600_000 } : {}),
      metrics,
      primary: it.primary,
      treatments: it.treatments.map((t) => ({ name: t.name, baseline: t.baseline, allocationPercent: t.allocationPercent, parameters: t.parameters.map((p) => ({ flagKey: p.flagKey, variation: p.variation })) })),
      flags,
      sourceStatus,
    };
    if (!desired.treatments.some((t) => t.baseline) && desired.treatments[0]) {
      desired.treatments[0].baseline = true;
      ctx.fidelity.push({ fidelity: 'full', message: `“${desired.treatments[0].name}” is the baseline (LaunchDarkly needs one; the source iteration marked none).` });
    }
    if (maintainer.maintainerTeamKey) ctx.fidelity.push({ fidelity: 'partial', message: 'Experiments take a member as maintainer, not a team: the copy is created without one.', location: 'experiment settings' });
    return finish(desired);
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Holdouts and layers
// ---------------------------------------------------------------------------------------------

export function mapNeutralHoldout(args: MapArgs<NeutralHoldout>): NeutralHoldoutMapResult {
  const { entity: hold, env } = args;
  const ctx = makeCtx(args, 'holdout');
  const h: NeutralHoldoutEnv | undefined = neutralHoldoutEnvOf(hold, env.statsig);
  const fp = fingerprint(h ?? null);
  const finish = (desired: DesiredHoldout | null, skipped?: string): NeutralHoldoutMapResult => ({ ...outcome(ctx, hold, fp, skipped), holdoutKey: hold.key, desired });
  if (hold.archived) return finish(null, `ended in ${sourceLabel(ctx)}`);
  if (!h) return finish(null, `not present in source environment “${env.statsig}” (exists in: ${hold.environments.map((e) => e.env).join(', ') || 'none'})`);
  if (h.status === 'ended') return finish(null, `ended in ${sourceLabel(ctx)} (${env.statsig})`);
  try {
    requireCapability(ctx, 'holdouts', 'holdouts');
    if (h.status === 'running' || h.status === 'enabled') {
      const choice = ctx.decisions.choose(
        {
          type: 'holdout_running',
          severity: 'acknowledge',
          subject: ctx.subject,
          path: 'running',
          title: `Holdout is ${h.status} in ${sourceLabel(ctx)}: the copy starts over`,
          explanation: `The holdout keeps ${h.holdoutAmount}% of ${h.randomizationUnit} contexts out of ${h.experiments.length} experiment${h.experiments.length === 1 ? '' : 's'} in ${sourceLabel(ctx)}. The target holdout is created with the same amount, metrics and randomization unit but not started, and it buckets contexts afresh: the held-out population will not be the same contexts.`,
          sourceFragment: { status: h.status, holdoutAmount: h.holdoutAmount, experiments: h.experiments },
          fingerprintOf: { status: h.status },
          options: [{ key: 'acknowledge', label: 'Create it unstarted', explanation: 'Start it in LaunchDarkly once its experiments are there.', resultingFidelity: 'partial' }, SKIP],
          recommended: 'acknowledge',
        },
        'acknowledge',
      );
      if (choice === 'skip') throw new SkipItem(`${h.status} in ${sourceLabel(ctx)} and not copied`);
      ctx.fidelity.push({ fidelity: 'partial', message: `${h.status === 'running' ? 'Running' : 'Enabled'} in ${sourceLabel(ctx)}: created unstarted in the target, bucketing a new population.` });
    }
    dependOnMetrics(ctx, h.metrics);
    const unit = randomizationUnit(ctx, h.randomizationUnit);
    if (h.prerequisiteFlagKey) {
      const flag = neutralFlagByKey(ctx.snapshot).get(h.prerequisiteFlagKey);
      if (flag && !flag.archived) ctx.deps.set(`flag:${flag.key}`, { kind: 'flag', key: flag.key, entityId: flag.key });
      else ctx.fidelity.push({ fidelity: 'partial', message: `Prerequisite flag “${h.prerequisiteFlagKey}” is ${flag ? 'archived' : 'not in the source snapshot'}; the copy has no prerequisite flag.`, location: 'prerequisite' });
    }
    const maintainer = maintainerFor(ctx, h.maintainer, 'holdout settings');
    if (h.experiments.length) ctx.fidelity.push({ fidelity: 'full', message: `${h.experiments.length} experiment${h.experiments.length === 1 ? '' : 's'} (${h.experiments.join(', ')}) join${h.experiments.length === 1 ? 's' : ''} it when copied.`, location: 'experiments' });
    return finish({
      key: hold.key,
      ldEnv: env.ld,
      statsigEnv: env.statsig,
      name: h.name || hold.key,
      description: h.description,
      randomizationUnit: unit,
      ...(h.attributes?.length ? { attributes: h.attributes } : {}),
      holdoutAmount: h.holdoutAmount,
      metrics: h.metrics.map((m) => ({ key: m.key, isGroup: m.isGroup, ...(m.analysisUnit ? { analysisUnit: resolveSourceKind(ctx, m.analysisUnit) } : {}) })),
      ...(h.primaryMetricKey ? { primaryMetricKey: h.primaryMetricKey } : {}),
      ...(h.prerequisiteFlagKey && ctx.deps.has(`flag:${h.prerequisiteFlagKey}`) ? { prerequisiteFlagKey: h.prerequisiteFlagKey } : {}),
      ...(maintainer.maintainerId ? { maintainerId: maintainer.maintainerId } : {}),
    });
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

export function mapNeutralLayer(args: MapArgs<NeutralLayer>): NeutralLayerMapResult {
  const { entity: l } = args;
  const ctx = makeCtx(args, 'layer');
  const fp = fingerprint({ key: l.key, name: l.name, description: l.description, randomizationUnit: l.randomizationUnit ?? null });
  const finish = (desired: DesiredLayer | null, skipped?: string): NeutralLayerMapResult => ({ ...outcome(ctx, l, fp, skipped), layerKey: l.key, desired });
  try {
    requireCapability(ctx, 'layers', 'layers');
    const reserved = l.environments.reduce((n, e) => n + e.reservations.length, 0);
    ctx.fidelity.push({ fidelity: 'full', message: reserved ? `Reservations (${reserved}) are written by the copied experiments as they are created.` : 'Empty layer: created with no reservations.', location: 'reservations' });
    if (l.randomizationUnit && l.randomizationUnit !== 'user') ctx.fidelity.push({ fidelity: 'partial', message: `Randomizes by “${l.randomizationUnit}” in ${sourceLabel(ctx)}; LaunchDarkly sets a layer's randomization unit from its first experiment, so the copy takes it from the first experiment reserved.`, location: 'randomization unit' });
    return finish({ key: l.key, name: l.name || l.key, description: l.description });
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

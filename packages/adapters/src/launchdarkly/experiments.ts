/**
 * LaunchDarkly source adapter, experimentation side (PLAN §20.5): raw metrics, metric groups,
 * experiments, holdouts and layers → the neutral block. Pure. Account-specific ids are resolved
 * to what another project can use: a treatment's `variationId` becomes the flag's variation
 * index, an experiment's `holdoutId` gains the holdout's key, a maintainer id its email. What
 * cannot be resolved is kept as read and warned about, never dropped silently.
 */
import { neutralUid, type NeutralExperiment, type NeutralExperimentEnv, type NeutralHoldout, type NeutralHoldoutEnv, type NeutralIteration, type NeutralIterationMetric, type NeutralLayer, type NeutralMaintainer, type NeutralMetric, type NeutralMetricGroup, type NeutralProject, type SnapshotWarning } from '@sslm/canonical';
import type { LdExperiment, LdFlag, LdHoldout, LdIteration, LdMember, LdMetric, LdMetricGroup } from '@sslm/ld-client';
import type { RawLdSnapshot } from './read.ts';

type Warn = (w: SnapshotWarning) => void;

export function normalizeExperimentation(raw: RawLdSnapshot, sourceId: string, neutral: NeutralProject, warn: Warn): void {
  const envKeys = raw.environments.map((e) => e.key);
  const flagsByKey = new Map(raw.flags.map((f) => [f.key, f]));
  const maintainer = maintainerResolver(raw.members);

  neutral.metrics = raw.metrics.map((m) => metric(m, sourceId, maintainer));
  neutral.metricGroups = raw.metricGroups.map((g) => metricGroup(g, sourceId, maintainer));

  // Layers first: an experiment's reservation lives on the layer side.
  const reservations = new Map<string, { key: string; reservationPercent: number }>();
  neutral.layers = raw.layers.map((l) => {
    const environments: NeutralLayer['environments'] = [];
    for (const [env, cfg] of Object.entries(l.environments ?? {})) {
      const rs = (cfg.reservations ?? []).map((r) => {
        reservations.set(`${env}|${r.experimentKey}`, { key: l.key, reservationPercent: r.reservationPercent ?? 0 });
        return { experimentKey: r.experimentKey, flagKey: r.flagKey ?? '', reservationPercent: r.reservationPercent ?? 0 };
      });
      environments.push({ env, reservations: rs });
    }
    environments.sort((a, b) => a.env.localeCompare(b.env));
    return {
      kind: 'layer' as const,
      uid: neutralUid(sourceId, 'layer', l.key),
      key: l.key,
      name: l.name ?? l.key,
      description: l.description ?? '',
      ...(l.randomizationUnit ? { randomizationUnit: l.randomizationUnit } : {}),
      archived: false as const,
      environments,
      ...(l.createdAt != null ? { createdAt: l.createdAt } : {}),
    };
  });

  // Holdouts: an experiment names its holdout by id; the key is what the target can look up.
  const holdoutKeyById = new Map<string, string>();
  for (const env of envKeys) for (const h of raw.holdouts[env] ?? []) if (h._id && h.key) holdoutKeyById.set(h._id, h.key);

  const experimentsByKey = new Map<string, NeutralExperimentEnv[]>();
  for (const env of envKeys) {
    for (const x of raw.experiments[env] ?? []) {
      // A holdout's base experiment is listed among the experiments; it travels with the holdout.
      if (x.type === 'holdout') continue;
      const path = `experiments/${env}/${x.key}`;
      const e = experimentEnv(env, x, flagsByKey, maintainer, holdoutKeyById, warn, path);
      const r = reservations.get(`${env}|${x.key}`);
      if (r) e.layer = r;
      const list = experimentsByKey.get(x.key) ?? [];
      list.push(e);
      experimentsByKey.set(x.key, list);
    }
  }
  neutral.experiments = [...experimentsByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, environments]): NeutralExperiment => {
      const first = environments[0]!;
      for (const e of environments.slice(1)) {
        if (e.name !== first.name || e.description !== first.description) warn({ code: 'ambiguous_override', path: `experiments/${e.env}/${key}`, message: `Experiment “${key}” has a different name or description in “${e.env}” than in “${first.env}”; each environment keeps its own.` });
      }
      return { kind: 'experiment', uid: neutralUid(sourceId, 'experiment', key), key, name: first.name, description: first.description, tags: first.tags, archived: environments.every((e) => e.archived), environments };
    });

  const holdoutsByKey = new Map<string, NeutralHoldoutEnv[]>();
  for (const env of envKeys) {
    for (const h of raw.holdouts[env] ?? []) {
      if (!h.key) {
        warn({ code: 'schema_mismatch', path: `holdouts/${env}`, message: `A holdout without a key (id ${h._id ?? '?'}) was skipped.` });
        continue;
      }
      const list = holdoutsByKey.get(h.key) ?? [];
      list.push(holdoutEnv(env, h, maintainer, warn, `holdouts/${env}/${h.key}`));
      holdoutsByKey.set(h.key, list);
    }
  }
  neutral.holdouts = [...holdoutsByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, environments]): NeutralHoldout => {
      const first = environments[0]!;
      return { kind: 'holdout', uid: neutralUid(sourceId, 'holdout', key), key, name: first.name, description: first.description, archived: environments.every((e) => e.status === 'ended'), environments };
    });
}

function maintainerResolver(members: Record<string, LdMember>) {
  return (id: string | null | undefined, email?: string | null, teamKey?: string | null): NeutralMaintainer | undefined => {
    const resolved = email ?? (id ? members[id]?.email : undefined);
    if (!id && !resolved && !teamKey) return undefined;
    return { ...(id ? { id } : {}), ...(resolved ? { email: resolved } : {}), ...(teamKey ? { teamKey } : {}) };
  };
}
type Maintainer = ReturnType<typeof maintainerResolver>;

function metric(m: LdMetric, sourceId: string, maintainer: Maintainer): NeutralMetric {
  const mt = maintainer(m.maintainerId, m._maintainer?.email);
  const lastModified = m.lastModified?.date ? Date.parse(m.lastModified.date) : NaN;
  return {
    kind: 'metric',
    uid: neutralUid(sourceId, 'metric', m.key),
    key: m.key,
    name: m.name ?? m.key,
    description: m.description ?? '',
    metricKind: m.kind ?? 'custom',
    tags: m.tags ?? [],
    archived: m.archived ?? false,
    ...(mt ? { maintainer: mt } : {}),
    ...(m.isNumeric != null ? { isNumeric: m.isNumeric } : {}),
    ...(m.unit ? { unit: m.unit } : {}),
    ...(m.eventKey ? { eventKey: m.eventKey } : {}),
    ...(m.selector ? { selector: m.selector } : {}),
    ...(m.urls?.length ? { urls: m.urls } : {}),
    ...(m.successCriteria ? { successCriteria: m.successCriteria } : {}),
    analysisUnits: m.analysisUnits?.length ? [...m.analysisUnits] : m.randomizationUnits?.length ? [...m.randomizationUnits] : ['user'],
    ...(m.unitAggregationType ? { unitAggregationType: m.unitAggregationType } : {}),
    ...(m.analysisType ? { analysisType: m.analysisType } : {}),
    ...(m.percentileValue != null ? { percentileValue: m.percentileValue } : {}),
    ...(m.eventDefault ? { eventDefault: { ...(m.eventDefault.disabled != null ? { disabled: m.eventDefault.disabled } : {}), ...(m.eventDefault.value != null ? { value: m.eventDefault.value } : {}) } } : {}),
    ...(m.filters?.op ? { filters: { type: m.filters.type ?? 'eventProperty', ...(m.filters.attribute ? { attribute: m.filters.attribute } : {}), op: m.filters.op, values: m.filters.values ?? [], ...(m.filters.contextKind ? { contextKind: m.filters.contextKind } : {}), negate: m.filters.negate ?? false } } : {}),
    // The default data source is LaunchDarkly's own events: only a warehouse source is a fact to carry.
    ...(m.dataSource?.key && m.dataSource.key !== 'launchdarkly' ? { dataSource: { key: m.dataSource.key, ...(m.dataSource.environmentKey ? { environmentKey: m.dataSource.environmentKey } : {}), ...(m.dataSource._name ? { name: m.dataSource._name } : {}), ...(m.dataSource._integrationKey ? { integrationKey: m.dataSource._integrationKey } : {}) } } : {}),
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
    ...(m._creationDate != null ? { creationDate: m._creationDate } : {}),
    ...(Number.isFinite(lastModified) ? { lastModified } : {}),
    ...(m._version != null ? { version: m._version } : {}),
  };
}

function metricGroup(g: LdMetricGroup, sourceId: string, maintainer: Maintainer): NeutralMetricGroup {
  const mt = g.maintainer?.kind === 'team' ? maintainer(undefined, undefined, g.maintainer.key ?? g.maintainer._team?.key) : maintainer(g.maintainer?.key ?? g.maintainer?._member?._id, g.maintainer?._member?.email);
  return {
    kind: 'metric_group',
    uid: neutralUid(sourceId, 'metric_group', g.key),
    key: g.key,
    name: g.name,
    description: g.description ?? '',
    groupKind: g.kind ?? 'standard',
    tags: g.tags ?? [],
    archived: false,
    ...(mt ? { maintainer: mt } : {}),
    metrics: (g.metrics ?? []).map((m) => ({ key: m.key, nameInGroup: m.nameInGroup ?? m.name ?? m.key })),
    ...(g._creationDate != null ? { creationDate: g._creationDate } : {}),
    ...(g._lastModified != null ? { lastModified: g._lastModified } : {}),
    ...(g._version != null ? { version: g._version } : {}),
  };
}

function iterationMetrics(it: LdIteration): { metrics: NeutralIterationMetric[]; primary?: { key: string; isGroup: boolean } } {
  const out = new Map<string, NeutralIterationMetric>();
  const add = (m: { key: string; isGroup?: boolean | null; analysisUnit?: string | null; kind?: string | null } | null | undefined) => {
    if (!m) return;
    const isGroup = m.isGroup ?? (m.kind === 'funnel' || m.kind === 'standard');
    if (!out.has(m.key)) out.set(m.key, { key: m.key, isGroup, ...(m.analysisUnit ? { analysisUnit: m.analysisUnit } : {}) });
  };
  const primaryRep = it.primarySingleMetric ?? it.primaryFunnel ?? it.primaryMetric;
  add(primaryRep);
  for (const m of it.metrics ?? []) add(m);
  for (const m of it.secondaryMetrics ?? []) add(m);
  const primary = primaryRep ? { key: primaryRep.key, isGroup: primaryRep.isGroup ?? (it.primaryFunnel ? true : primaryRep.kind === 'funnel' || primaryRep.kind === 'standard') } : undefined;
  return { metrics: [...out.values()], ...(primary ? { primary } : {}) };
}

function iteration(it: LdIteration, flagsByKey: Map<string, LdFlag>, warn: Warn, path: string): NeutralIteration {
  const variationIndex = (flagKey: string, id: string | null | undefined): number | undefined => {
    if (!id) return undefined;
    const i = (flagsByKey.get(flagKey)?.variations ?? []).findIndex((v) => v._id === id);
    if (i < 0) {
      warn({ code: 'unresolved_reference', path, message: `Variation ${id} of flag “${flagKey}” is not in the flag read from the source; the treatment keeps no variation.` });
      return undefined;
    }
    return i;
  };
  const treatments = (it.treatments ?? []).map((t) => ({
    ...(t._id ? { id: t._id } : {}),
    name: t.name,
    baseline: t.baseline ?? false,
    allocationPercent: t.allocationPercent,
    parameters: (t.parameters ?? []).flatMap((p) => {
      if (!p.flagKey) return [];
      const v = variationIndex(p.flagKey, p.variationId);
      return v === undefined ? [] : [{ flagKey: p.flagKey, variation: v }];
    }),
  }));
  const winner = it.winningTreatmentId ? treatments.find((t) => t.id === it.winningTreatmentId) : undefined;
  const flags = Object.entries(it.flags ?? {}).map(([flagKey, f]) => {
    const notIn = variationIndex(flagKey, f.notInExperimentVariationId);
    return {
      flagKey,
      ruleId: f.targetingRule ?? 'fallthrough',
      ...(f.targetingRuleDescription ? { ruleDescription: f.targetingRuleDescription } : {}),
      ...(f.flagConfigVersion != null ? { flagConfigVersion: f.flagConfigVersion } : {}),
      ...(notIn !== undefined ? { notInExperimentVariation: notIn } : {}),
    };
  });
  const { metrics, primary } = iterationMetrics(it);
  return {
    ...(it._id ? { id: it._id } : {}),
    hypothesis: it.hypothesis ?? '',
    status: it.status ?? 'not_started',
    ...(it.createdAt != null ? { createdAt: it.createdAt } : {}),
    ...(it.startedAt != null ? { startedAt: it.startedAt } : {}),
    ...(it.endedAt != null ? { endedAt: it.endedAt } : {}),
    ...(it.winningTreatmentId ? { winningTreatment: { id: it.winningTreatmentId, ...(winner ? { name: winner.name } : {}) } } : {}),
    ...(it.winningReason ? { winningReason: it.winningReason } : {}),
    ...(it.canReshuffleTraffic != null ? { canReshuffleTraffic: it.canReshuffleTraffic } : {}),
    randomizationUnit: it.randomizationUnit ?? 'user',
    ...(it.attributes?.length ? { attributes: [...it.attributes] } : {}),
    ...(it.reallocationFrequencyMillis != null ? { reallocationFrequencyMillis: it.reallocationFrequencyMillis } : {}),
    treatments,
    metrics,
    ...(primary ? { primary } : {}),
    flags,
    ...(it.layerSnapshot?.key ? { layerSnapshot: { key: it.layerSnapshot.key, ...(it.layerSnapshot.name ? { name: it.layerSnapshot.name } : {}), reservationPercent: it.layerSnapshot.reservationPercent ?? 0, ...(it.layerSnapshot.otherReservationPercent != null ? { otherReservationPercent: it.layerSnapshot.otherReservationPercent } : {}) } } : {}),
  };
}

function experimentEnv(env: string, x: LdExperiment, flagsByKey: Map<string, LdFlag>, maintainer: Maintainer, holdoutKeyById: Map<string, string>, warn: Warn, path: string): NeutralExperimentEnv {
  const mt = maintainer(x._maintainerId);
  const ac = x.analysisConfig;
  const holdoutKey = x.holdoutId ? holdoutKeyById.get(x.holdoutId) : undefined;
  if (x.holdoutId && !holdoutKey) warn({ code: 'unresolved_reference', path, message: `Experiment “${x.key}” belongs to holdout ${x.holdoutId}, which is not among the holdouts read from “${env}”.` });
  return {
    env,
    ...(x._id ? { id: x._id } : {}),
    name: x.name,
    description: x.description ?? '',
    experimentType: x.type ?? 'experiment',
    tags: x.tags ?? [],
    archived: x.archivedDate != null,
    ...(mt ? { maintainer: mt } : {}),
    ...(x.methodology ? { methodology: x.methodology } : {}),
    ...(ac && Object.values(ac).some((v) => v != null)
      ? {
          analysisConfig: {
            ...(ac.bayesianThreshold ? { bayesianThreshold: ac.bayesianThreshold } : {}),
            ...(ac.significanceThreshold ? { significanceThreshold: ac.significanceThreshold } : {}),
            ...(ac.testDirection ? { testDirection: ac.testDirection } : {}),
            ...(ac.multipleComparisonCorrectionMethod ? { multipleComparisonCorrectionMethod: ac.multipleComparisonCorrectionMethod } : {}),
            ...(ac.multipleComparisonCorrectionScope ? { multipleComparisonCorrectionScope: ac.multipleComparisonCorrectionScope } : {}),
            ...(ac.sequentialTestingEnabled != null ? { sequentialTestingEnabled: ac.sequentialTestingEnabled } : {}),
          },
        }
      : {}),
    ...(x.dataSource && x.dataSource !== 'launchdarkly' ? { dataSource: x.dataSource } : {}),
    ...(x.holdoutId ? { holdout: { id: x.holdoutId, ...(holdoutKey ? { key: holdoutKey } : {}) } } : {}),
    ...(x.currentIteration ? { currentIteration: iteration(x.currentIteration, flagsByKey, warn, `${path}/currentIteration`) } : {}),
    ...(x.draftIteration ? { draftIteration: iteration(x.draftIteration, flagsByKey, warn, `${path}/draftIteration`) } : {}),
    previousIterations: (x.previousIterations ?? []).map((it, i) => iteration(it, flagsByKey, warn, `${path}/previousIterations[${i}]`)),
    ...(x._creationDate != null ? { creationDate: x._creationDate } : {}),
  };
}

function holdoutEnv(env: string, h: LdHoldout, maintainer: Maintainer, warn: Warn, path: string): NeutralHoldoutEnv {
  const base = h.baseExperiment;
  const it = base?.currentIteration ?? base?.draftIteration;
  if (!base) warn({ code: 'partial_spec', path, message: `Holdout “${h.key}” was listed but its detail (base experiment, metrics, amount) could not be read; it migrates with what the listing gave.` });
  const { metrics, primary } = it ? iterationMetrics(it) : { metrics: [] as NeutralIterationMetric[], primary: undefined };
  const mt = maintainer(base?._maintainerId);
  const attached = [...(h.relatedExperiments ?? []).map((e) => e.key), ...(h.experiments ?? []).flatMap((e) => (e.key ? [e.key] : []))];
  return {
    env,
    ...(h._id ? { id: h._id } : {}),
    name: h.name ?? base?.name ?? h.key ?? '',
    description: h.description ?? base?.description ?? '',
    status: h.status ?? 'created',
    holdoutAmount: h.holdoutAmount ?? '0',
    randomizationUnit: it?.randomizationUnit ?? 'user',
    ...(it?.attributes?.length ? { attributes: [...it.attributes] } : {}),
    metrics,
    ...(primary ? { primaryMetricKey: primary.key } : {}),
    ...(h.prerequisiteFlagKey ? { prerequisiteFlagKey: h.prerequisiteFlagKey } : {}),
    ...(mt ? { maintainer: mt } : {}),
    experiments: [...new Set(attached)].sort(),
    ...(h.createdAt != null ? { createdAt: h.createdAt } : {}),
  };
}

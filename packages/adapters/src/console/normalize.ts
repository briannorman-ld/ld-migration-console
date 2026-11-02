import {
  CONDITION_TYPES,
  CONSOLE_MISSING_FIELDS,
  emptySnapshot,
  entityUid,
  OPERATORS,
  type CanonicalSnapshot,
  type Condition,
  type ConditionType,
  type Config,
  type Experiment,
  type ExperimentStatus,
  type FieldGroup,
  type Gate,
  type GateStatus,
  type Override,
  type ParamStoreParameter,
  type Rule,
  type Segment,
  type SegmentType,
  type SnapshotWarning,
  type SourceRef,
} from '@sslm/canonical';
import type { StatsigCondition, StatsigOverrides, StatsigRule } from '@sslm/statsig-client';
import type { RawConsoleSnapshot } from './crawl.ts';

const KNOWN_TYPES = new Set<string>(CONDITION_TYPES);
const KNOWN_OPERATORS = new Set<string>(OPERATORS);
const UA_DERIVED = new Set(['browser_name', 'browser_version', 'os_name', 'os_version']);

export interface NormalizeConsoleOptions {
  source: SourceRef & { alias: string };
  takenAt?: string;
}

/** Console API raw snapshot → canonical. Pure and deterministic; runs in a worker. */
export function normalizeConsoleSnapshot(raw: RawConsoleSnapshot, opts: NormalizeConsoleOptions): CanonicalSnapshot {
  const { source } = opts;
  const snap = emptySnapshot(source, opts.takenAt ?? raw.fetchedAt);
  const warn = (w: SnapshotWarning) => snap.warnings.push(w);
  const base = (kind: Parameters<typeof entityUid>[1], id: string) => ({ uid: entityUid(source.sourceId, kind, id), id, source: { sourceId: source.sourceId, sourceKind: source.sourceKind } });

  snap.completeness = { missing: [...CONSOLE_MISSING_FIELDS] };
  snap.companyId = raw.company?.companyID ?? undefined;
  snap.projectName = raw.project.name ?? undefined;
  snap.isWarehouseNative = raw.company?.isWarehouseNative ?? undefined;

  for (const i of raw.schemaIssues) {
    warn({ code: 'schema_mismatch', path: `${i.endpoint}${i.index !== undefined ? `[${i.index}]` : ''}`, message: i.issues.map((x) => `${x.path || '(root)'}: ${x.message}`).join('; ') });
  }
  for (const s of raw.skipped) warn({ code: 'fetch_skipped', path: s.endpoint, message: s.reason });

  snap.environments = (raw.environments?.environments ?? []).map((e) => ({ name: e.name, id: e.id ?? undefined, isProduction: e.isProduction ?? undefined, requiresReview: e.requiresReview ?? undefined, inferred: false }));
  snap.unitTypes = raw.unitIdTypes.map((u) => ({ name: u.name, description: u.description ?? undefined }));
  snap.tags = raw.tags.map((t) => ({ name: t.name, description: t.description ?? undefined }));
  snap.targetApps = raw.targetApps.map((t) => ({ id: t.id ?? t.name, name: t.name }));
  snap.users = raw.users.map((u) => ({ id: u.userID ?? undefined, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || undefined, role: u.role ?? undefined }));

  const overrides = gateOverrideIndex(raw.overrides);
  const condCtx = (path: string) => ({ warn, path });

  // --- Gates ---------------------------------------------------------------------------------
  for (const [i, g] of raw.gates.entries()) {
    const idType = g.idType ?? 'userID';
    const gate: Gate = {
      kind: 'gate',
      ...base('gate', g.id),
      name: g.name ?? g.id,
      ...meta(g),
      completeness: { missing: ['salts'] },
      archived: g.status === 'Archived' || g.archivedAt != null,
      enabled: g.isEnabled,
      idType,
      rules: (g.rules ?? []).map((r, ri) => rule(r, ri, idType, 'gate', condCtx(`gates[${i}].rules[${ri}]`))),
      overrides: gateOverrides(overrides.get(g.id), idType, warn, g.id),
      status: (g.status ?? undefined) as GateStatus | undefined,
      lifecycle: { type: g.type ?? undefined, typeReason: g.typeReason ?? undefined },
      checksPerHour: g.checksPerHour ?? null,
      holdoutIds: g.holdoutIDs ?? [],
    };
    snap.gates.push(gate);
  }

  // --- Dynamic configs ---------------------------------------------------------------------
  for (const [i, c] of raw.dynamicConfigs.entries()) {
    const idType = c.idType ?? 'userID';
    const config: Config = {
      kind: 'config',
      ...base('config', c.id),
      name: c.name ?? c.id,
      ...meta(c),
      completeness: { missing: ['salts'] },
      archived: c.status === 'Archived',
      enabled: c.isEnabled,
      idType,
      defaultValue: c.defaultValue ?? {},
      rules: (c.rules ?? []).map((r, ri) => rule(r, ri, idType, 'config', condCtx(`dynamic_configs[${i}].rules[${ri}]`))),
      overrides: [],
      schema: c.schema ?? null,
      lifecycle: { type: c.type ?? undefined, typeReason: c.typeReason ?? undefined },
      checksPerHour: c.checksPerHour ?? null,
      holdoutIds: c.holdoutIDs ?? [],
    };
    snap.configs.push(config);
  }

  // --- Segments ----------------------------------------------------------------------------
  for (const [i, s] of raw.segments.entries()) {
    const idType = s.idType ?? 'userID';
    const list = raw.idLists[s.id];
    const missing: FieldGroup[] = [];
    if (s.type === 'id_list' && !list) missing.push('idListMembers');
    const seg: Segment = {
      kind: 'segment',
      ...base('segment', s.id),
      name: s.name ?? s.id,
      ...meta(s),
      completeness: { missing },
      archived: false,
      segmentType: s.type as SegmentType,
      enabled: s.isEnabled ?? true,
      idType,
      rules: (s.rules ?? []).map((r, ri) => rule(r, ri, idType, 'segment', condCtx(`segments[${i}].rules[${ri}]`))),
      ...(s.type === 'id_list' ? { idList: { count: s.count ?? list?.count ?? undefined, ...(list ? { ids: list.ids } : {}) } } : {}),
    };
    snap.segments.push(seg);
  }

  // --- Experiments -------------------------------------------------------------------------
  const expOverrides = new Map((raw.overrides?.experiments ?? []).map((o) => [o.id, o]));
  for (const [i, e] of raw.experiments.entries()) {
    const idType = e.idType ?? 'userID';
    const groupNameById = new Map(e.groups.map((g) => [g.id ?? '', g.name]));
    const o = expOverrides.get(e.id);
    const exp: Experiment = {
      kind: 'experiment',
      ...base('experiment', e.id),
      name: e.name ?? e.id,
      ...meta(e),
      completeness: { missing: [] },
      archived: e.status === 'archived',
      status: e.status as ExperimentStatus,
      idType,
      groups: e.groups.map((g) => ({ id: g.id ?? undefined, name: g.name, size: g.size, parameterValues: (g.parameterValues ?? {}) as Record<string, unknown>, isControl: g.isControl ?? undefined })),
      allocation: e.allocation,
      layerId: e.layerID ?? null,
      targetingGateId: e.targetingGateID || null,
      launchedGroupId: e.launchedGroupID ?? null,
      hypothesis: e.hypothesis ?? undefined,
      primaryMetrics: (e.primaryMetrics ?? []).map((m) => ({ name: m.name, type: m.type })),
      secondaryMetrics: (e.secondaryMetrics ?? []).map((m) => ({ name: m.name, type: m.type })),
      overrides: (o?.userIDOverrides ?? []).map((u) => ({
        unitType: u.unitType ?? idType,
        ids: u.ids,
        value: { kind: 'group', groupId: u.groupID, groupName: groupNameById.get(u.groupID) },
        environment: u.environment ?? null,
      })),
      targetingRules: (e.inlineTargetingRules ?? []).map((r, ri) => rule(r, ri, idType, 'gate', condCtx(`experiments[${i}].inlineTargetingRules[${ri}]`))),
      holdoutIds: e.holdoutIDs ?? [],
      salt: e.salt ?? undefined,
    };
    snap.experiments.push(exp);
  }

  // --- Layers / holdouts / autotunes ---------------------------------------------------------
  for (const l of raw.layers) {
    snap.layers.push({
      kind: 'layer',
      ...base('layer', l.id),
      name: l.name ?? l.id,
      ...meta(l),
      completeness: { missing: [] },
      archived: false,
      idType: l.idType ?? 'userID',
      isImplicit: l.isImplicitLayer ?? false,
      parameters: (l.parameters ?? []).map((p) => ({ name: p.name, type: (p.type ?? undefined) as never, defaultValue: p.defaultValue })),
      experimentIds: raw.experiments.filter((e) => e.layerID === l.id).map((e) => e.id),
      holdoutIds: l.holdoutIDs ?? [],
    });
  }
  for (const h of raw.holdouts) {
    snap.holdouts.push({
      kind: 'holdout',
      ...base('holdout', h.id),
      name: h.name ?? h.id,
      ...meta(h),
      completeness: { missing: [] },
      archived: false,
      enabled: h.isEnabled ?? true,
      idType: h.idType ?? 'userID',
      passPercentage: h.passPercentage,
      isGlobal: h.isGlobal ?? false,
      gateIds: h.gateIDs ?? [],
      experimentIds: h.experimentIDs ?? [],
      layerIds: h.layerIDs ?? [],
      targetingGateId: h.targetingGateID || null,
    });
  }
  for (const a of raw.autotunes) {
    snap.autotunes.push({
      kind: 'autotune',
      ...base('autotune', a.id),
      name: a.name ?? a.id,
      ...meta(a),
      completeness: { missing: [] },
      archived: false,
      idType: a.idType ?? 'userID',
      variants: a.variants.map((v) => ({ id: v.id ?? v.name, name: v.name, json: v.json, size: v.size ?? undefined })),
      successEvent: a.successEvent || undefined,
      isStarted: a.isStarted ?? false,
      winner: a.winner ?? null,
    });
  }

  // --- Metrics / param stores -----------------------------------------------------------------
  for (const m of raw.metrics) {
    const id = m.id ?? `${m.name}::${m.type}`;
    snap.metrics.push({
      kind: 'metric',
      ...base('metric', id),
      name: m.name,
      description: m.description ?? undefined,
      tags: m.tags ?? [],
      owner: owner(m.owner),
      createdTime: m.createdTime ?? undefined,
      lastModifiedTime: m.lastModifiedTime ?? null,
      permalink: m.permalink ?? undefined,
      completeness: { missing: [] },
      archived: false,
      targetApps: [],
      metricType: m.type,
      definition: m,
      isWarehouseNative: m.warehouseNative != null,
    });
  }
  for (const p of raw.paramStores) {
    snap.paramStores.push({
      kind: 'param_store',
      ...base('param_store', p.name),
      name: p.name,
      description: p.description ?? undefined,
      tags: [],
      createdTime: p.createdTime ?? undefined,
      completeness: { missing: [] },
      archived: false,
      targetApps: [],
      parameters: p.parameters.map(paramStoreParam),
    });
  }

  // --- Prompts / AI Configs: shell only (versions have no read endpoint, PLAN §6) ---------------
  snap.prompts = raw.prompts.map((p) => ({
    kind: 'prompt' as const,
    ...base('prompt', p.id),
    name: p.name ?? p.id,
    ...meta({ ...p, owner: p.creatorEmail || p.creatorName ? { ownerID: p.creatorID, ownerType: 'USER', ownerName: p.creatorName, ownerEmail: p.creatorEmail } : null }),
    completeness: { missing: [] },
    archived: false,
    idType: p.idType ?? 'userID',
    holdoutIds: p.holdoutIDs ?? [],
  }));

  // --- Teams, alerts and project-wide settings --------------------------------------------------
  snap.teams = raw.teams.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? undefined,
    ...(t.members ? { memberEmails: unique([...t.members, ...(t.admins ?? [])].map((m) => m.email.toLowerCase())) } : {}),
  }));
  snap.alerts = raw.alerts.map((a) => ({
    id: a.id,
    name: a.name,
    alertType: a.alertType ?? undefined,
    message: a.message ?? undefined,
    metrics: alertMetricNames(a.metrics),
    condition: a.condition ?? undefined,
    threshold: a.alertThreshold ?? undefined,
    windowMs: a.windowMs ?? undefined,
    team: a.team ?? undefined,
    owner: owner(a.owner),
    tags: a.tags ?? [],
    subscribers: a.subscribers?.length ?? 0,
  }));
  if (raw.reviewSettings) snap.reviews = { configReviewRequired: raw.reviewSettings.is_config_review_required ?? undefined, metricReviewRequired: raw.reviewSettings.is_metric_review_required ?? undefined };
  if (raw.projectSettings) snap.settings = { defaultUnitType: raw.projectSettings.default_unit_type ?? undefined, visibility: raw.projectSettings.visibility ?? undefined };

  snap.sourceTime = Math.max(0, ...[...snap.gates, ...snap.configs, ...snap.segments, ...snap.experiments].map((e) => e.lastModifiedTime ?? 0));
  return snap;
}

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** `AlertSchemaDto.metrics` is an object with no declared properties; take its keys, or `name`s if it turns out to be a list. */
function alertMetricNames(metrics: unknown): string[] {
  if (Array.isArray(metrics)) return metrics.map((m) => (typeof m === 'string' ? m : typeof m === 'object' && m && typeof (m as { name?: unknown }).name === 'string' ? (m as { name: string }).name : JSON.stringify(m)));
  if (metrics && typeof metrics === 'object') return Object.keys(metrics);
  return [];
}

/** Console API rule → canonical rule. */
export function rule(r: StatsigRule, index: number, idType: string, kind: 'gate' | 'config' | 'segment', ctx: { warn: (w: SnapshotWarning) => void; path: string }): Rule {
  const out: Rule = {
    id: r.id ?? r.baseID ?? `rule_${index}`,
    baseId: r.baseID ?? undefined,
    name: r.name,
    passPercentage: r.passPercentage,
    conditions: r.conditions.map((c, ci) => condition(c, { warn: ctx.warn, path: `${ctx.path}.conditions[${ci}]` })),
    environments: r.environments ?? null,
    idType,
  };
  if (kind === 'config') {
    out.returnValue = r.returnValue ?? {};
    if (r.variants?.length) {
      out.variants = r.variants.map((v) => ({ id: v.id ?? undefined, name: v.name, passPercentage: v.passPercentage, returnValue: v.returnValue ?? {} }));
    }
  } else {
    out.returnValue = true;
  }
  return out;
}

/** Console API condition → canonical. The Console vocabulary *is* the canonical one. */
export function condition(c: StatsigCondition, ctx: { warn: (w: SnapshotWarning) => void; path: string }): Condition {
  let type = c.type as ConditionType;
  if (!KNOWN_TYPES.has(c.type) || c.type === 'unknown' || c.type === 'user_bucket') {
    ctx.warn({ code: 'unknown_condition', path: ctx.path, message: `Unknown condition type "${c.type}"; kept for a decision.` });
    type = 'unknown';
  }
  if (c.operator && !KNOWN_OPERATORS.has(c.operator)) {
    ctx.warn({ code: 'unknown_condition', path: ctx.path, message: `Unknown operator "${c.operator}"; kept verbatim.` });
  }
  const out: Condition = { type, operator: c.operator ?? null, targetValue: c.targetValue ?? null, raw: c };
  if (c.field != null) out.field = c.field;
  if (type === 'unit_id') out.customID = c.customID ?? null;
  if (type === 'country') out.derivedFrom = 'ip';
  if (UA_DERIVED.has(type)) out.derivedFrom = 'user_agent';
  return out;
}

type GateOverride = NonNullable<StatsigOverrides['gates']>[number];

function gateOverrideIndex(o: StatsigOverrides | null): Map<string, GateOverride> {
  return new Map((o?.gates ?? []).map((g) => [g.id, g]));
}

function gateOverrides(o: GateOverride | undefined, idType: string, warn: (w: SnapshotWarning) => void, gateId: string): Override[] {
  if (!o) return [];
  const out: Override[] = [];
  const push = (unitType: string, ids: string[] | null | undefined, pass: boolean, environment: string | null) => {
    if (ids?.length) out.push({ unitType, ids, value: { kind: 'gate', pass }, environment });
  };
  push('userID', o.passingUserIDs, true, null);
  push('userID', o.failingUserIDs, false, null);
  if ((o.passingCustomIDs?.length || o.failingCustomIDs?.length) && idType.toLowerCase() === 'userid') {
    warn({ code: 'ambiguous_override', path: `overrides.gates.${gateId}`, message: 'Custom-ID overrides on a userID gate: unit type unknown; recorded as "customID".' });
  }
  const customType = idType.toLowerCase() === 'userid' ? 'customID' : idType;
  push(customType, o.passingCustomIDs, true, null);
  push(customType, o.failingCustomIDs, false, null);
  for (const e of o.environmentOverrides ?? []) {
    const unitType = e.unitID ?? idType;
    push(unitType, e.passingIDs, true, e.environment ?? null);
    push(unitType, e.failingIDs, false, e.environment ?? null);
  }
  return out;
}

function paramStoreParam(p: { name: string; ref_type: string; param_type?: string | null } & Record<string, unknown>): ParamStoreParameter {
  const ref = (() => {
    switch (p.ref_type) {
      case 'gate':
        return { kind: 'gate' as const, id: String(p.gate_name) };
      case 'dynamic_config':
        return { kind: 'config' as const, id: String(p.config_name), param: String(p.param_name) };
      case 'experiment':
        return { kind: 'experiment' as const, id: String(p.experiment_name), param: String(p.param_name) };
      case 'layer':
        return { kind: 'layer' as const, id: String(p.layer_name), param: String(p.param_name) };
      default:
        return undefined;
    }
  })();
  return { name: p.name, refType: p.ref_type, paramType: p.param_type ?? 'unknown', ...(p.ref_type === 'static' ? { value: p.value } : {}), ...(ref ? { ref } : {}), raw: p };
}

type Meta = {
  description?: string | null;
  tags?: string[] | null;
  owner?: { ownerID?: string | null; ownerType?: string | null; ownerName?: string | null; ownerEmail?: string | null } | null;
  team?: string | null;
  createdTime?: number | null;
  lastModifiedTime?: number | null;
  version?: number | null;
  permalink?: string | null;
  targetApps?: string | string[] | null;
};

function meta(e: Meta) {
  return {
    description: e.description ?? undefined,
    tags: e.tags ?? [],
    owner: owner(e.owner),
    team: e.team ?? null,
    createdTime: e.createdTime ?? undefined,
    lastModifiedTime: e.lastModifiedTime ?? null,
    version: e.version ?? undefined,
    permalink: e.permalink ?? undefined,
    targetApps: typeof e.targetApps === 'string' ? [e.targetApps] : (e.targetApps ?? []),
  };
}

function owner(o: Meta['owner']) {
  if (!o) return undefined;
  return { id: o.ownerID ?? undefined, type: o.ownerType ?? undefined, name: o.ownerName ?? undefined, email: o.ownerEmail ?? undefined };
}

/**
 * PostHog source adapter, normalize side (PLAN §22.2): raw PostHog responses → the neutral block
 * of a CanonicalSnapshot. Pure and deterministic. A PostHog project has no environments (a flag
 * is one `filters` document), so the snapshot has exactly one environment, named after the
 * project, which the mapping profile maps to one LD environment (PLAN §22.1).
 *
 * What the adapter decides on its own is only what is exact: ordering, AND/OR shape, typed
 * values, the lossless `early_exit` rollout. Everything PostHog has and LD lacks goes onto the
 * neutral model as `coverage`, `caveats`, `payload`, `synthetic` or `prerequisites`, where the
 * mapper turns it into decisions (PLAN §22.3). Nothing archived or deleted is ever migrated.
 */
import {
  emptyNeutralProject,
  emptySnapshot,
  neutralUid,
  type CanonicalSnapshot,
  type FieldGroup,
  type NeutralAttribute,
  type NeutralCaveat,
  type NeutralClause,
  type NeutralFlag,
  type NeutralFlagEnv,
  type NeutralRule,
  type NeutralSegment,
  type NeutralSegmentRule,
  type NeutralServe,
  type NeutralTarget,
  type NeutralVariation,
  type SnapshotWarning,
  type SourceRef,
} from '@sslm/canonical';
import { translateConditionSet, translatePropertyGroup, unique, type AttributeType, type TranslateContext } from './conditions.ts';
import { needsMembers, type RawPostHogSnapshot } from './read.ts';
import type { PhCohort, PhConditionSet, PhFeatureFlag, PhPropertyDefinition } from './schemas.ts';

export interface NormalizePostHogOptions {
  source: SourceRef & { alias: string };
  takenAt?: string;
  /** The single source environment's name. Defaults to the project name. */
  environmentName?: string;
  /** Field groups this read could never provide (a payload upload adds to the API's list). */
  missingFields?: FieldGroup[];
}

/** What a PostHog API source never provides (PLAN §22.2 "Not readable"). */
export const POSTHOG_SOURCE_MISSING_FIELDS: FieldGroup[] = ['checks', 'salts', 'targetAppNames', 'idListMembers'];
/** What a local-evaluation payload lacks on top of that (PLAN §22.1). */
export const POSTHOG_PAYLOAD_MISSING_FIELDS: FieldGroup[] = [...POSTHOG_SOURCE_MISSING_FIELDS, 'tags', 'owner', 'timestamps', 'archived', 'lifecycle'];

/** The variation the console adds for "no condition set matched" on a multivariate flag (PLAN §22.3 `multivariate_no_match`). */
export const NO_MATCH_VARIATION_NAME = 'Not served';

export function normalizePostHogSnapshot(raw: RawPostHogSnapshot, opts: NormalizePostHogOptions): CanonicalSnapshot {
  const { source } = opts;
  const snap = emptySnapshot(source, opts.takenAt ?? raw.fetchedAt);
  const warn = (w: SnapshotWarning) => snap.warnings.push(w);
  snap.completeness = { missing: [...(opts.missingFields ?? POSTHOG_SOURCE_MISSING_FIELDS)] };
  snap.projectName = raw.project.name;
  const envName = opts.environmentName ?? raw.project.name;
  snap.environments = [{ name: envName, id: raw.projectId, isProduction: /prod/i.test(envName), inferred: true }];
  for (const i of raw.schemaIssues) warn({ code: 'schema_mismatch', path: i.path, message: i.issues.map((x) => `${x.path || '(root)'}: ${x.message}`).join('; ') });
  for (const s of raw.skipped) warn({ code: 'fetch_skipped', path: s.endpoint, message: s.reason });

  const neutral = emptyNeutralProject();
  // Identity: `distinct_id` is the user key; each group type is its own context kind (PLAN §22.2 "Identity").
  const groupKinds = new Map<number, string>();
  neutral.contextKinds = [{ key: 'user', name: 'user' }];
  for (const g of raw.groupTypes) {
    const key = kindKey(g.group_type);
    groupKinds.set(g.group_type_index, key);
    neutral.contextKinds.push({ key, ...(g.name_singular ? { name: g.name_singular } : {}) });
  }
  snap.unitTypes = raw.groupTypes.map((g) => ({ name: kindKey(g.group_type), ...(g.name_singular ? { description: g.name_singular } : {}) }));

  const attributeTypes = new Map<string, AttributeType>();
  neutral.attributes = raw.propertyDefinitions
    .map((d): NeutralAttribute | undefined => {
      const contextKind = d.type === 'group' ? (groupKinds.get(d.group_type_index ?? -1) ?? undefined) : 'user';
      if (!contextKind) return undefined;
      const type = attributeType(d);
      attributeTypes.set(`${contextKind}:${d.name}`, type);
      return { name: d.name, contextKind, type, ...(d.name === 'distinct_id' || d.name === '$group_key' ? { identifier: true } : {}) };
    })
    .filter((a): a is NeutralAttribute => !!a)
    .sort((a, b) => a.contextKind.localeCompare(b.contextKind) || a.name.localeCompare(b.name));

  // Cohorts → segment keys, before the flags that reference them.
  const cohortKeys = new Map<string, string>();
  const takenKeys = new Set<string>();
  for (const c of raw.cohorts) {
    let key = slug(c.name ?? '') || `cohort-${c.id}`;
    if (takenKeys.has(key)) key = `${key}-${c.id}`;
    takenKeys.add(key);
    cohortKeys.set(String(c.id), key);
  }

  // Flags are translated after their variations are known, so dependencies can name a variation.
  const live = raw.flags.filter((f) => !f.deleted);
  if (live.length !== raw.flags.length) warn({ code: 'partial_spec', path: 'feature_flags', message: `${raw.flags.length - live.length} deleted flag(s) left out.` });
  const flagsById = new Map<string, { key: string; variations: { value: unknown; synthetic?: string }[] }>();
  const variationsOf = new Map<string, NeutralVariation[]>();
  for (const f of live) {
    const v = variationsFor(f, warn);
    variationsOf.set(f.key, v);
    flagsById.set(String(f.id), { key: f.key, variations: v.map((x) => ({ value: x.value, ...(x.synthetic ? { synthetic: x.synthetic } : {}) })) });
  }
  const ctxFor = (path: string): TranslateContext => ({ groupKinds, cohortKeys, flagsById, attributeTypes, warn: (message) => warn({ code: 'unknown_condition', path, message }) });

  const experimentName = new Map<string, string>();
  for (const e of raw.experiments) {
    const name = e.name ?? `experiment ${e.id}`;
    experimentName.set(String(e.id), name);
    if (e.feature_flag_key) experimentName.set(`key:${e.feature_flag_key}`, name);
    if (e.feature_flag?.key) experimentName.set(`key:${e.feature_flag.key}`, name);
  }
  const earlyAccessStage = new Map<string, string>();
  for (const ea of raw.earlyAccessFeatures) if (ea.feature_flag?.key && ea.stage) earlyAccessStage.set(ea.feature_flag.key, ea.stage);

  for (const f of live) {
    const path = `feature_flags/${f.key}`;
    const variations = variationsOf.get(f.key)!;
    const pending = raw.scheduledChanges.filter((s) => s.record_id === String(f.id) && !s.executed_at);
    neutral.flags.push(buildFlag(f, { variations, envName, ctx: ctxFor(path), groupKinds, experimentName, earlyAccessStage: earlyAccessStage.get(f.key), pending, source, warn, path }));
  }
  neutral.flags.sort((a, b) => a.key.localeCompare(b.key));

  for (const c of raw.cohorts) {
    const key = cohortKeys.get(String(c.id))!;
    const path = `cohorts/${c.id}`;
    neutral.segments.push(buildSegment(c, key, envName, raw, ctxFor(path), source, warn, path));
  }
  neutral.segments.sort((a, b) => a.key.localeCompare(b.key));

  snap.tags = unique(neutral.flags.flatMap((f) => f.tags)).map((name) => ({ name }));
  snap.users = raw.members.filter((m) => m.user?.email).map((m) => ({ ...(m.user?.uuid ? { id: m.user.uuid } : {}), email: m.user!.email!, ...(m.user?.first_name ? { name: [m.user.first_name, m.user.last_name].filter(Boolean).join(' ') } : {}) }));
  snap.neutral = neutral;
  snap.sourceTime = Math.max(0, ...live.map((f) => Date.parse(f.updated_at ?? '') || 0)) || undefined;
  return snap;
}

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

interface FlagBuild {
  variations: NeutralVariation[];
  envName: string;
  ctx: TranslateContext;
  groupKinds: ReadonlyMap<number, string>;
  experimentName: ReadonlyMap<string, string>;
  earlyAccessStage?: string;
  pending: RawPostHogSnapshot['scheduledChanges'];
  source: SourceRef & { alias: string };
  warn: (w: SnapshotWarning) => void;
  path: string;
}

/** PostHog stores payloads as JSON-encoded strings; a value that is not valid JSON is kept as the string it is. */
export function parsePayload(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function variationsFor(f: PhFeatureFlag, warn: (w: SnapshotWarning) => void): NeutralVariation[] {
  const payloads = f.filters?.payloads ?? {};
  if (f.is_remote_configuration) {
    const payload = parsePayload(payloads.true ?? Object.values(payloads)[0]);
    return [
      { value: payload ?? null, name: 'Remote config' },
      { value: null, name: NO_MATCH_VARIATION_NAME, synthetic: 'no_match' },
    ];
  }
  const variants = f.filters?.multivariate?.variants ?? [];
  if (variants.length) {
    const out: NeutralVariation[] = variants.map((v) => ({ value: v.key, name: v.name || v.key, ...(v.key in payloads ? { payload: parsePayload(payloads[v.key]) } : {}) }));
    const keys = out.map((v) => v.value);
    if (new Set(keys).size !== keys.length) warn({ code: 'schema_mismatch', path: `feature_flags/${f.key}/filters/multivariate`, message: 'duplicate variant keys' });
    out.push({ value: '', name: NO_MATCH_VARIATION_NAME, synthetic: 'no_match' });
    return out;
  }
  return [{ value: true, ...('true' in payloads ? { payload: parsePayload(payloads.true) } : {}) }, { value: false }];
}

function buildFlag(f: PhFeatureFlag, b: FlagBuild): NeutralFlag {
  const { variations, warn, path } = b;
  const filters = f.filters ?? {};
  const isMultivariate = !!(f.is_remote_configuration || (filters.multivariate?.variants ?? []).length);
  const noMatch = variations.findIndex((v) => v.synthetic === 'no_match');
  const offVariation = isMultivariate ? noMatch : 1;
  const caveats: NeutralCaveat[] = [];
  const flagKind = isMultivariate ? 'multivariate' : 'boolean';
  const bucketKind = filters.aggregation_group_type_index != null ? (b.groupKinds.get(filters.aggregation_group_type_index) ?? `group-${filters.aggregation_group_type_index}`) : 'user';
  const experimentIds = (f.experiment_set ?? []).map(String);
  const experiments = unique([...experimentIds.map((id) => b.experimentName.get(id) ?? `experiment ${id}`), ...(b.experimentName.has(`key:${f.key}`) ? [b.experimentName.get(`key:${f.key}`)!] : [])]);
  const variantIndex = (key: string | null | undefined): number | undefined => {
    if (!key) return undefined;
    const i = variations.findIndex((v) => v.value === key && !v.synthetic);
    return i >= 0 ? i : undefined;
  };

  const rules: NeutralRule[] = [];
  const targets: NeutralTarget[] = [];
  let hasRollout = false;

  // Early-access enrollment overrides every set: opted in → on, opted out → off (PLAN §22.2).
  const enrollment = filters.feature_enrollment === true || (filters.super_groups ?? []).length > 0;
  if (enrollment) {
    const attribute = `$feature_enrollment/${f.key}`;
    rules.push({ id: 'enrollment-in', description: 'Early access: opted in', clauses: [{ contextKind: 'user', attribute, op: 'in', values: [true], negate: false }], variation: 0 });
    rules.push({ id: 'enrollment-out', description: 'Early access: opted out', clauses: [{ contextKind: 'user', attribute, op: 'in', values: [false], negate: false }], variation: offVariation });
    caveats.push({ kind: 'early_access_enrollment', detail: { attribute, ...(b.earlyAccessStage ? { stage: b.earlyAccessStage } : {}) } });
  }

  const sets = filters.groups ?? [];
  if (f.is_remote_configuration) {
    caveats.push({ kind: 'remote_config' });
  } else {
    for (const [i, set] of sets.entries()) {
      const translated = translateConditionSet(set.properties ?? [], b.ctx);
      const pct = set.rollout_percentage == null ? 100 : Math.max(0, Math.min(100, set.rollout_percentage));
      const setKind = set.aggregation_group_type_index != null ? (b.groupKinds.get(set.aggregation_group_type_index) ?? `group-${set.aggregation_group_type_index}`) : bucketKind;
      const override = variantIndex(set.variant);
      if (set.variant && override === undefined) warn({ code: 'unresolved_reference', path: `${path}/filters/groups[${i}]`, message: `variant override “${set.variant}” is not one of the flag's variants; the set serves the variant split instead.` });

      // Individual targets: a set that is exactly "distinct_id is one of …" at 100% with no dependency.
      const only = (set.properties ?? [])[0];
      const liftable = (set.properties ?? []).length === 1 && (only?.type ?? 'person') === 'person' && only?.key === 'distinct_id' && (only.operator ?? 'exact') === 'exact' && !only.negation && pct === 100 && translated.prerequisites.length === 0;
      if (liftable) {
        const values = translated.branches[0]?.[0]?.values.map(String) ?? [];
        const variation = override ?? 0;
        const cur = targets.find((t) => t.contextKind === 'user' && t.variation === variation);
        if (cur) for (const v of values) if (!cur.values.includes(v)) cur.values.push(v);
        else targets.push({ contextKind: 'user', variation, values });
        continue;
      }

      // A 0% set matches nobody: without early exit it is a no-op (dropped, exact); with early
      // exit every context it matches gets the off value, which is a rule serving it.
      if (pct === 0 && !filters.early_exit) continue;
      let serve: NeutralServe;
      if (pct === 0) serve = { variation: offVariation };
      else if (override !== undefined) serve = { variation: override };
      else if (isMultivariate) {
        serve = { rollout: { contextKind: setKind, variations: variantWeights(filters.multivariate?.variants ?? [], variations) } };
        hasRollout = true;
      } else serve = { variation: 0 };

      let coverage: number | undefined;
      if (pct > 0 && pct < 100) {
        hasRollout = true;
        if (filters.early_exit) {
          // "Stop at the first matching set": the uncovered share gets the off value, which is a
          // plain LD rollout (PLAN §22.2).
          serve = { rollout: { contextKind: setKind, variations: scaleRollout(serve, pct, offVariation) } };
        } else {
          coverage = pct / 100;
          // The mapper turns a covered rule into a rollout; a plain variation would lose the set's bucketing kind.
          if (serve.variation !== undefined && setKind !== 'user') serve = { rollout: { contextKind: setKind, variations: [{ variation: serve.variation, weight: 100_000 }] } };
        }
      }
      const experiment = experimentIds.length && serve.rollout ? { key: experiments[0] ?? `experiment ${experimentIds[0]}` } : undefined;
      const multi = translated.branches.length > 1;
      for (const [k, clauses] of translated.branches.entries()) {
        rules.push({
          id: multi ? `set-${i}-${k}` : `set-${i}`,
          description: `Condition set ${i + 1}${multi ? ` (${String.fromCharCode(97 + k)})` : ''}`,
          clauses,
          ...serve,
          ...(coverage !== undefined ? { coverage } : {}),
          ...(experiment ? { experiment } : {}),
          ...(translated.prerequisites.length ? { prerequisites: translated.prerequisites } : {}),
        });
      }
    }
  }

  if (f.ensure_experience_continuity) caveats.push({ kind: 'experience_continuity' });
  if (f.bucketing_identifier === 'device_id') caveats.push({ kind: 'device_bucketing', detail: { attribute: '$device_id' } });
  if (f.evaluation_contexts?.length) caveats.push({ kind: 'evaluation_contexts', detail: { contexts: [...f.evaluation_contexts] } });
  if (f.has_encrypted_payloads) caveats.push({ kind: 'encrypted_payload', detail: { readable: Object.values(filters.payloads ?? {}).some((p) => typeof p === 'string' && p !== '' && !/redacted/i.test(p)) } });
  if (filters.holdout?.id != null) caveats.push({ kind: 'holdout', detail: { id: String(filters.holdout.id), percentage: filters.holdout.exclusion_percentage ?? 0 } });
  else if ((filters.holdout_groups ?? []).length) caveats.push({ kind: 'holdout', detail: { id: 'legacy', percentage: 0 } });
  if (b.pending.length) caveats.push({ kind: 'scheduled_changes', detail: { changes: b.pending.map((s) => ({ at: s.scheduled_at ?? '', operation: s.payload?.operation ?? 'unknown', recurring: !!(s.is_recurring || s.recurrence_rule) })) } });
  if (hasRollout) caveats.push({ kind: 'unsalted_rollout' });

  const hasSurvey = f.surveys && (Array.isArray(f.surveys) ? f.surveys.length > 0 : typeof f.surveys === 'object' && Object.keys(f.surveys as object).length > 0);
  const env: NeutralFlagEnv = {
    env: b.envName,
    on: f.active ?? true,
    offVariation,
    fallthrough: f.is_remote_configuration ? { variation: 0 } : { variation: offVariation },
    rules,
    targets: targets.sort((a, b2) => a.variation - b2.variation),
    prerequisites: [],
    ...(f.version != null ? { version: f.version } : {}),
    ...(f.updated_at ? { lastModified: Date.parse(f.updated_at) || undefined } : {}),
  };
  const customProperties: NeutralFlag['customProperties'] = {};
  if (f.evaluation_contexts?.length) customProperties['posthog.evaluationContexts'] = { name: 'PostHog evaluation contexts', value: [...f.evaluation_contexts] };

  return {
    kind: 'flag',
    uid: neutralUid(b.source.sourceId, 'flag', f.key),
    key: f.key,
    // PostHog's `key` is the display key; its `name` field holds the description.
    name: f.key,
    description: f.name ?? '',
    flagKind,
    variations,
    tags: (f.tags ?? []).map((t) => (typeof t === 'string' ? t : typeof t === 'object' && t && 'name' in t ? String((t as { name: unknown }).name) : String(t))).filter(Boolean),
    temporary: true,
    archived: f.archived ?? false,
    ...(hasSurvey ? { purpose: 'survey' } : {}),
    clientSideAvailability: f.evaluation_runtime === 'server' ? { usingEnvironmentId: false, usingMobileKey: false } : { usingEnvironmentId: true, usingMobileKey: true },
    defaults: { onVariation: 0, offVariation },
    customProperties,
    ...(f.created_by?.email ? { maintainer: { ...(f.created_by.id != null ? { id: String(f.created_by.id) } : {}), email: f.created_by.email } } : {}),
    experiments,
    ...(f.version != null ? { version: f.version } : {}),
    ...(f.created_at ? { creationDate: Date.parse(f.created_at) || undefined } : {}),
    environments: [env],
    ...(caveats.length ? { caveats } : {}),
  };
}

/** Variant percentages → LD weights (thousandths of a percent) summing to exactly 100,000. */
export function variantWeights(variants: { key: string; rollout_percentage?: number | null }[], variations: NeutralVariation[]): { variation: number; weight: number }[] {
  const out = variants.map((v) => ({ variation: variations.findIndex((x) => x.value === v.key && !x.synthetic), weight: Math.round((v.rollout_percentage ?? 0) * 1000) })).filter((w) => w.variation >= 0);
  const total = out.reduce((n, w) => n + w.weight, 0);
  if (out.length && total !== 100_000) out[out.length - 1]!.weight += 100_000 - total;
  return out;
}

/** `pct`% of matched contexts get `serve` (scaled), the rest the off variation. */
export function scaleRollout(serve: NeutralServe, pct: number, offVariation: number): { variation: number; weight: number }[] {
  const share = Math.round(pct * 1000);
  const parts = serve.rollout ? serve.rollout.variations.map((w) => ({ variation: w.variation, weight: Math.round((w.weight * share) / 100_000) })) : [{ variation: serve.variation ?? 0, weight: share }];
  const used = parts.reduce((n, w) => n + w.weight, 0);
  const off = parts.find((w) => w.variation === offVariation);
  if (off) off.weight += 100_000 - used;
  else parts.push({ variation: offVariation, weight: 100_000 - used });
  return parts.filter((w) => w.weight > 0);
}

// ---------------------------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------------------------

function buildSegment(c: PhCohort, key: string, envName: string, raw: RawPostHogSnapshot, ctx: TranslateContext, source: SourceRef & { alias: string }, warn: (w: SnapshotWarning) => void, path: string): NeutralSegment {
  const caveats: NeutralCaveat[] = [];
  const rules: NeutralSegmentRule[] = [];
  const included: NeutralSegment['environments'][number]['included'] = [];
  let unbounded: { contextKind: string } | undefined;
  const type = c.is_static ? 'static' : (c.cohort_type ?? (c.filters?.properties ? 'person_property' : 'unknown'));

  if (needsMembers(c)) {
    const members = raw.cohortMembers[String(c.id)];
    if (members) {
      const ids = unique(members.flatMap((p) => p.distinct_ids ?? []));
      if (ids.length) included.push({ contextKind: 'user', values: ids });
      if (members.some((p) => (p.distinct_ids ?? []).length > 1)) caveats.push({ kind: 'multi_id_members', detail: { persons: members.length, ids: ids.length } });
      if (type !== 'static') caveats.push({ kind: 'frozen_membership', detail: { cohortType: type, count: members.length } });
    } else {
      const reason = raw.membersUnreadable[String(c.id)] ?? 'members not read';
      caveats.push({ kind: 'membership_unreadable', detail: { reason } });
      // Without a readable list the segment can only be created empty for a manual import (the mapper's big-segment path).
      unbounded = { contextKind: 'user' };
      warn({ code: 'fetch_skipped', path, message: `Members of cohort “${c.name ?? c.id}” not read: ${reason}` });
    }
  } else if (c.filters?.properties) {
    const branches = translatePropertyGroup(c.filters.properties, ctx);
    for (const [k, clauses] of branches.entries()) {
      rules.push({ id: `cohort-${c.id}-${k}`, description: branches.length > 1 ? `Condition ${k + 1}` : (c.name ?? `cohort ${c.id}`), clauses: clauses.length ? clauses : [] });
    }
    if (c.filters.filterTestAccounts) rules.forEach((r) => r.clauses.push({ contextKind: 'user', attribute: '$test_accounts', op: 'posthog:filterTestAccounts', values: [], negate: false }));
  } else if (c.groups) {
    warn({ code: 'partial_spec', path, message: `Cohort “${c.name ?? c.id}” uses the legacy groups format, which the console does not read.` });
    rules.push({ id: `cohort-${c.id}-legacy`, description: c.name ?? `cohort ${c.id}`, clauses: [{ contextKind: 'user', attribute: 'cohort', op: 'posthog:legacy_groups', values: [], negate: false } satisfies NeutralClause] });
  }

  return {
    kind: 'segment',
    uid: neutralUid(source.sourceId, 'segment', key),
    key,
    name: c.name ?? key,
    description: c.description ?? '',
    tags: [],
    archived: false,
    environments: [
      {
        env: envName,
        rules,
        included,
        excluded: [],
        ...(unbounded ? { unbounded } : {}),
        ...(c.version != null ? { version: c.version } : {}),
        ...(c.last_calculation ? { lastModified: Date.parse(c.last_calculation) || undefined } : {}),
      },
    ],
    ...(caveats.length ? { caveats } : {}),
  };
}

// ---------------------------------------------------------------------------------------------

function attributeType(d: PhPropertyDefinition): AttributeType {
  switch ((d.property_type ?? '').toLowerCase()) {
    case 'string':
      return 'string';
    case 'numeric':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'datetime';
    default:
      return d.is_numerical ? 'number' : 'unknown';
  }
}

/** LD keys and context-kind keys: letters, digits, `.`, `_`, `-`. */
export function slug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64);
}

function kindKey(groupType: string): string {
  return slug(groupType) || 'group';
}

export type { PhConditionSet };

/**
 * StatSig condition → LD clauses (PLAN §10.3). Semantics follow the StatSig evaluator
 * (reference/repos/node-js-server-sdk/src/Evaluator.ts), not the docs:
 * - `any`/`none` and every `str_*_any` operator compare case-insensitively; LD's `in`,
 *   `contains`, `startsWith` and `endsWith` don't, so all of them raise `case_insensitive_match`.
 * - A missing attribute makes StatSig's negative operators (`none`, `str_contains_none`, `neq`)
 *   pass, while an LD clause on a missing attribute never matches, negated or not.
 *
 * A translated condition is a DNF (OR of ANDs): most conditions are one clause, but
 * `array_contains_all`, `on`, `not_array_contains_all` and inlined gate references expand.
 * `[]` never matches; `[[]]` always matches.
 */
import { normalizeCondition, ownValue, toArray, type CanonicalSnapshot, type Condition, type Segment } from '@sslm/canonical';
import { DROP_CONDITION, DROP_RULE, SKIP, type DecisionCollector, plannedContextKinds, plannedKindOptions } from './decisions.ts';
import { attributeFor, attributeOption, configuredUnit, defaultKindFor, sanitizeKey, unitFromChoice, type UnitTarget } from './profile.ts';
import { segmentById } from './lookup.ts';
import type { DecisionOption, DecisionSubject, Dependency, DesiredRule, DesiredTarget, FidelityNote, IdListCoverages, IdLists, LdClause, LdDirectory, LdOperator, LdRollout, MapperCapabilities, MappingProfile } from './types.ts';

export type Dnf = LdClause[][];
export const ALWAYS: Dnf = [[]];
export const NEVER: Dnf = [];

/** LD's limit for standard (non-big) list segments. */
export const LIST_SEGMENT_MAX = 15_000;
/** Upper bound on LD rules one StatSig rule may expand into. */
export const MAX_EXPANSION = 10;

export class SkipItem extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SkipItem';
  }
}

export interface ConditionContext {
  profile: MappingProfile;
  capabilities: MapperCapabilities;
  snapshot: CanonicalSnapshot;
  sourceId: string;
  idLists: IdLists;
  /** Reconciliation results for uploaded raw-ID lists, by segment uid (PLAN §4.2). */
  coverage?: IdListCoverages;
  /** LD members and teams for owner → maintainer matching (absent = not read). */
  directory?: LdDirectory;
  nowMs: number;
  /**
   * Collects the timestamps at which a `time` condition that chose "schedule" flips, so the
   * flag mapper can compute the targeting as of each one (DesiredFlagEnv.scheduledChanges).
   * Absent while that re-mapping runs: the condition is then simply resolved as of `nowMs`.
   */
  scheduleFlips?: Set<number>;
  decisions: DecisionCollector;
  subject: DecisionSubject;
  fidelity: FidelityNote[];
  deps: Map<string, Dependency>;
  /** Kind that holds StatSig's user-level attributes (email, country, custom fields). */
  userKind: string;
  /** Resolves `passes_gate` / `fails_gate`; supplied by the gate mapper (PLAN §10.4). */
  gateReference?: (gateIds: string[], negate: boolean, c: Condition, loc: Loc) => Dnf;
  /** Set while translating an inlined gate's conditions, e.g. `via employees_only`. */
  pathPrefix?: string;
  /** Context-kind keys already decided for this mapping run, by unit type. */
  kindCache: Map<string, UnitTarget>;
}

export interface Loc {
  ruleId: string;
  ruleName: string;
  index: number;
}

export function locLabel(ctx: ConditionContext, loc: Loc): string {
  return `${ctx.pathPrefix ? `${ctx.pathPrefix} › ` : ''}rule “${loc.ruleName}” › condition ${loc.index + 1}`;
}

function path(ctx: ConditionContext, loc: Loc): string {
  return `${ctx.pathPrefix ? `${ctx.pathPrefix} / ` : ''}rule:${loc.ruleId}:cond:${loc.index}`;
}

/** A sentence-case name from an ID-like string: "ds_paint_props_shaders" → "Ds paint props shaders". */
export function readableName(id: string): string {
  const s = id.split(/[_\-.\s]+/).filter(Boolean).join(' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : id;
}

/**
 * The LD flag name for a source entity (MappingProfile.flagNames, edge case 1.13): the display
 * name, or with the `readable` option a name derived from the ID when the display name *is* the
 * ID. The derivation is noted as a fact, so the decision-set hash changes with the option.
 */
export function flagName(ctx: ConditionContext, id: string, displayName: string | undefined): string {
  const name = displayName || id;
  if (ctx.profile.flagNames !== 'readable' || name !== id) return name;
  const readable = readableName(id);
  if (readable === id) return name;
  ctx.decisions.note('flag_name', 'readable');
  ctx.fidelity.push({ fidelity: 'full', message: `Flag name “${readable}” derived from the StatSig ID (Mapping › Flag names); the ID stays on the key and in migration.id.` });
  return readable;
}

/**
 * KNOWN-EDGE-CASES 4.16: StatSig allows several rules with one name; LaunchDarkly refuses two
 * rules with the same description in one environment ("duplicate rule description not allowed").
 * The second and later rules of a name get " (2)", " (3)"…, noted at full fidelity. In place.
 */
export function dedupeRuleDescriptions<T extends { description: string }>(rules: T[], fidelity?: FidelityNote[]): T[] {
  const used = new Set<string>();
  const renamed: string[] = [];
  for (const r of rules) {
    let label = r.description;
    if (used.has(label)) {
      let n = 2;
      while (used.has(`${r.description} (${n})`)) n++;
      label = `${r.description} (${n})`;
      renamed.push(label);
      r.description = label;
    }
    used.add(label);
  }
  if (renamed.length && fidelity) fidelity.push({ fidelity: 'full', message: `Rule name${renamed.length === 1 ? '' : 's'} repeated in StatSig numbered for LaunchDarkly, which wants one description per rule: ${renamed.map((l) => `“${l}”`).join(', ')}.` });
  return rules;
}

function note(ctx: ConditionContext, loc: Loc, fidelity: FidelityNote['fidelity'], message: string) {
  ctx.fidelity.push({ fidelity, message, location: locLabel(ctx, loc) });
}

function subjectAt(ctx: ConditionContext, loc: Loc): DecisionSubject {
  return { ...ctx.subject, ruleId: loc.ruleId, ruleName: loc.ruleName, location: locLabel(ctx, loc) };
}

/** Option keys that mean the same thing in every condition-level decision. */
function applyCommon(choice: string, loc: Loc): Dnf | undefined {
  if (choice === 'drop_condition') return ALWAYS;
  if (choice === 'drop_rule') return NEVER;
  if (choice === 'skip') throw new SkipItem(`skipped by decision at rule “${loc.ruleName}”`);
  return undefined;
}

/** Context kind for a unit type (the attribute's kind when the unit type is kept as an attribute). */
export function resolveKind(ctx: ConditionContext, unitType: string): string {
  return resolveUnit(ctx, unitType).contextKind;
}

/**
 * Where a unit type's IDs live in LD, raising `unit_type_kind` for kinds the LD project lacks:
 * create the kind (proposed, or under a key the user typed), keep the unit type as an attribute
 * of the `user` context (the guide's Context kinds step can also put it on any other kind), use a kind
 * another unit type's answer creates, or an existing kind. A custom unit ID is never the key of
 * the `user` context (CLAUDE.md). A kind that only carries an attribute is created all the same.
 */
export function resolveUnit(ctx: ConditionContext, unitType: string): UnitTarget {
  const cached = ctx.kindCache.get(unitType.toLowerCase());
  if (cached) return cached;
  const configured = configuredUnit(ctx.profile, ctx.sourceId, unitType);
  const proposed = configured?.contextKind ?? defaultKindFor(unitType);
  let unit: UnitTarget = configured ?? { contextKind: proposed, attribute: 'key' };
  if (!configured && proposed !== 'user' && !ctx.capabilities.existingContextKinds.includes(proposed)) {
    const existing = ctx.capabilities.existingContextKinds.filter((k) => k !== proposed && k !== 'user');
    const canCreate = ctx.capabilities.contextKinds !== 'not_permitted' && ctx.capabilities.contextKinds !== 'unavailable';
    const options: DecisionOption[] = [
      {
        key: `create:${proposed}`,
        label: `Create context kind “${proposed}”`,
        explanation: canCreate
          ? `The migration creates the LaunchDarkly context kind “${proposed}” for StatSig's ${unitType}. Your app must send a “${proposed}” context.`
          : `This token can't create context kinds. Ask a LaunchDarkly admin to create “${proposed}” first; SDK evaluations also auto-create kinds.`,
        resultingFidelity: 'full',
      },
      {
        key: attributeOption(unitType),
        label: `Keep “${unitType}” as an attribute of the user context`,
        explanation: `No new context kind. Conditions on ${unitType} become clauses on the user attribute “${unitType}”, rollouts bucket by it, and ID overrides become a targeting rule (LaunchDarkly targets individuals only by key). Your app must send ${unitType} as a user attribute.`,
        resultingFidelity: 'full',
      },
      ...plannedKindOptions(plannedContextKinds(ctx.decisions.resolutions, ctx.profile), new Set([proposed, ...ctx.capabilities.existingContextKinds]), unitType, canCreate),
      ...existing.map((k) => ({ key: `existing:${k}`, label: `Use the existing kind “${k}”`, explanation: `StatSig's ${unitType} becomes the key of the LaunchDarkly “${k}” context.`, resultingFidelity: 'full' as const })),
    ];
    const choice = ctx.decisions.choose(
      {
        type: 'unit_type_kind',
        severity: 'choice',
        subject: { sourceId: ctx.sourceId, kind: 'unit_type', uid: `${ctx.sourceId}/unit_type/${unitType}`, id: unitType },
        path: 'kind',
        title: `Context kind for unit type ${unitType}`,
        explanation: `StatSig buckets and targets by ${unitType}. LaunchDarkly needs somewhere for it: its own context kind, or an attribute of another context (the user context here; the guide's Context kinds step offers any kind). A custom unit ID is never the key of the user context.`,
        sourceFragment: { unitType },
        options,
        recommended: options[0]!.key,
      },
      options[0]!.key,
    );
    unit = unitFromChoice(choice, proposed);
  }
  ctx.kindCache.set(unitType.toLowerCase(), unit);
  if (unit.contextKind !== 'user' && !ctx.capabilities.existingContextKinds.includes(unit.contextKind)) {
    ctx.deps.set(`context_kind:${unit.contextKind}`, { kind: 'context_kind', key: unit.contextKind, entityId: unitType });
  }
  return unit;
}

/** A percentage rollout over a unit type: by context key, or bucketed by the attribute it maps to. */
export function rolloutFor(unit: UnitTarget, variations: LdRollout['variations']): LdRollout {
  return { contextKind: unit.contextKind, ...(unit.attribute !== 'key' ? { bucketBy: unit.attribute } : {}), variations };
}

/** One group of ID overrides: same unit, same variation. */
export type OverrideGroup = UnitTarget & { unitType: string; variation: number; values: string[] };

/**
 * Overrides keyed by context key become individual targets; overrides on a unit type kept as an
 * attribute become targeting rules placed before the flag's own rules (LD targets individuals
 * only by key). Both sorted, so the output is deterministic.
 */
export function splitOverrides(ctx: ConditionContext, groups: OverrideGroup[]): { targets: DesiredTarget[]; rules: DesiredRule[] } {
  const live = groups.filter((g) => g.values.length > 0);
  const targets = live
    .filter((g) => g.attribute === 'key')
    .map((g) => ({ contextKind: g.contextKind, variation: g.variation, values: g.values }))
    .sort((a, b) => `${a.contextKind}|${a.variation}`.localeCompare(`${b.contextKind}|${b.variation}`));
  const byAttr = live.filter((g) => g.attribute !== 'key').sort((a, b) => `${a.contextKind}|${a.attribute}|${a.variation}`.localeCompare(`${b.contextKind}|${b.attribute}|${b.variation}`));
  const rules: DesiredRule[] = byAttr.map((g) => ({
    description: `${g.unitType} overrides`,
    clauses: [{ contextKind: g.contextKind, attribute: g.attribute, op: 'in', values: g.values, negate: false }],
    variation: g.variation,
  }));
  const perAttribute = new Map<string, OverrideGroup[]>();
  for (const g of byAttr) {
    const k = `${g.contextKind}|${g.attribute}`;
    perAttribute.set(k, [...(perAttribute.get(k) ?? []), g]);
  }
  for (const gs of perAttribute.values()) {
    const n = gs.reduce((c, g) => c + g.values.length, 0);
    const { contextKind, attribute } = gs[0]!;
    ctx.fidelity.push({ fidelity: 'full', message: `${n} ${gs[0]!.unitType} override${n === 1 ? '' : 's'} became ${gs.length} targeting rule${gs.length === 1 ? '' : 's'} on ${contextKind} attribute “${attribute}”: LaunchDarkly targets individuals only by context key.` });
  }
  return { targets, rules };
}

export function translateCondition(ctx: ConditionContext, c: Condition, loc: Loc): Dnf {
  switch (c.type) {
    case 'public':
      return ALWAYS;
    case 'environment_tier':
      // resolveRulesForEnvironment removes every statically-decidable tier condition.
      return unsupported(ctx, c, loc, 'An environment-tier condition with an operator that cannot be resolved statically.');
    case 'passes_gate':
    case 'fails_gate': {
      const ids = toArray(c.targetValue).map(String);
      if (!ctx.gateReference) return unsupported(ctx, c, loc, 'Gate references are not supported here.');
      return ctx.gateReference(ids, c.type === 'fails_gate', c, loc);
    }
    case 'passes_segment':
    case 'fails_segment':
      return segmentCondition(ctx, c, loc, toArray(c.targetValue).map(String), c.type === 'fails_segment');
    case 'time':
      return timeCondition(ctx, c, loc);
    case 'user_id':
      return attributeCondition(ctx, c, loc, resolveKind(ctx, 'userID'), 'key');
    case 'unit_id':
      const u = resolveUnit(ctx, c.customID ?? 'userID');
      return attributeCondition(ctx, c, loc, u.contextKind, u.attribute);
    case 'email':
    case 'ip_address':
    case 'locale':
    case 'app_version':
    case 'custom_field':
      return mappedAttribute(ctx, c, loc);
    case 'country':
      return c.derivedFrom ? derived(ctx, c, loc) : mappedAttribute(ctx, c, loc);
    case 'browser_name':
    case 'browser_version':
    case 'os_name':
    case 'os_version':
    case 'device_model':
    case 'user_agent':
      return derived(ctx, c, loc);
    default:
      return unsupported(ctx, c, loc, ownValue(UNSUPPORTED_WHY, c.type) ?? `StatSig condition type “${c.type}” has no LaunchDarkly equivalent.`);
  }
}

const UNSUPPORTED_WHY: Record<string, string> = {
  target_app: 'StatSig target apps decide which SDK keys see a gate. LaunchDarkly has no per-app targeting clause (the closest is the ld_application context, which needs SDK configuration).',
  javascript: 'Custom JavaScript conditions run inside StatSig only.',
  experiment_group: 'Experiment-group conditions depend on StatSig experiment assignment, which does not move to LaunchDarkly (PLAN §11).',
  url: 'StatSig reads the page URL in its web SDK. LaunchDarkly only sees attributes your app sends.',
  user_bucket: 'StatSig bucket conditions depend on StatSig hashing; LaunchDarkly buckets differently.',
  unknown: 'The source sent a condition type this app does not recognize.',
};

function mappedAttribute(ctx: ConditionContext, c: Condition, loc: Loc): Dnf {
  const { attribute, renamed } = attributeFor(ctx.profile, c.type, c.field);
  if (renamed) note(ctx, loc, 'full', `Custom field “${c.field}” maps to LaunchDarkly attribute “${attribute}” (“${c.field}” is reserved in LaunchDarkly).`);
  return attributeCondition(ctx, c, loc, ctx.userKind, attribute);
}

function derived(ctx: ConditionContext, c: Condition, loc: Loc): Dnf {
  const { attribute } = attributeFor(ctx.profile, c.type, c.field);
  const from = c.derivedFrom === 'ip' ? 'the IP address' : 'the user agent';
  const choice = ctx.decisions.choose(
    {
      type: 'derived_attribute',
      severity: 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `${c.type} is derived by StatSig`,
      explanation: `StatSig fills ${c.type} from ${from} when your app doesn't send it. LaunchDarkly SDKs don't derive attributes, so your app must send “${attribute}” (it is added to the context contract).`,
      sourceFragment: c.raw,
      fingerprintOf: { conditionType: c.type, attribute },
      options: [
        { key: 'map', label: `Map to attribute “${attribute}”`, explanation: `Target the LaunchDarkly attribute “${attribute}”. Exact once your app sends it.`, resultingFidelity: 'partial' },
        DROP_RULE,
        SKIP,
      ],
      recommended: 'map',
    },
    'map',
  );
  const common = applyCommon(choice, loc);
  if (common) return common;
  note(ctx, loc, 'partial', `Your app must send “${attribute}” (StatSig derived it from ${from}).`);
  return attributeCondition(ctx, c, loc, ctx.userKind, attribute);
}

// ---------------------------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------------------------

const CASE_INSENSITIVE: Record<string, { op: LdOperator; negate: boolean; anchor: 'full' | 'start' | 'end' | 'none' }> = {
  any: { op: 'in', negate: false, anchor: 'full' },
  none: { op: 'in', negate: true, anchor: 'full' },
  str_contains_any: { op: 'contains', negate: false, anchor: 'none' },
  str_contains_none: { op: 'contains', negate: true, anchor: 'none' },
  str_starts_with_any: { op: 'startsWith', negate: false, anchor: 'start' },
  str_ends_with_any: { op: 'endsWith', negate: false, anchor: 'end' },
};

/** StatSig operators that pass when the attribute is missing; LD clauses never do. */
const PASSES_WHEN_MISSING = new Set(['none', 'none_case_sensitive', 'str_contains_none', 'neq']);

function attributeCondition(ctx: ConditionContext, c: Condition, loc: Loc, contextKind: string, attribute: string): Dnf {
  const op = typeof c.operator === 'string' ? c.operator.toLowerCase() : null;
  const targets = toArray(c.targetValue);
  const clause = (o: LdOperator, values: unknown[], negate = false): LdClause => ({ contextKind, attribute, op: o, values, negate });
  const one = (o: LdOperator, values: unknown[], negate = false): Dnf => [[clause(o, values, negate)]];

  // Equality operators: StatSig compares loosely (6.2, 6.5, 6.10); each group holds the forms of one target.
  const typed = () => typedTargets(ctx, c, loc, op!, targets, attribute);
  // Numeric operators: StatSig's Number() coercion accepts numeric strings; LD's operators don't (6.6).
  const numeric = (o: LdOperator): Dnf => {
    numericContract(ctx, attribute);
    return one(o, targets.map(Number));
  };
  // Version operators: StatSig pads, truncates and strips suffixes; LD needs three-part semver (6.7).
  const semver = (o: LdOperator, negate = false): Dnf => {
    const v = versionTargets(ctx, c, loc, op!, targets);
    return 'dnf' in v ? v.dnf : one(o, v.values, negate);
  };

  let out: Dnf;
  switch (op) {
    case 'any':
    case 'none':
      out = caseInsensitive(ctx, c, loc, op, unique(typed().flat()), contextKind, attribute);
      break;
    case 'str_contains_any':
    case 'str_contains_none':
    case 'str_starts_with_any':
    case 'str_ends_with_any':
      out = caseInsensitive(ctx, c, loc, op, targets, contextKind, attribute);
      break;
    case 'any_case_sensitive':
      out = one('in', unique(typed().flat()));
      break;
    case 'none_case_sensitive':
      out = one('in', unique(typed().flat()), true);
      break;
    case 'str_matches':
      out = regex(ctx, c, loc, targets.map(String), contextKind, attribute);
      break;
    case 'gt':
      out = numeric('greaterThan');
      break;
    case 'gte':
      out = numeric('greaterThanOrEqual');
      break;
    case 'lt':
      out = numeric('lessThan');
      break;
    case 'lte':
      out = numeric('lessThanOrEqual');
      break;
    case 'eq':
    case 'neq':
      if (c.targetValue === null || c.targetValue === undefined) return nullCheck(ctx, c, loc, op === 'eq' ? 'is_null' : 'is_not_null', contextKind, attribute);
      out = one('in', unique(typed().flat()), op === 'neq');
      break;
    case 'version_gt':
      out = semver('semVerGreaterThan');
      break;
    case 'version_lt':
      out = semver('semVerLessThan');
      break;
    case 'version_eq':
      out = semver('semVerEqual');
      break;
    case 'version_neq':
      out = semver('semVerEqual', true);
      break;
    // PLAN §10.3 pitfall: >= is "not less than", <= is "not greater than".
    case 'version_gte':
      out = semver('semVerLessThan', true);
      break;
    case 'version_lte':
      out = semver('semVerGreaterThan', true);
      break;
    case 'before':
      out = one('before', targets.map(toTimestamp));
      break;
    case 'after':
      out = one('after', targets.map(toTimestamp));
      break;
    case 'on': {
      // Same calendar day (UTC): after the previous millisecond, before the next day.
      const days = targets.map(toTimestamp).filter((t): t is number => typeof t === 'number').map((t) => Math.floor(t / DAY) * DAY);
      if (days.length === 0) return unsupported(ctx, c, loc, 'The `on` date could not be parsed.');
      out = days.map((d) => [clause('after', [d - 1]), clause('before', [d + DAY])]);
      break;
    }
    case 'array_contains_any':
      out = one('in', unique(typed().flat()));
      break;
    case 'array_contains_none':
      out = one('in', unique(typed().flat()), true);
      break;
    case 'array_contains_all':
      out = [typed().map((forms) => clause('in', forms))];
      break;
    case 'not_array_contains_all':
      // De Morgan: "not (has a and has b)" = "lacks a" or "lacks b" → one LD rule per value.
      out = typed().map((forms) => [clause('in', forms, true)]);
      if (out.length > 1) note(ctx, loc, 'full', `not_array_contains_all expands into ${out.length} LaunchDarkly rules (one per value).`);
      break;
    case 'is_null':
    case 'is_not_null':
      return nullCheck(ctx, c, loc, op, contextKind, attribute);
    case 'in_segment_list':
    case 'not_in_segment_list':
      return segmentCondition(ctx, c, loc, targets.map(String), op === 'not_in_segment_list');
    default:
      return unsupported(ctx, c, loc, `StatSig operator “${String(c.operator)}” has no LaunchDarkly equivalent.`);
  }

  if (op && PASSES_WHEN_MISSING.has(op) && !(contextKind === 'user' && attribute === 'key') && out.length > 0) {
    const choice = ctx.decisions.choose(
      {
        type: 'negated_missing_attribute',
        severity: 'acknowledge',
        subject: subjectAt(ctx, loc),
        path: path(ctx, loc),
        title: `Users without “${attribute}” behave differently`,
        explanation: `StatSig's “${op}” passes users who don't send ${attribute === 'key' ? `a ${contextKind} ID` : `“${attribute}”`}. In LaunchDarkly a clause on a missing attribute never matches, even when negated, so those users won't match this rule.`,
        sourceFragment: c.raw,
        fingerprintOf: { op, attribute, contextKind },
        options: [
          { key: 'acknowledge', label: 'Acknowledge', explanation: 'Migrate as is. Users missing the attribute no longer match this rule.', resultingFidelity: 'partial' },
          SKIP,
        ],
        recommended: 'acknowledge',
      },
      'acknowledge',
    );
    const common = applyCommon(choice, loc);
    if (common) return common;
    note(ctx, loc, 'partial', `Users without “${attribute}” no longer match (${op} on a missing attribute).`);
  }
  return out;
}

function caseInsensitive(ctx: ConditionContext, c: Condition, loc: Loc, op: string, targets: unknown[], contextKind: string, attribute: string): Dnf {
  const spec = CASE_INSENSITIVE[op]!;
  // `any` / `none` keep the typed values `typedTargets` settled on; the string operators stringify.
  const typed = op === 'any' || op === 'none';
  const values = unique(targets.map(String));
  const keep = typed ? targets : values;
  const clause = (o: LdOperator, vs: unknown[]): Dnf => [[{ contextKind, attribute, op: o, values: vs, negate: spec.negate }]];
  // Values with no cased letters (IPs, numbers) compare the same either way.
  if (values.every((v) => v.toLowerCase() === v.toUpperCase())) return clause(spec.op, keep);

  const choice = ctx.decisions.choose(
    {
      type: 'case_insensitive_match',
      severity: 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `Case-insensitive match (${op})`,
      explanation: `StatSig's “${op}” ignores case: “${values[0]}” also matches “${values[0]!.toLowerCase()}”. LaunchDarkly's “${spec.op}” is case-sensitive.`,
      sourceFragment: c.raw,
      fingerprintOf: normalizeCondition(c),
      options: [
        { key: 'regex', label: 'Case-folded regex', explanation: `Use LaunchDarkly “matches” with a pattern that accepts any casing, e.g. ${caseFoldedPattern(values[0]!, spec.anchor)}. Exact, but harder to read and edit in LaunchDarkly.`, resultingFidelity: 'full' },
        { key: 'variants', label: 'Add lowercase and uppercase variants', explanation: `Keep “${spec.op}” and add each value as written, lowercased and uppercased. Mixed casings like “${mixedCase(values[0]!)}” won't match.`, resultingFidelity: 'partial' },
        { key: 'exact', label: 'Keep exact values (case-sensitive)', explanation: 'Only the exact casing in StatSig matches in LaunchDarkly.', resultingFidelity: 'partial' },
        SKIP,
      ],
      recommended: 'regex',
    },
    'regex',
  );
  const common = applyCommon(choice, loc);
  if (common) return common;
  if (choice === 'regex') return clause('matches', values.map((v) => caseFoldedPattern(v, spec.anchor)));
  if (choice === 'variants') {
    note(ctx, loc, 'partial', `Case-insensitive “${op}” approximated with lower/upper variants.`);
    return clause(spec.op, unique(keep.flatMap((v) => (typeof v === 'string' ? [v, v.toLowerCase(), v.toUpperCase()] : [v]))));
  }
  note(ctx, loc, 'partial', `Case-insensitive “${op}” migrated as case-sensitive.`);
  return clause(spec.op, keep);
}

// ---------------------------------------------------------------------------------------------
// Value typing and version formats (edge cases 6.2, 6.5, 6.6, 6.7, 6.10)
// ---------------------------------------------------------------------------------------------

const INTEGER = /^-?\d+$/;
const DIGITS = /^\d+$/;
const isArrayOp = (op: string) => op.startsWith('array_contains_') || op === 'not_array_contains_all';

/**
 * StatSig's equality operators are loosely typed: `any`, `none` and the `*_case_sensitive` variants
 * compare `String()` of both sides, `eq`/`neq` use `==`, and the array operators also try
 * `parseInt(target)` (EvaluatorUtils `stringCompare`, `arrayHasValue`). LD's `in` compares typed
 * JSON values, so `"2"` ≠ `2`. When a target is a number or boolean (or, for array operators, an
 * integer string), a `value_type` decision says which forms to emit. Returns one group of forms
 * per target, in target order, so `*_all` operators can keep one clause per target.
 */
function typedTargets(ctx: ConditionContext, c: Condition, loc: Loc, op: string, targets: unknown[], attribute: string): unknown[][] {
  const arrayOp = isArrayOp(op);
  const loose = (t: unknown) => typeof t === 'number' || typeof t === 'boolean' || (arrayOp && typeof t === 'string' && INTEGER.test(t));
  const asGiven = targets.map((t) => [t]);
  const looseTargets = targets.filter(loose);
  if (looseTargets.length === 0) return asGiven;

  const other = (t: unknown): unknown => (typeof t === 'string' ? Number(t) : String(t));
  const both = targets.map((t) => (loose(t) ? unique([t, other(t)]) : [t]));
  // `any` on 2 matches 2 and "2"; an array operator with the *number* 2 matches only numbers
  // (`Set.has(2) || Set.has(parseInt(2))`), while the string "2" matches both.
  const exact: 'both' | 'number' = arrayOp && looseTargets.every((t) => typeof t !== 'string') ? 'number' : 'both';
  const ex = looseTargets[0]!;
  const exStr = JSON.stringify(String(ex));
  const exNum = typeof ex === 'string' ? Number(ex) : ex;
  const show = (groups: unknown[][]) => groups.flat().map((v) => JSON.stringify(v)).join(', ');

  const choice = ctx.decisions.choose(
    {
      type: 'value_type',
      severity: 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `Typed values: ${op} on ${looseTargets.map((t) => JSON.stringify(t)).join(', ')}`,
      explanation:
        exact === 'both'
          ? `StatSig's “${op}” compares loosely: the target ${JSON.stringify(ex)} matches “${attribute}” sent as ${String(exNum)} and as ${exStr}. LaunchDarkly's “in” compares typed JSON values, so ${exStr} and ${String(exNum)} are different values.`
          : `StatSig's “${op}” with the number ${String(ex)} matches only a number in the “${attribute}” array (strings don't match). LaunchDarkly's “in” compares typed JSON values too, so the values can stay as they are; choose “both” if your app may send strings.`,
      sourceFragment: c.raw,
      fingerprintOf: { op, targets, attribute },
      options: [
        { key: 'both', label: 'Match the number and the string', explanation: `Emit both forms of each value (${show(both)}), so the attribute matches whichever way your app sends it.`, resultingFidelity: exact === 'both' ? 'full' : 'partial' },
        { key: 'number', label: 'Keep the values as typed', explanation: `Numbers stay numbers and strings stay strings (${show(asGiven)}). An attribute sent as ${exStr} won't match a number target.`, resultingFidelity: exact === 'number' ? 'full' : 'partial' },
        { key: 'string', label: 'Compare as strings', explanation: `Stringify every value (${show(targets.map((t) => [String(t)]))}). Your app must send “${attribute}” as a string.`, resultingFidelity: 'partial' },
        SKIP,
      ],
      recommended: exact,
    },
    exact,
  );
  applyCommon(choice, loc);
  if (choice === 'both') {
    if (exact !== 'both') note(ctx, loc, 'partial', `“${attribute}” matches both numbers and strings in LaunchDarkly; StatSig's ${op} matched numbers only.`);
    return both;
  }
  if (choice === 'number') {
    if (exact !== 'number') note(ctx, loc, 'partial', `“${attribute}” must be sent with the types in the clause (StatSig's ${op} also matched ${exStr}).`);
    return asGiven;
  }
  note(ctx, loc, 'partial', `Values compared as strings: “${attribute}” must be sent as a string (StatSig's ${op} also matched ${String(exNum)}).`);
  return targets.map((t) => [String(t)]);
}

/** 6.6: `Number()` in StatSig accepts "25"; LD's numeric operators need a number. One note per attribute. */
function numericContract(ctx: ConditionContext, attribute: string): void {
  const message = `“${attribute}” must be sent as a number: StatSig's numeric operators coerced numeric strings, LaunchDarkly's don't.`;
  if (!ctx.fidelity.some((n) => n.message === message)) ctx.fidelity.push({ fidelity: 'full', message });
}

/**
 * 6.7: StatSig (`versionCompare`) strips everything from the first `-`, splits on `.`, pads missing
 * parts with 0 and compares any number of parts. LD's semVer operators need valid semver: a
 * four-part version never matches, and a prerelease sorts below its release. Missing parts are
 * padded (exact, with a note); extra parts and suffixes raise `version_format`.
 */
function versionTargets(ctx: ConditionContext, c: Condition, loc: Loc, op: string, targets: unknown[]): { values: string[] } | { dnf: Dnf } {
  const raw = targets.map(String);
  const padded: string[] = [];
  const lossy: { from: string; to: string; why: string }[] = [];
  const values = raw.map((v) => {
    const hyphen = v.indexOf('-');
    const core = hyphen >= 0 ? v.slice(0, hyphen) : v;
    const parts = core.split('.');
    // Not a version StatSig can compare either (NaN part): leave it alone.
    if (core.length === 0 || !parts.every((p) => DIGITS.test(p))) return v;
    const three = parts.slice(0, 3).map((p) => String(Number(p)));
    while (three.length < 3) three.push('0');
    const to = three.join('.');
    const why = [parts.length > 3 ? `has ${parts.length} parts` : '', hyphen >= 0 ? `has the suffix “${v.slice(hyphen)}”` : ''].filter(Boolean).join(' and ');
    if (why) lossy.push({ from: v, to, why });
    else if (to !== v) padded.push(`“${v}” → “${to}”`);
    return to;
  });
  if (padded.length) note(ctx, loc, 'full', `Version ${padded.join(', ')} for LaunchDarkly semver (StatSig pads missing parts with 0 and ignores leading zeros, so this is exact).`);
  if (lossy.length === 0) return { values };

  const list = lossy.map((l) => `“${l.from}” ${l.why}`).join('; ');
  const truncated = lossy.map((l) => `“${l.to}”`).join(', ');
  const hasParts = lossy.some((l) => l.why.includes('parts'));
  const hasSuffix = lossy.some((l) => l.why.includes('suffix'));
  const choice = ctx.decisions.choose(
    {
      type: 'version_format',
      severity: 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `Version ${lossy.map((l) => `“${l.from}”`).join(', ')} isn't semver`,
      explanation: `${list.charAt(0).toUpperCase()}${list.slice(1)}. StatSig compares any number of dot-separated parts and ignores everything after “-”. LaunchDarkly's semVer operators need valid semver: a four-part version never matches at all, and a prerelease like 5.3.0-beta sorts below 5.3.0.`,
      sourceFragment: c.raw,
      fingerprintOf: { op, targets: raw },
      options: [
        {
          key: 'truncate',
          label: `Compare against ${truncated}`,
          explanation: [
            hasParts ? 'Drop the fourth and later parts: versions that differ only there compare equal in LaunchDarkly, and your app must send a three-part version or the clause never matches.' : '',
            hasSuffix ? 'Drop the suffix: StatSig ignored it on both sides, but LaunchDarkly sorts a prerelease attribute value (5.3.0-beta) below 5.3.0, so prerelease builds fall on the other side of the comparison.' : '',
          ]
            .filter(Boolean)
            .join(' '),
          resultingFidelity: 'partial',
        },
        DROP_CONDITION,
        DROP_RULE,
        SKIP,
      ],
      recommended: 'truncate',
    },
    'truncate',
  );
  const common = applyCommon(choice, loc);
  if (common) {
    note(ctx, loc, 'partial', choice === 'drop_condition' ? `Non-semver version condition dropped (the rule matches more users).` : `Rule with a non-semver version condition dropped.`);
    return { dnf: common };
  }
  note(ctx, loc, 'partial', `Version ${lossy.map((l) => `“${l.from}” → “${l.to}”`).join(', ')}: ${hasParts ? 'the app must send three-part versions; versions differing only after the third part compare equal' : 'prerelease builds sort below the release in LaunchDarkly'}.`);
  return { values };
}

/** `[pP][rR][oO]`: a pattern every regex engine treats as case-insensitive for these letters. */
export function caseFoldedPattern(value: string, anchor: 'full' | 'start' | 'end' | 'none'): string {
  let body = '';
  for (const ch of value) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    body += lo !== up && [...lo].length === 1 && [...up].length === 1 ? `[${escapeClass(lo)}${escapeClass(up)}]` : escapeRegex(ch);
  }
  return `${anchor === 'full' || anchor === 'start' ? '^' : ''}${body}${anchor === 'full' || anchor === 'end' ? '$' : ''}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function escapeClass(s: string): string {
  return s.replace(/[\]\\^-]/g, '\\$&');
}

export function mixedCase(v: string): string {
  return [...v].map((ch, i) => (i % 2 ? ch.toLowerCase() : ch.toUpperCase())).join('');
}

/** Constructs that behave differently (or fail) across SDK regex engines, e.g. RE2 in Go. */
export const NON_PORTABLE_REGEX: { re: RegExp; what: string }[] = [
  { re: /\(\?<[=!]/, what: 'lookbehind' },
  { re: /\(\?[=!]/, what: 'lookahead' },
  { re: /\\[1-9]/, what: 'backreference' },
  { re: /\(\?P?<[A-Za-z]/, what: 'named group' },
  { re: /\\[pP]\{/, what: 'Unicode property escape' },
  { re: /[*+?}][+]/, what: 'possessive quantifier' },
  { re: /\(\?[imsx]+[:)]/, what: 'inline flags' },
];

function regex(ctx: ConditionContext, c: Condition, loc: Loc, patterns: string[], contextKind: string, attribute: string): Dnf {
  const found = unique(patterns.flatMap((p) => NON_PORTABLE_REGEX.filter((n) => n.re.test(p)).map((n) => n.what)));
  const out: Dnf = [[{ contextKind, attribute, op: 'matches', values: patterns, negate: false }]];
  if (found.length === 0) return out;
  const choice = ctx.decisions.choose(
    {
      type: 'regex_dialect',
      severity: 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `Regex uses ${found.join(', ')}`,
      explanation: `The pattern ${patterns.join(', ')} uses ${found.join(', ')}, which some LaunchDarkly SDK regex engines (for example Go's RE2) don't support. Those SDKs will treat the clause as not matching.`,
      sourceFragment: c.raw,
      fingerprintOf: { patterns },
      options: [
        { key: 'keep', label: 'Keep as is', explanation: 'Works in SDKs whose regex engine supports it (JavaScript, Java, .NET, Python).', resultingFidelity: 'partial' },
        DROP_RULE,
        SKIP,
      ],
      recommended: 'keep',
    },
    'keep',
  );
  const common = applyCommon(choice, loc);
  if (common) return common;
  note(ctx, loc, 'partial', `Regex uses ${found.join(', ')}; not portable to every SDK.`);
  return out;
}

function nullCheck(ctx: ConditionContext, c: Condition, loc: Loc, op: 'is_null' | 'is_not_null', contextKind: string, attribute: string): Dnf {
  const isNull = op === 'is_null';
  // A blocking `is_null` previews as "rule dropped"; only say so once the user has chosen it.
  const options: DecisionOption[] = isNull
    ? [DROP_RULE, SKIP]
    : [{ key: 'matches_any', label: 'Approximate with matches ".*"', explanation: `Matches users who send “${attribute}” as a string. Non-string values (numbers, booleans) won't match.`, resultingFidelity: 'partial' }, DROP_RULE, SKIP];
  const { choice, resolved } = ctx.decisions.chooseEx(
    {
      type: 'null_check',
      severity: isNull ? 'blocking' : 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: isNull ? `“${attribute}” is not set` : `“${attribute}” is set`,
      explanation: isNull
        ? `LaunchDarkly has no clause that matches a missing attribute: a clause on a missing attribute never matches, even when negated. This rule can't be expressed in LaunchDarkly.`
        : `LaunchDarkly has no “is set” operator. A regex that matches anything is the closest equivalent for string attributes.`,
      sourceFragment: c.raw,
      fingerprintOf: { op, attribute },
      options,
      ...(isNull ? {} : { recommended: 'matches_any' }),
    },
    isNull ? 'drop_rule' : 'matches_any',
  );
  const common = applyCommon(choice, loc);
  if (common) {
    if (resolved) note(ctx, loc, 'partial', `Rule requiring “${attribute}” ${isNull ? 'not ' : ''}to be set dropped.`);
    return common;
  }
  note(ctx, loc, 'partial', `“is set” approximated with matches ".*" (strings only).`);
  return [[{ contextKind, attribute, op: 'matches', values: ['.*'], negate: false }]];
}

function unsupported(ctx: ConditionContext, c: Condition, loc: Loc, why: string): Dnf {
  const { choice, resolved } = ctx.decisions.chooseEx(
    {
      type: 'unsupported_condition',
      severity: 'blocking',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `No LaunchDarkly equivalent: ${c.type}${c.operator ? ` ${String(c.operator)}` : ''}`,
      explanation: why,
      sourceFragment: c.raw,
      fingerprintOf: normalizeCondition(c),
      options: [DROP_CONDITION, DROP_RULE, SKIP],
    },
    'drop_rule',
  );
  const common = applyCommon(choice, loc)!;
  if (resolved) note(ctx, loc, 'partial', choice === 'drop_condition' ? `Unsupported ${c.type} condition dropped (the rule matches more users).` : `Rule with an unsupported ${c.type} condition dropped.`);
  return common;
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

const DAY = 86_400_000;

/** StatSig accepts seconds or milliseconds since the epoch, or a date string. */
export function toTimestamp(v: unknown): number | string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isNaN(n)) return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  if (typeof v === 'string') {
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return String(v);
}

/**
 * `time` conditions compare the current time. Resolved statically when the answer can't change
 * any more (an `after` in the past, a `before` in the past); otherwise a `time_condition` decision.
 */
function timeCondition(ctx: ConditionContext, c: Condition, loc: Loc): Dnf {
  const op = typeof c.operator === 'string' ? c.operator.toLowerCase() : '';
  const ts = toArray(c.targetValue).map(toTimestamp).filter((t): t is number => typeof t === 'number');
  if (ts.length !== 1) return unsupported(ctx, c, loc, 'The time condition has no single parseable timestamp.');
  const t = ts[0]!;
  const now = ctx.nowMs;
  let nowValue: boolean;
  let isStatic: boolean;
  switch (op) {
    case 'after':
    case 'gt':
    case 'gte':
      nowValue = op === 'gte' ? now >= t : now > t;
      isStatic = nowValue;
      break;
    case 'before':
    case 'lt':
    case 'lte':
      nowValue = op === 'lte' ? now <= t : now < t;
      isStatic = !nowValue;
      break;
    case 'on': {
      const today = Math.floor(now / DAY);
      const day = Math.floor(t / DAY);
      nowValue = today === day;
      isStatic = today > day;
      break;
    }
    default:
      return unsupported(ctx, c, loc, `Time operator “${op}” is not supported.`);
  }
  const when = new Date(t).toISOString().replace('.000Z', 'Z');
  if (isStatic) {
    note(ctx, loc, 'full', nowValue ? `Time condition (${op} ${when}) is always true now; dropped.` : `Time condition (${op} ${when}) can never be true again; rule dropped.`);
    return nowValue ? ALWAYS : NEVER;
  }
  const sc = ctx.capabilities.scheduledChanges ?? 'unknown';
  const canSchedule = sc !== 'unavailable' && sc !== 'not_permitted';
  const options: DecisionOption[] = [
    ...(canSchedule
      ? [
          {
            key: 'schedule',
            label: `Schedule the flip in LaunchDarkly at ${when}`,
            explanation: `Mirror how StatSig behaves today, and create a LaunchDarkly scheduled change that applies the targeting as of ${when} at that moment. Exact, with no re-sync needed. Enterprise plans${sc === 'unknown' ? '; your plan is checked on the first write' : ''}.`,
            resultingFidelity: 'full' as const,
          },
        ]
      : []),
    {
      key: 'resolve_now',
      label: nowValue ? 'Keep the rule without the time check' : 'Leave the rule out for now',
      explanation: `Mirror how StatSig behaves today, and re-sync after ${when} so LaunchDarkly catches up.`,
      resultingFidelity: 'partial',
    },
    SKIP,
  ];
  // The scheduled change is exact, but it needs Enterprise: it's recommended once the probe (or a
  // successful write) has shown the plan allows it; before that the safe default is to resolve now.
  const recommended = sc === 'available' ? 'schedule' : 'resolve_now';
  const choice = ctx.decisions.choose(
    {
      type: 'time_condition',
      severity: 'choice',
      subject: subjectAt(ctx, loc),
      path: path(ctx, loc),
      title: `Time condition: ${op} ${when}`,
      explanation: `This rule ${nowValue ? 'applies now but stops' : 'starts applying'} at ${when}. LaunchDarkly clauses can't compare the current time; a LaunchDarkly scheduled change (Enterprise) can flip the targeting at that moment.`,
      sourceFragment: c.raw,
      fingerprintOf: { op, t },
      options,
      recommended,
    },
    recommended,
  );
  const common = applyCommon(choice, loc);
  if (common) return common;
  if (choice === 'schedule' && canSchedule) {
    if (ctx.scheduleFlips) {
      ctx.scheduleFlips.add(op === 'on' ? Math.floor(t / DAY) * DAY : t);
      if (op === 'on') ctx.scheduleFlips.add((Math.floor(t / DAY) + 1) * DAY);
      note(ctx, loc, 'full', `Time condition resolved as of the sync (${nowValue ? 'true' : 'false'}); a LaunchDarkly scheduled change flips it at ${when}.`);
    }
    return nowValue ? ALWAYS : NEVER;
  }
  note(ctx, loc, 'partial', `Time condition resolved as of the sync (${nowValue ? 'true' : 'false'}); re-sync after ${when}.`);
  return nowValue ? ALWAYS : NEVER;
}

// ---------------------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------------------

export function segmentSize(seg: Segment, idLists: IdLists): { count?: number; ids?: string[]; hashed: boolean } {
  const fetched = idLists[seg.uid];
  if (fetched) return { count: fetched.length, ids: fetched, hashed: false };
  if (seg.idList?.hashed) return { count: seg.idList.count, hashed: true };
  return { count: seg.idList?.ids?.length ?? seg.idList?.count, ids: seg.idList?.ids, hashed: false };
}

/** Formats an ID count for decision text. */
const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');

/**
 * The `big_segment` decision for an ID list above LD's 15,000-ID limit (PLAN §8.3). Its subject is
 * the *segment*, whichever gate's condition asks, so the gate and the segment mapper share one
 * question and one answer. `import` is offered unless the probe ruled big segments out.
 */
export function bigSegmentChoice(ctx: ConditionContext, seg: Segment, count: number, fragment: unknown): { choice: string; resolved: boolean } {
  const bs = ctx.capabilities.bigSegments ?? 'unknown';
  const canImport = bs !== 'unavailable' && bs !== 'not_permitted';
  const options: DecisionOption[] = [
    ...(canImport
      ? [
          {
            key: 'import',
            label: 'Import as a LaunchDarkly big segment',
            explanation: `Create an unbounded (big) segment and load the ${n(count)} IDs with a CSV import in replace mode, so every sync mirrors the StatSig list. Enterprise plans${bs === 'unknown' ? '; your plan is checked on the first write' : ''}. Big segments have no rules and can't be previewed in the LaunchDarkly UI.`,
            resultingFidelity: 'full' as const,
          },
        ]
      : []),
    DROP_CONDITION,
    DROP_RULE,
    SKIP,
  ];
  return ctx.decisions.chooseEx(
    {
      type: 'big_segment',
      severity: canImport ? 'choice' : 'blocking',
      subject: { sourceId: seg.source.sourceId, kind: 'segment', uid: seg.uid, id: seg.id, location: `${n(count)} IDs` },
      path: 'size',
      title: `Segment “${seg.id}” has ${n(count)} IDs`,
      explanation: `LaunchDarkly list segments hold at most ${n(LIST_SEGMENT_MAX)} IDs. Bigger lists need a big segment (Enterprise), filled by a CSV import.${canImport ? '' : ' Your LaunchDarkly plan does not include big segments.'}`,
      sourceFragment: fragment,
      fingerprintOf: { segment: seg.id, over: count > LIST_SEGMENT_MAX, canImport },
      options,
      ...(canImport ? { recommended: 'import' } : {}),
    },
    canImport ? 'import' : 'drop_rule',
  );
}

/**
 * The `hashed_id_list` decision for a spec-sourced list (PLAN §4.2, §8.3). Without raw IDs it is
 * blocking: the segment can't be written until a raw-ID CSV is uploaded and reconciled (an action
 * in the app, not an option here). With a reconciliation short of 100% it asks to accept the gap.
 */
export function hashedListChoice(ctx: ConditionContext, seg: Segment, fragment: unknown): { choice: string; resolved: boolean } {
  const cov = ctx.coverage?.[seg.uid];
  const have = ctx.idLists[seg.uid];
  if (!have) {
    return ctx.decisions.chooseEx(
      {
        type: 'hashed_id_list',
        severity: 'blocking',
        subject: { sourceId: seg.source.sourceId, kind: 'segment', uid: seg.uid, id: seg.id, location: `${n(seg.idList?.count)} hashed IDs` },
        path: 'hashed',
        title: `Segment “${seg.id}” has only hashed IDs`,
        explanation: `The config spec ships this ID list as one-way hashes (the first 8 characters of base64(sha256(id))), which can't be turned back into IDs. Under Source warnings › ID lists, read the members from StatSig with a read-only Console API key, or upload the raw IDs as a CSV: the console hashes them in the browser, reports how many of StatSig's hashes they cover, and migrates the list once you accept that coverage. Or decide how to handle the rule now.`,
        sourceFragment: fragment,
        fingerprintOf: { segment: seg.id, hashed: true },
        options: [DROP_CONDITION, DROP_RULE, SKIP],
      },
      'drop_rule',
    );
  }
  if (!cov || (cov.verified && cov.missing === 0) || (!cov.verified && cov.matched >= cov.total)) return { choice: 'accept', resolved: true };
  const pct = cov.total ? Math.floor((cov.matched / cov.total) * 1000) / 10 : 0;
  const what = cov.verified ? `${n(cov.matched)} of StatSig's ${n(cov.total)} hashes matched (${pct}%); ${n(cov.missing)} hashes have no raw ID` : `the upload has ${n(cov.matched)} IDs against StatSig's count of ${n(cov.total)} (${pct}%); no hash file was uploaded, so the IDs themselves are unverified`;
  return ctx.decisions.chooseEx(
    {
      type: 'hashed_id_list',
      severity: 'acknowledge',
      subject: { sourceId: seg.source.sourceId, kind: 'segment', uid: seg.uid, id: seg.id, location: `${pct}% reconciled` },
      path: 'coverage',
      title: `Segment “${seg.id}”: raw IDs cover ${pct}% of the StatSig list`,
      explanation: `Reconciliation: ${what}${cov.extra ? `; ${n(cov.extra)} uploaded IDs are not in StatSig's list and are left out` : ''}. The LaunchDarkly segment will hold the ${n(cov.matched)} matched IDs.`,
      sourceFragment: fragment,
      fingerprintOf: { segment: seg.id, matched: cov.matched, total: cov.total, verified: cov.verified },
      options: [
        { key: 'accept', label: `Accept ${pct}% coverage`, explanation: `Migrate the ${n(cov.matched)} IDs the upload covers. Users in the ${n(cov.missing)} missing IDs are in the segment in StatSig but not in LaunchDarkly.`, resultingFidelity: 'partial' },
        { key: 'skip', label: 'Skip until a fuller upload', explanation: 'Keep the segment and the rules that need it in StatSig; upload a more complete CSV later.', resultingFidelity: 'skipped' },
      ],
      recommended: 'accept',
    },
    'accept',
  );
}

function segmentCondition(ctx: ConditionContext, c: Condition, loc: Loc, ids: string[], negate: boolean): Dnf {
  const clauses: LdClause[] = [];
  for (const id of ids) {
    const seg = segmentById(ctx.snapshot).get(id);
    const blocked = (type: 'missing_reference' | 'id_list_unavailable', title: string, explanation: string): Dnf => {
      const { choice, resolved } = ctx.decisions.chooseEx(
        { type, severity: 'blocking', subject: subjectAt(ctx, loc), path: `${path(ctx, loc)}:segment:${id}`, title, explanation, sourceFragment: c.raw, fingerprintOf: { segment: id, type }, options: [DROP_CONDITION, DROP_RULE, SKIP] },
        'drop_rule',
      );
      if (resolved) note(ctx, loc, 'partial', choice === 'drop_condition' ? `Condition on segment “${id}” dropped (the rule matches more users).` : `Rule requiring segment “${id}” dropped.`);
      return applyCommon(choice, loc)!;
    };
    const decided = ({ choice, resolved }: { choice: string; resolved: boolean }): Dnf | undefined => {
      const common = applyCommon(choice, loc);
      if (common && resolved) note(ctx, loc, 'partial', choice === 'drop_condition' ? `Condition on segment “${id}” dropped (the rule matches more users).` : `Rule requiring segment “${id}” dropped.`);
      return common;
    };
    if (!seg) return blocked('missing_reference', `Segment “${id}” not found`, `The rule references segment “${id}”, which isn't in this StatSig snapshot.`);
    if (seg.archived) return blocked('missing_reference', `Segment “${id}” is archived`, `The rule references an archived segment.`);
    if (seg.segmentType !== 'rule_based') {
      const size = segmentSize(seg, ctx.idLists);
      if (size.hashed || ctx.coverage?.[seg.uid]) {
        const h = decided(hashedListChoice(ctx, seg, c.raw));
        if (h) return h;
      }
      if (size.hashed) return NEVER; // unreachable: without raw IDs the decision above is blocking and applies drop/skip
      if ((size.count ?? 0) > LIST_SEGMENT_MAX) {
        if (!size.ids)
          return blocked('id_list_unavailable', `Segment “${id}” members aren't loaded`, `The ID list (${n(size.count)} IDs) wasn't fetched from StatSig. Load it under Source warnings (Console API key needed), then it can migrate as a big segment.`);
        const b = decided(bigSegmentChoice(ctx, seg, size.count ?? size.ids.length, c.raw));
        if (b) return b;
      } else if (!size.ids) return blocked('id_list_unavailable', `Segment “${id}” members aren't loaded`, `The ID list (${n(size.count)} IDs) wasn't fetched from StatSig. Refresh the source with a Console API key to load it.`);
    }
    const key = sanitizeKey(seg.id);
    ctx.deps.set(`segment:${key}`, { kind: 'segment', key, entityId: seg.id });
    clauses.push({ contextKind: 'user', attribute: 'segmentMatch', op: 'segmentMatch', values: [key], negate });
  }
  if (clauses.length <= 1) return [clauses];
  // Several segments in one condition (spec multi_pass/multi_fail): StatSig passes if *any* listed
  // segment passes (or fails). One clause with several values covers "in any"; "not in any one"
  // needs one LD rule per segment.
  if (negate) return clauses.map((cl) => [cl]);
  return [[{ ...clauses[0]!, values: clauses.flatMap((x) => x.values) }]];
}

// ---------------------------------------------------------------------------------------------
// DNF helpers
// ---------------------------------------------------------------------------------------------

/** AND of DNFs, distributing ORs. Returns `undefined` when the result exceeds `max` terms. */
export function andDnf(parts: Dnf[], max = MAX_EXPANSION): Dnf | undefined {
  let acc: Dnf = ALWAYS;
  for (const p of parts) {
    const next: Dnf = [];
    for (const a of acc) for (const b of p) next.push([...a, ...b]);
    if (next.length > max) return undefined;
    acc = next;
  }
  return acc;
}

/** NOT of a DNF, if it can be expressed: each conjunct becomes an OR of negated clauses. */
export function notDnf(d: Dnf, max = MAX_EXPANSION): Dnf | undefined {
  if (d.length === 0) return ALWAYS;
  const negatedTerms: Dnf[] = d.map((term) => (term.length === 0 ? NEVER : term.map((cl) => [{ ...cl, negate: !cl.negate }])));
  return andDnf(negatedTerms, max);
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

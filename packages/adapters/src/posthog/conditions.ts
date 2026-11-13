/**
 * PostHog property filters → neutral clauses (PLAN §22.2 "Condition translator"). Pure.
 *
 * Semantics are those of the evaluator, not the docs (reference/posthog/sdk-python-feature_flags.py
 * `match_property`, server-property_matching.rs):
 * - `exact` / `is_not` compare lower-cased strings and coerce "true"/"false"; `icontains`,
 *   `starts_with`, `ends_with` lower-case both sides. LD compares typed, case-sensitive values, so
 *   those clauses carry `caseInsensitive` and the mapper raises `case_insensitive_match`.
 * - A filter whose property is missing is inconclusive in PostHog (the SDK falls back to the
 *   server, which treats it as no match), so negated operators behave like LD's on missing
 *   attributes except `is_not`, which the server passes; the mapper raises
 *   `negated_missing_attribute` for negated clauses.
 * - Within a condition set filters are ANDed; `not_between` is the one filter that is an OR, so a
 *   set translates to a *disjunction of clause lists* (one LD rule each).
 *
 * Operators the console cannot write are emitted with the PostHog operator name as `op`; the
 * mapper's `unsupported_condition` path turns them into blocking decisions. Presence checks are
 * emitted as `isSet` / `isNotSet` for the mapper's `null_check`.
 */
import type { NeutralClause, NeutralPrerequisite } from '@sslm/canonical';
import type { PhPropertyFilter, PhPropertyGroup } from './schemas.ts';

export type AttributeType = 'string' | 'number' | 'boolean' | 'datetime' | 'unknown';

export interface TranslateContext {
  /** `group_type_index` → context kind key (the group type's name). */
  groupKinds: ReadonlyMap<number, string>;
  /** Cohort id → the segment key the normalizer gave it. Unknown ids keep `cohort-<id>`. */
  cohortKeys: ReadonlyMap<string, string>;
  /** Flag id → `{ key, variations }` of the parent flag, for `flag_evaluates_to`. */
  flagsById: ReadonlyMap<string, { key: string; variations: { value: unknown; synthetic?: string }[] }>;
  /** `${contextKind}:${attribute}` → declared type, from the property definitions. */
  attributeTypes: ReadonlyMap<string, AttributeType>;
  /** Problems worth a snapshot warning (unknown operator, odd value). */
  warn: (message: string) => void;
}

/** One LD rule per branch (AND of clauses); several branches when a filter is an OR. */
export type Branches = NeutralClause[][];

export interface TranslatedSet {
  branches: Branches;
  /** Rule-level prerequisites (`flag_evaluates_to` filters). */
  prerequisites: NeutralPrerequisite[];
}

/** Most LD rules one condition set may expand into before the expanding filter is treated as unsupported. */
export const MAX_SET_EXPANSION = 10;

export const PRESENCE_OPS = { isSet: 'isSet', isNotSet: 'isNotSet' } as const;

/** Translate the filters of one condition set (ANDed) into branches. */
export function translateConditionSet(filters: PhPropertyFilter[], ctx: TranslateContext): TranslatedSet {
  let branches: Branches = [[]];
  const prerequisites: NeutralPrerequisite[] = [];
  for (const f of filters) {
    const out = translateFilter(f, ctx);
    if (out.kind === 'prerequisite') {
      prerequisites.push(out.prerequisite);
      continue;
    }
    const parts: Branches = out.kind === 'branches' ? out.branches : [out.clauses];
    if (parts.length * branches.length > MAX_SET_EXPANSION) {
      ctx.warn(`A condition set expands into more than ${MAX_SET_EXPANSION} LaunchDarkly rules; the “${f.operator ?? 'exact'}” filter on “${f.key}” is left for a decision.`);
      branches = branches.map((b) => [...b, unsupported(f, ctx, `${f.operator ?? 'exact'}`)]);
      continue;
    }
    branches = branches.flatMap((b) => parts.map((p) => [...b, ...p]));
  }
  return { branches, prerequisites };
}

/**
 * A cohort's filter tree (`{ type: AND|OR, values: [...] }`, nested) into branches. `OR` becomes
 * one branch per alternative; `AND` is the cross product. Behavioral filters inside the tree are
 * emitted as unsupported clauses.
 */
export function translatePropertyGroup(group: PhPropertyGroup | null | undefined, ctx: TranslateContext): Branches {
  if (!group) return [[]];
  const values = group.values ?? [];
  const isOr = (group.type ?? 'AND').toUpperCase() === 'OR';
  const parts: Branches[] = values.map((v) => {
    if (isGroup(v)) return translatePropertyGroup(v, ctx);
    const out = translateFilter(v as PhPropertyFilter, ctx);
    if (out.kind === 'prerequisite') return [[unsupported(v as PhPropertyFilter, ctx, 'flag_evaluates_to in a cohort')]];
    return out.kind === 'branches' ? out.branches : [out.clauses];
  });
  if (parts.length === 0) return [[]];
  if (isOr) return parts.flat();
  let acc: Branches = [[]];
  for (const p of parts) {
    if (acc.length * p.length > MAX_SET_EXPANSION) {
      ctx.warn(`A cohort's conditions expand into more than ${MAX_SET_EXPANSION} LaunchDarkly rules; the rest is left for a decision.`);
      return acc.map((b) => [...b, { contextKind: 'user', attribute: 'cohort', op: 'cohort_expansion', values: [], negate: false }]);
    }
    acc = acc.flatMap((b) => p.map((q) => [...b, ...q]));
  }
  return acc;
}

function isGroup(v: unknown): v is PhPropertyGroup {
  if (!v || typeof v !== 'object') return false;
  const n = v as { type?: unknown; values?: unknown };
  return Array.isArray(n.values) || n.type === 'AND' || n.type === 'OR';
}

export type FilterOutcome = { kind: 'clauses'; clauses: NeutralClause[] } | { kind: 'branches'; branches: Branches } | { kind: 'prerequisite'; prerequisite: NeutralPrerequisite };

const DATE_OPS = new Set(['is_date_before', 'is_date_after']);
const TEXT_OPS: Record<string, { op: string; negate: boolean }> = {
  icontains: { op: 'contains', negate: false },
  not_icontains: { op: 'contains', negate: true },
  icontains_multi: { op: 'contains', negate: false },
  not_icontains_multi: { op: 'contains', negate: true },
  starts_with: { op: 'startsWith', negate: false },
  not_starts_with: { op: 'startsWith', negate: true },
  ends_with: { op: 'endsWith', negate: false },
  not_ends_with: { op: 'endsWith', negate: true },
};
const NUMERIC_OPS: Record<string, string> = { gt: 'greaterThan', gte: 'greaterThanOrEqual', min: 'greaterThanOrEqual', lt: 'lessThan', lte: 'lessThanOrEqual', max: 'lessThanOrEqual' };
/** PostHog semver operator → LD operator and negation (`gte` is "not less than", as for StatSig `version_gte`). */
const SEMVER_OPS: Record<string, { op: string; negate: boolean }> = {
  semver_eq: { op: 'semVerEqual', negate: false },
  semver_neq: { op: 'semVerEqual', negate: true },
  semver_gt: { op: 'semVerGreaterThan', negate: false },
  semver_gte: { op: 'semVerLessThan', negate: true },
  semver_lt: { op: 'semVerLessThan', negate: false },
  semver_lte: { op: 'semVerGreaterThan', negate: true },
};

export function translateFilter(f: PhPropertyFilter, ctx: TranslateContext): FilterOutcome {
  const op = (f.operator ?? 'exact').toLowerCase();
  const type = f.type ?? 'person';
  const flip = f.negation === true;
  const one = (c: NeutralClause): FilterOutcome => ({ kind: 'clauses', clauses: [flip ? { ...c, negate: !c.negate } : c] });

  if (type === 'cohort') {
    const id = String(f.value ?? f.key);
    const key = ctx.cohortKeys.get(id) ?? `cohort-${id}`;
    if (!['in', 'not_in', 'exact', 'is_not'].includes(op)) return one(unsupported(f, ctx, `${op} on a cohort`));
    return one({ contextKind: 'user', attribute: 'key', op: 'segmentMatch', values: [key], negate: op === 'not_in' || op === 'is_not' });
  }

  if (type === 'flag') {
    if (op !== 'flag_evaluates_to') return one(unsupported(f, ctx, `${op} on a flag`));
    const parent = ctx.flagsById.get(f.key);
    if (!parent) return { kind: 'prerequisite', prerequisite: { key: `flag-${f.key}`, variation: 0 } };
    const want = f.value;
    let variation = -1;
    if (want === true || want === 'true') variation = parent.variations.findIndex((v) => v.value === true);
    else if (want === false || want === 'false') variation = parent.variations.findIndex((v) => v.value === false || v.synthetic === 'no_match');
    else if (typeof want === 'string') variation = parent.variations.findIndex((v) => v.value === want);
    if (variation < 0) {
      ctx.warn(`Flag dependency on “${parent.key}” expects value ${JSON.stringify(want)}, which that flag has no variation for.`);
      variation = 0;
    }
    return { kind: 'prerequisite', prerequisite: { key: parent.key, variation } };
  }

  if (type === 'person_metadata' || type === 'event' || type === 'element') return one(unsupported(f, ctx, `a ${type} property`));

  // Person or group property.
  let contextKind = 'user';
  if (type === 'group') contextKind = (f.group_type_index !== undefined && f.group_type_index !== null ? ctx.groupKinds.get(f.group_type_index) : undefined) ?? `group-${f.group_type_index ?? '?'}`;
  const attribute = f.key === 'distinct_id' || f.key === '$group_key' ? 'key' : f.key;
  const declared = ctx.attributeTypes.get(`${contextKind}:${f.key}`) ?? 'unknown';
  const clause = (ldOp: string, values: unknown[], negate = false, caseInsensitive = false): NeutralClause => ({ contextKind, attribute, op: ldOp, values, negate, ...(caseInsensitive ? { caseInsensitive: true } : {}) });

  switch (op) {
    case 'exact':
    case 'is_not': {
      const raw = toArray(f.value);
      if (raw.length === 0) return one(unsupported(f, ctx, 'exact with an empty value (a truthiness check)'));
      const { values, caseInsensitive } = typeValues(raw, declared);
      return one(clause('in', values, op === 'is_not', caseInsensitive));
    }
    case 'is_set':
    case 'is_not_set':
      return one(clause(op === 'is_set' ? PRESENCE_OPS.isSet : PRESENCE_OPS.isNotSet, []));
    case 'regex':
    case 'not_regex':
      return one(clause('matches', toArray(f.value).map(String), op === 'not_regex'));
    case 'between':
    case 'not_between': {
      const [lo, hi] = toArray(f.value).map(toNumber);
      if (lo === undefined || hi === undefined) return one(unsupported(f, ctx, `${op} without two numeric bounds`));
      if (op === 'between') return { kind: 'clauses', clauses: [clause('greaterThanOrEqual', [lo]), clause('lessThanOrEqual', [hi])].map((c) => (flip ? { ...c, negate: !c.negate } : c)) };
      // Outside the range: below OR above, one LD rule each.
      if (flip) return { kind: 'clauses', clauses: [clause('greaterThanOrEqual', [lo]), clause('lessThanOrEqual', [hi])] };
      return { kind: 'branches', branches: [[clause('lessThan', [lo])], [clause('greaterThan', [hi])]] };
    }
    case 'is_date_exact':
      return one(unsupported(f, ctx, 'is_date_exact'));
    case 'is_cleaned_path_exact':
    case 'is_cleaned_path_not_exact':
      return one(unsupported(f, ctx, op));
  }
  if (op in TEXT_OPS) {
    const t = TEXT_OPS[op]!;
    return one(clause(t.op, toArray(f.value).map(String), t.negate, true));
  }
  if (op in NUMERIC_OPS) {
    const n = toNumber(firstOf(f.value));
    if (n === undefined) return one(unsupported(f, ctx, `${op} against a non-numeric value ${JSON.stringify(f.value)}`));
    return one(clause(NUMERIC_OPS[op]!, [n]));
  }
  if (DATE_OPS.has(op)) {
    const v = firstOf(f.value);
    if (v === undefined || v === null) return one(unsupported(f, ctx, `${op} without a date`));
    return one(clause(op === 'is_date_before' ? 'before' : 'after', [typeof v === 'number' ? v : String(v)]));
  }
  if (op in SEMVER_OPS) {
    const s = SEMVER_OPS[op]!;
    return one(clause(s.op, [String(firstOf(f.value) ?? '')], s.negate));
  }
  if (op === 'semver_tilde' || op === 'semver_caret' || op === 'semver_wildcard') {
    const range = semverRange(op, String(firstOf(f.value) ?? ''));
    if (!range) return one(unsupported(f, ctx, `${op} with “${String(firstOf(f.value))}”`));
    if (range === 'any') return { kind: 'clauses', clauses: [] };
    const cs = [clause('semVerLessThan', [range.lower], true), clause('semVerLessThan', [range.upper])];
    if (!flip) return { kind: 'clauses', clauses: cs };
    return { kind: 'branches', branches: [[clause('semVerLessThan', [range.lower])], [clause('semVerLessThan', [range.upper], true)]] };
  }
  ctx.warn(`Unknown PostHog operator “${op}” on “${f.key}”.`);
  return one(unsupported(f, ctx, op));
}

/** A clause the mapper cannot write: `op` is the PostHog operator (prefixed so it never collides with an LD one). */
function unsupported(f: PhPropertyFilter, _ctx: TranslateContext, what: string): NeutralClause {
  const contextKind = f.type === 'group' ? 'group' : 'user';
  return { contextKind, attribute: f.key, op: `posthog:${what}`, values: toArray(f.value), negate: false };
}

export function toArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function firstOf(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const BOOLISH = new Set(['true', 'false']);

/**
 * Type the values of an equality filter. PostHog stores filter values as strings and compares
 * lower-cased strings, coercing "true"/"false" to booleans. LD compares typed values, so numbers
 * and booleans are converted when the property is declared so (or every value looks like one);
 * the rest stay strings and carry `caseInsensitive`.
 */
export function typeValues(raw: unknown[], declared: AttributeType): { values: unknown[]; caseInsensitive: boolean } {
  const strings = raw.map((v) => (typeof v === 'string' ? v : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)));
  const allBool = strings.every((s) => BOOLISH.has(s.toLowerCase()));
  if (declared === 'boolean' || (declared === 'unknown' && allBool && raw.every((v) => typeof v === 'boolean' || typeof v === 'string'))) {
    if (allBool) return { values: unique(strings.map((s) => s.toLowerCase() === 'true')), caseInsensitive: false };
  }
  const nums = raw.map(toNumber);
  if (declared === 'number' && nums.every((n) => n !== undefined)) return { values: unique(nums as number[]), caseInsensitive: false };
  if (declared === 'unknown' && raw.every((v) => typeof v === 'number')) return { values: unique(raw), caseInsensitive: false };
  // Strings. Case matters to LD only when a value has letters.
  const hasLetters = strings.some((s) => /\p{L}/u.test(s));
  return { values: unique(strings), caseInsensitive: hasLetters };
}

/**
 * The `[lower, upper)` range of a tilde, caret or wildcard semver filter, as the Python SDK
 * computes it (`_parse_semver_filter`); `'any'` for a bare `*`.
 */
export function semverRange(op: 'semver_tilde' | 'semver_caret' | 'semver_wildcard', raw: string): { lower: string; upper: string } | 'any' | undefined {
  let v = raw.trim().replace(/^[~^v=]+/, '');
  if (op === 'semver_wildcard' && (v === '*' || v === 'x' || v === 'X' || v === '')) return 'any';
  const parts = v.split('.');
  const nums: number[] = [];
  let wildcardAt = -1;
  for (const [i, p] of parts.entries()) {
    if (p === 'x' || p === 'X' || p === '*') {
      wildcardAt = i;
      break;
    }
    const n = Number(p.replace(/[-+].*$/, ''));
    if (!Number.isInteger(n) || n < 0 || parts[i] === '') return undefined;
    nums.push(n);
  }
  if (nums.length === 0 || nums.length > 3) return undefined;
  const [maj, min, pat] = [nums[0]!, nums[1] ?? 0, nums[2] ?? 0];
  const lower = `${maj}.${min}.${pat}`;
  const given = wildcardAt >= 0 ? wildcardAt : nums.length;
  if (op === 'semver_wildcard') {
    if (given <= 1) return { lower: `${maj}.0.0`, upper: `${maj + 1}.0.0` };
    if (given === 2) return { lower: `${maj}.${min}.0`, upper: `${maj}.${min + 1}.0` };
    return { lower, upper: `${maj}.${min}.${pat + 1}` };
  }
  if (op === 'semver_tilde') {
    if (given <= 1) return { lower: `${maj}.0.0`, upper: `${maj + 1}.0.0` };
    return { lower, upper: `${maj}.${min + 1}.0` };
  }
  // caret: the leftmost non-zero part may not change.
  if (maj > 0 || given <= 1) return { lower, upper: `${maj + 1}.0.0` };
  if (min > 0 || given === 2) return { lower, upper: `0.${min + 1}.0` };
  return { lower, upper: `0.0.${pat + 1}` };
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

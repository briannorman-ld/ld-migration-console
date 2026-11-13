/**
 * Neutral model → desired LD state (PLAN §20.3, §22.3). The LaunchDarkly source adapter fills the
 * neutral block with LD's own vocabulary, so for it this is a near-identity mapping: what is copied
 * verbatim is copied verbatim, and every real difference between the source and the target project
 * is a decision or a fidelity note. The PostHog adapter (PLAN §22) uses the same model plus the
 * optional fields LD lacks (`coverage`, `payload`, `synthetic`, rule `prerequisites`, `caveats`,
 * `caseInsensitive`); each of those becomes a decision here (CLAUDE.md: never silently drop or
 * approximate). Pure and deterministic, like the StatSig mappers.
 */
import {
  fingerprint,
  migratedFromTag,
  migrationKindOf,
  neutralEnvOf,
  neutralSegmentEnvOf,
  PROVENANCE_PROPERTY_RE,
  PROVENANCE_TAG_RE,
  sourceTag,
  type CanonicalSnapshot,
  type MigrationSourceKind,
  type NeutralCaveat,
  type NeutralClause,
  type NeutralFlag,
  type NeutralFlagEnv,
  type NeutralPrerequisite,
  type NeutralRule,
  type NeutralScheduledChange,
  type NeutralSegment,
  type NeutralServe,
  type NeutralVariation,
} from '@sslm/canonical';
import { caseFoldedPattern, dedupeRuleDescriptions, LIST_SEGMENT_MAX, mixedCase, NON_PORTABLE_REGEX, SkipItem, unique } from './conditions.ts';
import { DecisionCollector, DROP_CONDITION, DROP_RULE, SKIP, plannedContextKinds, plannedKindOptions } from './decisions.ts';
import { provenanceProperties, report, type MapArgs, type MapOutcome } from './gate.ts';
import { neutralFlagByKey, neutralSegmentByKey } from './lookup.ts';
import { chooseMaintainer } from './maintainer.ts';
import { configuredUnit, kindFromChoice, sanitizeTag } from './profile.ts';
import type { CustomProperty, DecisionOption, DecisionSubject, Dependency, DesiredFlagEnv, DesiredFlagShell, DesiredRule, DesiredScheduledChange, DesiredSegment, DesiredSegmentRule, DesiredTarget, FidelityNote, LdClause, LdOperator, LdRollout, VariationOrRollout } from './types.ts';

/** LD clause operators the console knows how to write (reference/launchdarkly/semantic-patch-flags.md). */
export const LD_OPERATORS: ReadonlySet<string> = new Set<LdOperator>([
  'in',
  'endsWith',
  'startsWith',
  'matches',
  'contains',
  'lessThan',
  'lessThanOrEqual',
  'greaterThan',
  'greaterThanOrEqual',
  'before',
  'after',
  'segmentMatch',
  'semVerEqual',
  'semVerLessThan',
  'semVerGreaterThan',
]);

/** Presence checks a non-LD adapter emits (PostHog `is_set` / `is_not_set`); LD has no such operator (`null_check`). */
const PRESENCE_OPS = new Set(['isSet', 'isNotSet']);
const SEMVER_OPS = new Set(['semVerEqual', 'semVerLessThan', 'semVerGreaterThan']);
/** PostHog relative dates (`_parse_date_filter`): `-30d`, `-2w`, `-6m`, `-1y`, `-3h`. */
const RELATIVE_DATE = /^-?(\d+)([hdwmy])$/i;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** Custom property that keeps a PostHog early-access feature's name and stage on the LD flag (PLAN §22.3). */
export const EARLY_ACCESS_PROPERTY = 'posthog.earlyAccess';

export interface NeutralFlagMapResult extends MapOutcome {
  flagKey: string;
  flagKind: 'boolean' | 'multivariate';
  shell: DesiredFlagShell;
  /** The desired targeting; a preview (recommended options applied) while decisions are open. */
  env: DesiredFlagEnv;
}

export interface NeutralSegmentMapResult extends MapOutcome {
  segmentKey: string;
  desired: DesiredSegment | null;
}

interface Ctx {
  snapshot: CanonicalSnapshot;
  sourceId: string;
  kind: MigrationSourceKind;
  args: MapArgs<unknown>;
  decisions: DecisionCollector;
  subject: DecisionSubject;
  fidelity: FidelityNote[];
  deps: Map<string, Dependency>;
  kindCache: Map<string, string>;
}

const SOURCE_WORD: Record<MigrationSourceKind, string> = { launchdarkly: 'the source project', posthog: 'PostHog', statsig: 'StatSig' };
const SOURCE_KIND_WORD: Record<MigrationSourceKind, string> = { launchdarkly: 'LaunchDarkly', posthog: 'PostHog', statsig: 'StatSig' };
const sourceLabel = (ctx: Ctx) => SOURCE_WORD[ctx.kind] ?? 'the source';
/** Clauses from an LD source already carry LD semantics; other sources' negations, regexes and versions are checked. */
const foreign = (ctx: Ctx) => ctx.kind !== 'launchdarkly';

function makeCtx(args: MapArgs<NeutralFlag | NeutralSegment>, kind: DecisionSubject['kind']): Ctx {
  const snapshot = args.canonical.snapshot;
  return {
    snapshot,
    sourceId: snapshot.source.sourceId,
    kind: migrationKindOf(snapshot.source.sourceKind),
    args,
    decisions: new DecisionCollector(args.resolutions, args.profile),
    subject: { sourceId: snapshot.source.sourceId, kind, uid: args.entity.uid, id: args.entity.key },
    fidelity: [],
    deps: new Map(),
    kindCache: new Map(),
  };
}

/**
 * Context kind for a source kind key. Kinds the target project already has are used as they are;
 * a missing one raises `unit_type_kind` (create it, or use an existing kind), like a StatSig
 * custom unit type. `user` always exists.
 */
export function resolveSourceKind(ctx: Ctx, kindKey: string): string {
  const cached = ctx.kindCache.get(kindKey);
  if (cached) return cached;
  const caps = ctx.args.capabilities;
  // A source kind can only become a target kind; a `user` attribute (StatSig-only choice) is ignored.
  const unit = configuredUnit(ctx.args.profile, ctx.sourceId, kindKey);
  const configured = unit?.attribute === 'key' ? unit.contextKind : undefined;
  const proposed = configured ?? kindKey;
  let kind = proposed;
  if (proposed !== 'user' && !configured && !caps.existingContextKinds.includes(proposed)) {
    const existing = caps.existingContextKinds.filter((k) => k !== proposed);
    const canCreate = caps.contextKinds !== 'not_permitted' && caps.contextKinds !== 'unavailable';
    const options: DecisionOption[] = [
      {
        key: `create:${proposed}`,
        label: `Create context kind “${proposed}”`,
        explanation: canCreate ? `The target project has no “${proposed}” context kind yet; the migration creates it with the same key, so SDK contexts keep working unchanged.` : `This token can't create context kinds. Ask a LaunchDarkly admin to create “${proposed}” in the target project first; SDK evaluations also auto-create kinds.`,
        resultingFidelity: 'full',
      },
      ...existing.map((k) => ({ key: `existing:${k}`, label: `Use the existing kind “${k}”`, explanation: `Contexts of kind “${proposed}” in ${sourceLabel(ctx)} become “${k}” contexts in the target. Your app must send that kind.`, resultingFidelity: 'partial' as const })),
      ...plannedKindOptions(plannedContextKinds(ctx.decisions.resolutions, ctx.args.profile), new Set([proposed, ...caps.existingContextKinds]), kindKey, canCreate),
    ];
    const choice = ctx.decisions.choose(
      {
        type: 'unit_type_kind',
        severity: 'choice',
        subject: { sourceId: ctx.sourceId, kind: 'unit_type', uid: `${ctx.sourceId}/unit_type/${kindKey}`, id: kindKey },
        path: 'kind',
        title: `Context kind “${kindKey}” is missing in the target project`,
        explanation: `Rules, rollouts or targets use the “${kindKey}” context kind, which the target project does not have.`,
        sourceFragment: { contextKind: kindKey },
        options,
        recommended: options[0]!.key,
      },
      options[0]!.key,
    );
    kind = kindFromChoice(choice, proposed);
  }
  ctx.kindCache.set(kindKey, kind);
  if (kind !== 'user' && !caps.existingContextKinds.includes(kind)) ctx.deps.set(`context_kind:${kind}`, { kind: 'context_kind', key: kind, entityId: kindKey });
  return kind;
}

type ClauseOutcome = { kind: 'clause'; clause: LdClause } | { kind: 'clauses'; clauses: LdClause[] } | { kind: 'drop_condition' } | { kind: 'drop_rule' };

interface Loc {
  ruleId: string;
  ruleName: string;
  index: number;
}

function translateClause(ctx: Ctx, c: NeutralClause, loc: Loc, env: string, inSegment: boolean): ClauseOutcome {
  const where = `rule “${loc.ruleName}” › clause ${loc.index + 1}`;
  const path = `rule:${loc.ruleId}:clause:${loc.index}`;
  const subject = { ...ctx.subject, ruleId: loc.ruleId, ruleName: loc.ruleName, location: where };
  if (PRESENCE_OPS.has(c.op)) return presenceCheck(ctx, c, where, path, subject);
  if (!LD_OPERATORS.has(c.op) || (inSegment && c.op === 'segmentMatch')) {
    const native = c.op.startsWith('posthog:') ? c.op.slice('posthog:'.length) : c.op;
    const choice = ctx.decisions.choose(
      {
        type: 'unsupported_condition',
        severity: 'blocking',
        subject,
        path,
        title: inSegment && c.op === 'segmentMatch' ? 'Segment rule references another segment' : `No LaunchDarkly equivalent: ${native}`,
        explanation: inSegment && c.op === 'segmentMatch' ? 'LaunchDarkly segment rules cannot match other segments; the console cannot write this clause.' : `The console does not know how to write a clause for “${native}” on “${c.attribute}”.`,
        sourceFragment: c,
        options: [DROP_CONDITION, DROP_RULE, SKIP],
      },
      'drop_rule',
    );
    return skipOrDrop(ctx, choice, where, `clause with operator “${native}”`);
  }
  if (c.op === 'segmentMatch') {
    const missing = c.values.map(String).filter((key) => {
      const seg = neutralSegmentByKey(ctx.snapshot).get(key);
      return !seg || !neutralSegmentEnvOf(seg, env);
    });
    if (missing.length) {
      const choice = ctx.decisions.choose(
        {
          type: 'missing_reference',
          severity: 'blocking',
          subject,
          path,
          title: `Segment${missing.length === 1 ? '' : 's'} ${missing.map((m) => `“${m}”`).join(', ')} not in ${sourceLabel(ctx)}`,
          explanation: `The rule matches segment${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the snapshot for environment “${env}” (deleted, or not readable with this token).`,
          sourceFragment: c,
          options: [DROP_CONDITION, DROP_RULE, SKIP],
        },
        'drop_rule',
      );
      return skipOrDrop(ctx, choice, where, `clause on missing segment${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);
    }
    for (const key of c.values.map(String)) ctx.deps.set(`segment:${key}`, { kind: 'segment', key, entityId: key });
  }
  let values = c.values;
  let op = c.op as LdOperator;
  if (foreign(ctx)) {
    if (c.op === 'before' || c.op === 'after') {
      const out = relativeDates(ctx, c, where, path, subject);
      if (out.kind !== 'values') return out;
      values = out.values;
    }
    if (SEMVER_OPS.has(c.op)) {
      const out = versionFormats(ctx, c, where, path, subject);
      if (out.kind !== 'values') return out;
      values = out.values;
    }
    if (c.op === 'matches') {
      const out = regexDialect(ctx, c, where, path, subject);
      if (out) return out;
    }
    if (c.caseInsensitive && values.every((v) => typeof v === 'string')) {
      const out = caseInsensitive(ctx, c, values as string[], where, path, subject);
      if (out.kind !== 'values') return out;
      values = out.values;
      op = out.op;
    }
    // Negation an adapter used only to encode an operator (semver_gte → not semVerLessThan) behaves like LD on a missing attribute.
    if (c.negate && c.op !== 'segmentMatch' && !SEMVER_OPS.has(c.op) && !(c.contextKind === 'user' && c.attribute === 'key')) {
      const out = negatedMissing(ctx, c, where, path, subject);
      if (out) return out;
    }
  }
  return { kind: 'clause', clause: { contextKind: resolveSourceKind(ctx, c.contextKind), attribute: c.attribute, op, values, negate: c.negate } };
}

type ValuesOutcome = { kind: 'values'; values: unknown[]; op: LdOperator } | ClauseOutcome;

function presenceCheck(ctx: Ctx, c: NeutralClause, where: string, path: string, subject: DecisionSubject): ClauseOutcome {
  const isNotSet = c.op === 'isNotSet';
  const options: DecisionOption[] = isNotSet
    ? [DROP_RULE, SKIP]
    : [{ key: 'matches_any', label: 'Approximate with matches ".*"', explanation: `Matches contexts that send “${c.attribute}” as a string. Non-string values (numbers, booleans) won't match.`, resultingFidelity: 'partial' }, DROP_RULE, SKIP];
  const { choice, resolved } = ctx.decisions.chooseEx(
    {
      type: 'null_check',
      severity: isNotSet ? 'blocking' : 'choice',
      subject,
      path,
      title: isNotSet ? `“${c.attribute}” is not set` : `“${c.attribute}” is set`,
      explanation: isNotSet
        ? `LaunchDarkly has no clause that matches a missing attribute: a clause on a missing attribute never matches, even when negated. This rule can't be expressed in LaunchDarkly.`
        : `LaunchDarkly has no “is set” operator. A regex that matches anything is the closest equivalent for string attributes.`,
      sourceFragment: c,
      fingerprintOf: { op: c.op, attribute: c.attribute },
      options,
      ...(isNotSet ? {} : { recommended: 'matches_any' }),
    },
    isNotSet ? 'drop_rule' : 'matches_any',
  );
  if (choice === 'skip' || choice === 'drop_rule' || choice === 'drop_condition') {
    const out = skipOrDrop(ctx, choice, where, `“${c.attribute}” ${isNotSet ? 'is not set' : 'is set'} check`);
    if (!resolved) ctx.fidelity.pop();
    return out;
  }
  ctx.fidelity.push({ fidelity: 'partial', message: `“is set” approximated with matches ".*" (strings only).`, location: where });
  return { kind: 'clause', clause: { contextKind: resolveSourceKind(ctx, c.contextKind), attribute: c.attribute, op: 'matches', values: ['.*'], negate: false } };
}

/** PostHog date filters may be relative (`-30d`); LD compares against an instant (`relative_date`). */
function relativeDates(ctx: Ctx, c: NeutralClause, where: string, path: string, subject: DecisionSubject): ValuesOutcome {
  const relative = c.values.filter((v): v is string => typeof v === 'string' && RELATIVE_DATE.test(v.trim()));
  if (!relative.length) return { kind: 'values', values: c.values, op: c.op as LdOperator };
  const now = new Date(ctx.args.now);
  const frozen = relative.map((v) => resolveRelative(v, now));
  const choice = ctx.decisions.choose(
    {
      type: 'relative_date',
      severity: 'choice',
      subject,
      path,
      title: `Relative date ${relative.map((v) => `“${v}”`).join(', ')} in a date condition`,
      explanation: `${sourceLabel(ctx)} evaluates “${c.op === 'before' ? 'before' : 'after'} ${relative[0]}” against the current time on every evaluation, so the threshold moves. LaunchDarkly compares against a fixed instant.`,
      sourceFragment: c,
      fingerprintOf: { op: c.op, attribute: c.attribute, relative },
      options: [
        { key: 'freeze', label: `Freeze to ${frozen.map((f) => f.slice(0, 10)).join(', ')} (now)`, explanation: 'The instant the relative date resolves to at migration time. It no longer moves; re-syncing recomputes it.', resultingFidelity: 'partial' },
        DROP_RULE,
        SKIP,
      ],
      recommended: 'freeze',
    },
    'freeze',
  );
  if (choice !== 'freeze') return skipOrDrop(ctx, choice, where, `relative date “${relative[0]}”`);
  ctx.fidelity.push({ fidelity: 'partial', message: `Relative date ${relative.join(', ')} frozen to ${frozen.join(', ')}; it no longer moves with time.`, location: where });
  let i = 0;
  return { kind: 'values', values: c.values.map((v) => (typeof v === 'string' && RELATIVE_DATE.test(v.trim()) ? frozen[i++]! : v)), op: c.op as LdOperator };
}

function resolveRelative(v: string, now: Date): string {
  const m = RELATIVE_DATE.exec(v.trim())!;
  const n = Number(m[1]);
  const d = new Date(now.getTime());
  switch (m[2]!.toLowerCase()) {
    case 'h':
      d.setUTCHours(d.getUTCHours() - n);
      break;
    case 'd':
      d.setUTCDate(d.getUTCDate() - n);
      break;
    case 'w':
      d.setUTCDate(d.getUTCDate() - 7 * n);
      break;
    case 'm':
      d.setUTCMonth(d.getUTCMonth() - n);
      break;
    case 'y':
      d.setUTCFullYear(d.getUTCFullYear() - n);
      break;
  }
  return d.toISOString();
}

/** LD's semVer operators need valid semver; missing parts are padded (exact), anything else is `version_format`. */
function versionFormats(ctx: Ctx, c: NeutralClause, where: string, path: string, subject: DecisionSubject): ValuesOutcome {
  const raw = c.values.map(String);
  const padded: string[] = [];
  const lossy: string[] = [];
  const values = raw.map((v) => {
    if (SEMVER.test(v)) return v;
    const core = v.replace(/[-+].*$/, '');
    const parts = core.split('.');
    if (core && parts.every((p) => /^\d+$/.test(p)) && parts.length < 3) {
      while (parts.length < 3) parts.push('0');
      const to = parts.map((p) => String(Number(p))).join('.');
      padded.push(`“${v}” → “${to}”`);
      return to;
    }
    lossy.push(v);
    return v;
  });
  if (padded.length) ctx.fidelity.push({ fidelity: 'full', message: `Version ${padded.join(', ')} for LaunchDarkly semver (${sourceLabel(ctx)} pads missing parts with 0, so this is exact).`, location: where });
  if (!lossy.length) return { kind: 'values', values, op: c.op as LdOperator };
  const truncated = lossy.map((v) => {
    const parts = v.replace(/[-+].*$/, '').split('.').slice(0, 3);
    while (parts.length < 3) parts.push('0');
    return parts.map((p) => String(Number(p) || 0)).join('.');
  });
  const choice = ctx.decisions.choose(
    {
      type: 'version_format',
      severity: 'choice',
      subject,
      path,
      title: `Version ${lossy.map((v) => `“${v}”`).join(', ')} isn't semver`,
      explanation: `LaunchDarkly's semVer operators need valid semver (major.minor.patch with an optional prerelease): a four-part version never matches at all.`,
      sourceFragment: c,
      fingerprintOf: { op: c.op, values: raw },
      options: [{ key: 'truncate', label: `Compare against ${truncated.map((t) => `“${t}”`).join(', ')}`, explanation: 'Drop extra parts and anything that is not a number; versions that differ only there compare equal.', resultingFidelity: 'partial' }, DROP_CONDITION, DROP_RULE, SKIP],
      recommended: 'truncate',
    },
    'truncate',
  );
  if (choice !== 'truncate') return skipOrDrop(ctx, choice, where, `non-semver version ${lossy.join(', ')}`);
  ctx.fidelity.push({ fidelity: 'partial', message: `Version ${lossy.map((v, i) => `“${v}” compared as “${truncated[i]}”`).join(', ')}.`, location: where });
  let i = 0;
  return { kind: 'values', values: values.map((v) => (lossy.includes(String(v)) ? truncated[i++]! : v)), op: c.op as LdOperator };
}

function regexDialect(ctx: Ctx, c: NeutralClause, where: string, path: string, subject: DecisionSubject): ClauseOutcome | undefined {
  const patterns = c.values.map(String);
  const found = unique(patterns.flatMap((p) => NON_PORTABLE_REGEX.filter((n) => n.re.test(p)).map((n) => n.what)));
  if (!found.length) return undefined;
  const choice = ctx.decisions.choose(
    {
      type: 'regex_dialect',
      severity: 'choice',
      subject,
      path,
      title: `Regex uses ${found.join(', ')}`,
      explanation: `The pattern ${patterns.join(', ')} uses ${found.join(', ')}, which some LaunchDarkly SDK regex engines (for example Go's RE2) don't support. Those SDKs will treat the clause as not matching.`,
      sourceFragment: c,
      fingerprintOf: { patterns },
      options: [{ key: 'keep', label: 'Keep as is', explanation: 'Works in SDKs whose regex engine supports it (JavaScript, Java, .NET, Python).', resultingFidelity: 'partial' }, DROP_RULE, SKIP],
      recommended: 'keep',
    },
    'keep',
  );
  if (choice !== 'keep') return skipOrDrop(ctx, choice, where, `regex using ${found.join(', ')}`);
  ctx.fidelity.push({ fidelity: 'partial', message: `Regex uses ${found.join(', ')}; not portable to every SDK.`, location: where });
  return undefined;
}

const ANCHOR: Partial<Record<string, 'full' | 'start' | 'end' | 'none'>> = { in: 'full', startsWith: 'start', endsWith: 'end', contains: 'none' };

function caseInsensitive(ctx: Ctx, c: NeutralClause, values: string[], where: string, path: string, subject: DecisionSubject): ValuesOutcome {
  const anchor = ANCHOR[c.op] ?? 'full';
  const choice = ctx.decisions.choose(
    {
      type: 'case_insensitive_match',
      severity: 'choice',
      subject,
      path,
      title: `Case-insensitive match (${c.op})`,
      explanation: `${sourceLabel(ctx)} compares “${c.attribute}” ignoring case: “${values[0]}” also matches “${values[0]!.toLowerCase()}”. LaunchDarkly's “${c.op}” is case-sensitive.`,
      sourceFragment: c,
      fingerprintOf: { op: c.op, attribute: c.attribute, values, negate: c.negate },
      options: [
        { key: 'regex', label: 'Case-folded regex', explanation: `Use LaunchDarkly “matches” with a pattern that accepts any casing, e.g. ${caseFoldedPattern(values[0]!, anchor)}. Exact, but harder to read and edit in LaunchDarkly.`, resultingFidelity: 'full' },
        { key: 'variants', label: 'Add lowercase and uppercase variants', explanation: `Keep “${c.op}” and add each value as written, lowercased and uppercased. Mixed casings like “${mixedCase(values[0]!)}” won't match.`, resultingFidelity: 'partial' },
        { key: 'exact', label: 'Keep exact values (case-sensitive)', explanation: `Only the exact casing in ${sourceLabel(ctx)} matches in LaunchDarkly.`, resultingFidelity: 'partial' },
        SKIP,
      ],
      recommended: 'regex',
    },
    'regex',
  );
  if (choice === 'skip') return skipOrDrop(ctx, choice, where, 'case-insensitive clause');
  if (choice === 'regex') return { kind: 'values', values: values.map((v) => caseFoldedPattern(v, anchor)), op: 'matches' };
  if (choice === 'variants') {
    ctx.fidelity.push({ fidelity: 'partial', message: `Case-insensitive “${c.op}” approximated with lower/upper variants.`, location: where });
    return { kind: 'values', values: unique(values.flatMap((v) => [v, v.toLowerCase(), v.toUpperCase()])), op: c.op as LdOperator };
  }
  ctx.fidelity.push({ fidelity: 'partial', message: `Case-insensitive “${c.op}” migrated as case-sensitive.`, location: where });
  return { kind: 'values', values, op: c.op as LdOperator };
}

function negatedMissing(ctx: Ctx, c: NeutralClause, where: string, path: string, subject: DecisionSubject): ClauseOutcome | undefined {
  const choice = ctx.decisions.choose(
    {
      type: 'negated_missing_attribute',
      severity: 'acknowledge',
      subject,
      path,
      title: `Contexts without “${c.attribute}” behave differently`,
      explanation: `${sourceLabel(ctx)} passes a negated condition for contexts that don't send “${c.attribute}”. In LaunchDarkly a clause on a missing attribute never matches, even when negated, so those contexts won't match this rule.`,
      sourceFragment: c,
      fingerprintOf: { op: c.op, attribute: c.attribute, contextKind: c.contextKind },
      options: [{ key: 'acknowledge', label: 'Acknowledge', explanation: 'Migrate as is. Contexts missing the attribute no longer match this rule.', resultingFidelity: 'partial' }, SKIP],
      recommended: 'acknowledge',
    },
    'acknowledge',
  );
  if (choice === 'skip') return skipOrDrop(ctx, choice, where, `negated clause on “${c.attribute}”`);
  ctx.fidelity.push({ fidelity: 'partial', message: `Contexts without “${c.attribute}” no longer match (negated clause on a missing attribute).`, location: where });
  return undefined;
}

function skipOrDrop(ctx: Ctx, choice: string, where: string, what: string): ClauseOutcome {
  if (choice === 'skip') throw new SkipItem(`${what} can't be written`);
  if (choice === 'drop_condition') {
    ctx.fidelity.push({ fidelity: 'partial', message: `Dropped the ${what} (the rule matches more contexts than in ${sourceLabel(ctx)}).`, location: where });
    return { kind: 'drop_condition' };
  }
  ctx.fidelity.push({ fidelity: 'partial', message: `Dropped the rule because of its ${what}.`, location: where });
  return { kind: 'drop_rule' };
}

/** A rollout in the target re-buckets: the new flag has its own salt (PLAN §20.3). */
function rebucket(ctx: Ctx, path: string, location: string, pct: string): 'acknowledge' | 'skip' {
  const choice = ctx.decisions.choose(
    {
      type: 'partial_rollout_rebucket',
      severity: 'acknowledge',
      subject: { ...ctx.subject, location },
      path,
      title: `${pct} rollout: contexts will be re-bucketed`,
      explanation: `LaunchDarkly buckets with a per-flag salt that cannot be copied, so the new flag assigns the same percentages to different contexts. Rollouts with a fixed seed keep their assignment only if the seed is copied, which the API does not allow.`,
      sourceFragment: { location, pct },
      fingerprintOf: { pct },
      options: [
        { key: 'acknowledge', label: 'Acknowledge: contexts will be re-bucketed', explanation: 'Migrate the rollout with the same weights.', resultingFidelity: 'partial' },
        { key: 'skip', label: 'Skip this item', explanation: 'Finish the rollout (0% or 100%) in the source first, then migrate.', resultingFidelity: 'skipped' },
      ],
      recommended: 'acknowledge',
    },
    'acknowledge',
  );
  return choice === 'skip' ? 'skip' : 'acknowledge';
}

const pctOf = (variations: { weight: number }[]) => variations.map((w) => `${w.weight / 1000}%`).join(' / ');

/** A rollout with one entry at 100% is a plain variation that remembers its bucketing kind (covered rules of group-targeted flags). */
const isFixedRollout = (s: NeutralServe | VariationOrRollout) => !!s.rollout && s.rollout.variations.length === 1 && s.rollout.variations[0]!.weight === 100_000;

function serveOf(ctx: Ctx, s: NeutralServe, variationCount: number, path: string, location: string): VariationOrRollout {
  if (s.rollout) {
    const pct = pctOf(s.rollout.variations);
    if (!isFixedRollout(s)) {
      if (rebucket(ctx, `${path}:rollout`, location, pct) === 'skip') throw new SkipItem(`waiting for the ${pct} rollout in ${location} to finish`);
      ctx.fidelity.push({ fidelity: 'partial', message: `${pct} rollout re-buckets contexts (new flag, new salt).`, location });
    }
    for (const w of s.rollout.variations) if (w.variation >= variationCount) throw new SkipItem(`${location} serves variation ${w.variation}, which the flag doesn't have`);
    return { rollout: { contextKind: resolveSourceKind(ctx, s.rollout.contextKind), ...(s.rollout.bucketBy ? { bucketBy: s.rollout.bucketBy } : {}), variations: s.rollout.variations.map((w) => ({ variation: w.variation, weight: w.weight })) } };
  }
  const v = s.variation ?? 0;
  if (v >= variationCount) throw new SkipItem(`${location} serves variation ${v}, which the flag doesn't have`);
  return { variation: v };
}

const variationName = (v: { value: unknown; name?: string }, i: number): string => v.name ?? (typeof v.value === 'boolean' || typeof v.value === 'number' ? String(v.value) : typeof v.value === 'string' ? v.value : `Variation ${i + 1}`);

export function mapNeutralFlag(args: MapArgs<NeutralFlag>): NeutralFlagMapResult {
  const { entity: original, env } = args;
  const ctx = makeCtx(args, 'flag');
  const alias = ctx.snapshot.source.alias;
  const tagMigrated = migratedFromTag(ctx.kind);
  const key = original.key;
  const sourceEnv = neutralEnvOf(original, env.statsig);
  // PostHog-style payloads and the synthetic "no match" variation reshape the variation list first (PLAN §22.3).
  const { flag, source } = prepareVariations(ctx, original, sourceEnv);
  const lastVariation = Math.max(0, flag.variations.length - 1);
  const offEnv: DesiredFlagEnv = { ldEnv: env.ld, statsigEnv: env.statsig, on: false, offVariation: flag.defaults?.offVariation ?? lastVariation, fallthrough: { variation: flag.defaults?.onVariation ?? 0 }, rules: [], targets: [], prerequisites: [] };
  const shell = flagShell(ctx, flag, alias, tagMigrated);
  const fp = fingerprint({
    variations: original.variations.map((v) => [v.value, v.payload ?? null]),
    env: sourceEnv ? { on: sourceEnv.on, offVariation: sourceEnv.offVariation, fallthrough: sourceEnv.fallthrough, rules: sourceEnv.rules, targets: sourceEnv.targets, prerequisites: sourceEnv.prerequisites } : null,
    caveats: original.caveats ?? null,
  });
  const version = sourceEnv?.version ?? flag.version;

  const finish = (desired: DesiredFlagEnv, skipped?: string): NeutralFlagMapResult => ({
    uid: flag.uid,
    entityId: flag.key,
    sourceId: ctx.sourceId,
    flagKey: key,
    flagKind: flag.flagKind,
    shell: version !== undefined ? { ...shell, customProperties: { ...shell.customProperties, ...provenanceProperties({ id: flag.key, version }, alias, 'flag', ctx.kind) } } : shell,
    env: desired,
    fidelity: report(ctx.fidelity, skipped),
    unresolved: ctx.decisions.unresolved,
    applied: ctx.decisions.applied,
    stale: ctx.decisions.stale,
    dependencies: [...ctx.deps.values()].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)),
    statsigFingerprint: fp,
    decisionSetHash: ctx.decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  });

  if (flag.archived) return finish(offEnv, `archived in ${sourceLabel(ctx)}`);
  if (flag.purpose && flag.purpose !== 'default') return finish(offEnv, `it is a ${flag.purpose} flag, which the console does not copy as a plain flag`);
  if (!source) return finish(offEnv, `no configuration in source environment “${env.statsig}”`);

  try {
    const desired = applyCaveats(ctx, flag, source, translateEnv(ctx, flag, source, env.ld));
    if (flag.deprecated) ctx.fidelity.push({ fidelity: 'full', message: `Deprecated in ${sourceLabel(ctx)}. Consider retiring it instead of migrating.` });
    if (flag.experiments.length && !source.rules.some((r) => r.experiment)) ctx.fidelity.push({ fidelity: 'partial', message: `${flag.experiments.length} experiment${flag.experiments.length === 1 ? '' : 's'} run${flag.experiments.length === 1 ? 's' : ''} on this flag in ${sourceLabel(ctx)} (${flag.experiments.join(', ')}); experiments are not migrated (PLAN §11).` });
    return finish(desired);
  } catch (e) {
    if (e instanceof SkipItem) return finish(offEnv, e.reason);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Variations: payloads and the synthetic "no match" variation (PLAN §22.3)
// ---------------------------------------------------------------------------------------------

/**
 * Decide the variation list before anything references its indexes: `variant_payloads` (what
 * the LD value is when the source served a key *and* a payload) and `multivariate_no_match` (the
 * variation the source's "no match" result becomes). Returns the flag and environment to map,
 * with indexes remapped when a variation went away.
 */
function prepareVariations(ctx: Ctx, flag: NeutralFlag, source: NeutralFlagEnv | undefined): { flag: NeutralFlag; source: NeutralFlagEnv | undefined } {
  let variations: NeutralVariation[] = flag.variations.map((v) => ({ ...v }));
  let flagKind = flag.flagKind;
  const withPayload = variations.filter((v) => v.payload !== undefined && !v.synthetic);
  if (withPayload.length) {
    const keys = withPayload.map((v) => (typeof v.value === 'string' ? `“${v.value}”` : String(v.value))).join(', ');
    const choice = ctx.decisions.choose(
      {
        type: 'variant_payloads',
        severity: 'blocking',
        subject: { ...ctx.subject, location: 'variations' },
        path: 'variant_payloads',
        title: `Variations ${keys} carry payloads: what should the LaunchDarkly value be?`,
        explanation: `${sourceLabel(ctx)} returns a variant key from the flag call and a separate payload from the payload call. A LaunchDarkly variation has one value, so code that reads one or the other has to be served accordingly.`,
        sourceFragment: Object.fromEntries(withPayload.map((v) => [String(v.value), v.payload])),
        fingerprintOf: withPayload.map((v) => [v.value, v.payload]),
        options: [
          { key: 'keys', label: 'Serve the variant keys (payloads noted, not served)', explanation: 'Code that switches on the flag value keeps working; code that read the payload must read it elsewhere. The payloads are kept in the fidelity notes.', resultingFidelity: 'partial' },
          { key: 'payloads', label: 'Serve the payloads as a JSON flag', explanation: 'Each variation’s value is its payload (the variant key becomes the variation name). Code that read the payload keeps working; code that compared the key must compare the payload instead.', resultingFidelity: 'partial' },
          { key: 'both', label: 'Serve { "variant": key, "payload": … } objects', explanation: 'A JSON flag whose values carry both. Every call site changes shape once, nothing is lost.', resultingFidelity: 'full' },
          SKIP,
        ],
      },
      'keys',
    );
    if (choice === 'skip') {
      // Mapped as skipped through the usual path: an impossible variation list.
      variations = [];
    } else if (choice === 'keys') {
      ctx.fidelity.push({ fidelity: 'partial', message: `Payloads not served: ${withPayload.map((v) => `${String(v.value)} → ${JSON.stringify(v.payload)}`).join('; ')}.`, location: 'variations' });
    } else {
      flagKind = 'multivariate';
      variations = variations.map((v) => {
        if (v.synthetic) return { ...v, value: null };
        const name = v.name ?? (typeof v.value === 'string' ? v.value : String(v.value));
        if (choice === 'payloads') return { ...v, name, value: v.payload === undefined ? (v.value === false ? null : v.value) : v.payload };
        return { ...v, name, value: { variant: v.value, ...(v.payload !== undefined ? { payload: v.payload } : {}) } };
      });
      ctx.fidelity.push({ fidelity: choice === 'both' ? 'full' : 'partial', message: choice === 'payloads' ? 'Variations serve the payloads as a JSON flag; the variant keys are the variation names.' : 'Variations serve { variant, payload } objects as a JSON flag.', location: 'variations' });
    }
  }

  const synthetic = variations.findIndex((v) => v.synthetic === 'no_match');
  let remap: ((i: number) => number) | undefined;
  if (synthetic >= 0 && variations.length > 1) {
    const real = variations.map((v, i) => ({ v, i })).filter((x) => !x.v.synthetic);
    const choice = ctx.decisions.choose(
      {
        type: 'multivariate_no_match',
        severity: 'choice',
        subject: { ...ctx.subject, location: 'variations' },
        path: 'no_match',
        title: `What to serve when no rule matches`,
        explanation: `${sourceLabel(ctx)} returns “false” (no variant) for a multivariate flag when no condition set matches and when the flag is off. A LaunchDarkly flag always serves one of its variations, so the console adds one for that case unless you pick an existing variant.`,
        sourceFragment: { variations: real.map((x) => x.v.value) },
        // Keyed on the source's variation values, so a payload choice does not stale this answer.
        fingerprintOf: flag.variations.filter((v) => !v.synthetic).map((v) => v.value),
        options: [
          { key: 'add', label: `Add a “${variations[synthetic]!.name ?? 'Not served'}” variation`, explanation: `Value ${JSON.stringify(variations[synthetic]!.value)}; served as the off variation and the default rule. Code that treated “false” as “no variant” checks for it instead.`, resultingFidelity: 'full' },
          ...real.map((x) => ({ key: `variant:${x.i}`, label: `Serve “${x.v.name ?? String(x.v.value)}” instead`, explanation: `Contexts that matched no condition set in ${sourceLabel(ctx)} get this variant in LaunchDarkly.`, resultingFidelity: 'partial' as const })),
        ],
        recommended: 'add',
      },
      'add',
    );
    const m = /^variant:(\d+)$/.exec(choice);
    if (m) {
      const target = Number(m[1]);
      variations = variations.filter((_, i) => i !== synthetic);
      remap = (i) => (i === synthetic ? (target > synthetic ? target - 1 : target) : i > synthetic ? i - 1 : i);
      ctx.fidelity.push({ fidelity: 'partial', message: `“No match” serves “${flag.variations[target]?.name ?? String(flag.variations[target]?.value)}” instead of nothing.`, location: 'variations' });
    }
  }

  const defaults = flag.defaults ? { onVariation: remap ? remap(flag.defaults.onVariation) : flag.defaults.onVariation, offVariation: remap ? remap(flag.defaults.offVariation) : flag.defaults.offVariation } : undefined;
  const out: NeutralFlag = { ...flag, variations, flagKind, ...(defaults ? { defaults } : {}) };
  if (!remap || !source) return { flag: out, source };
  const r = remap;
  const serve = (s: NeutralServe): NeutralServe => (s.rollout ? { rollout: { ...s.rollout, variations: mergeWeights(s.rollout.variations.map((w) => ({ variation: r(w.variation), weight: w.weight }))) } } : { variation: r(s.variation ?? 0) });
  const remapRules = (rules: NeutralRule[]): NeutralRule[] => rules.map((rule) => ({ ...rule, ...serve(rule), ...(rule.rollout ? {} : { rollout: undefined }) })).map(({ rollout, ...rule }) => (rollout ? { ...rule, rollout } : rule));
  const env: NeutralFlagEnv = {
    ...source,
    offVariation: r(source.offVariation),
    fallthrough: serve(source.fallthrough),
    rules: remapRules(source.rules),
    targets: source.targets.map((t) => ({ ...t, variation: r(t.variation) })),
    prerequisites: source.prerequisites,
  };
  // Rules a scheduled change appends point at the source's variation indexes too.
  const caveats = flag.caveats?.map((c) => (c.kind === 'scheduled_changes' ? { ...c, detail: { changes: c.detail.changes.map((ch) => (ch.rules ? { ...ch, rules: remapRules(ch.rules) } : ch)) } } : c));
  return { flag: caveats ? { ...out, caveats } : out, source: env };
}

/** Rollout entries that now point at the same variation are merged. */
function mergeWeights(ws: { variation: number; weight: number }[]): { variation: number; weight: number }[] {
  const out = new Map<number, number>();
  for (const w of ws) out.set(w.variation, (out.get(w.variation) ?? 0) + w.weight);
  return [...out.entries()].map(([variation, weight]) => ({ variation, weight }));
}

// ---------------------------------------------------------------------------------------------
// Environment targeting
// ---------------------------------------------------------------------------------------------

function translateEnv(ctx: Ctx, flag: NeutralFlag, source: NeutralFlagEnv, ldEnv: string): DesiredFlagEnv {
  const n = flag.variations.length;
  const rules: DesiredRule[] = [];
  let fallthrough: VariationOrRollout = serveOf(ctx, source.fallthrough, n, 'fallthrough', 'default rule');
  const active = source.rules.filter((r) => !r.disabled);
  const hoisted: { rule: NeutralRule; prerequisites: NeutralPrerequisite[] }[] = [];
  rules: for (const [i, r] of source.rules.entries()) {
    const ruleId = r.id ?? `#${i}`;
    const ruleName = r.description || `rule ${i + 1}`;
    const location = `rule “${ruleName}”`;
    if (r.disabled) {
      ctx.fidelity.push({ fidelity: 'full', message: `Rule “${ruleName}” is disabled in ${sourceLabel(ctx)} (not evaluated) and was not copied.`, location });
      continue;
    }
    const clauses: LdClause[] = [];
    let dropRule = false;
    for (const [k, c] of r.clauses.entries()) {
      const out = translateClause(ctx, c, { ruleId, ruleName, index: k }, source.env, false);
      if (out.kind === 'clause') clauses.push(out.clause);
      else if (out.kind === 'clauses') clauses.push(...out.clauses);
      else if (out.kind === 'drop_rule') {
        dropRule = true;
        break;
      }
    }
    if (dropRule) continue;
    let serve = serveOf(ctx, experimentServe(ctx, r, location), n, `rule:${ruleId}`, location);
    if (r.trackEvents) ctx.fidelity.push({ fidelity: 'full', message: `Rule “${ruleName}” tracks evaluation events in ${sourceLabel(ctx)} (experimentation); event tracking is not copied.`, location });

    // Coverage (PLAN §21.4): the source sends the uncovered share to the *next* rule.
    const later = active.slice(active.indexOf(r) + 1);
    if (r.coverage !== undefined && r.coverage < 1) {
      const rest = coverageRest(ctx, r, later, source, flag, ruleId, location);
      if (rest === undefined) continue; // rule dropped
      serve = withCoverage(ctx, serve, r.coverage, rest, n, ruleId, location);
    }
    if (r.prerequisites?.length) hoisted.push({ rule: r, prerequisites: r.prerequisites });

    if (clauses.length === 0) {
      // Every clause was dropped (or the source rule matched everyone): it becomes the default rule.
      fallthrough = serve;
      if (later.length > 0 && !(r.coverage !== undefined && r.coverage < 1)) ctx.fidelity.push({ fidelity: 'partial', message: `Rule “${ruleName}” now matches everyone; the ${later.length} rule${later.length === 1 ? '' : 's'} after it can never match and ${later.length === 1 ? 'is' : 'are'} dropped.`, location });
      break rules;
    }
    rules.push({ description: r.description, clauses, ...serve });
  }
  if (source.trackEvents) ctx.fidelity.push({ fidelity: 'full', message: `Event tracking for the default rule is on in ${sourceLabel(ctx)}; not copied.` });

  const targets: DesiredTarget[] = source.targets
    .map((t) => {
      if (t.variation >= n) throw new SkipItem(`individual targets serve variation ${t.variation}, which the flag doesn't have`);
      return { contextKind: resolveSourceKind(ctx, t.contextKind), variation: t.variation, values: [...t.values] };
    })
    .sort((a, b) => `${a.contextKind}|${a.variation}`.localeCompare(`${b.contextKind}|${b.variation}`));

  const rulePrereqs = rulePrerequisites(ctx, hoisted, active, source);
  const prerequisites = translatePrerequisites(ctx, { ...source, prerequisites: [...source.prerequisites, ...rulePrereqs] }, source.env);
  if (source.offVariation >= n) throw new SkipItem(`the off variation is ${source.offVariation}, which the flag doesn't have`);
  return { ldEnv, statsigEnv: source.env, on: source.on, offVariation: source.offVariation, fallthrough, rules: dedupeRuleDescriptions(rules, ctx.fidelity), targets, prerequisites };
}

/** A rule that is a running experiment's allocation (PLAN §21.3 `experiment_rule`). */
function experimentServe(ctx: Ctx, r: NeutralRule, location: string): NeutralServe {
  if (!r.experiment) return r;
  const control = r.rollout?.variations[0]?.variation ?? r.variation ?? 0;
  const choice = ctx.decisions.choose(
    {
      type: 'experiment_rule',
      severity: 'choice',
      subject: { ...ctx.subject, location },
      path: `rule:${r.id ?? r.description}:experiment`,
      title: `Rule “${r.description}” allocates experiment “${r.experiment.key}”`,
      explanation: `Experiments end in ${sourceLabel(ctx)} and start new in LaunchDarkly (PLAN §11). The rule's weights can migrate as a plain rollout, the control variation can be served as if the experiment had concluded, or the flag can wait until the experiment is stopped.`,
      sourceFragment: { experiment: r.experiment, rollout: r.rollout ?? null, variation: r.variation ?? null },
      fingerprintOf: { experiment: r.experiment.key, weights: r.rollout?.variations ?? null },
      options: [
        { key: 'freeze', label: 'Freeze the current split as a rollout', explanation: 'Same weights, no experiment analysis in LaunchDarkly. Sticky assignments are not reproduced.', resultingFidelity: 'partial' },
        { key: 'control', label: 'Serve the control variation', explanation: 'As if the experiment had concluded with no winner.', resultingFidelity: 'partial' },
        SKIP,
      ],
      recommended: 'freeze',
    },
    'freeze',
  );
  if (choice === 'skip') throw new SkipItem(`experiment “${r.experiment.key}” is running on ${location}`);
  if (choice === 'control') {
    ctx.fidelity.push({ fidelity: 'partial', message: `Experiment “${r.experiment.key}” on ${location} replaced by its control variation.`, location });
    return { variation: control };
  }
  ctx.fidelity.push({ fidelity: 'partial', message: `Experiment “${r.experiment.key}” on ${location} frozen as a plain rollout; analysis stays in ${sourceLabel(ctx)}.`, location });
  return r.rollout ? { rollout: r.rollout } : { variation: r.variation ?? 0 };
}

/**
 * What the uncovered share of a covered rule should get. Lossless when nothing after the rule
 * could serve anything else (the rule is last, or every later rule and the default rule serve one
 * same variation); otherwise `rollout_coverage` (PLAN §21.3). Undefined = drop the rule.
 */
function coverageRest(ctx: Ctx, r: NeutralRule, later: NeutralRule[], source: NeutralFlagEnv, flag: NeutralFlag, ruleId: string, location: string): number | undefined {
  const fixed = (s: NeutralServe): number | undefined => (s.rollout ? (s.rollout.variations.length === 1 ? s.rollout.variations[0]!.variation : undefined) : (s.variation ?? 0));
  const fallthrough = fixed(source.fallthrough);
  const same = fallthrough !== undefined && later.every((l) => fixed(l) === fallthrough && (l.coverage === undefined || l.coverage >= 1) && !l.prerequisites?.length);
  if (same) return fallthrough;
  const pct = `${Math.round(r.coverage! * 10000) / 100}%`;
  const options: DecisionOption[] = [
    ...(fallthrough !== undefined ? [{ key: 'fallthrough', label: `Uncovered contexts get the default rule's value (“${variationName(flag.variations[fallthrough] ?? { value: fallthrough }, fallthrough)}”)`, explanation: `In ${sourceLabel(ctx)} the ${100 - Math.round(r.coverage! * 100)}% outside this rule's rollout continue to the later rules, which may serve something else. In LaunchDarkly a rollout assigns every matched context, so they get the default rule's value instead.`, resultingFidelity: 'partial' as const }] : []),
    DROP_RULE,
    SKIP,
  ];
  const choice = ctx.decisions.choose(
    {
      type: 'rollout_coverage',
      severity: 'choice',
      subject: { ...ctx.subject, location },
      path: `rule:${ruleId}:coverage`,
      title: `${pct} rollout on “${r.description}” sends the rest to the next rules`,
      explanation: `${sourceLabel(ctx)} evaluates the ${later.length} later rule${later.length === 1 ? '' : 's'} for contexts outside the ${pct}; a LaunchDarkly rollout cannot continue to the next rule.`,
      sourceFragment: { coverage: r.coverage, later: later.map((l) => l.description) },
      fingerprintOf: { coverage: r.coverage, later: later.map((l) => [l.description, l.variation ?? null, l.rollout?.variations ?? null]) },
      options,
      ...(fallthrough !== undefined ? { recommended: 'fallthrough' } : {}),
    },
    fallthrough !== undefined ? 'fallthrough' : 'drop_rule',
  );
  if (choice === 'skip') throw new SkipItem(`the ${pct} rollout on ${location} cannot continue to the later rules`);
  if (choice === 'drop_rule') {
    ctx.fidelity.push({ fidelity: 'partial', message: `Dropped the rule: its ${pct} rollout cannot continue to the later rules.`, location });
    return undefined;
  }
  ctx.fidelity.push({ fidelity: 'partial', message: `Contexts outside the ${pct} rollout get the default rule's value instead of the later rules.`, location });
  return fallthrough!;
}

/** `coverage` of the matched contexts get `serve` (scaled); the rest get variation `rest`. */
function withCoverage(ctx: Ctx, serve: VariationOrRollout, coverage: number, rest: number, n: number, ruleId: string, location: string): VariationOrRollout {
  if (rest >= n) throw new SkipItem(`${location} falls back to variation ${rest}, which the flag doesn't have`);
  const share = Math.round(coverage * 100_000);
  const parts = serve.rollout ? serve.rollout.variations.map((w) => ({ variation: w.variation, weight: Math.round((w.weight * share) / 100_000) })) : [{ variation: serve.variation ?? 0, weight: share }];
  const used = parts.reduce((s, w) => s + w.weight, 0);
  parts.push({ variation: rest, weight: 100_000 - used });
  const variations = mergeWeights(parts).filter((w) => w.weight > 0);
  const pct = pctOf(variations);
  if (!serve.rollout || isFixedRollout(serve)) {
    // A plain variation became a rollout: it re-buckets too.
    if (rebucket(ctx, `rule:${ruleId}:coverage:rollout`, location, pct) === 'skip') throw new SkipItem(`waiting for the ${pct} rollout in ${location} to finish`);
    ctx.fidelity.push({ fidelity: 'partial', message: `${pct} rollout re-buckets contexts (new flag, new salt).`, location });
  }
  const base: LdRollout = serve.rollout ?? { contextKind: 'user', variations: [] };
  return { rollout: { ...base, variations } };
}

/**
 * Rule-level prerequisites (PLAN §22.3 `rule_prerequisite`). LD prerequisites are flag-level:
 * hoisting is lossless when every rule carries the same ones and the default rule serves the off
 * variation (a failed prerequisite then yields the off variation either way).
 */
function rulePrerequisites(ctx: Ctx, hoisted: { rule: NeutralRule; prerequisites: NeutralPrerequisite[] }[], active: NeutralRule[], source: NeutralFlagEnv): NeutralPrerequisite[] {
  if (!hoisted.length) return [];
  const keyOf = (ps: NeutralPrerequisite[]) => ps.map((p) => `${p.key}:${p.variation}`).sort().join(',');
  const first = keyOf(hoisted[0]!.prerequisites);
  const uniform = hoisted.length === active.length && hoisted.every((h) => keyOf(h.prerequisites) === first) && !source.fallthrough.rollout && (source.fallthrough.variation ?? 0) === source.offVariation;
  const out = new Map<string, NeutralPrerequisite>();
  if (uniform) {
    for (const p of hoisted[0]!.prerequisites) out.set(`${p.key}:${p.variation}`, p);
    ctx.fidelity.push({ fidelity: 'full', message: `Dependency on ${[...out.values()].map((p) => `“${p.key}”`).join(', ')} hoisted to a flag prerequisite (every rule required it, so this is exact).`, location: 'prerequisites' });
    return [...out.values()];
  }
  for (const h of hoisted) {
    const names = h.prerequisites.map((p) => `“${p.key}”`).join(', ');
    const location = `rule “${h.rule.description}”`;
    const choice = ctx.decisions.choose(
      {
        type: 'rule_prerequisite',
        severity: 'choice',
        subject: { ...ctx.subject, location },
        path: `rule:${h.rule.id ?? h.rule.description}:prerequisite`,
        title: `Rule “${h.rule.description}” depends on flag ${names}`,
        explanation: `${sourceLabel(ctx)} checks ${names} for this rule only; LaunchDarkly prerequisites apply to the whole flag. Hoisting gates every rule on it; otherwise the dependency is dropped with the rule.`,
        sourceFragment: h.prerequisites,
        fingerprintOf: { rule: h.rule.description, prerequisites: h.prerequisites },
        options: [
          { key: 'hoist', label: `Make ${names} a prerequisite of the whole flag`, explanation: `Every rule, not just this one, serves the off variation until ${names} passes.`, resultingFidelity: 'partial' },
          DROP_RULE,
          SKIP,
        ],
        recommended: 'hoist',
      },
      'hoist',
    );
    if (choice === 'skip') throw new SkipItem(`the dependency of ${location} on ${names} cannot be written for one rule`);
    if (choice === 'drop_rule') {
      ctx.fidelity.push({ fidelity: 'partial', message: `Rule-level dependency on ${names} not carried; the rule is kept without it.`, location });
      continue;
    }
    ctx.fidelity.push({ fidelity: 'partial', message: `Dependency on ${names} hoisted from ${location} to the whole flag.`, location });
    for (const p of h.prerequisites) out.set(`${p.key}:${p.variation}`, p);
  }
  return [...out.values()];
}

function translatePrerequisites(ctx: Ctx, source: NeutralFlagEnv, env: string): DesiredFlagEnv['prerequisites'] {
  if (!source.prerequisites.length) return [];
  const caps = ctx.args.capabilities.prerequisites;
  const names = source.prerequisites.map((p) => `“${p.key}”`).join(', ');
  if (caps === 'unavailable' || caps === 'not_permitted') {
    const choice = ctx.decisions.choose(
      {
        type: 'prerequisite_unsupported',
        severity: 'blocking',
        subject: { ...ctx.subject, location: 'prerequisites' },
        path: 'prerequisites',
        title: `Prerequisites ${names} can't be written to the target`,
        explanation: caps === 'not_permitted' ? 'The target token may not set prerequisites.' : 'The target plan has no flag prerequisites (Enterprise).',
        sourceFragment: source.prerequisites,
        options: [
          { key: 'drop_prerequisites', label: 'Migrate without prerequisites', explanation: `The flag serves its rules without first checking ${names}; contexts that fail the prerequisite in ${sourceLabel(ctx)} may get the feature.`, resultingFidelity: 'partial' },
          SKIP,
        ],
      },
      'drop_prerequisites',
    );
    if (choice === 'skip') throw new SkipItem(`prerequisites ${names} can't be written`);
    ctx.fidelity.push({ fidelity: 'partial', message: `Prerequisites ${names} dropped (not available in the target).`, location: 'prerequisites' });
    return [];
  }
  const out: DesiredFlagEnv['prerequisites'] = [];
  for (const p of source.prerequisites) {
    const ref = neutralFlagByKey(ctx.snapshot).get(p.key);
    if (!ref || ref.archived || !neutralEnvOf(ref, env)) {
      const choice = ctx.decisions.choose(
        {
          type: 'missing_reference',
          severity: 'blocking',
          subject: { ...ctx.subject, location: `prerequisite “${p.key}”` },
          path: `prerequisite:${p.key}`,
          title: `Prerequisite flag “${p.key}” is not in ${sourceLabel(ctx)}`,
          explanation: ref?.archived ? `“${p.key}” is archived in ${sourceLabel(ctx)}, so it cannot be migrated as a prerequisite.` : `“${p.key}” is not in the snapshot (deleted, or not readable with this token).`,
          sourceFragment: p,
          options: [{ key: 'drop_prerequisite', label: `Drop the prerequisite on “${p.key}”`, explanation: 'The flag serves its rules without checking it.', resultingFidelity: 'partial' }, SKIP],
        },
        'drop_prerequisite',
      );
      if (choice === 'skip') throw new SkipItem(`prerequisite “${p.key}” is missing`);
      ctx.fidelity.push({ fidelity: 'partial', message: `Prerequisite “${p.key}” dropped (${ref?.archived ? 'archived' : 'missing'} in ${sourceLabel(ctx)}).`, location: `prerequisite “${p.key}”` });
      continue;
    }
    // The parent's variation list may itself be reshaped by its own decisions; indexes here are the source's.
    if (p.variation >= ref.variations.length) throw new SkipItem(`prerequisite “${p.key}” requires variation ${p.variation}, which that flag doesn't have`);
    ctx.deps.set(`flag:${p.key}`, { kind: 'flag', key: p.key, entityId: p.key });
    out.push({ key: p.key, variation: p.variation });
  }
  if (out.length && caps === 'unknown') ctx.fidelity.push({ fidelity: 'full', message: `Prerequisites need an Enterprise plan; the target's plan is checked on the first write.`, location: 'prerequisites' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Caveats (PLAN §22.3): source facts LD has no field for
// ---------------------------------------------------------------------------------------------

function applyCaveats(ctx: Ctx, flag: NeutralFlag, source: NeutralFlagEnv, desired: DesiredFlagEnv): DesiredFlagEnv {
  let out = desired;
  // Device bucketing rewrites every rollout; the scheduled states built below get the same rewrite.
  let rewrite: (s: VariationOrRollout) => VariationOrRollout = (s) => s;
  const caveats = flag.caveats ?? [];
  for (const c of caveats) {
    switch (c.kind) {
      case 'experience_continuity':
        acknowledge(ctx, 'experience_continuity', 'continuity', `Assignments persist across login in ${sourceLabel(ctx)}`, `${sourceLabel(ctx)} keeps the value a person saw before logging in once they are identified. LaunchDarkly evaluates the context it is given, so a person who logs in may be bucketed differently unless the application keeps the anonymous context in a multi-context.`, c, 'Migrate; the application decides whether to carry the anonymous context after login.', 'Persisted assignments across login are not reproduced.');
        break;
      case 'early_access_enrollment': {
        const d = c.detail;
        const feature = d.name ? `early-access feature “${d.name}”${d.stage ? ` (${d.stage})` : ''}` : `early-access feature${d.stage ? ` (stage: ${d.stage})` : ''}`;
        const about = [d.description ? `“${d.description}”` : '', d.documentationUrl ? `docs: ${d.documentationUrl}` : ''].filter(Boolean).join('; ');
        acknowledge(
          ctx,
          'early_access_enrollment',
          'early_access',
          d.name ? `Early-access feature “${d.name}”: opt-in through “${d.attribute}”` : `Early-access opt-in through “${d.attribute}”`,
          `Opted-in people get the ${feature} in ${sourceLabel(ctx)} through the “${d.attribute}” person property, which its early-access UI sets${about ? ` (${about})` : ''}. The rules migrate; LaunchDarkly has no opt-in UI, so the application must set that attribute on the context itself.${d.name || d.stage ? ` The feature's name and stage are kept on the flag as the custom property “${EARLY_ACCESS_PROPERTY}”.` : ''}`,
          c,
          'Migrate the opt-in and opt-out rules on the attribute.',
          `Early-access enrollment${d.name ? ` in “${d.name}”` : ''} relies on the application sending “${d.attribute}”.`,
        );
        break;
      }
      case 'device_bucketing': {
        const r = deviceBucketing(ctx, c, out);
        out = r.desired;
        rewrite = r.rewrite;
        break;
      }
      case 'evaluation_contexts':
        ctx.fidelity.push({ fidelity: 'partial', message: `Evaluates only for requests tagged ${c.detail.contexts.join(', ')} in ${sourceLabel(ctx)}; LaunchDarkly has no per-request evaluation contexts (kept as a custom property).`, location: 'flag settings' });
        break;
      case 'encrypted_payload':
        encryptedPayload(ctx, c);
        break;
      case 'holdout':
        holdout(ctx, c);
        break;
      case 'scheduled_changes':
        // Below, once every other caveat has shaped the targeting the scheduled states build on.
        break;
      case 'unsalted_rollout':
        ctx.fidelity.push({ fidelity: 'full', message: `${sourceLabel(ctx)} hashes rollouts without a per-flag salt (the same contexts fall into equal percentages across flags); LaunchDarkly salts per flag, so that correlation is not carried.`, location: 'rollouts' });
        break;
      case 'remote_config':
        ctx.fidelity.push({ fidelity: 'full', message: `Remote-config flag: one static payload served to everyone, as a JSON flag with no rules.`, location: 'flag settings' });
        break;
      case 'multi_id_members':
      case 'frozen_membership':
      case 'membership_unreadable':
        break;
    }
  }
  for (const c of caveats) if (c.kind === 'scheduled_changes') out = scheduledChanges(ctx, c, flag, source, out, rewrite);
  return out;
}

function acknowledge(ctx: Ctx, type: 'experience_continuity' | 'early_access_enrollment', path: string, title: string, explanation: string, fragment: NeutralCaveat, ackText: string, note: string): void {
  const choice = ctx.decisions.choose(
    {
      type,
      severity: 'acknowledge',
      subject: { ...ctx.subject, location: 'flag settings' },
      path,
      title,
      explanation,
      sourceFragment: fragment,
      options: [{ key: 'acknowledge', label: 'Acknowledge', explanation: ackText, resultingFidelity: 'partial' }, SKIP],
      recommended: 'acknowledge',
    },
    'acknowledge',
  );
  if (choice === 'skip') throw new SkipItem(title.toLowerCase());
  ctx.fidelity.push({ fidelity: 'partial', message: note, location: 'flag settings' });
}

function deviceBucketing(ctx: Ctx, c: Extract<NeutralCaveat, { kind: 'device_bucketing' }>, desired: DesiredFlagEnv): { desired: DesiredFlagEnv; rewrite: (s: VariationOrRollout) => VariationOrRollout } {
  const choice = ctx.decisions.choose(
    {
      type: 'device_bucketing',
      severity: 'choice',
      subject: { ...ctx.subject, location: 'rollouts' },
      path: 'device_bucketing',
      title: `Rollouts bucket by device (“${c.detail.attribute}”), not by user`,
      explanation: `${sourceLabel(ctx)} assigns this flag's percentages by “${c.detail.attribute}”, so anonymous visitors keep their assignment on one device. LaunchDarkly buckets by the context key unless told otherwise.`,
      sourceFragment: c,
      options: [
        { key: 'device_kind', label: 'Bucket by a “device” context kind', explanation: 'Rollouts use the device context; the application must send a device context whose key is the device id.', resultingFidelity: 'partial' },
        { key: 'user_attribute', label: `Bucket by the user attribute “${c.detail.attribute}”`, explanation: `Rollouts use bucketBy “${c.detail.attribute}” on the user context; the application must send it as a user attribute.`, resultingFidelity: 'partial' },
        { key: 'keep', label: 'Bucket by the user key', explanation: 'Anonymous visitors may change assignment when they log in.', resultingFidelity: 'partial' },
        SKIP,
      ],
      recommended: 'device_kind',
    },
    'device_kind',
  );
  if (choice === 'skip') throw new SkipItem('it buckets by device id');
  const rewrite = (s: VariationOrRollout): VariationOrRollout => {
    if (!s.rollout) return s;
    if (choice === 'device_kind') return { rollout: { ...s.rollout, contextKind: resolveSourceKind(ctx, 'device') } };
    if (choice === 'user_attribute') return { rollout: { ...s.rollout, bucketBy: c.detail.attribute } };
    return s;
  };
  ctx.fidelity.push({ fidelity: 'partial', message: choice === 'keep' ? `Device bucketing not carried: rollouts bucket by the user key.` : choice === 'device_kind' ? `Rollouts bucket by the “device” context kind (the application must send it).` : `Rollouts bucket by the user attribute “${c.detail.attribute}”.`, location: 'rollouts' });
  return { desired: { ...desired, fallthrough: rewrite(desired.fallthrough), rules: desired.rules.map((r) => ({ ...r, ...rewrite(r) })) }, rewrite };
}

function encryptedPayload(ctx: Ctx, c: Extract<NeutralCaveat, { kind: 'encrypted_payload' }>): void {
  const readable = c.detail.readable;
  const choice = ctx.decisions.choose(
    {
      type: 'encrypted_payload',
      severity: readable ? 'acknowledge' : 'blocking',
      subject: { ...ctx.subject, location: 'variations' },
      path: 'encrypted_payload',
      title: readable ? 'The payload is stored encrypted in PostHog' : 'The encrypted payload could not be read',
      explanation: readable ? 'PostHog keeps this payload encrypted at rest and decrypts it for authorized readers. LaunchDarkly flag variations are stored and served in plain text.' : 'The key used to read the source returns encrypted payloads redacted (a personal API key decrypts them). The flag cannot carry its payload.',
      sourceFragment: c,
      options: readable
        ? [{ key: 'acknowledge', label: 'Migrate the payload in plain text', explanation: 'Anyone who can read the LaunchDarkly flag can read it.', resultingFidelity: 'partial' }, SKIP]
        : [{ key: 'without_payload', label: 'Migrate without the payload', explanation: 'The variation value is null; set it by hand in LaunchDarkly.', resultingFidelity: 'manual' }, SKIP],
      ...(readable ? { recommended: 'acknowledge' } : {}),
    },
    readable ? 'acknowledge' : 'without_payload',
  );
  if (choice === 'skip') throw new SkipItem('its payload is encrypted in the source');
  ctx.fidelity.push(readable ? { fidelity: 'partial', message: 'Payload stored in plain text in LaunchDarkly (encrypted in the source).', location: 'variations' } : { fidelity: 'manual', message: 'Encrypted payload not readable with this key; set the variation value by hand.', location: 'variations' });
}

function holdout(ctx: Ctx, c: Extract<NeutralCaveat, { kind: 'holdout' }>): void {
  const pct = c.detail.percentage;
  const choice = ctx.decisions.choose(
    {
      type: 'holdout_attached',
      severity: 'acknowledge',
      subject: { ...ctx.subject, location: `holdout “${c.detail.id}”` },
      path: `holdout:${c.detail.id}`,
      title: `Holdout “${c.detail.id}” holds ${pct}% of contexts out of this flag`,
      explanation: `${sourceLabel(ctx)} excludes ${pct}% of contexts from this flag before its rules run. The console does not write holdouts; the flag migrates without it.`,
      sourceFragment: c,
      fingerprintOf: { holdoutId: c.detail.id, percentage: pct },
      options: [
        { key: 'acknowledge', label: 'Migrate without the holdout', explanation: `The ${pct}% held out in ${sourceLabel(ctx)} get the feature in LaunchDarkly once the flag serves it to them.`, resultingFidelity: 'partial' },
        { key: 'skip', label: `Keep the flag in ${sourceLabel(ctx)} until the holdout ends`, explanation: 'Skip this item for now and migrate the flag after the holdout is removed.', resultingFidelity: 'skipped' },
      ],
      recommended: 'acknowledge',
    },
    'acknowledge',
  );
  if (choice === 'skip') throw new SkipItem(`holdout “${c.detail.id}” is attached`);
  ctx.fidelity.push({ fidelity: 'partial', message: `Holdout “${c.detail.id}” (${pct}%) not carried.`, location: `holdout “${c.detail.id}”` });
}

const isoOf = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const noteKey = (n: FidelityNote) => `${n.fidelity}|${n.location ?? ''}|${n.message}`;

/**
 * Pending scheduled changes (PLAN §22.3 `scheduled_rule`). A one-off status flip or added
 * condition set still in the future can become an LD scheduled change (Enterprise), like a StatSig
 * time condition (schedule.ts): each one carries the flag's *whole* targeting as of that moment,
 * cumulative over the earlier changes, so the flag converges on the same state whether LD applies
 * the change or a later sync writes it directly. Recurring schedules, changes already due, variant
 * changes and payloads the adapter could not read stay in the source and are noted.
 */
function scheduledChanges(ctx: Ctx, c: Extract<NeutralCaveat, { kind: 'scheduled_changes' }>, flag: NeutralFlag, source: NeutralFlagEnv, desired: DesiredFlagEnv, rewrite: (s: VariationOrRollout) => VariationOrRollout): DesiredFlagEnv {
  const nowMs = Date.parse(ctx.args.now);
  const changes = c.detail.changes;
  const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;
  /** "scheduled change" / "3 scheduled changes": the count only when there are several. */
  const some = (k: number, word: string) => (k === 1 ? word : `${k} ${word}s`);
  const describe = (x: NeutralScheduledChange) => `${x.operation} at ${x.at || 'an unknown time'}${x.recurring ? ' (recurring)' : ''}`;
  /** Why a change cannot be an LD scheduled change; undefined when it can. */
  const blocker = (x: NeutralScheduledChange): string | undefined => {
    if (x.recurring) return 'recurring schedules are not LaunchDarkly scheduled changes';
    if (x.on === undefined && !x.rules?.length) return x.variants ? 'variant changes are not carried' : 'the change could not be translated';
    const t = Date.parse(x.at);
    if (!Number.isFinite(t)) return 'it has no date';
    if (t <= nowMs) return 'it is already due';
    return undefined;
  };
  // Earliest first: the states below are cumulative, and the option lists them in that order.
  const schedulable = changes.filter((x) => !blocker(x)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const noted = changes.filter((x) => blocker(x));
  const list = changes.map(describe).join('; ');
  const notedList = noted.map((x) => `${describe(x)}: ${blocker(x)}`).join('; ');
  const sc = ctx.args.capabilities.scheduledChanges ?? 'unknown';
  const canSchedule = schedulable.length > 0 && sc !== 'unavailable' && sc !== 'not_permitted';
  const why = sc === 'unavailable' ? ' (the target plan has no scheduled changes)' : sc === 'not_permitted' ? ' (the target token may not create scheduled changes)' : '';
  const options: DecisionOption[] = [
    ...(canSchedule
      ? [
          {
            key: 'schedule',
            label: 'Create them as LaunchDarkly scheduled changes',
            explanation: `${plural(schedulable.length, 'change')} (${schedulable.map(describe).join('; ')}) become${schedulable.length === 1 ? 's' : ''} LaunchDarkly scheduled changes, each carrying the flag's whole targeting as of that moment, so the flag converges on the same state however it gets there. Enterprise plans${sc === 'unknown' ? '; your plan is checked on the first write' : ''}.${noted.length ? ` The other ${plural(noted.length, 'change')} (${notedList}) stay${noted.length === 1 ? 's' : ''} in ${sourceLabel(ctx)} and ${noted.length === 1 ? 'is' : 'are'} noted.` : ''}`,
            resultingFidelity: noted.length ? ('partial' as const) : ('full' as const),
          },
        ]
      : []),
    { key: 'acknowledge', label: 'Migrate the current state only', explanation: `The pending changes stay in ${sourceLabel(ctx)}.`, resultingFidelity: 'partial' },
    SKIP,
  ];
  const choice = ctx.decisions.choose(
    {
      type: 'scheduled_rule',
      severity: canSchedule ? 'choice' : 'acknowledge',
      subject: { ...ctx.subject, location: 'scheduled changes' },
      path: 'scheduled_changes',
      title: `${plural(changes.length, 'pending scheduled change')} in ${sourceLabel(ctx)}`,
      explanation: canSchedule
        ? `${list}. LaunchDarkly scheduled changes (Enterprise) can apply ${schedulable.length === changes.length ? (changes.length === 1 ? 'it' : 'them') : `${schedulable.length} of them`} at the same moment; otherwise the console migrates the flag's current state and the changes stay in ${sourceLabel(ctx)} until the cutover.`
        : `${list}. The console migrates the flag's current state; the scheduled changes are not carried into LaunchDarkly${why} (set them up as LaunchDarkly scheduled changes, or keep them in ${sourceLabel(ctx)} until the cutover).`,
      sourceFragment: c,
      fingerprintOf: { changes, canSchedule },
      options,
      recommended: canSchedule ? 'schedule' : 'acknowledge',
    },
    canSchedule ? 'schedule' : 'acknowledge',
  );
  if (choice === 'skip') throw new SkipItem('it has pending scheduled changes');
  if (choice !== 'schedule' || !canSchedule) {
    ctx.fidelity.push({ fidelity: 'partial', message: `Pending ${some(changes.length, 'scheduled change')} not carried: ${list}.`, location: 'scheduled changes' });
    return desired;
  }

  // Cumulative states, earliest first: a flip changes `on`, an added set appends its rules.
  let on = source.on;
  let rules = source.rules;
  const seen = new Set(ctx.fidelity.map(noteKey));
  const out: DesiredScheduledChange[] = [];
  for (const ch of schedulable) {
    const when = isoOf(Date.parse(ch.at));
    if (ch.on !== undefined) on = ch.on;
    if (ch.rules?.length) rules = [...rules, ...ch.rules];
    // The decision collector is shared (the same ids dedupe, so a clause of an added set raises
    // its decision once and is answered once); the notes are a throwaway list, from which only
    // what the current state did not already say is kept, against the change's date.
    const inner: Ctx = { ...ctx, fidelity: [] };
    const env = translateEnv(inner, flag, { ...source, on, rules }, desired.ldEnv);
    for (const n of inner.fidelity) {
      if (seen.has(noteKey(n))) continue;
      seen.add(noteKey(n));
      ctx.fidelity.push({ ...n, location: `${n.location ?? 'targeting'} (scheduled ${when})` });
    }
    const what = [ch.on !== undefined ? `turn ${ch.on ? 'on' : 'off'}` : '', ch.rules?.length ? `add ${plural(ch.rules.length, 'rule')}` : ''].filter(Boolean).join(' and ');
    out.push({
      executionDate: when,
      description: `PostHog scheduled change: ${what} at ${when}`,
      state: { on: env.on, offVariation: env.offVariation, fallthrough: rewrite(env.fallthrough), rules: env.rules.map((r) => ({ ...r, ...rewrite(r) })), targets: env.targets, prerequisites: env.prerequisites },
    });
  }
  ctx.fidelity.push({ fidelity: 'full', message: `${plural(out.length, 'LaunchDarkly scheduled change')} (${out.map((x) => x.executionDate).join(', ')}) appl${out.length === 1 ? 'ies' : 'y'} the pending ${sourceLabel(ctx)} ${out.length === 1 ? 'change' : 'changes'} at ${out.length === 1 ? 'its' : 'their'} time${sc === 'unknown' ? '; scheduled changes need an Enterprise plan, checked on the first write' : ''}.`, location: 'scheduled changes' });
  if (noted.length) ctx.fidelity.push({ fidelity: 'partial', message: `Pending ${some(noted.length, 'scheduled change')} not carried: ${notedList}.`, location: 'scheduled changes' });
  return { ...desired, scheduledChanges: out };
}

// ---------------------------------------------------------------------------------------------

function flagShell(ctx: Ctx, flag: NeutralFlag, alias: string, tagMigrated: string): DesiredFlagShell {
  const ownTags = flag.tags.filter((t) => !PROVENANCE_TAG_RE.test(t));
  const stripped = flag.tags.length - ownTags.length;
  if (stripped) ctx.fidelity.push({ fidelity: 'full', message: `${stripped} provenance tag${stripped === 1 ? '' : 's'} from an earlier migration into ${sourceLabel(ctx)} not copied.` });
  const renamed = ownTags.filter((t) => sanitizeTag(t) !== t);
  if (renamed.length) ctx.fidelity.push({ fidelity: 'full', message: `Tag${renamed.length === 1 ? '' : 's'} ${renamed.map((t) => `“${t}”`).join(', ')} renamed to fit LaunchDarkly's tag format.` });
  const tags = unique([tagMigrated, sourceTag(alias), ...ownTags.map(sanitizeTag)].filter(Boolean));

  const props: Record<string, CustomProperty> = provenanceProperties({ id: flag.key, ...(flag.version !== undefined ? { version: flag.version } : {}) }, alias, 'flag', ctx.kind);
  // The early-access feature definition (name, stage) travels with the flag; LD has no field for it.
  const early = flag.caveats?.find((c): c is Extract<NeutralCaveat, { kind: 'early_access_enrollment' }> => c.kind === 'early_access_enrollment');
  if (early && (early.detail.name || early.detail.stage)) props[EARLY_ACCESS_PROPERTY] = { name: `${SOURCE_KIND_WORD[ctx.kind]} early access feature`, value: [early.detail.name, early.detail.stage].filter((v): v is string => !!v) };
  const own = Object.entries(flag.customProperties).filter(([k]) => !PROVENANCE_PROPERTY_RE.test(k) && k !== EARLY_ACCESS_PROPERTY);
  if (own.length) {
    const choice = ctx.decisions.choose(
      {
        type: 'copy_custom_properties',
        severity: 'choice',
        subject: { ...ctx.subject, location: 'custom properties' },
        path: 'custom_properties',
        title: `Copy ${own.length} custom propert${own.length === 1 ? 'y' : 'ies'} (${own.map(([, v]) => v.name).join(', ')})`,
        explanation: `The source flag carries custom properties of its own. Copy them to the target flag, or leave them out (for example when they reference the source account's tooling).`,
        sourceFragment: Object.fromEntries(own),
        fingerprintOf: own.map(([k]) => k).sort(),
        options: [
          { key: 'copy', label: 'Copy them', explanation: 'The target flag gets the same custom properties.', resultingFidelity: 'full' },
          { key: 'drop', label: 'Leave them out', explanation: 'Only the migration provenance properties are written.', resultingFidelity: 'partial' },
        ],
        recommended: 'copy',
      },
      'copy',
    );
    if (choice === 'copy') for (const [k, v] of own) props[k] = { name: v.name, value: [...v.value] };
    else ctx.fidelity.push({ fidelity: 'partial', message: `${own.length} custom propert${own.length === 1 ? 'y' : 'ies'} not copied.`, location: 'custom properties' });
  }
  // Member IDs belong to the source account; the maintainer is matched by email (and the team by key) in the target, like a StatSig owner.
  const maintainer = flag.maintainer
    ? chooseMaintainer({ profile: ctx.args.profile, ...(ctx.args.directory ? { directory: ctx.args.directory } : {}), decisions: ctx.decisions, subject: ctx.subject, fidelity: ctx.fidelity }, { ...(flag.maintainer.email ? { owner: { id: flag.maintainer.id, email: flag.maintainer.email } } : {}), team: flag.maintainer.teamKey ?? null })
    : {};
  if (flag.maintainer?.id && !flag.maintainer.email && !flag.maintainer.teamKey) ctx.fidelity.push({ fidelity: 'full', message: `Maintainer not carried: ${sourceLabel(ctx)} gave only a member ID, which belongs to the source account.`, location: 'flag settings' });
  if (!flag.clientSideAvailability) ctx.fidelity.push({ fidelity: 'full', message: `${sourceLabel(ctx)} did not report client-side availability; the target flag is server-side only until changed.`, location: 'flag settings' });

  return {
    key: flag.key,
    name: flag.name || flag.key,
    description: flag.description,
    variations: flag.variations.map((v, i) => ({ value: v.value, name: variationName(v, i) })),
    defaults: flag.defaults ?? { onVariation: 0, offVariation: Math.max(0, flag.variations.length - 1) },
    temporary: flag.temporary,
    tags,
    clientSideAvailability: flag.clientSideAvailability ?? { usingEnvironmentId: false, usingMobileKey: false },
    customProperties: props,
    ...maintainer,
  };
}

// ---------------------------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------------------------

export function mapNeutralSegment(args: MapArgs<NeutralSegment>): NeutralSegmentMapResult {
  const { entity: seg, env } = args;
  const ctx = makeCtx(args, 'segment');
  const alias = ctx.snapshot.source.alias;
  const source = neutralSegmentEnvOf(seg, env.statsig);
  const fp = fingerprint(source ? { rules: source.rules, included: source.included, excluded: source.excluded, unbounded: source.unbounded ?? null, caveats: seg.caveats ?? null } : null);

  const finish = (desired: DesiredSegment | null, skipped?: string): NeutralSegmentMapResult => ({
    uid: seg.uid,
    entityId: seg.key,
    sourceId: ctx.sourceId,
    segmentKey: seg.key,
    desired,
    fidelity: report(ctx.fidelity, skipped),
    unresolved: ctx.decisions.unresolved,
    applied: ctx.decisions.applied,
    stale: ctx.decisions.stale,
    dependencies: [...ctx.deps.values()],
    statsigFingerprint: fp,
    decisionSetHash: ctx.decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  });

  if (seg.archived) return finish(null, `archived in ${sourceLabel(ctx)}`);
  if (!source) return finish(null, `not present in source environment “${env.statsig}”`);
  const ownTags = seg.tags.filter((t) => !PROVENANCE_TAG_RE.test(t));
  const base: DesiredSegment = {
    key: seg.key,
    ldEnv: env.ld,
    statsigEnv: env.statsig,
    name: seg.name || seg.key,
    description: seg.description,
    tags: unique([migratedFromTag(ctx.kind), sourceTag(alias), ...ownTags.map(sanitizeTag)].filter(Boolean)),
    rules: [],
    included: [],
    includedContexts: [],
  };

  try {
    segmentCaveats(ctx, seg);
    if (source.unbounded) {
      const caps = ctx.args.capabilities.bigSegments;
      if (caps === 'unavailable' || caps === 'not_permitted') throw new SkipItem(`it is a big segment and the target ${caps === 'not_permitted' ? 'token may not create' : 'plan has no'} big segments`);
      const unreadable = seg.caveats?.find((c) => c.kind === 'membership_unreadable');
      const choice = ctx.decisions.choose(
        {
          type: 'big_segment',
          severity: 'blocking',
          subject: { ...ctx.subject, location: 'membership' },
          path: 'big_segment',
          title: unreadable ? `Members of “${seg.key}” could not be read` : `Big segment “${seg.key}”: membership can't be read`,
          explanation: unreadable
            ? `${sourceLabel(ctx)} did not give the member list (${unreadable.detail.reason}). The console can create the segment in the target as a big segment (Enterprise) for you to fill with a CSV import, or skip it; rules that match it are blocked until it exists.`
            : `LaunchDarkly only answers whether one key is a member of a big segment, so the console cannot read the list. It can create the big segment in the target (Enterprise) for you to fill with a CSV import, or skip it; rules that match it are blocked until it exists.`,
          sourceFragment: { key: seg.key, unbounded: true, contextKind: source.unbounded.contextKind, ...(unreadable ? { reason: unreadable.detail.reason } : {}) },
          options: [
            { key: 'create_empty', label: 'Create it empty; import the members yourself', explanation: `A big segment on the “${source.unbounded.contextKind}” kind with no members. Export the list from ${sourceLabel(ctx)} and import it in the target.`, resultingFidelity: 'manual' },
            SKIP,
          ],
        },
        'create_empty',
      );
      if (choice === 'skip') throw new SkipItem('its membership is not readable (big segment)');
      base.unbounded = { contextKind: resolveSourceKind(ctx, source.unbounded.contextKind), ids: [], manual: true };
      ctx.fidelity.push({ fidelity: 'manual', message: `Big segment created without members; import the member list in the target.` });
      return finish(base);
    }

    const out: DesiredSegmentRule[] = [];
    for (const [i, r] of source.rules.entries()) {
      const ruleId = r.id ?? `#${i}`;
      const ruleName = r.description || `rule ${i + 1}`;
      const clauses: LdClause[] = [];
      let dropRule = false;
      for (const [k, c] of r.clauses.entries()) {
        const o = translateClause(ctx, c, { ruleId, ruleName, index: k }, source.env, true);
        if (o.kind === 'clause') clauses.push(o.clause);
        else if (o.kind === 'clauses') clauses.push(...o.clauses);
        else if (o.kind === 'drop_rule') {
          dropRule = true;
          break;
        }
      }
      if (dropRule) continue;
      let weight: { weight: number; rolloutContextKind: string; bucketBy?: string } | undefined;
      if (r.weight !== undefined && r.weight < 100_000) {
        if (rebucket(ctx, `rule:${ruleId}:rollout`, `rule “${ruleName}”`, `${r.weight / 1000}%`) === 'skip') throw new SkipItem(`waiting for the ${r.weight / 1000}% rule “${ruleName}”`);
        ctx.fidelity.push({ fidelity: 'partial', message: `${r.weight / 1000}% of matching contexts: re-bucketed (new segment, new salt).`, location: `rule “${ruleName}”` });
        weight = { weight: r.weight, rolloutContextKind: resolveSourceKind(ctx, r.rolloutContextKind ?? 'user'), ...(r.bucketBy ? { bucketBy: r.bucketBy } : {}) };
      }
      out.push({ description: r.description, clauses: clauses.length ? clauses : [{ contextKind: 'user', attribute: 'key', op: 'matches', values: ['.*'], negate: false }], ...(weight ?? {}) });
    }
    base.rules = dedupeRuleDescriptions(out, ctx.fidelity);
    let big: { contextKind: string; ids: string[] } | undefined;
    for (const inc of source.included) {
      const kind = resolveSourceKind(ctx, inc.contextKind);
      if (inc.values.length > LIST_SEGMENT_MAX) {
        if (big) throw new SkipItem(`both ${big.contextKind} and ${kind} keys exceed LaunchDarkly's ${LIST_SEGMENT_MAX.toLocaleString('en-US')}-key limit; a big segment holds one context kind`);
        big = bigSegmentImport(ctx, seg, kind, inc.values);
        continue;
      }
      if (kind === 'user') base.included = [...inc.values];
      else base.includedContexts.push({ contextKind: kind, values: [...inc.values] });
    }
    for (const exc of source.excluded) {
      const kind = resolveSourceKind(ctx, exc.contextKind);
      if (kind === 'user') base.excluded = [...exc.values];
      else (base.excludedContexts ??= []).push({ contextKind: kind, values: [...exc.values] });
    }
    if (big) {
      // Big segments hold one imported list and nothing else: no rules, no other lists, no exclusions.
      const dropped = [base.rules.length ? `${base.rules.length} rule${base.rules.length === 1 ? '' : 's'}` : '', base.included.length || base.includedContexts.length ? 'the other included lists' : '', base.excluded?.length || base.excludedContexts?.length ? 'the excluded keys' : ''].filter(Boolean);
      if (dropped.length) ctx.fidelity.push({ fidelity: 'partial', message: `Big segment: ${dropped.join(', ')} dropped (a LaunchDarkly big segment holds only its imported ${big.contextKind} keys).`, location: 'membership' });
      const { excluded: _excluded, excludedContexts: _excludedContexts, ...rest } = base;
      return finish({ ...rest, rules: [], included: [], includedContexts: [], unbounded: big });
    }
    return finish(base);
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

/**
 * An included list above LD's standard-segment limit (`big_segment`, as size.ts raises it for a
 * StatSig list that does not fit a flag): import it as a big segment, or skip the segment.
 */
function bigSegmentImport(ctx: Ctx, seg: NeutralSegment, kind: string, values: string[]): { contextKind: string; ids: string[] } {
  const n = (x: number) => x.toLocaleString('en-US');
  const count = values.length;
  const bs = ctx.args.capabilities.bigSegments ?? 'unknown';
  const canImport = bs !== 'unavailable' && bs !== 'not_permitted';
  const options: DecisionOption[] = [
    ...(canImport
      ? [
          {
            key: 'import',
            label: 'Import as a LaunchDarkly big segment',
            explanation: `Create an unbounded (big) segment “${seg.key}” and load the ${n(count)} ${kind} keys with a CSV import in replace mode, so every sync mirrors the ${sourceLabel(ctx)} list. Enterprise plans${bs === 'unknown' ? '; your plan is checked on the first write' : ''}. Big segments have no rules and can't be previewed in the LaunchDarkly UI.`,
            resultingFidelity: 'full' as const,
          },
        ]
      : []),
    SKIP,
  ];
  const choice = ctx.decisions.choose(
    {
      type: 'big_segment',
      severity: canImport ? 'choice' : 'blocking',
      subject: { ...ctx.subject, location: 'membership' },
      path: `big_segment:${kind}`,
      title: `${n(count)} ${kind} keys in “${seg.key}” need a big segment`,
      explanation: `A standard LaunchDarkly segment lists at most ${n(LIST_SEGMENT_MAX)} keys. Bigger lists need a big segment (Enterprise), filled by a CSV import.${canImport ? '' : bs === 'not_permitted' ? ' The target token may not create big segments.' : ' Your LaunchDarkly plan does not include big segments.'}`,
      sourceFragment: { key: seg.key, contextKind: kind, count },
      fingerprintOf: { contextKind: kind, over: true, canImport },
      options,
      ...(canImport ? { recommended: 'import' } : {}),
    },
    canImport ? 'import' : 'skip',
  );
  if (choice !== 'import' || !canImport) throw new SkipItem(`${n(count)} included ${kind} keys exceed LaunchDarkly's ${n(LIST_SEGMENT_MAX)}-key limit for list segments`);
  ctx.fidelity.push({ fidelity: 'full', message: `${n(count)} ${kind} keys, more than a list segment holds (${n(LIST_SEGMENT_MAX)}): imported into a big segment${bs === 'unknown' ? ' (Enterprise; checked on the first write)' : ''}.`, location: 'membership' });
  return { contextKind: kind, ids: values.map(String) };
}

/** Segment caveats (PLAN §22.3): frozen computed memberships and members with several ids. */
function segmentCaveats(ctx: Ctx, seg: NeutralSegment): void {
  for (const c of seg.caveats ?? []) {
    if (c.kind === 'frozen_membership') {
      const choice = ctx.decisions.choose(
        {
          type: 'cohort_snapshot',
          severity: 'choice',
          subject: { ...ctx.subject, location: 'membership' },
          path: 'cohort_snapshot',
          title: `“${seg.name}” is a ${c.detail.cohortType} cohort: its members were frozen at read time`,
          explanation: `${sourceLabel(ctx)} recomputes this cohort from events; LaunchDarkly segments have no event history. The ${c.detail.count.toLocaleString('en-US')} current members can migrate as a fixed list, which will not follow new activity.`,
          sourceFragment: c,
          fingerprintOf: { cohortType: c.detail.cohortType },
          options: [
            { key: 'freeze', label: `Migrate the ${c.detail.count.toLocaleString('en-US')} current members as a list`, explanation: 'Re-syncing refreshes the list from the source until the cutover.', resultingFidelity: 'partial' },
            SKIP,
          ],
          recommended: 'freeze',
        },
        'freeze',
      );
      if (choice === 'skip') throw new SkipItem(`it is a ${c.detail.cohortType} cohort`);
      ctx.fidelity.push({ fidelity: 'partial', message: `${c.detail.cohortType} cohort frozen to its ${c.detail.count.toLocaleString('en-US')} members at read time.`, location: 'membership' });
    } else if (c.kind === 'multi_id_members') {
      const choice = ctx.decisions.choose(
        {
          type: 'cohort_person_ids',
          severity: 'acknowledge',
          subject: { ...ctx.subject, location: 'membership' },
          path: 'cohort_person_ids',
          title: `${c.detail.persons.toLocaleString('en-US')} members, ${c.detail.ids.toLocaleString('en-US')} ids: some people have several`,
          explanation: `${sourceLabel(ctx)} merges a person's distinct ids; a LaunchDarkly segment lists context keys. Every id is included, so the segment matches whichever id the application sends.`,
          sourceFragment: c,
          fingerprintOf: { persons: c.detail.persons, ids: c.detail.ids },
          options: [{ key: 'acknowledge', label: 'Include every id', explanation: 'The list is longer than the member count.', resultingFidelity: 'full' }, SKIP],
          recommended: 'acknowledge',
        },
        'acknowledge',
      );
      if (choice === 'skip') throw new SkipItem('members have several ids');
      ctx.fidelity.push({ fidelity: 'full', message: `${c.detail.persons.toLocaleString('en-US')} members listed by all ${c.detail.ids.toLocaleString('en-US')} of their ids.`, location: 'membership' });
    }
  }
}

/**
 * LaunchDarkly's flag-size limit (KNOWN-EDGE-CASES 15.22). A PATCH that would make a flag larger
 * than 400,000 bytes is refused with `400 flag size validation failed: This flag could not be
 * saved because it is N bytes, which exceeds the 400000 byte limit. Remove some targets, rules, or
 * variations to reduce its size`. The limit counts the whole flag: every environment's rules,
 * individual targets and the variations together. A StatSig gate whose rule lists thousands of IDs
 * (`unit_id any [...]`, `custom_field any [...]`) or whose overrides list thousands of users would
 * be translated into one `in` clause or one targets group of the same size, and the flag is
 * refused once the lists of all migrated environments add up past the limit.
 *
 * The mapper therefore estimates the size of each environment's targeting as LaunchDarkly stores
 * it, and when an environment's share of the budget is exceeded moves the largest lists out into
 * segments (`fitFlagEnv`): a list segment for IDs matched on a context key, a big segment above
 * LaunchDarkly's 15,000-ID list limit (the `big_segment` decision), a rule-based segment holding the
 * clause for anything else. The flag then references the segment with a `segmentMatch` clause.
 * Each move is a fidelity note; a move that changes behaviour (a negated list: contexts without the
 * attribute no longer fail the clause) is a `flag_size` acknowledgement. Pure and deterministic.
 */
import { LIST_SEGMENT_MAX, SkipItem, type ConditionContext } from './conditions.ts';
import { DROP_RULE, SKIP } from './decisions.ts';
import { sanitizeKey } from './profile.ts';
import type { DecisionOption, DesiredFlagEnv, DesiredFlagShell, DesiredRule, DesiredSegment, DesiredTarget, EnvTarget, LdClause, MappingProfile } from './types.ts';

/** LaunchDarkly refuses a flag above this many bytes (the whole flag, every environment). */
export const FLAG_SIZE_LIMIT = 400_000;
/**
 * What the console lets a flag grow to: three quarters of the limit. The rest is headroom for the
 * fields LaunchDarkly adds that the estimate can't see (`_id`s, `trackEvents`, `_summary`, the
 * environments that aren't migrated) and for the difference between this estimate and
 * LaunchDarkly's own count.
 */
export const FLAG_SIZE_BUDGET = 300_000;
/** Never squeeze an environment below this, however many environments share the flag. */
const MIN_ENV_BUDGET = 20_000;

/** Per-rule bytes LaunchDarkly adds: `_id`, `trackEvents`, `ref`, punctuation. */
const RULE_OVERHEAD = 80;
/** Per-clause bytes LaunchDarkly adds: `_id` and punctuation. */
const CLAUSE_OVERHEAD = 50;
/** Per-environment fixed fields: `_site`, `_environmentName`, `salt`, `sel`, `version`, `lastModified`, `_summary`… */
const ENV_OVERHEAD = 400;
/** Project-level fields beyond the shell: `_links`, `_maintainer`, `creationDate`, `_version`, `experiments`… */
const SHELL_OVERHEAD = 600;
/** The `segmentMatch` clause that replaces a moved list (one short value). */
const SEGMENT_CLAUSE_BYTES = 120;

const encoder = new TextEncoder();
/** UTF-8 length of a JSON value, as LaunchDarkly stores it. */
function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** The per-environment state the size counts (also a scheduled change's state). */
export type FlagEnvState = Pick<DesiredFlagEnv, 'on' | 'offVariation' | 'fallthrough' | 'rules' | 'targets' | 'prerequisites'>;

/** Estimated bytes of one environment's targeting as LaunchDarkly stores it. */
export function estimateEnvBytes(state: FlagEnvState): number {
  let n = ENV_OVERHEAD + bytes({ on: state.on, offVariation: state.offVariation, fallthrough: state.fallthrough, prerequisites: state.prerequisites });
  for (const r of state.rules) n += ruleBytes(r);
  for (const t of state.targets) n += targetBytes(t);
  return n;
}

/** Estimated bytes of the project-level part of a flag (variations, provenance, name, description, tags). */
export function estimateShellBytes(shell: DesiredFlagShell): number {
  return SHELL_OVERHEAD + bytes(shell);
}

function ruleBytes(r: DesiredRule): number {
  return RULE_OVERHEAD + bytes({ description: r.description, variation: r.variation, rollout: r.rollout }) + r.clauses.reduce((n, c) => n + CLAUSE_OVERHEAD + bytes(c), 0);
}

/** LaunchDarkly keeps individual targets twice (`targets` for users, `contextTargets` for every kind). */
function targetBytes(t: DesiredTarget): number {
  return 2 * (40 + bytes(t));
}

/** How many LaunchDarkly environments this source migrates into: they share the flag's budget. */
export function migratedEnvCount(profile: MappingProfile, sourceId: string): number {
  const envs = new Set(Object.values(profile.sources[sourceId]?.envMapping ?? {}).filter((v): v is string => !!v));
  return Math.max(1, envs.size);
}

/** The share of `FLAG_SIZE_BUDGET` one environment's targeting may use once the shell is paid for. */
export function envBudget(shell: DesiredFlagShell, environments: number): number {
  return Math.max(MIN_ENV_BUDGET, Math.floor((FLAG_SIZE_BUDGET - estimateShellBytes(shell)) / Math.max(1, environments)));
}

export interface FitOptions {
  flagKey: string;
  flagName: string;
  shell: DesiredFlagShell;
  env: EnvTarget;
  /** Bytes one environment may use; see `envBudget`. */
  budget: number;
  /** Segments already split off this flag (shared by the current state and its scheduled states), by key. Filled in place. */
  segments: Map<string, DesiredSegment>;
}

/** A list that may leave the flag: a targets group, or one clause's values. */
type Candidate = { bytes: number; where: string } & ({ kind: 'targets'; index: number } | { kind: 'clause'; rule: number; clause: number });

/**
 * Returns `state` unchanged when its estimate is within the budget; otherwise a copy with the
 * largest lists moved into segments (added to `o.segments`) until the estimate fits, and the
 * notes and decisions that explain it. Throws `SkipItem` when a decision chose to skip the item.
 */
export function fitFlagEnv<S extends FlagEnvState>(ctx: ConditionContext, state: S, o: FitOptions): S {
  const before = estimateEnvBytes(state);
  if (before <= o.budget) return state;

  const n = (x: number) => x.toLocaleString('en-US');
  const variationName = (i: number | undefined) => (i === undefined ? 'rollout' : (o.shell.variations[i]?.name ?? `variation ${i}`));
  const candidates: Candidate[] = [];
  state.targets.forEach((t, index) => {
    if (t.values.length) candidates.push({ kind: 'targets', index, bytes: targetBytes(t), where: `${variationName(t.variation)} overrides (${t.contextKind})` });
  });
  state.rules.forEach((r, rule) => {
    r.clauses.forEach((c, clause) => {
      if (c.op === 'segmentMatch' || c.values.length < 2) return;
      candidates.push({ kind: 'clause', rule, clause, bytes: CLAUSE_OVERHEAD + bytes(c), where: `rule “${r.description}”` });
    });
  });
  // Largest first; ties in flag order, so the result is deterministic.
  const order = (c: Candidate) => (c.kind === 'targets' ? `0:${String(c.index).padStart(6, '0')}` : `1:${String(c.rule).padStart(6, '0')}:${String(c.clause).padStart(6, '0')}`);
  candidates.sort((a, b) => b.bytes - a.bytes || order(a).localeCompare(order(b)));

  const rules = state.rules.map((r) => ({ ...r, clauses: [...r.clauses] }));
  const droppedRules = new Set<number>();
  const movedTargets = new Set<number>();
  const front: DesiredRule[] = [];
  const moved: string[] = [];
  let size = before;
  for (const c of candidates) {
    if (size <= o.budget) break;
    if (c.kind === 'targets') {
      const t = state.targets[c.index]!;
      const out = spill(ctx, o, { contextKind: t.contextKind, attribute: 'key', op: 'in', values: t.values, negate: false, where: c.where, slug: `${variationName(t.variation)}-overrides-${t.contextKind}`, keyed: true, overrides: true });
      movedTargets.add(c.index);
      size -= c.bytes;
      if (out) {
        // Individual targets are evaluated before rules, so the segment rule goes before every rule.
        front.push({ description: c.where, clauses: [segmentClause(out.key, false)], variation: t.variation });
        size += RULE_OVERHEAD + SEGMENT_CLAUSE_BYTES;
        moved.push(`${c.where}: ${n(t.values.length)} ${t.contextKind} keys moved into segment “${out.key}”`);
      }
    } else {
      if (droppedRules.has(c.rule)) continue;
      const r = rules[c.rule]!;
      const cl = r.clauses[c.clause]!;
      const out = spill(ctx, o, { ...cl, where: c.where, slug: `${r.description}-${cl.attribute}`, keyed: cl.attribute === 'key' && cl.op === 'in', overrides: false });
      if (!out) {
        droppedRules.add(c.rule);
        size -= ruleBytes(r);
        continue;
      }
      r.clauses[c.clause] = segmentClause(out.key, cl.negate);
      size -= c.bytes - SEGMENT_CLAUSE_BYTES;
      moved.push(`${c.where}: ${n(cl.values.length)} values moved into segment “${out.key}”`);
    }
  }

  const keptTargets = state.targets.filter((_, i) => !movedTargets.has(i));
  const keptRules = rules.filter((_, i) => !droppedRules.has(i));
  const next: S = { ...state, targets: keptTargets, rules: [...front, ...keptRules] };
  const after = estimateEnvBytes(next);
  if (moved.length) {
    ctx.fidelity.push({
      fidelity: 'full',
      message: `Targeting in ${o.env.ld} estimated at ${n(before)} bytes, above this environment's ${n(o.budget)}-byte share of LaunchDarkly's ${n(FLAG_SIZE_LIMIT)}-byte flag size limit: ${moved.join('; ')}. The segment${moved.length === 1 ? ' is' : 's are'} written before the flag and synced with it; the flag now estimates at ${n(after)} bytes.`,
    });
    // The split shapes the result without a question: a changed budget (another environment mapped) shows as "decisions changed".
    ctx.decisions.note(`flag_size:${o.env.ld}`, [...o.segments.keys()].sort().join(','));
  }
  if (after > o.budget) ctx.fidelity.push({ fidelity: 'manual', message: `Targeting in ${o.env.ld} still estimates at ${n(after)} bytes after moving every list it could, above its ${n(o.budget)}-byte share of LaunchDarkly's flag size limit; LaunchDarkly may refuse the write. Split the gate in StatSig, or shorten its rules.` });
  return next;
}

function segmentClause(key: string, negate: boolean): LdClause {
  return { contextKind: 'user', attribute: 'segmentMatch', op: 'segmentMatch', values: [key], negate };
}

interface ListToMove extends LdClause {
  /** Where the list sits in the flag, for notes and decisions. */
  where: string;
  /** Readable part of the segment key. */
  slug: string;
  /** Exact IDs on a context key: a list (or big) segment; anything else becomes a segment rule. */
  keyed: boolean;
  /** Individual targets (overrides), which become a rule before every other rule. */
  overrides: boolean;
}

/**
 * Moves one list into a segment and returns it, or `null` when a decision dropped the rule
 * instead. Throws `SkipItem` on "skip".
 */
function spill(ctx: ConditionContext, o: FitOptions, list: ListToMove): DesiredSegment | null {
  const n = (x: number) => x.toLocaleString('en-US');
  const count = list.values.length;
  const base: Omit<DesiredSegment, 'key'> = {
    ldEnv: o.env.ld,
    statsigEnv: o.env.statsig,
    name: `${o.flagName} › ${list.where}`,
    description: `${n(count)} values of ${list.where} in flag “${o.flagKey}”, kept in a segment because the flag's targeting would exceed LaunchDarkly's ${n(FLAG_SIZE_LIMIT)}-byte flag size limit. Synced with the flag by the LaunchDarkly Migration Console: edit the list in StatSig, not here.`,
    tags: o.shell.tags,
    rules: [],
    included: [],
    includedContexts: [],
  };
  const slug = list.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'list';
  const keyBase = sanitizeKey(`${o.flagKey}.${slug}`);

  let body: Partial<DesiredSegment>;
  if (list.keyed && count > LIST_SEGMENT_MAX) {
    const bs = ctx.capabilities.bigSegments ?? 'unknown';
    const canImport = bs !== 'unavailable' && bs !== 'not_permitted';
    const options: DecisionOption[] = [
      ...(canImport
        ? [
            {
              key: 'import',
              label: 'Import as a LaunchDarkly big segment',
              explanation: `Create an unbounded (big) segment “${keyBase}” and load the ${n(count)} ${list.contextKind} keys with a CSV import in replace mode, so every sync mirrors the StatSig list; the flag targets it with a segment clause. Enterprise plans${bs === 'unknown' ? '; your plan is checked on the first write' : ''}. Big segments have no rules and can't be previewed in the LaunchDarkly UI.`,
              resultingFidelity: 'full' as const,
            },
          ]
        : []),
      ...(list.overrides ? [{ key: 'drop_rule', label: 'Drop these overrides', explanation: `The ${n(count)} overridden ${list.contextKind} keys are not targeted in LaunchDarkly; they get what the rules serve.`, resultingFidelity: 'partial' as const }] : [DROP_RULE]),
      SKIP,
    ];
    const choice = ctx.decisions.choose(
      {
        type: 'big_segment',
        severity: canImport ? 'choice' : 'blocking',
        subject: { ...ctx.subject, location: list.where },
        path: `size:${keyBase}`,
        title: `${n(count)} ${list.contextKind} keys in ${list.where} need a big segment`,
        explanation: `The list is too long for the flag itself (LaunchDarkly refuses flags above ${n(FLAG_SIZE_LIMIT)} bytes) and for a standard list segment (at most ${n(LIST_SEGMENT_MAX)} IDs). Bigger lists need a big segment (Enterprise), filled by a CSV import.${canImport ? '' : ' Your LaunchDarkly plan does not include big segments.'}`,
        sourceFragment: { flag: o.flagKey, where: list.where, contextKind: list.contextKind, count },
        fingerprintOf: { where: list.where, over: true, canImport },
        options,
        ...(canImport ? { recommended: 'import' } : {}),
      },
      canImport ? 'import' : 'drop_rule',
    );
    if (choice === 'skip') throw new SkipItem(`${n(count)} ${list.contextKind} keys in ${list.where} exceed LaunchDarkly's flag size and list segment limits`);
    if (choice !== 'import') {
      ctx.fidelity.push({ fidelity: 'partial', message: `${list.where} dropped: its ${n(count)} ${list.contextKind} keys exceed LaunchDarkly's flag size and list segment limits.`, location: list.where });
      return null;
    }
    body = { unbounded: { contextKind: list.contextKind, ids: list.values.map(String) } };
  } else if (list.keyed) {
    const ids = list.values.map(String);
    body = list.contextKind === 'user' ? { included: ids } : { includedContexts: [{ contextKind: list.contextKind, values: ids }] };
  } else {
    body = { rules: [{ description: list.where, clauses: [{ contextKind: list.contextKind, attribute: list.attribute, op: list.op, values: list.values, negate: false }] }] };
  }

  if (list.negate) {
    // 15.1: a negated clause on a missing attribute never matches, but "not in segment" does match
    // a context the segment doesn't hold, so contexts without the attribute now pass the clause.
    const what = list.attribute === 'key' ? `a ${list.contextKind} context` : `“${list.attribute}”`;
    const choice = ctx.decisions.choose(
      {
        type: 'flag_size',
        severity: 'acknowledge',
        subject: { ...ctx.subject, location: list.where },
        path: `negated:${keyBase}`,
        title: `${list.where}: ${n(count)} excluded values move into a segment`,
        explanation: `The flag's targeting would exceed LaunchDarkly's ${n(FLAG_SIZE_LIMIT)}-byte flag size limit, so the ${n(count)} values of this “not in” list move into segment “${keyBase}” and the clause becomes “not in segment”. In LaunchDarkly a clause on a missing attribute never matches, even negated, but a context the segment doesn't hold does match “not in segment”: contexts without ${what} failed this clause before and pass it now (as they do in StatSig).`,
        sourceFragment: { flag: o.flagKey, where: list.where, attribute: list.attribute, count },
        fingerprintOf: { where: list.where, attribute: list.attribute, negate: true },
        options: [
          { key: 'acknowledge', label: 'Acknowledge: move the list into a segment', explanation: `Contexts without ${what} match this rule in LaunchDarkly.`, resultingFidelity: 'partial' },
          SKIP,
        ],
        recommended: 'acknowledge',
      },
      'acknowledge',
    );
    if (choice === 'skip') throw new SkipItem(`${list.where} has ${n(count)} excluded values that don't fit the flag`);
    ctx.fidelity.push({ fidelity: 'partial', message: `${list.where}: the excluded values live in segment “${keyBase}”, so contexts without ${what} now match the rule.`, location: list.where });
  }

  // One segment per distinct list: a scheduled state with the same list reuses it; a different list under the same name gets a suffix.
  const content = segmentContent(body);
  for (let i = 1; ; i++) {
    const key = i === 1 ? keyBase : `${keyBase}-${i}`;
    const existing = o.segments.get(key);
    if (existing) {
      if (segmentContent(existing) === content) return existing;
      continue;
    }
    const seg: DesiredSegment = { key, ...base, ...body };
    o.segments.set(key, seg);
    return seg;
  }
}

/** What a split-off segment holds, for telling two lists apart (metadata left out). */
function segmentContent(s: Partial<DesiredSegment>): string {
  return JSON.stringify({ unbounded: s.unbounded ?? null, included: s.included ?? [], includedContexts: s.includedContexts ?? [], rules: s.rules ?? [] });
}

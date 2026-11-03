/**
 * Feature gate → boolean LD flag (PLAN §10). Pure and deterministic: the same inputs always give
 * the same flag, decisions and fingerprints. `now` is an input because `time` conditions depend on it.
 */
import { fingerprint, migratedFromTag, overridesForEnvironment, PROP, resolveRulesForEnvironment, SOURCE_KIND_LABEL, sourceTag, targetingFingerprint, type CanonicalSnapshot, type Condition, type Gate, type Holdout, type MigrationSourceKind } from '@sslm/canonical';
import { flagName, dedupeRuleDescriptions, ALWAYS, andDnf, MAX_EXPANSION, NEVER, resolveKind, SkipItem, translateCondition, unique, type ConditionContext, type Dnf, type Loc, resolveUnit, rolloutFor, splitOverrides, type OverrideGroup } from './conditions.ts';
import { DecisionCollector, DROP_CONDITION, DROP_RULE, SKIP } from './decisions.ts';
import { chooseMaintainer } from './maintainer.ts';
import { sanitizeKey, sanitizeTag } from './profile.ts';
import { inlineGate, type InlineState } from './refs.ts';
import { scheduledChanges } from './schedule.ts';
import type {
  AppliedDecision,
  ClientSideAvailability,
  CustomProperty,
  DecisionPoint,
  Dependency,
  DesiredFlagEnv,
  DesiredFlagShell,
  DesiredRule,
  DesiredTarget,
  EnvTarget,
  Fidelity,
  FidelityNote,
  FidelityReport,
  IdListCoverages,
  IdLists,
  LdDirectory,
  MapperCapabilities,
  MappingProfile,
  Resolution,
  StaleDecision,
  VariationOrRollout,
} from './types.ts';

/** A StatSig rule and the slice `[first, last)` of the LD rules it produced. */
interface EmittedRule {
  id: string;
  name: string;
  passPercentage: number;
  serve: VariationOrRollout;
  first: number;
  last: number;
}

/**
 * Edge case 4.15: a rule that serves what the default rule serves (in StatSig, a 0 % rule before
 * the implicit fail) is redundant when every rule after it serves the same thing: dropping it
 * changes nothing. When a later rule serves something else it is an exclusion ("fail these users
 * before the pass rule"), and dropping it changes the result for users in both audiences. Both
 * kinds are listed in one `redundant_rules` decision per gate; the default keeps every rule, so
 * the LD flag mirrors StatSig rule for rule.
 */
function trimRedundantRules(ctx: ConditionContext, out: DesiredRule[], emitted: EmittedRule[], fallthrough: VariationOrRollout): DesiredRule[] {
  if (fallthrough.variation === undefined) return out;
  const served = fallthrough.variation;
  const label = served === PASS ? 'Pass' : 'Fail';
  const candidates: (EmittedRule & { cls: 'trailing' | 'exclusion' })[] = [];
  let allLaterSame = true;
  for (let i = emitted.length - 1; i >= 0; i--) {
    const e = emitted[i]!;
    if (e.serve.variation === served) candidates.unshift({ ...e, cls: allLaterSame ? 'trailing' : 'exclusion' });
    else allLaterSame = false;
  }
  if (candidates.length === 0) return out;
  const trailing = candidates.filter((c) => c.cls === 'trailing');
  const exclusions = candidates.filter((c) => c.cls === 'exclusion');
  const names = (xs: EmittedRule[]) => xs.map((x) => `“${x.name}”`).join(', ');
  const n = candidates.length;
  const plural = (k: number, one: string, many: string) => (k === 1 ? one : many);
  const explanation = [
    `In StatSig a ${served === PASS ? '100 %' : '0 %'} rule serves ${label} to the users it matches, and so does the default rule: the LaunchDarkly flag would carry ${n} ${plural(n, 'rule', 'rules')} that ${plural(n, 'changes', 'change')} nothing on ${plural(n, 'its', 'their')} own.`,
    trailing.length ? `${names(trailing)}: every rule after ${plural(trailing.length, 'it', 'them')} serves ${label} too, so dropping ${plural(trailing.length, 'it', 'them')} keeps the same result for everyone.` : '',
    exclusions.length ? `${names(exclusions)}: a later rule serves something else, so ${plural(exclusions.length, 'it acts', 'they act')} as an exclusion. Dropping ${plural(exclusions.length, 'it', 'them')} changes the result for users who also match that later rule.` : '',
    'Keeping them mirrors StatSig rule for rule, which can matter for monitoring or for rules you plan to change later.',
  ]
    .filter(Boolean)
    .join(' ');
  const choice = ctx.decisions.choose(
    {
      type: 'redundant_rules',
      severity: 'choice',
      subject: { ...ctx.subject, location: `${n} ${plural(n, 'rule serves', 'rules serve')} ${label}, like the default rule` },
      path: 'rules:redundant',
      title: `${n} ${plural(n, 'rule serves', 'rules serve')} ${label}, which the default rule already does`,
      explanation,
      sourceFragment: { defaultServes: label, rules: candidates.map((c) => ({ id: c.id, name: c.name, passPercentage: c.passPercentage, kind: c.cls })) },
      fingerprintOf: candidates.map((c) => ({ id: c.id, kind: c.cls })).sort((a, b) => a.id.localeCompare(b.id)),
      options: [
        { key: 'keep', label: 'Keep every rule', explanation: 'The LaunchDarkly flag has the same rules as the StatSig gate, redundant ones included.', resultingFidelity: 'full' },
        ...(trailing.length
          ? [
              {
                key: 'trim_trailing',
                label: `Drop the ${trailing.length} ${plural(trailing.length, 'rule', 'rules')} that ${plural(trailing.length, 'changes', 'change')} nothing`,
                explanation: `Drop ${names(trailing)}. Everyone they match reaches the default rule and gets ${label}, exactly as before.${exclusions.length ? ` ${names(exclusions)} ${plural(exclusions.length, 'stays', 'stay')}.` : ''}`,
                resultingFidelity: 'full' as const,
              },
            ]
          : []),
        ...(exclusions.length
          ? [
              {
                key: 'trim_all',
                label: `Drop all ${n}, exclusions included`,
                explanation: `Also drop ${names(exclusions)}. Users who match ${plural(exclusions.length, 'it', 'one of them')} and a later rule get what the later rule serves instead of ${label}. Safe only when those audiences never overlap.`,
                resultingFidelity: 'partial' as const,
              },
            ]
          : []),
      ],
      recommended: 'keep',
    },
    'keep',
  );
  if (choice === 'keep') return out;
  const dropped = choice === 'trim_all' ? candidates : trailing;
  const droppedTrailing = dropped.filter((c) => c.cls === 'trailing');
  const droppedExclusions = dropped.filter((c) => c.cls === 'exclusion');
  if (droppedTrailing.length) ctx.fidelity.push({ fidelity: 'full', message: `Dropped ${droppedTrailing.length} ${plural(droppedTrailing.length, 'rule', 'rules')} that ${plural(droppedTrailing.length, 'serves', 'serve')} ${label} like the default rule (${names(droppedTrailing)}): same result for everyone.` });
  if (droppedExclusions.length) ctx.fidelity.push({ fidelity: 'partial', message: `Dropped ${droppedExclusions.length} exclusion ${plural(droppedExclusions.length, 'rule', 'rules')} (${names(droppedExclusions)}): users ${plural(droppedExclusions.length, 'it', 'they')} matched now reach the later rules instead of getting ${label}.` });
  const skip = new Set<number>();
  for (const d of dropped) for (let i = d.first; i < d.last; i++) skip.add(i);
  return out.filter((_, i) => !skip.has(i));
}

/** The canonical model is StatSig's today; the kind is written into every resource (PLAN §3.3). */
export const SOURCE_KIND: MigrationSourceKind = 'statsig';
/** `migrated-from-statsig`: the marker tag on everything the console creates from this source. */
export const TAG_MIGRATED = migratedFromTag(SOURCE_KIND);
export { sourceTag };

/** Variation indexes of every migrated gate: `[true, false]`. */
export const PASS = 0;
export const FAIL = 1;

export interface MapArgs<E> {
  canonical: { snapshot: CanonicalSnapshot; idLists?: IdLists; coverage?: IdListCoverages };
  entity: E;
  profile: MappingProfile;
  resolutions: ReadonlyMap<string, Resolution>;
  capabilities: MapperCapabilities;
  env: EnvTarget;
  /** ISO time the mapping is evaluated at (time conditions). */
  now: string;
  /** LD members and teams for owner → maintainer matching; absent = not read yet (owners raise `maintainer_unknown`). */
  directory?: LdDirectory;
}

export interface MapOutcome {
  uid: string;
  entityId: string;
  sourceId: string;
  fidelity: FidelityReport;
  /** Decisions without an answer. The item can't migrate until this is empty. */
  unresolved: DecisionPoint[];
  applied: AppliedDecision[];
  stale: StaleDecision[];
  dependencies: Dependency[];
  /** Fingerprint of everything in StatSig this result depends on (PLAN §3.3 `migration.sync.<env>`). */
  statsigFingerprint: string;
  decisionSetHash: string;
  /** Set when the item is not migrated (archived, or a decision chose "skip"). */
  skipped?: string;
}

export interface GateMapResult extends MapOutcome {
  flagKey: string;
  shell: DesiredFlagShell;
  /** The desired targeting; a preview (recommended options applied) while decisions are open. */
  env: DesiredFlagEnv;
}

export function mapGate(args: MapArgs<Gate>): GateMapResult {
  const { entity: gate, canonical, profile, capabilities, env } = args;
  const snapshot = canonical.snapshot;
  const sourceId = gate.source.sourceId;
  const decisions = new DecisionCollector(args.resolutions, profile);
  const fidelity: FidelityNote[] = [];
  const deps = new Map<string, Dependency>();
  const subject = { sourceId, kind: 'gate' as const, uid: gate.uid, id: gate.id };
  const ctx: ConditionContext = {
    profile,
    capabilities,
    snapshot,
    sourceId,
    idLists: canonical.idLists ?? {},
    ...(canonical.coverage ? { coverage: canonical.coverage } : {}),
    ...(args.directory ? { directory: args.directory } : {}),
    nowMs: Date.parse(args.now),
    scheduleFlips: new Set(),
    decisions,
    subject,
    fidelity,
    deps,
    userKind: 'user',
    kindCache: new Map(),
  };
  ctx.userKind = resolveKind(ctx, 'userID');
  const flagKey = sanitizeKey(gate.id);
  const shell = flagShell(ctx, gate, snapshot.source.alias, flagKey);
  const offEnv: DesiredFlagEnv = { ldEnv: env.ld, statsigEnv: env.statsig, on: false, offVariation: FAIL, fallthrough: { variation: FAIL }, rules: [], targets: [], prerequisites: [] };
  const inline: InlineState = { env, stack: [], inlined: new Map(), cache: new Map() };
  // Edge case 4.8: the holdouts' shares are part of what the flag depends on in StatSig.
  const holdouts = attachedHoldouts(snapshot, gate);
  const holdoutFingerprint = holdouts.map((h) => ({ id: h.id, passPercentage: h.passPercentage, enabled: h.enabled, archived: h.archived }));

  const finish = (desired: DesiredFlagEnv, skipped?: string): GateMapResult => ({
    uid: gate.uid,
    entityId: gate.id,
    sourceId,
    flagKey,
    shell,
    env: desired,
    fidelity: report(fidelity, skipped),
    unresolved: decisions.unresolved,
    applied: decisions.applied,
    stale: decisions.stale,
    dependencies: [...deps.values()].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)),
    statsigFingerprint: fingerprint({ self: targetingFingerprint(gate, env.statsig), inlined: [...inline.inlined.entries()].sort(), ...(holdoutFingerprint.length ? { holdouts: holdoutFingerprint } : {}) }),
    decisionSetHash: decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  });

  if (gate.archived) return finish(offEnv, 'archived in StatSig');

  // KNOWN-EDGE-CASES 4.13: `status` wins over `isEnabled` and the rule list. A Launched gate skips
  // rule evaluation and returns true for everyone; a Disabled gate returns false. The Console API
  // can report a Launched gate with `isEnabled: false` and no rules.
  if (gate.status === 'Launched') {
    fidelity.push({ fidelity: 'full', message: `Launched in StatSig: everyone passes, so the flag is on in ${env.ld} and serves true to everyone${gate.rules.length ? ` (its ${gate.rules.length} rule${gate.rules.length === 1 ? ' is' : 's are'} not evaluated in StatSig and ${gate.rules.length === 1 ? 'is' : 'are'} not migrated)` : ''}.` });
    if (gate.lifecycle?.type === 'STALE') fidelity.push({ fidelity: 'full', message: `StatSig marks this gate stale (${gate.lifecycle.typeReason ?? 'STALE'}). Consider hard-coding it instead of migrating.` });
    return finish({ ldEnv: env.ld, statsigEnv: env.statsig, on: true, offVariation: FAIL, fallthrough: { variation: PASS }, rules: [], targets: [], prerequisites: [] });
  }
  const enabled = gate.enabled && gate.status !== 'Disabled';

  /**
   * The environment's targeting as of `c.nowMs`. Run once for now, and once more per scheduled
   * flip (see ./schedule.ts); every pass shares `deps` and the kind cache, so the plan carries
   * every segment and prerequisite any of the states needs.
   */
  const translate = (c: ConditionContext, state: InlineState): DesiredFlagEnv => {
    const resolved = resolveRulesForEnvironment(gate.rules, env.statsig);
    for (const d of resolved.dropped) {
      const r = gate.rules.find((x) => x.id === d.ruleId);
      c.fidelity.push({ fidelity: 'full', message: `Rule “${r?.name ?? d.ruleId}” doesn't apply in ${env.statsig} (${d.reason === 'not_enabled_in_environment' ? 'not enabled here' : 'environment tier is false here'}).` });
    }
    const rules = resolved.rules;
    const overrides = overridesForEnvironment(gate.overrides, env.statsig);
    const hasPassOverrides = overrides.some((o) => o.value.kind === 'gate' && o.value.pass && o.ids.length > 0);

    // PLAN §10.4 rule 1: every rule requires the same gate → an LD prerequisite is exact.
    const prereqCandidate = commonPassesGate(rules.map((r) => r.conditions));
    const prerequisites = new Set<string>();
    c.gateReference = (ids, negate, cond, loc) => gateReference(c, state, { ids, negate, c: cond, loc, prereqCandidate, hasPassOverrides, prerequisites });

    const out: DesiredRule[] = [];
    /** Which StatSig rule each entry of `out` came from, for the redundant-rule check below. */
    const emitted: EmittedRule[] = [];
    let fallthrough: VariationOrRollout = { variation: FAIL };
    rules: for (const r of rules) {
      const serve = serveFor(c, gate, r.id, r.name, r.passPercentage, r.idType);
      const conds = r.conditions.map((cond, i) => translateCondition(c, cond, { ruleId: r.id, ruleName: r.name, index: i }));
      let dnf = andDnf(conds);
      if (!dnf) dnf = expansion(c, r.id, r.name, conds.reduce((n, d) => n * Math.max(d.length, 1), 1));
      if (dnf.length === 0) continue;
      const first = out.length;
      for (const [k, term] of dnf.entries()) {
        if (term.length === 0) {
          // A rule that matches everyone: it becomes the fallthrough and nothing after it is reachable.
          fallthrough = serve;
          const after = rules.length - rules.indexOf(r) - 1;
          if (after > 0) c.fidelity.push({ fidelity: 'full', message: `Rule “${r.name}” matches everyone; the ${after} rule${after === 1 ? '' : 's'} after it can never match and ${after === 1 ? 'is' : 'are'} dropped.` });
          break rules;
        }
        out.push({ description: dnf.length > 1 ? `${r.name} (${k + 1}/${dnf.length})` : r.name, clauses: term, ...serve });
      }
      if (out.length > first) emitted.push({ id: r.id, name: r.name, passPercentage: r.passPercentage, serve, first, last: out.length });
    }

    const kept = trimRedundantRules(c, out, emitted, fallthrough);

    const ov = overrideTargets(c, overrides);
    for (const key of [...prerequisites].sort()) deps.set(`flag:${sanitizeKey(key)}`, { kind: 'flag', key: sanitizeKey(key), entityId: key });
    return {
      ldEnv: env.ld,
      statsigEnv: env.statsig,
      on: enabled,
      offVariation: FAIL,
      fallthrough,
      rules: dedupeRuleDescriptions([...ov.rules, ...kept], c.fidelity),
      targets: ov.targets,
      prerequisites: [...prerequisites].sort().map((k) => ({ key: sanitizeKey(k), variation: PASS })),
    };
  };

  try {
    holdoutsAttached(ctx, gate, holdouts);
    const desired = translate(ctx, inline);
    const scheduled = scheduledChanges(ctx, inline, translate);
    if (!enabled) fidelity.push({ fidelity: 'full', message: `Disabled in StatSig: the flag is off in ${env.ld} and serves false.` });
    if (gate.lifecycle?.type === 'STALE') fidelity.push({ fidelity: 'full', message: `StatSig marks this gate stale (${gate.lifecycle.typeReason ?? 'STALE'}). Consider hard-coding it instead of migrating.` });
    return finish(scheduled.length ? { ...desired, scheduledChanges: scheduled } : desired);
  } catch (e) {
    if (e instanceof SkipItem) return finish(offEnv, e.reason);
    throw e;
  }
}

function serveFor(ctx: ConditionContext, gate: Gate, ruleId: string, ruleName: string, pass: number, idType: string): VariationOrRollout {
  if (pass >= 100) return { variation: PASS };
  if (pass <= 0) return { variation: FAIL };
  const choice = ctx.decisions.choose(
    {
      type: 'partial_rollout_rebucket',
      severity: 'acknowledge',
      subject: { ...ctx.subject, ruleId, ruleName, location: `rule “${ruleName}”` },
      path: `rule:${ruleId}:rollout`,
      title: `${pass}% rollout: users will be re-bucketed`,
      explanation: `StatSig buckets with sha256(salt.ruleSalt.unitID); LaunchDarkly buckets with hash(flagKey.salt.key). ${pass}% of users still pass, but not the same users: some who see the feature today won't, and others will.`,
      sourceFragment: { rule: ruleName, passPercentage: pass, idType },
      fingerprintOf: { passPercentage: pass },
      options: [
        { key: 'acknowledge', label: 'Acknowledge: users will be re-bucketed', explanation: 'Migrate the rollout with the same percentage.', resultingFidelity: 'partial' },
        { key: 'skip', label: 'Set StatSig to 0% or 100% first', explanation: 'Skip this item for now. Finish or roll back the rollout in StatSig, then migrate an exact 0%/100% rule.', resultingFidelity: 'skipped' },
      ],
      recommended: 'acknowledge',
    },
    'acknowledge',
  );
  if (choice === 'skip') throw new SkipItem(`waiting for the ${pass}% rollout in rule “${ruleName}” to finish`);
  ctx.fidelity.push({ fidelity: 'partial', message: `${pass}% rollout re-buckets users (StatSig and LaunchDarkly hash differently).`, location: `rule “${ruleName}”` });
  const weight = Math.round(pass * 1000);
  return { rollout: rolloutFor(resolveUnit(ctx, idType || gate.idType), [{ variation: PASS, weight }, { variation: FAIL, weight: 100_000 - weight }]) };
}

/** The gate's `holdoutIds` resolved against the snapshot, in id order; ids the snapshot lacks are left out. */
function attachedHoldouts(snapshot: CanonicalSnapshot, gate: Gate): Holdout[] {
  return [...gate.holdoutIds].sort().flatMap((id) => snapshot.holdouts.filter((h) => h.id === id).slice(0, 1));
}

/**
 * Edge case 4.8: a StatSig holdout forces `false` for its share of users before the rules run.
 * LD has nothing equivalent on a flag (LD holdouts are separate populations, PLAN §11), so each
 * active holdout is a `holdout_attached` acknowledgement; "skip" keeps the gate in StatSig.
 */
function holdoutsAttached(ctx: ConditionContext, gate: Gate, holdouts: Holdout[]): void {
  for (const id of [...gate.holdoutIds].sort()) {
    const h = holdouts.find((x) => x.id === id);
    if (!h) {
      ctx.fidelity.push({ fidelity: 'partial', message: `Holdout “${id}” is attached but isn't in this StatSig snapshot: its share of users (held out in StatSig) will get the feature in LaunchDarkly.`, location: `holdout “${id}”` });
      continue;
    }
    const name = h.name || h.id;
    const pct = h.passPercentage;
    if (h.archived || !h.enabled || pct <= 0) {
      ctx.fidelity.push({ fidelity: 'full', message: `Holdout “${name}” is ${h.archived ? 'archived' : !h.enabled ? 'disabled' : 'at 0%'} in StatSig, so it holds nobody out; nothing to carry over.`, location: `holdout “${name}”` });
      continue;
    }
    const unit = h.idType || gate.idType;
    const scope = h.targetingGateId ? ` among users who pass “${h.targetingGateId}”` : '';
    const choice = ctx.decisions.choose(
      {
        type: 'holdout_attached',
        severity: 'acknowledge',
        subject: { ...ctx.subject, location: `holdout “${name}”` },
        path: `holdout:${h.id}`,
        title: `Holdout “${name}” holds ${pct}% of users out of this gate`,
        explanation: `StatSig evaluates the ${h.isGlobal ? 'global ' : ''}holdout before the rules: ${pct}% of ${unit}s${scope} get false whatever the rules say. LaunchDarkly has no holdout on a single flag (LaunchDarkly holdouts are separate populations), so the migrated flag has no held-out share.`,
        sourceFragment: { holdoutId: h.id, passPercentage: pct, isGlobal: h.isGlobal, idType: h.idType, targetingGateId: h.targetingGateId },
        fingerprintOf: { holdoutId: h.id, passPercentage: pct },
        options: [
          { key: 'acknowledge', label: 'Migrate without the holdout', explanation: `${pct}% of users held out in StatSig will get the feature in LaunchDarkly once the flag serves it to them.`, resultingFidelity: 'partial' },
          { key: 'skip', label: 'Keep the gate in StatSig until the holdout ends', explanation: `Skip this item for now. End or remove the holdout in StatSig, then migrate the gate without it.`, resultingFidelity: 'skipped' },
        ],
        recommended: 'acknowledge',
      },
      'acknowledge',
    );
    if (choice === 'skip') throw new SkipItem(`holdout “${name}” (${pct}%) is still attached in StatSig`);
    ctx.fidelity.push({ fidelity: 'partial', message: `Holdout “${name}” (${pct}%) is not carried over: users it holds out in StatSig get the feature in LaunchDarkly.`, location: `holdout “${name}”` });
  }
}

export function expansion(ctx: ConditionContext, ruleId: string, ruleName: string, size: number): Dnf {
  const choice = ctx.decisions.choose(
    {
      type: 'rule_expansion',
      severity: 'blocking',
      subject: { ...ctx.subject, ruleId, ruleName, location: `rule “${ruleName}”` },
      path: `rule:${ruleId}:expansion`,
      title: `Rule “${ruleName}” expands into ${size} LaunchDarkly rules`,
      explanation: `Translating this rule's ORs (inlined gates, not_array_contains_all, on) would need more than ${MAX_EXPANSION} LaunchDarkly rules.`,
      sourceFragment: { rule: ruleName, size },
      options: [DROP_RULE, SKIP],
    },
    'drop_rule',
  );
  if (choice === 'skip') throw new SkipItem(`rule “${ruleName}” is too complex to translate`);
  return NEVER;
}

export interface GateRefOpts {
  ids: string[];
  negate: boolean;
  c: Condition;
  loc: Loc;
  prereqCandidate: string | null;
  hasPassOverrides: boolean;
  prerequisites: Set<string>;
}

export function gateReference(ctx: ConditionContext, state: InlineState, o: GateRefOpts): Dnf {
  const results = o.ids.map((id) => ({ id, r: inlineGate(ctx, state, id, o.negate) }));
  const failed = results.filter((x) => !x.r.ok);
  if (failed.length === 0) {
    for (const { id, r } of results) if (r.ok) ctx.fidelity.push({ fidelity: 'full', message: `Inlined ${o.negate ? '“fails' : '“passes'} ${id}” (${r.dnf.length} alternative${r.dnf.length === 1 ? '' : 's'}).`, location: `rule “${o.loc.ruleName}”` });
    return results.flatMap(({ r }) => (r.ok ? r.dnf : []));
  }

  const ref = o.ids.join(', ');
  const why = failed.map((f) => (f.r.ok ? '' : f.r.reason)).join('; ');
  const canPrereq = !o.negate && o.ids.length === 1 && o.prereqCandidate === o.ids[0] && ctx.capabilities.prerequisites !== 'unavailable' && ctx.capabilities.prerequisites !== 'not_permitted';
  const options = [
    ...(canPrereq
      ? [
          {
            key: 'prerequisite',
            label: `Use “${ref}” as a prerequisite`,
            explanation: `Every rule requires ${ref}, so a LaunchDarkly prerequisite on the migrated “${ref}” flag is equivalent${o.hasPassOverrides ? ', except that LaunchDarkly checks prerequisites before individual targets: overrides that pass this gate stop applying to users who fail the prerequisite' : ''}. Enterprise plans${ctx.capabilities.prerequisites === 'unknown' ? '; your plan is checked on the first write' : ''}. “${ref}” is migrated to the same environment first.`,
            resultingFidelity: o.hasPassOverrides ? ('partial' as const) : ('full' as const),
          },
        ]
      : []),
    DROP_CONDITION,
    DROP_RULE,
    SKIP,
  ];
  const choice = ctx.decisions.choose(
    {
      type: 'gate_reference',
      severity: canPrereq ? 'choice' : 'blocking',
      subject: { ...ctx.subject, location: `references ${ref}` },
      path: `ref:${o.negate ? 'fails' : 'passes'}:${ref}`,
      title: `${o.negate ? 'Fails' : 'Passes'} gate “${ref}” can't be inlined`,
      explanation: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
      sourceFragment: o.c.raw,
      fingerprintOf: { ids: o.ids, negate: o.negate, why, canPrereq },
      options,
      ...(canPrereq ? { recommended: 'prerequisite' } : {}),
    },
    canPrereq ? 'prerequisite' : 'drop_rule',
  );
  if (choice === 'prerequisite') {
    o.prerequisites.add(o.ids[0]!);
    if (o.hasPassOverrides) ctx.fidelity.push({ fidelity: 'partial', message: `Prerequisite “${ref}” is checked before individual targets.` });
    return ALWAYS;
  }
  if (choice === 'skip') throw new SkipItem(`gate reference to “${ref}” can't be translated`);
  ctx.fidelity.push({ fidelity: 'partial', message: choice === 'drop_condition' ? `Condition on gate “${ref}” dropped (the rule matches more users).` : `Rule requiring gate “${ref}” dropped.`, location: `rule “${o.loc.ruleName}”` });
  return choice === 'drop_condition' ? ALWAYS : NEVER;
}

/** The gate every rule requires via a single `passes_gate`, if there is one. */
export function commonPassesGate(ruleConditions: Condition[][]): string | null {
  if (ruleConditions.length === 0) return null;
  let common: string | null = null;
  for (const conds of ruleConditions) {
    const refs = conds.filter((c) => c.type === 'passes_gate' && !Array.isArray(c.targetValue)).map((c) => String(c.targetValue));
    if (refs.length === 0) return null;
    if (common === null) common = refs[0]!;
    if (!refs.includes(common)) return null;
  }
  return common;
}

/**
 * Overrides → individual targets (PLAN §10.2 step 4). Environment-specific overrides come first,
 * so they win over all-environment ones; LD allows each key in one variation only.
 */
function overrideTargets(ctx: ConditionContext, overrides: Gate['overrides']): ReturnType<typeof splitOverrides> {
  const ordered = [...overrides.filter((o) => o.environment !== null), ...overrides.filter((o) => o.environment === null)];
  const seen = new Map<string, number>();
  const groups = new Map<string, OverrideGroup>();
  let conflicts = 0;
  for (const o of ordered) {
    if (o.value.kind !== 'gate') continue;
    const unit = resolveUnit(ctx, o.unitType);
    const variation = o.value.pass ? PASS : FAIL;
    const gk = `${unit.contextKind}|${unit.attribute}|${variation}`;
    const g = groups.get(gk) ?? { ...unit, unitType: o.unitType, variation, values: [] };
    for (const id of o.ids) {
      const k = `${unit.contextKind}|${unit.attribute}|${id}`;
      const prev = seen.get(k);
      if (prev !== undefined) {
        if (prev !== variation) conflicts++;
        continue;
      }
      seen.set(k, variation);
      g.values.push(id);
    }
    groups.set(gk, g);
  }
  if (conflicts) ctx.fidelity.push({ fidelity: 'partial', message: `${conflicts} ID${conflicts === 1 ? ' is' : 's are'} overridden both to pass and to fail; the environment-specific (or first) override wins.` });
  return splitOverrides(ctx, [...groups.values()]);
}

function flagShell(ctx: ConditionContext, gate: Gate, alias: string, key: string): DesiredFlagShell {
  if (key !== gate.id) ctx.fidelity.push({ fidelity: 'full', message: `Flag key “${key}” differs from the StatSig name “${gate.id}” (LaunchDarkly keys allow letters, digits, . _ -).` });
  const tags = unique([TAG_MIGRATED, sourceTag(alias), ...gate.tags.map(sanitizeTag)].filter(Boolean));
  const renamed = gate.tags.filter((t) => sanitizeTag(t) !== t);
  if (renamed.length) ctx.fidelity.push({ fidelity: 'full', message: `Tag${renamed.length === 1 ? '' : 's'} ${renamed.map((t) => `“${t}”`).join(', ')} renamed to fit LaunchDarkly's tag format.` });

  const clientSideAvailability = chooseClientSideAvailability(ctx, gate.targetApps);

  const props = provenanceProperties(gate, alias, 'gate');

  return {
    key,
    name: flagName(ctx, gate.id, gate.name),
    description: gate.description ?? '',
    variations: [
      { value: true, name: 'Pass' },
      { value: false, name: 'Fail' },
    ],
    // Environments that aren't migrated (and new ones) serve false even if someone turns them on.
    defaults: { onVariation: FAIL, offVariation: FAIL },
    temporary: gate.lifecycle?.type !== 'PERMANENT',
    tags,
    clientSideAvailability,
    customProperties: props,
    ...chooseMaintainer(ctx, gate),
  };
}

/** PLAN §10.1: StatSig client SDKs see every config; LD flags are opt-in per SDK type. Shared by every flag-producing mapper. */
export function chooseClientSideAvailability(ctx: ConditionContext, targetApps: string[]): ClientSideAvailability {
  const csa = ctx.decisions.choose(
    {
      type: 'client_side_availability',
      severity: 'choice',
      subject: { ...ctx.subject, location: 'flag settings' },
      path: 'client_side_availability',
      title: 'Client-side availability',
      explanation: 'StatSig client SDKs can evaluate every gate. LaunchDarkly flags are only sent to client-side and mobile SDKs when you allow it.',
      sourceFragment: { targetApps },
      fingerprintOf: {},
      options: [
        { key: 'both', label: 'Client-side and mobile SDKs', explanation: 'Mirrors StatSig: any SDK can evaluate the flag.', resultingFidelity: 'full' },
        { key: 'mobile', label: 'Mobile SDKs only', explanation: 'Browser SDKs using the client-side ID won’t see the flag.', resultingFidelity: 'partial' },
        { key: 'server', label: 'Server-side SDKs only', explanation: 'Client and mobile SDKs won’t see the flag.', resultingFidelity: 'partial' },
      ],
      recommended: 'both',
    },
    'both',
  );
  return { usingEnvironmentId: csa === 'both', usingMobileKey: csa !== 'server' };
}

/** Provenance custom properties (PLAN §3.3) minus the per-environment sync entries. */
export function provenanceProperties(entity: { id: string; version?: number; owner?: { email?: string }; permalink?: string }, alias: string, statsigType: string, kind: MigrationSourceKind = SOURCE_KIND): Record<string, CustomProperty> {
  const label = SOURCE_KIND_LABEL[kind];
  const props: Record<string, CustomProperty> = {
    [PROP.kind]: { name: 'Migrated from', value: [kind] },
    [PROP.id]: { name: `${label} ID`, value: [entity.id] },
    [PROP.type]: { name: `${label} type`, value: [statsigType] },
    [PROP.source]: { name: `${label} source`, value: [alias] },
  };
  if (entity.version !== undefined) props[PROP.version] = { name: `${label} version`, value: [String(entity.version)] };
  if (entity.owner?.email) props[PROP.owner] = { name: `${label} owner`, value: [entity.owner.email] };
  if (entity.permalink) props[PROP.permalink] = { name: `${label} link`, value: [entity.permalink] };
  return props;
}

const RANK: Record<Fidelity, number> = { full: 0, partial: 1, manual: 2, skipped: 3 };

export function report(notes: FidelityNote[], skipped?: string): FidelityReport {
  if (skipped) return { overall: 'skipped', notes: [...notes, { fidelity: 'skipped', message: `Not migrated: ${skipped}.` }] };
  const overall = notes.reduce<Fidelity>((w, n) => (RANK[n.fidelity] > RANK[w] ? n.fidelity : w), 'full');
  return { overall, notes };
}

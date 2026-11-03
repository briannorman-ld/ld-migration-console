/**
 * Dynamic config → JSON multivariate LD flag (PLAN §10.1 "Config", §10.2; docs/KNOWN-EDGE-CASES.md §10).
 *
 * StatSig semantics (verified in reference/repos/node-js-server-sdk/src/Evaluator.ts `_evalConfig`):
 * rules are evaluated top-down and the FIRST rule whose conditions all match ends evaluation. Its
 * pass percentage then decides between the rule's `returnValue` (or, with variants, the bucketed
 * variant) and the config's `defaultValue`. There is no fall-through to later rules, a disabled
 * config returns the default for everyone, and overrides force a value before the rules.
 *
 * LD side: variation 0 is the default value (fallthrough and off), then every distinct rule /
 * variant / override value, deduplicated by value and named after its rule or variant. The list is
 * built from every rule of the config, not just this environment's, so the project-level shell is
 * the same whichever environment is migrated first (append-only, PLAN §7).
 */
import { fingerprint, overridesForEnvironment, resolveRulesForEnvironment, stableStringify, targetingFingerprint, type Config, type Rule } from '@sslm/canonical';
import { flagName, dedupeRuleDescriptions, andDnf, resolveKind, SkipItem, translateCondition, unique, type ConditionContext, resolveUnit, rolloutFor, splitOverrides, type OverrideGroup } from './conditions.ts';
import { DecisionCollector } from './decisions.ts';
import { chooseClientSideAvailability, commonPassesGate, expansion, gateReference, PASS, provenanceProperties, report, sourceTag, TAG_MIGRATED, type MapArgs, type MapOutcome } from './gate.ts';
import { chooseMaintainer } from './maintainer.ts';
import { sanitizeKey, sanitizeTag } from './profile.ts';
import type { InlineState } from './refs.ts';
import { scheduledChanges } from './schedule.ts';
import type { Dependency, DesiredFlagEnv, DesiredFlagShell, DesiredRule, DesiredTarget, FidelityNote, VariationOrRollout } from './types.ts';

/** Variation index of the config's `defaultValue`: fallthrough and off variation of every migrated config. */
export const DEFAULT = 0;

export interface ConfigMapResult extends MapOutcome {
  flagKey: string;
  shell: DesiredFlagShell;
  /** The desired targeting; a preview (recommended options applied) while decisions are open. */
  env: DesiredFlagEnv;
}

/** The flag's variations: distinct JSON values (stable key order), first come first indexed. */
class Variations {
  readonly list: { value: unknown; name: string }[] = [];
  private readonly byValue = new Map<string, number>();

  constructor(defaultValue: unknown) {
    this.add(defaultValue, 'Default');
  }

  add(value: unknown, name: string): number {
    const key = stableStringify(value);
    const hit = this.byValue.get(key);
    if (hit !== undefined) return hit;
    const base = name || `Value ${this.list.length}`;
    let label = base;
    for (let n = 2; this.list.some((v) => v.name === label); n++) label = `${base} (${n})`;
    this.list.push({ value, name: label });
    this.byValue.set(key, this.list.length - 1);
    return this.list.length - 1;
  }

  index(value: unknown): number {
    return this.byValue.get(stableStringify(value)) ?? this.add(value, '');
  }
}

export function mapConfig(args: MapArgs<Config>): ConfigMapResult {
  const { entity: config, canonical, profile, capabilities, env } = args;
  const snapshot = canonical.snapshot;
  const sourceId = config.source.sourceId;
  const decisions = new DecisionCollector(args.resolutions, profile);
  const fidelity: FidelityNote[] = [];
  const deps = new Map<string, Dependency>();
  const subject = { sourceId, kind: 'config' as const, uid: config.uid, id: config.id };
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
  const flagKey = sanitizeKey(config.id);
  const variations = collectVariations(config);
  const shell = flagShell(ctx, config, snapshot.source.alias, flagKey, variations);
  const offEnv: DesiredFlagEnv = { ldEnv: env.ld, statsigEnv: env.statsig, on: false, offVariation: DEFAULT, fallthrough: { variation: DEFAULT }, rules: [], targets: [], prerequisites: [] };
  const inline: InlineState = { env, stack: [], inlined: new Map(), cache: new Map() };

  const finish = (desired: DesiredFlagEnv, skipped?: string): ConfigMapResult => ({
    uid: config.uid,
    entityId: config.id,
    sourceId,
    flagKey,
    shell,
    env: desired,
    fidelity: report(fidelity, skipped),
    unresolved: decisions.unresolved,
    applied: decisions.applied,
    stale: decisions.stale,
    dependencies: [...deps.values()].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)),
    statsigFingerprint: fingerprint({ self: targetingFingerprint(config, env.statsig), inlined: [...inline.inlined.entries()].sort() }),
    decisionSetHash: decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  });

  if (config.archived) return finish(offEnv, 'archived in StatSig');

  /** The environment's targeting as of `c.nowMs`; re-run per scheduled flip (./schedule.ts), sharing `deps` and the kind cache. */
  const translate = (c: ConditionContext, state: InlineState): DesiredFlagEnv => {
    const resolved = resolveRulesForEnvironment(config.rules, env.statsig);
    for (const d of resolved.dropped) {
      const r = config.rules.find((x) => x.id === d.ruleId);
      c.fidelity.push({ fidelity: 'full', message: `Rule “${r?.name ?? d.ruleId}” doesn't apply in ${env.statsig} (${d.reason === 'not_enabled_in_environment' ? 'not enabled here' : 'environment tier is false here'}).` });
    }
    const rules = resolved.rules;
    const overrides = overridesForEnvironment(config.overrides, env.statsig);
    const hasPassOverrides = overrides.some((o) => o.value.kind !== 'group' && o.ids.length > 0);

    // PLAN §10.4 rule 1: every rule requires the same gate → an LD prerequisite is exact.
    const prereqCandidate = commonPassesGate(rules.map((r) => r.conditions));
    const prerequisites = new Set<string>();
    c.gateReference = (ids, negate, cond, loc) => gateReference(c, state, { ids, negate, c: cond, loc, prereqCandidate, hasPassOverrides, prerequisites });

    const out: DesiredRule[] = [];
    let fallthrough: VariationOrRollout = { variation: DEFAULT };
    rules: for (const r of rules) {
      const serve = serveFor(c, config, r, variations);
      const conds = r.conditions.map((cond, i) => translateCondition(c, cond, { ruleId: r.id, ruleName: r.name, index: i }));
      let dnf = andDnf(conds);
      if (!dnf) dnf = expansion(c, r.id, r.name, conds.reduce((n, d) => n * Math.max(d.length, 1), 1));
      if (dnf.length === 0) continue;
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
    }

    const ov = overrideTargets(c, overrides, variations);
    for (const key of [...prerequisites].sort()) deps.set(`flag:${sanitizeKey(key)}`, { kind: 'flag', key: sanitizeKey(key), entityId: key });
    return {
      ldEnv: env.ld,
      statsigEnv: env.statsig,
      on: config.enabled,
      offVariation: DEFAULT,
      fallthrough,
      rules: dedupeRuleDescriptions([...ov.rules, ...out], c.fidelity),
      targets: ov.targets,
      prerequisites: [...prerequisites].sort().map((k) => ({ key: sanitizeKey(k), variation: PASS })),
    };
  };

  try {
    const desired = translate(ctx, inline);
    const scheduled = scheduledChanges(ctx, inline, translate);
    if (!config.enabled) fidelity.push({ fidelity: 'full', message: `Disabled in StatSig: the flag is off in ${env.ld} and serves the default value.` });
    if (config.lifecycle?.type === 'STALE') fidelity.push({ fidelity: 'full', message: `StatSig marks this config stale (${config.lifecycle.typeReason ?? 'STALE'}). Consider hard-coding its value instead of migrating.` });
    if (config.schema) fidelity.push({ fidelity: 'full', message: 'The StatSig JSON schema is not carried over: LaunchDarkly JSON variations are not schema-validated.' });
    for (const h of config.holdoutIds) {
      const holdout = snapshot.holdouts.find((x) => x.id === h);
      const share = holdout ? `${holdout.passPercentage}% of users are` : 'Some users are';
      fidelity.push({ fidelity: 'partial', message: `${share} held out by “${h}” in StatSig and get the default value; LaunchDarkly holdouts aren't created yet, so they get the rules' values in LaunchDarkly.` });
    }
    return finish(scheduled.length ? { ...desired, scheduledChanges: scheduled } : desired);
  } catch (e) {
    if (e instanceof SkipItem) return finish(offEnv, e.reason);
    throw e;
  }
}

/** Every value the config can return, in a source-order-stable sequence: default, then rules (and their variants), then overrides. */
function collectVariations(config: Config): Variations {
  const vars = new Variations(config.defaultValue);
  for (const r of config.rules) {
    vars.add(r.returnValue ?? {}, r.name);
    for (const v of r.variants ?? []) vars.add(v.returnValue, v.name);
  }
  for (const o of config.overrides) if (o.value.kind === 'value') vars.add(o.value.returnValue, 'Override');
  return vars;
}

/** Thousandths of a percent (LD `WeightedVariation.weight`): the whole flag is 100 000. */
const WHOLE = 100_000;

/**
 * What a matching rule serves (KNOWN-EDGE-CASES 10.2–10.4): inside the pass percentage the rule's
 * value (or a variant), outside it the default. A rule whose value is the default serves the
 * default either way, so it needs no rollout and no re-bucketing acknowledgement.
 */
function serveFor(ctx: ConditionContext, config: Config, r: Rule, vars: Variations): VariationOrRollout {
  const pass = Math.min(100, Math.max(0, r.passPercentage));
  const valueIdx = vars.index(r.returnValue ?? {});
  const unit = resolveUnit(ctx, r.idType || config.idType);

  if (r.variants?.length) {
    // Variants split the rule's passing units by cumulative share (10.3); what they don't cover gets the rule's own value.
    const shares = r.variants.map((v) => ({ variation: vars.index(v.returnValue), share: Math.max(0, v.passPercentage) }));
    const covered = shares.reduce((n, s) => n + s.share, 0);
    if (covered > 100.001) throw new SkipItem(`variants of rule “${r.name}” add up to ${covered}%`);
    const remainder = Math.max(0, 100 - covered);
    if (remainder > 0.001) ctx.fidelity.push({ fidelity: 'full', message: `Variants cover ${covered}% of rule “${r.name}”; the other ${round2(remainder)}% get the rule's own value.`, location: `rule “${r.name}”` });
    const weights = new Map<number, number>();
    const put = (variation: number, weight: number) => weights.set(variation, (weights.get(variation) ?? 0) + weight);
    for (const s of shares) put(s.variation, (pass * s.share) / 100);
    if (remainder > 0) put(valueIdx, (pass * remainder) / 100);
    if (pass < 100) put(DEFAULT, 100 - pass);
    const live = [...weights.entries()].filter(([, w]) => w > 0);
    if (live.length <= 1) return { variation: live[0]?.[0] ?? DEFAULT };
    acknowledgeRebucket(ctx, r, pass, { variants: shares.map((s) => `${vars.list[s.variation]!.name} ${s.share}%`) });
    return { rollout: rolloutFor(unit, toThousandths(live)) };
  }

  if (valueIdx === DEFAULT) return { variation: DEFAULT };
  if (pass >= 100) return { variation: valueIdx };
  if (pass <= 0) return { variation: DEFAULT };
  acknowledgeRebucket(ctx, r, pass, {});
  const weight = Math.round(pass * 1000);
  return { rollout: rolloutFor(unit, [{ variation: valueIdx, weight }, { variation: DEFAULT, weight: WHOLE - weight }]) };
}

/**
 * Same decision type, path and fingerprint as the gate mapper's `partial_rollout_rebucket`, so one
 * policy covers gates and configs and a rule's acknowledgement survives a gate ↔ config comparison.
 */
function acknowledgeRebucket(ctx: ConditionContext, r: Rule, pass: number, extra: { variants?: string[] }): void {
  const split = extra.variants ? ` split ${extra.variants.join(' / ')}` : '';
  const choice = ctx.decisions.choose(
    {
      type: 'partial_rollout_rebucket',
      severity: 'acknowledge',
      subject: { ...ctx.subject, ruleId: r.id, ruleName: r.name, location: `rule “${r.name}”` },
      path: `rule:${r.id}:rollout`,
      title: extra.variants ? `${pass}% rollout${split}: users will be re-bucketed` : `${pass}% rollout: users will be re-bucketed`,
      explanation: `StatSig buckets with sha256(salt.ruleSalt.unitID); LaunchDarkly buckets with hash(flagKey.salt.key). The same shares of users get each value, but not the same users: some who see a value today will see another.`,
      sourceFragment: { rule: r.name, passPercentage: pass, idType: r.idType, ...(extra.variants ? { variants: extra.variants } : {}) },
      fingerprintOf: { passPercentage: pass, ...(extra.variants ? { variants: extra.variants } : {}) },
      options: [
        { key: 'acknowledge', label: 'Acknowledge: users will be re-bucketed', explanation: 'Migrate the rollout with the same percentages.', resultingFidelity: 'partial' },
        { key: 'skip', label: 'Set StatSig to 0% or 100% first', explanation: 'Skip this item for now. Finish or roll back the rollout in StatSig, then migrate an exact 0%/100% rule.', resultingFidelity: 'skipped' },
      ],
      recommended: 'acknowledge',
    },
    'acknowledge',
  );
  if (choice === 'skip') throw new SkipItem(`waiting for the ${pass}% rollout in rule “${r.name}” to finish`);
  ctx.fidelity.push({ fidelity: 'partial', message: `${pass}% rollout${split} re-buckets users (StatSig and LaunchDarkly hash differently).`, location: `rule “${r.name}”` });
}

/** Percent weights → thousandths summing to exactly 100 000 (rounding goes to the largest share). */
function toThousandths(live: [number, number][]): { variation: number; weight: number }[] {
  const out = live.map(([variation, pct]) => ({ variation, weight: Math.round(pct * 1000) }));
  const drift = WHOLE - out.reduce((n, w) => n + w.weight, 0);
  if (drift !== 0) out.reduce((a, b) => (b.weight > a.weight ? b : a)).weight += drift;
  return out;
}

/**
 * Overrides → individual targets (PLAN §10.2 step 4). Only spec sources carry config overrides,
 * with the forced value; a pass/fail override without a value can only serve the default.
 */
function overrideTargets(ctx: ConditionContext, overrides: Config['overrides'], vars: Variations): ReturnType<typeof splitOverrides> {
  const ordered = [...overrides.filter((o) => o.environment !== null), ...overrides.filter((o) => o.environment === null)];
  const seen = new Map<string, number>();
  const groups = new Map<string, OverrideGroup>();
  let conflicts = 0;
  let valueless = 0;
  for (const o of ordered) {
    if (o.ids.length === 0) continue;
    let variation: number;
    if (o.value.kind === 'value') variation = vars.index(o.value.returnValue);
    else if (o.value.kind === 'gate') {
      variation = DEFAULT;
      if (o.value.pass) valueless += o.ids.length;
    } else {
      ctx.fidelity.push({ fidelity: 'partial', message: `${o.ids.length} ${o.unitType} override${o.ids.length === 1 ? '' : 's'} to group “${o.value.groupName ?? o.value.groupId}” dropped: a config has no groups.` });
      continue;
    }
    const unit = resolveUnit(ctx, o.unitType);
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
  if (valueless) ctx.fidelity.push({ fidelity: 'partial', message: `${valueless} ID${valueless === 1 ? ' is' : 's are'} overridden to pass without a value; LaunchDarkly targets ${valueless === 1 ? 'it' : 'them'} to the default value.` });
  if (conflicts) ctx.fidelity.push({ fidelity: 'partial', message: `${conflicts} ID${conflicts === 1 ? ' is' : 's are'} overridden to two values; the environment-specific (or first) override wins.` });
  return splitOverrides(ctx, [...groups.values()]);
}

/**
 * Edge case 10.14: LaunchDarkly refuses a flag with fewer than two variations ("At least two
 * variations must be defined"), and a config whose rules all return the default has only one.
 * A second variation that no rule, rollout or target serves is added so the flag can exist; the
 * value is a placeholder of the default's JSON type, distinct from it (variation values must differ).
 */
export const UNUSED_VARIATION = 'Unused';

export function placeholderVariationValue(defaultValue: unknown): unknown {
  const same = (v: unknown) => stableStringify(v) === stableStringify(defaultValue);
  if (Array.isArray(defaultValue)) return same([]) ? [null] : [];
  if (defaultValue !== null && typeof defaultValue === 'object') return same({}) ? { unused: true } : {};
  if (typeof defaultValue === 'string') return same('') ? 'unused' : '';
  if (typeof defaultValue === 'number') return same(0) ? 1 : 0;
  if (typeof defaultValue === 'boolean') return !defaultValue;
  return {};
}

function flagShell(ctx: ConditionContext, config: Config, alias: string, key: string, vars: Variations): DesiredFlagShell {
  if (key !== config.id) ctx.fidelity.push({ fidelity: 'full', message: `Flag key “${key}” differs from the StatSig name “${config.id}” (LaunchDarkly keys allow letters, digits, . _ -).` });
  if (vars.list.length === 1) {
    vars.add(placeholderVariationValue(config.defaultValue), UNUSED_VARIATION);
    ctx.fidelity.push({ fidelity: 'full', message: `Every rule returns the default value, and LaunchDarkly needs two variations: a second variation “${UNUSED_VARIATION}” was added that nothing serves.` });
  }
  const tags = unique([TAG_MIGRATED, sourceTag(alias), ...config.tags.map(sanitizeTag)].filter(Boolean));
  const renamed = config.tags.filter((t) => sanitizeTag(t) !== t);
  if (renamed.length) ctx.fidelity.push({ fidelity: 'full', message: `Tag${renamed.length === 1 ? '' : 's'} ${renamed.map((t) => `“${t}”`).join(', ')} renamed to fit LaunchDarkly's tag format.` });
  return {
    key,
    name: flagName(ctx, config.id, config.name),
    description: config.description ?? '',
    variations: vars.list.map((v) => ({ ...v })),
    // Environments that aren't migrated (and new ones) serve the default even if someone turns them on.
    defaults: { onVariation: DEFAULT, offVariation: DEFAULT },
    temporary: config.lifecycle?.type !== 'PERMANENT',
    tags,
    clientSideAvailability: chooseClientSideAvailability(ctx, config.targetApps),
    customProperties: provenanceProperties(config, alias, 'config'),
    ...chooseMaintainer(ctx, config),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

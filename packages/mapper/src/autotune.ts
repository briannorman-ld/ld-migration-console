/**
 * StatSig autotune → LD multi-armed bandit (PLAN §11 "Autotune": an LD bandit, `type: mab`, drafted;
 * the success event becomes a metric). Pure and deterministic, like mapGate.
 *
 * What lands in LD, per environment:
 * - a JSON multivariate flag with one variation per variant (project-level shell + per-env targeting);
 * - a custom conversion metric for the success event (project-level);
 * - an experiment of type `mab` on the flag's default rule, created as a draft (per environment).
 *
 * The policy of §11 applies: nothing running is moved mid-flight. A running autotune raises
 * `autotune_running` (default: wait); a concluded one becomes a flag serving the winner at 100%.
 */
import { fingerprint, stableStringify, type Autotune } from '@sslm/canonical';
import { resolveKind, SkipItem, unique, type ConditionContext, resolveUnit, rolloutFor } from './conditions.ts';
import { DecisionCollector, SKIP } from './decisions.ts';
import { chooseClientSideAvailability, provenanceProperties, report, sourceTag, TAG_MIGRATED, type MapArgs, type MapOutcome } from './gate.ts';
import { sanitizeKey, sanitizeTag } from './profile.ts';
import type { Dependency, DesiredBandit, DesiredFlagEnv, DesiredFlagShell, DesiredMetric, DesiredTreatment, FidelityNote, VariationOrRollout } from './types.ts';

export type AutotuneState = 'not_started' | 'running' | 'concluded';

/** LD reallocates bandit traffic on this cadence. StatSig's exploration window isn't in the canonical model. */
export const BANDIT_REALLOCATION_MS = 60 * 60 * 1000;

export interface AutotuneMapResult extends MapOutcome {
  flagKey: string;
  shell: DesiredFlagShell;
  /** The flag's targeting; a preview (recommended options applied) while decisions are open. */
  env: DesiredFlagEnv;
  /** The drafted bandit, or null when only the flag is migrated (concluded, or no metric). */
  bandit: DesiredBandit | null;
  /** The success-event metric the bandit needs, or null when there is none to create. */
  metric: DesiredMetric | null;
  state: AutotuneState;
}

interface Arm {
  name: string;
  value: unknown;
  /** Thousandths of a percent, summing to 100 000 across arms. */
  weight: number;
  isWinner: boolean;
}

export function mapAutotune(args: MapArgs<Autotune>): AutotuneMapResult {
  const { entity: a, canonical, profile, capabilities, env } = args;
  const snapshot = canonical.snapshot;
  const sourceId = a.source.sourceId;
  const alias = snapshot.source.alias;
  const decisions = new DecisionCollector(args.resolutions, profile);
  const fidelity: FidelityNote[] = [];
  const deps = new Map<string, Dependency>();
  const subject = { sourceId, kind: 'autotune' as const, uid: a.uid, id: a.id };
  const ctx: ConditionContext = {
    profile,
    capabilities,
    snapshot,
    sourceId,
    idLists: canonical.idLists ?? {},
    nowMs: Date.parse(args.now),
    decisions,
    subject,
    fidelity,
    deps,
    userKind: 'user',
    kindCache: new Map(),
  };
  ctx.userKind = resolveKind(ctx, 'userID');
  const flagKey = sanitizeKey(a.id);
  const state: AutotuneState = a.winner ? 'concluded' : a.isStarted ? 'running' : 'not_started';
  const statsigFingerprint = fingerprint({ idType: a.idType, variants: a.variants.map((v) => [v.name, v.json, v.size ?? null]), successEvent: a.successEvent ?? null, isStarted: a.isStarted, winner: a.winner?.name ?? null });

  const emptyShell: DesiredFlagShell = {
    key: flagKey,
    name: a.name || a.id,
    description: a.description ?? '',
    variations: a.variants.map((v) => ({ value: v.json, name: v.name })),
    defaults: { onVariation: 0, offVariation: 0 },
    temporary: true,
    tags: [],
    clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: true },
    customProperties: {},
  };
  const offEnv: DesiredFlagEnv = { ldEnv: env.ld, statsigEnv: env.statsig, on: false, offVariation: 0, fallthrough: { variation: 0 }, rules: [], targets: [], prerequisites: [] };

  const finish = (out: { shell: DesiredFlagShell; env: DesiredFlagEnv; bandit: DesiredBandit | null; metric: DesiredMetric | null }, skipped?: string): AutotuneMapResult => ({
    uid: a.uid,
    entityId: a.id,
    sourceId,
    flagKey,
    ...out,
    state,
    fidelity: report(fidelity, skipped),
    unresolved: decisions.unresolved,
    applied: decisions.applied,
    stale: decisions.stale,
    dependencies: [...deps.values()].sort((x, y) => `${x.kind}:${x.key}`.localeCompare(`${y.kind}:${y.key}`)),
    statsigFingerprint,
    decisionSetHash: decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  });
  const skip = (reason: string) => finish({ shell: emptyShell, env: offEnv, bandit: null, metric: null }, reason);

  if (a.archived) return skip('archived in StatSig');
  if (a.variants.length === 0) return skip('has no variants');

  try {
    const unit = resolveUnit(ctx, a.idType || 'userID');
    const contextKind = unit.contextKind;
    const arms = buildArms(ctx, a);
    if (arms.length < 2) throw new SkipItem(`has a single value “${arms[0]?.name ?? ''}” (nothing to tune: hard-code it, or create a plain flag)`);
    if (flagKey !== a.id) fidelity.push({ fidelity: 'full', message: `Flag key “${flagKey}” differs from the StatSig name “${a.id}” (LD keys allow letters, digits, . _ -).` });

    // What the flag serves in this environment (PLAN §11 table, applied to autotunes).
    let on = false;
    let serve: VariationOrRollout = { variation: 0 };
    let bandit = true;
    if (state === 'concluded') {
      const w = arms.findIndex((x) => x.isWinner);
      if (w < 0) throw new SkipItem(`StatSig reports winner “${a.winner!.name}”, which is not one of its variants`);
      on = true;
      serve = { variation: w };
      bandit = false;
      fidelity.push({ fidelity: 'full', message: `Concluded in StatSig: winner “${arms[w]!.name}” is served to everyone, so no bandit is created in LD.` });
    } else {
      if (state === 'running') {
        const choice = decisions.choose(
          {
            type: 'autotune_running',
            severity: 'choice',
            subject,
            path: 'running',
            title: 'Running in StatSig: wait for a winner, or pre-stage the bandit?',
            explanation: `This autotune is still exploring ${arms.length} arms in StatSig. LD can't take over its learned allocation: a new LD bandit starts from equal traffic and learns again. The default is to wait and migrate the winner once StatSig picks it.`,
            sourceFragment: { isStarted: a.isStarted, winner: a.winner, variants: a.variants.map((v) => v.name) },
            fingerprintOf: { isStarted: a.isStarted },
            options: [
              { key: 'wait', label: 'Wait: migrate after StatSig picks a winner', explanation: 'Skip for now. The item shows “running in StatSig”; once it concludes, the winner migrates as a flag at 100%.', resultingFidelity: 'skipped' },
              { key: 'prestage', label: 'Pre-stage: flag (off) and a draft bandit now', explanation: 'Creates the JSON flag, the success metric and an LD bandit draft. Nothing is served until you turn the flag on and start the bandit in LD.', resultingFidelity: 'partial' },
            ],
            recommended: 'wait',
          },
          'wait',
        );
        if (choice === 'wait') throw new SkipItem(`running in StatSig (${arms.length} arms); migrate after it picks a winner`);
        fidelity.push({ fidelity: 'partial', message: `Pre-staged while running in StatSig: the LD bandit starts from equal traffic; StatSig's learned allocation doesn't carry over.` });
      } else {
        fidelity.push({ fidelity: 'full', message: `Not started in StatSig: the flag is created off with a draft bandit. Start it from LD when ready.` });
      }
      serve = { rollout: rolloutFor(unit, arms.map((x, i) => ({ variation: i, weight: x.weight }))) };
    }

    // Metric (PLAN §11 "Metrics are the critical path").
    let metric: DesiredMetric | null = null;
    if (bandit) {
      if (a.successEvent) {
        const key = sanitizeKey(a.successEvent);
        metric = {
          key,
          name: a.successEvent,
          description: `Success event of StatSig autotune “${a.id}” (source ${alias}).`,
          kind: 'custom',
          eventKey: a.successEvent,
          isNumeric: false,
          successCriteria: 'HigherThanBaseline',
          tags: unique([TAG_MIGRATED, sourceTag(alias)]),
          analysisUnits: [contextKind],
        };
        deps.set(`metric:${key}`, { kind: 'metric', key, entityId: a.successEvent });
        fidelity.push({ fidelity: 'full', message: `Success event “${a.successEvent}” becomes the LD metric “${key}”. Your app must send it through LD track("${a.successEvent}").` });
      } else {
        const fromSpec = a.completeness.missing.includes('metrics');
        const choice = decisions.choose(
          {
            type: 'missing_metric',
            severity: 'blocking',
            subject,
            path: 'metric',
            title: 'No success event: the bandit has nothing to optimize',
            explanation: fromSpec
              ? 'Config specs don’t carry an autotune’s success event. Connect this project through the Console API to migrate the bandit, or create the flag only and add the metric and bandit in LD by hand.'
              : 'This autotune has no success event in StatSig, so LD can’t create a bandit for it.',
            sourceFragment: { successEvent: a.successEvent ?? null, missing: a.completeness.missing },
            fingerprintOf: { fromSpec },
            options: [
              { key: 'flag_only', label: 'Create the flag only', explanation: 'The JSON flag is created off with equal traffic to every arm. Create a metric and the bandit in LD yourself.', resultingFidelity: 'manual' },
              SKIP,
            ],
          },
          'flag_only',
        );
        if (choice === 'skip') throw new SkipItem('has no success event to turn into a metric');
        bandit = false;
        fidelity.push({ fidelity: 'manual', message: 'No success event: the flag is created without a bandit. Add a metric and a multi-armed bandit on it in LD.' });
      }
    }
    if (bandit && unit.attribute !== 'key') fidelity.push({ fidelity: 'partial', message: `Randomizes by the user key: LD experiments randomize by context kind, not by the user attribute “${unit.attribute}” that ${a.idType} maps to.` });
    if (bandit && contextKind !== 'user') {
      deps.set(`randomization_unit:${contextKind}`, { kind: 'randomization_unit', key: contextKind, entityId: a.idType });
      fidelity.push({ fidelity: 'full', message: `Randomizes by “${contextKind}”: the migration enables it as a randomization unit in the LD project's experimentation settings.` });
    }

    const tags = unique([TAG_MIGRATED, sourceTag(alias), ...a.tags.map(sanitizeTag)].filter(Boolean));
    const renamed = a.tags.filter((t) => sanitizeTag(t) !== t);
    if (renamed.length) fidelity.push({ fidelity: 'full', message: `Tag${renamed.length === 1 ? '' : 's'} ${renamed.map((t) => `“${t}”`).join(', ')} renamed to fit LD's tag format.` });
    const shell: DesiredFlagShell = {
      key: flagKey,
      name: a.name || a.id,
      description: a.description ?? '',
      variations: arms.map((x) => ({ value: x.value, name: x.name })),
      // Unmigrated (and new) environments serve the first arm, as does "off".
      defaults: { onVariation: 0, offVariation: 0 },
      temporary: true,
      tags,
      clientSideAvailability: chooseClientSideAvailability(ctx, a.targetApps),
      customProperties: provenanceProperties(a, alias, 'autotune'),
    };
    const desiredEnv: DesiredFlagEnv = { ldEnv: env.ld, statsigEnv: env.statsig, on, offVariation: 0, fallthrough: serve, rules: [], targets: [], prerequisites: [] };
    const desiredBandit: DesiredBandit | null =
      bandit && metric
        ? {
            key: flagKey,
            ldEnv: env.ld,
            statsigEnv: env.statsig,
            name: a.name || a.id,
            description: a.description ?? '',
            hypothesis: `Migrated from StatSig autotune “${a.id}”${a.description ? `: ${a.description}` : ''}. Maximize “${a.successEvent}”.`,
            flagKey,
            ruleId: 'fallthrough',
            treatments: arms.map<DesiredTreatment>((x, i) => ({ name: x.name, baseline: i === 0, allocationPercent: percent(x.weight), variation: i })),
            metricKey: metric.key,
            randomizationUnit: contextKind,
            reallocationFrequencyMillis: BANDIT_REALLOCATION_MS,
            tags,
          }
        : null;
    if (desiredBandit) fidelity.push({ fidelity: 'full', message: `“${arms[0]!.name}” is the bandit's baseline arm (LD needs one; StatSig has none).` });
    return finish({ shell, env: desiredEnv, bandit: desiredBandit, metric });
  } catch (e) {
    if (e instanceof SkipItem) return skip(e.reason);
    throw e;
  }
}

/**
 * Variants → arms. LD variations must have distinct values, so variants with the same JSON are
 * merged (`duplicate_variant_value`), and sizes are normalized to thousandths summing to 100%.
 */
function buildArms(ctx: ConditionContext, a: Autotune): Arm[] {
  const groups = new Map<string, { names: string[]; value: unknown; size: number; isWinner: boolean }>();
  const defaultSize = 100 / a.variants.length;
  let sizeTotal = 0;
  for (const v of a.variants) {
    const size = v.size ?? defaultSize;
    sizeTotal += size;
    const k = stableStringify(v.json);
    const g = groups.get(k) ?? { names: [], value: v.json, size: 0, isWinner: false };
    g.names.push(v.name);
    g.size += size;
    g.isWinner ||= a.winner?.name === v.name || a.winner?.id === v.id;
    groups.set(k, g);
  }
  const dupes = [...groups.values()].filter((g) => g.names.length > 1);
  if (dupes.length) {
    const choice = ctx.decisions.choose(
      {
        type: 'duplicate_variant_value',
        severity: 'choice',
        subject: ctx.subject,
        path: 'duplicate_values',
        title: `${dupes.length === 1 ? 'Two variants serve' : 'Several variants serve'} the same value`,
        explanation: `LD flag variations must have distinct values. ${dupes.map((d) => d.names.map((n) => `“${n}”`).join(' and ')).join('; ')} return identical JSON, so LD can't tell them apart.`,
        sourceFragment: dupes.map((d) => ({ variants: d.names, json: d.value })),
        options: [
          { key: 'merge', label: 'Merge them into one arm', explanation: 'One LD variation (and bandit arm) with their combined traffic. Users see the same values as in StatSig; the bandit just has fewer arms.', resultingFidelity: 'partial' },
          SKIP,
        ],
        recommended: 'merge',
      },
      'merge',
    );
    if (choice === 'skip') throw new SkipItem('has variants with identical values');
    ctx.fidelity.push({ fidelity: 'partial', message: `Merged ${dupes.map((d) => d.names.map((n) => `“${n}”`).join(' + ')).join(', ')}: identical values become one arm.` });
  }
  const list = [...groups.values()];
  if (Math.abs(sizeTotal - 100) > 0.01 && a.variants.some((v) => v.size !== undefined)) {
    ctx.fidelity.push({ fidelity: 'full', message: `Variant sizes add up to ${round2(sizeTotal)}%, not 100%; normalized to ${list.map((g) => percent(Math.round((g.size / sizeTotal) * 100_000))).join('/')}%.` });
  }
  // Thousandths that sum exactly to 100 000: round each, then put the rounding remainder on the first arm.
  const weights = list.map((g) => Math.round((g.size / sizeTotal) * 100_000));
  weights[0]! += 100_000 - weights.reduce((n, w) => n + w, 0);
  return list.map((g, i) => ({ name: g.names.join(' / '), value: g.value, weight: weights[i]!, isWinner: g.isWinner }));
}

/** Thousandths → LD's percent string, e.g. 33340 → "33.34". */
export function percent(weight: number): string {
  return (Math.round(weight / 10) / 100).toString();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Scheduled changes for `time` conditions (PLAN §5.1, §8.3 `time_condition` → "schedule").
 *
 * A StatSig `time` condition compares the SDK clock, which no LD clause can do. When the user
 * chooses to schedule, the flag is mapped as of now (the condition resolved statically) and then
 * mapped again as of each future flip; every re-mapping becomes one LD scheduled change carrying
 * the *whole* targeting of that moment, so the flag converges on the right state whether LD
 * applies the change or a later sync writes it directly. Full-state changes also make re-syncs
 * trivial: the previous run's scheduled changes are deleted and recreated.
 */
import { DecisionCollector } from './decisions.ts';
import type { ConditionContext } from './conditions.ts';
import type { InlineState } from './refs.ts';
import type { DesiredFlagEnv, DesiredScheduledChange } from './types.ts';

export function scheduledChanges(ctx: ConditionContext, inline: InlineState, translate: (c: ConditionContext, state: InlineState) => DesiredFlagEnv): DesiredScheduledChange[] {
  const flips = [...(ctx.scheduleFlips ?? [])].filter((t) => t > ctx.nowMs).sort((a, b) => a - b);
  const out: DesiredScheduledChange[] = [];
  for (const t of flips) {
    const when = new Date(t).toISOString().replace('.000Z', 'Z');
    // Same decisions (same ids and fingerprints, so the same answers), a throwaway collector and
    // note list: only the resulting state matters. `deps` and the kind cache are shared on purpose.
    const inner: ConditionContext = { ...ctx, nowMs: t + 1, decisions: new DecisionCollector(ctx.decisions.resolutions, ctx.profile), fidelity: [], kindCache: ctx.kindCache, deps: ctx.deps };
    delete inner.scheduleFlips;
    const state: InlineState = { env: inline.env, stack: [], inlined: inline.inlined, cache: new Map() };
    const env = translate(inner, state);
    out.push({
      executionDate: when,
      description: `Targeting as of ${when} (StatSig time condition)`,
      state: { on: env.on, offVariation: env.offVariation, fallthrough: env.fallthrough, rules: env.rules, targets: env.targets, prerequisites: env.prerequisites },
    });
  }
  if (out.length) ctx.fidelity.push({ fidelity: 'full', message: `${out.length} LaunchDarkly scheduled change${out.length === 1 ? '' : 's'} (${out.map((c) => c.executionDate).join(', ')}) flip the targeting when the time conditions do.` });
  return out;
}

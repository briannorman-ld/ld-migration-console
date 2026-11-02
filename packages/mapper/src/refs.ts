/**
 * Gate references (PLAN §10.4). A `passes_gate X` is inlined when that is exact: X's rules all pass
 * 100% (trailing 0% rules are harmless), so "X passes" is the OR of its rules, plus its pass
 * overrides, minus its fail overrides. Otherwise the caller decides (prerequisite, drop, skip).
 */
import { overridesForEnvironment, resolveRulesForEnvironment, targetingFingerprint, type Gate } from '@sslm/canonical';
import { ALWAYS, andDnf, MAX_EXPANSION, NEVER, notDnf, resolveKind, translateCondition, type ConditionContext, type Dnf, resolveUnit } from './conditions.ts';
import type { EnvTarget, LdClause } from './types.ts';

const MAX_DEPTH = 4;

export type InlineResult = { ok: true; dnf: Dnf; gate: Gate } | { ok: false; reason: string };

export interface InlineState {
  env: EnvTarget;
  /** Gates currently being inlined (cycle detection). */
  stack: string[];
  /** Fingerprints of every inlined gate, so drift in X shows up as drift in the referencing gate. */
  inlined: Map<string, string>;
  cache: Map<string, InlineResult>;
}

export function inlineGate(ctx: ConditionContext, state: InlineState, gateId: string, negate: boolean): InlineResult {
  const cacheKey = `${gateId}|${negate}|${state.stack.join('>')}`;
  const hit = state.cache.get(cacheKey);
  if (hit) return hit;
  // If inlining fails half-way, forget the decisions, notes and dependencies it raised.
  const mark = ctx.decisions.mark();
  const fidelity = ctx.fidelity.length;
  const deps = new Map(ctx.deps);
  const inlined = new Map(state.inlined);
  const r = computeInline(ctx, state, gateId, negate);
  if (!r.ok) {
    ctx.decisions.rollback(mark);
    ctx.fidelity.length = fidelity;
    ctx.deps.clear();
    deps.forEach((v, k) => ctx.deps.set(k, v));
    state.inlined.clear();
    inlined.forEach((v, k) => state.inlined.set(k, v));
  }
  state.cache.set(cacheKey, r);
  return r;
}

function computeInline(ctx: ConditionContext, state: InlineState, gateId: string, negate: boolean): InlineResult {
  const gate = ctx.snapshot.gates.find((g) => g.id === gateId);
  if (!gate) return { ok: false, reason: `gate “${gateId}” is not in this StatSig snapshot` };
  if (gate.archived) return { ok: false, reason: `gate “${gateId}” is archived` };
  if (state.stack.includes(gateId) || gate.uid === ctx.subject.uid) return { ok: false, reason: `gate references form a cycle (${[...state.stack, gateId].join(' → ')})` };
  if (state.stack.length >= MAX_DEPTH) return { ok: false, reason: `gate references nest deeper than ${MAX_DEPTH}` };
  state.inlined.set(gate.id, targetingFingerprint(gate, state.env.statsig));
  if (!gate.enabled) return { ok: true, dnf: negate ? ALWAYS : NEVER, gate };

  const rules = resolveRulesForEnvironment(gate.rules, state.env.statsig).rules;
  while (rules.length && rules[rules.length - 1]!.passPercentage === 0) rules.pop();
  const partial = rules.find((r) => r.passPercentage !== 100);
  if (partial) return { ok: false, reason: `gate “${gateId}” has a ${partial.passPercentage}% rollout in rule “${partial.name}”, which can't be inlined exactly` };

  const overrides = overridesForEnvironment(gate.overrides, state.env.statsig);
  if (negate && overrides.some((o) => o.ids.length)) return { ok: false, reason: `gate “${gateId}” has overrides, so “fails ${gateId}” can't be inlined exactly` };

  const inner: ConditionContext = {
    ...ctx,
    pathPrefix: `${ctx.pathPrefix ? `${ctx.pathPrefix} › ` : ''}via ${gateId}`,
    gateReference: (ids, neg, c, loc) => {
      const parts: Dnf[] = [];
      for (const id of ids) {
        const res = inlineGate(inner, { ...state, stack: [...state.stack, gateId] }, id, neg);
        if (!res.ok) throw new NotInlinable(res.reason);
        parts.push(res.dnf);
      }
      // multi_pass / multi_fail: any listed gate passing (or failing) is enough.
      return parts.flat();
    },
  };

  let ruleTerms: Dnf = [];
  try {
    for (const r of rules) {
      const conds = r.conditions.map((c, i) => translateCondition(inner, c, { ruleId: r.id, ruleName: r.name, index: i }));
      const d = andDnf(conds);
      if (!d) return { ok: false, reason: `gate “${gateId}” expands into more than ${MAX_EXPANSION} LD rules` };
      ruleTerms.push(...d);
    }
  } catch (e) {
    if (e instanceof NotInlinable) return { ok: false, reason: e.message };
    throw e;
  }
  if (ruleTerms.some((t) => t.length === 0)) ruleTerms = ALWAYS;

  if (negate) {
    const d = notDnf(ruleTerms);
    return d ? { ok: true, dnf: d, gate } : { ok: false, reason: `“fails ${gateId}” expands into more than ${MAX_EXPANSION} LD rules` };
  }

  // StatSig checks overrides before rules: pass = passIds ∨ (¬failIds ∧ rules).
  const passTerms: Dnf = [];
  const failClauses: LdClause[] = [];
  for (const o of overrides) {
    if (o.value.kind !== 'gate' || o.ids.length === 0) continue;
    const { contextKind, attribute } = resolveUnit(ctx, o.unitType);
    if (o.value.pass) passTerms.push([{ contextKind, attribute, op: 'in', values: o.ids, negate: false }]);
    else failClauses.push({ contextKind, attribute, op: 'in', values: o.ids, negate: true });
  }
  const dnf = [...passTerms, ...ruleTerms.map((t) => [...t, ...failClauses])];
  if (dnf.length > MAX_EXPANSION) return { ok: false, reason: `gate “${gateId}” expands into more than ${MAX_EXPANSION} LD rules` };
  return { ok: true, dnf, gate };
}

class NotInlinable extends Error {}

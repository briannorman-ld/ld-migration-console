import { fingerprint } from '@sslm/canonical';
import { attributeTarget, isValidContextKindKey, unitFromChoice } from './profile.ts';
import type { AppliedDecision, DecisionOption, DecisionPoint, DecisionSubject, DecisionType, MappingProfile, Resolution, Severity, StaleDecision } from './types.ts';

export interface DecisionSpec {
  type: DecisionType;
  severity: Severity;
  subject: DecisionSubject;
  /** Distinguishes several decisions of one type on one subject, e.g. `rule:<id>:cond:2`. */
  path: string;
  title: string;
  explanation: string;
  sourceFragment: unknown;
  /** What makes two decisions "the same question" (defaults to the fragment). */
  fingerprintOf?: unknown;
  options: DecisionOption[];
  recommended?: string;
}

export function decisionPoint(spec: DecisionSpec): DecisionPoint {
  const { path, fingerprintOf, ...rest } = spec;
  return {
    ...rest,
    id: `${spec.type}:${spec.subject.uid}:${path}`,
    fingerprint: fingerprint({ type: spec.type, fragment: fingerprintOf ?? spec.sourceFragment }),
  };
}

export type Lookup = { status: 'resolved'; optionKey: string; via: AppliedDecision['via'] } | { status: 'unresolved'; stale?: Resolution };

/**
 * Resource-scope resolutions win over workspace policies. A resource resolution whose fingerprint
 * no longer matches is stale: the question is asked again, showing the old answer (PLAN §8.1).
 * A policy applies only if its option still exists for this decision.
 */
/**
 * Whether an answer is one this decision takes: a listed option, or, for `unit_type_kind`, a
 * `create:<key>` the user typed for a kind under a valid LD key (the card's free-text answer) or
 * an `attribute:` target the Unit types page can set (an attribute of `user` or of any kind).
 */
export function acceptsOption(dp: Pick<DecisionPoint, 'type' | 'options'>, optionKey: string): boolean {
  if (dp.options.some((o) => o.key === optionKey)) return true;
  // `maintainer_unknown` also takes a member or team the user picked on the People step.
  if (dp.type === 'maintainer_unknown') return /^(member|team):.+/.test(optionKey);
  if (dp.type !== 'unit_type_kind') return false;
  if (optionKey.startsWith('create:')) return isValidContextKindKey(optionKey.slice('create:'.length));
  if (optionKey.startsWith('attribute:')) return attributeTarget(optionKey) !== undefined;
  return false;
}

export function lookupResolution(dp: DecisionPoint, resolutions: ReadonlyMap<string, Resolution>, profile: MappingProfile): Lookup {
  const r = resolutions.get(dp.id);
  let stale: Resolution | undefined;
  if (r && r.scope === 'resource') {
    if (r.fingerprint === dp.fingerprint && acceptsOption(dp, r.optionKey)) return { status: 'resolved', optionKey: r.optionKey, via: 'resource' };
    stale = r;
  }
  const policy = profile.policies[dp.type];
  if (policy && acceptsOption(dp, policy)) return { status: 'resolved', optionKey: policy, via: 'policy' };
  return stale ? { status: 'unresolved', stale } : { status: 'unresolved' };
}

/**
 * Collects decisions while mapping one entity. `choose` returns the option to *preview* with:
 * the resolution if there is one, otherwise the recommended option (or `fallback` for blocking
 * decisions). Unresolved decisions are still reported, so the item can't migrate until the user
 * answers; the preview just shows what the recommended answer would produce.
 */
export class DecisionCollector {
  readonly applied: AppliedDecision[] = [];
  readonly unresolved: DecisionPoint[] = [];
  readonly stale: StaleDecision[] = [];
  private readonly seen = new Set<string>();

  constructor(
    readonly resolutions: ReadonlyMap<string, Resolution>,
    readonly profile: MappingProfile,
  ) {}

  choose(spec: DecisionSpec, fallback: string): string {
    return this.chooseEx(spec, fallback).choice;
  }

  /** Like `choose`, and says whether the answer came from a resolution or is only a preview. */
  chooseEx(spec: DecisionSpec, fallback: string): { choice: string; resolved: boolean } {
    const dp = decisionPoint(spec);
    const l = lookupResolution(dp, this.resolutions, this.profile);
    const first = !this.seen.has(dp.id);
    this.seen.add(dp.id);
    if (l.status === 'resolved') {
      if (first) this.applied.push({ decision: dp, optionKey: l.optionKey, via: l.via });
      return { choice: l.optionKey, resolved: true };
    }
    if (first) {
      this.unresolved.push(dp);
      if (l.stale) this.stale.push({ decision: dp, previous: l.stale });
    }
    return { choice: dp.recommended ?? fallback, resolved: false };
  }

  /** Checkpoint, so a translation attempt that turns out impossible leaves no stray decisions. */
  mark(): { applied: number; unresolved: number; stale: number; seen: Set<string> } {
    return { applied: this.applied.length, unresolved: this.unresolved.length, stale: this.stale.length, seen: new Set(this.seen) };
  }

  rollback(m: ReturnType<DecisionCollector['mark']>): void {
    this.applied.length = m.applied;
    this.unresolved.length = m.unresolved;
    this.stale.length = m.stale;
    this.seen.clear();
    m.seen.forEach((s) => this.seen.add(s));
  }

  /** Hash of every applied resolution: stored in provenance as `decisionSetHash` (PLAN §3.3). */
  setHash(): string {
    return fingerprint(this.applied.map((a) => [a.decision.id, a.decision.fingerprint, a.optionKey]).sort());
  }
}

// Option helpers shared by several decision types.
export const SKIP: DecisionOption = { key: 'skip', label: 'Skip this item', explanation: "Don't migrate it. It stays in StatSig only.", resultingFidelity: 'skipped' };
export const DROP_RULE: DecisionOption = { key: 'drop_rule', label: 'Drop the rule', explanation: 'The LD flag will not have this rule. Users it matched fall through to the next rule.', resultingFidelity: 'partial' };
export const DROP_CONDITION: DecisionOption = { key: 'drop_condition', label: 'Drop the condition', explanation: 'Keep the rule without this condition, so it matches more users than in StatSig.', resultingFidelity: 'partial' };

/**
 * Label for an answer, including answers that are not one of the listed options: a
 * `unit_type_kind` decision also accepts `create:<key>` for a kind the user named.
 */
export function optionLabel(d: Pick<DecisionPoint, 'type' | 'options'>, optionKey: string): string {
  const o = d.options.find((x) => x.key === optionKey);
  if (o) return o.label;
  if (d.type === 'unit_type_kind' && optionKey.startsWith('create:')) return `Create context kind “${optionKey.slice('create:'.length)}”`;
  const attr = d.type === 'unit_type_kind' ? attributeTarget(optionKey) : undefined;
  if (attr) return `Keep “${attr.attribute}” as an attribute of the ${attr.contextKind} context`;
  if (d.type === 'maintainer_unknown' && optionKey.startsWith('member:')) return `Assign LD member ${optionKey.slice('member:'.length)}`;
  if (d.type === 'maintainer_unknown' && optionKey.startsWith('team:')) return `Assign the team “${optionKey.slice('team:'.length)}”`;
  return optionKey;
}

/**
 * Context kinds that other `unit_type_kind` answers in this workspace already create or map to
 * (as their key, or as the kind that carries their attribute), by kind key → the unit types that
 * chose it. A unit type decided later can pick one of these
 * instead of creating a second kind for the same concept (`planKey` and `plan_id` → `plan`).
 * Read from the resolutions and the profile; the mapper stays pure.
 */
export function plannedContextKinds(resolutions: ReadonlyMap<string, Resolution>, profile: MappingProfile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (kind: string, unitType: string) => {
    if (!kind || kind === 'user' || !isValidContextKindKey(kind)) return;
    const list = out.get(kind) ?? [];
    if (!list.includes(unitType)) list.push(unitType);
    out.set(kind, list);
  };
  for (const r of resolutions.values()) {
    if (r.type !== 'unit_type_kind' || r.scope !== 'resource') continue;
    // Decision ids are `unit_type_kind:<sourceId>/unit_type/<unitType>:kind`.
    const unitType = r.id.match(/\/unit_type\/([^:]+):kind$/)?.[1] ?? r.id;
    add(unitFromChoice(r.optionKey, '').contextKind, unitType);
  }
  for (const sp of Object.values(profile.sources)) {
    for (const [unitType, v] of Object.entries(sp.unitTypeKinds)) add(v.startsWith('attribute:') ? (attributeTarget(v)?.contextKind ?? '') : v, unitType);
  }
  return out;
}

/** The "use the kind another unit type already creates" options for a `unit_type_kind` decision. */
export function plannedKindOptions(planned: Map<string, string[]>, exclude: Set<string>, unitType: string, canCreate: boolean): DecisionOption[] {
  return [...planned.entries()]
    .filter(([k]) => !exclude.has(k))
    .map(([k, by]) => ({
      key: `create:${k}`,
      label: `Use the kind “${k}”, which this migration creates`,
      explanation: `Chosen for ${by.join(', ')}. ${unitType} is keyed by the same “${k}” context${canCreate ? '; the kind is created once' : ''}.`,
      resultingFidelity: 'full' as const,
    }));
}

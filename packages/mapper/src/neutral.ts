/**
 * Neutral model → desired LD state (PLAN §20.3). Today the neutral block is filled only by the
 * LaunchDarkly source adapter, so this is a near-identity mapping: what is copied verbatim is
 * copied verbatim, and every real difference between the source and the target project is a
 * decision or a fidelity note (CLAUDE.md: never silently drop or approximate). Pure and
 * deterministic, like the StatSig mappers.
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
  type NeutralClause,
  type NeutralFlag,
  type NeutralFlagEnv,
  type NeutralSegment,
  type NeutralServe,
} from '@sslm/canonical';
import { dedupeRuleDescriptions, LIST_SEGMENT_MAX, SkipItem, unique } from './conditions.ts';
import { DecisionCollector, DROP_CONDITION, DROP_RULE, SKIP, plannedContextKinds, plannedKindOptions } from './decisions.ts';
import { provenanceProperties, report, type MapArgs, type MapOutcome } from './gate.ts';
import { chooseMaintainer } from './maintainer.ts';
import { configuredUnit, kindFromChoice, sanitizeTag } from './profile.ts';
import type { CustomProperty, DecisionOption, DecisionSubject, Dependency, DesiredFlagEnv, DesiredFlagShell, DesiredRule, DesiredSegment, DesiredSegmentRule, DesiredTarget, FidelityNote, LdClause, LdOperator, VariationOrRollout } from './types.ts';

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

const sourceLabel = (ctx: Ctx) => (ctx.kind === 'launchdarkly' ? 'the source project' : 'the source');

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

type ClauseOutcome = { kind: 'clause'; clause: LdClause } | { kind: 'drop_condition' } | { kind: 'drop_rule' };

interface Loc {
  ruleId: string;
  ruleName: string;
  index: number;
}

function translateClause(ctx: Ctx, c: NeutralClause, loc: Loc, env: string, inSegment: boolean): ClauseOutcome {
  const where = `rule “${loc.ruleName}” › clause ${loc.index + 1}`;
  const path = `rule:${loc.ruleId}:clause:${loc.index}`;
  if (!LD_OPERATORS.has(c.op) || (inSegment && c.op === 'segmentMatch')) {
    const choice = ctx.decisions.choose(
      {
        type: 'unsupported_condition',
        severity: 'blocking',
        subject: { ...ctx.subject, ruleId: loc.ruleId, ruleName: loc.ruleName, location: where },
        path,
        title: inSegment && c.op === 'segmentMatch' ? 'Segment rule references another segment' : `Operator “${c.op}” isn't supported`,
        explanation: inSegment && c.op === 'segmentMatch' ? 'LaunchDarkly segment rules cannot match other segments; the console cannot write this clause.' : `The console does not know how to write clauses with the “${c.op}” operator.`,
        sourceFragment: c,
        options: [DROP_CONDITION, DROP_RULE, SKIP],
      },
      'drop_rule',
    );
    return skipOrDrop(ctx, choice, where, `clause with operator “${c.op}”`);
  }
  if (c.op === 'segmentMatch') {
    const missing = c.values.map(String).filter((key) => {
      const seg = ctx.snapshot.neutral?.segments.find((s) => s.key === key);
      return !seg || !neutralSegmentEnvOf(seg, env);
    });
    if (missing.length) {
      const choice = ctx.decisions.choose(
        {
          type: 'missing_reference',
          severity: 'blocking',
          subject: { ...ctx.subject, ruleId: loc.ruleId, ruleName: loc.ruleName, location: where },
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
  return { kind: 'clause', clause: { contextKind: resolveSourceKind(ctx, c.contextKind), attribute: c.attribute, op: c.op as LdOperator, values: c.values, negate: c.negate } };
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

function serveOf(ctx: Ctx, s: NeutralServe, variationCount: number, path: string, location: string): VariationOrRollout {
  if (s.rollout) {
    const pct = s.rollout.variations.map((w) => `${w.weight / 1000}%`).join(' / ');
    if (rebucket(ctx, `${path}:rollout`, location, pct) === 'skip') throw new SkipItem(`waiting for the ${pct} rollout in ${location} to finish`);
    ctx.fidelity.push({ fidelity: 'partial', message: `${pct} rollout re-buckets contexts (new flag, new salt).`, location });
    for (const w of s.rollout.variations) if (w.variation >= variationCount) throw new SkipItem(`${location} serves variation ${w.variation}, which the flag doesn't have`);
    return { rollout: { contextKind: resolveSourceKind(ctx, s.rollout.contextKind), ...(s.rollout.bucketBy ? { bucketBy: s.rollout.bucketBy } : {}), variations: s.rollout.variations.map((w) => ({ variation: w.variation, weight: w.weight })) } };
  }
  const v = s.variation ?? 0;
  if (v >= variationCount) throw new SkipItem(`${location} serves variation ${v}, which the flag doesn't have`);
  return { variation: v };
}

const variationName = (v: { value: unknown; name?: string }, i: number): string => v.name ?? (typeof v.value === 'boolean' || typeof v.value === 'number' ? String(v.value) : typeof v.value === 'string' ? v.value : `Variation ${i + 1}`);

export function mapNeutralFlag(args: MapArgs<NeutralFlag>): NeutralFlagMapResult {
  const { entity: flag, env } = args;
  const ctx = makeCtx(args, 'flag');
  const alias = ctx.snapshot.source.alias;
  const tagMigrated = migratedFromTag(ctx.kind);
  const key = flag.key;
  const source = neutralEnvOf(flag, env.statsig);
  const lastVariation = Math.max(0, flag.variations.length - 1);
  const offEnv: DesiredFlagEnv = { ldEnv: env.ld, statsigEnv: env.statsig, on: false, offVariation: flag.defaults?.offVariation ?? lastVariation, fallthrough: { variation: flag.defaults?.onVariation ?? 0 }, rules: [], targets: [], prerequisites: [] };
  const shell = flagShell(ctx, flag, alias, tagMigrated);
  const fp = fingerprint({
    variations: flag.variations.map((v) => v.value),
    env: source ? { on: source.on, offVariation: source.offVariation, fallthrough: source.fallthrough, rules: source.rules, targets: source.targets, prerequisites: source.prerequisites } : null,
  });
  const version = source?.version ?? flag.version;

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
    const desired = translateEnv(ctx, flag, source, env.ld);
    if (flag.deprecated) ctx.fidelity.push({ fidelity: 'full', message: `Deprecated in ${sourceLabel(ctx)}. Consider retiring it instead of migrating.` });
    if (flag.experiments.length) ctx.fidelity.push({ fidelity: 'partial', message: `${flag.experiments.length} experiment${flag.experiments.length === 1 ? '' : 's'} run${flag.experiments.length === 1 ? 's' : ''} on this flag in ${sourceLabel(ctx)} (${flag.experiments.join(', ')}); experiments are not migrated (PLAN §11).` });
    return finish(desired);
  } catch (e) {
    if (e instanceof SkipItem) return finish(offEnv, e.reason);
    throw e;
  }
}

function translateEnv(ctx: Ctx, flag: NeutralFlag, source: NeutralFlagEnv, ldEnv: string): DesiredFlagEnv {
  const n = flag.variations.length;
  const rules: DesiredRule[] = [];
  let fallthrough: VariationOrRollout = serveOf(ctx, source.fallthrough, n, 'fallthrough', 'default rule');
  let truncated = false;
  rules: for (const [i, r] of source.rules.entries()) {
    const ruleId = r.id ?? `#${i}`;
    const ruleName = r.description || `rule ${i + 1}`;
    if (r.disabled) {
      ctx.fidelity.push({ fidelity: 'full', message: `Rule “${ruleName}” is disabled in ${sourceLabel(ctx)} (not evaluated) and was not copied.`, location: `rule “${ruleName}”` });
      continue;
    }
    const mark = ctx.decisions.mark();
    const clauses: LdClause[] = [];
    let dropRule = false;
    for (const [k, c] of r.clauses.entries()) {
      const out = translateClause(ctx, c, { ruleId, ruleName, index: k }, source.env, false);
      if (out.kind === 'clause') clauses.push(out.clause);
      else if (out.kind === 'drop_rule') {
        dropRule = true;
        break;
      }
    }
    if (dropRule) continue;
    void mark;
    const serve = serveOf(ctx, r, n, `rule:${ruleId}`, `rule “${ruleName}”`);
    if (r.trackEvents) ctx.fidelity.push({ fidelity: 'full', message: `Rule “${ruleName}” tracks evaluation events in ${sourceLabel(ctx)} (experimentation); event tracking is not copied.`, location: `rule “${ruleName}”` });
    if (clauses.length === 0) {
      // Every clause was dropped: the rule matches everyone, so it becomes the default rule.
      fallthrough = serve;
      const after = source.rules.length - i - 1;
      if (after > 0) ctx.fidelity.push({ fidelity: 'partial', message: `Rule “${ruleName}” now matches everyone; the ${after} rule${after === 1 ? '' : 's'} after it can never match and ${after === 1 ? 'is' : 'are'} dropped.`, location: `rule “${ruleName}”` });
      truncated = true;
      break rules;
    }
    rules.push({ description: r.description, clauses, ...serve });
  }
  void truncated;
  if (source.trackEvents) ctx.fidelity.push({ fidelity: 'full', message: `Event tracking for the default rule is on in ${sourceLabel(ctx)}; not copied.` });

  const targets: DesiredTarget[] = source.targets
    .map((t) => {
      if (t.variation >= n) throw new SkipItem(`individual targets serve variation ${t.variation}, which the flag doesn't have`);
      return { contextKind: resolveSourceKind(ctx, t.contextKind), variation: t.variation, values: [...t.values] };
    })
    .sort((a, b) => `${a.contextKind}|${a.variation}`.localeCompare(`${b.contextKind}|${b.variation}`));

  const prerequisites = translatePrerequisites(ctx, source, source.env);
  if (source.offVariation >= n) throw new SkipItem(`the off variation is ${source.offVariation}, which the flag doesn't have`);
  return { ldEnv, statsigEnv: source.env, on: source.on, offVariation: source.offVariation, fallthrough, rules: dedupeRuleDescriptions(rules, ctx.fidelity), targets, prerequisites };
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
    const ref = ctx.snapshot.neutral?.flags.find((f) => f.key === p.key);
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
    if (p.variation >= ref.variations.length) throw new SkipItem(`prerequisite “${p.key}” requires variation ${p.variation}, which that flag doesn't have`);
    ctx.deps.set(`flag:${p.key}`, { kind: 'flag', key: p.key, entityId: p.key });
    out.push({ key: p.key, variation: p.variation });
  }
  if (out.length && caps === 'unknown') ctx.fidelity.push({ fidelity: 'full', message: `Prerequisites need an Enterprise plan; the target's plan is checked on the first write.`, location: 'prerequisites' });
  return out;
}

function flagShell(ctx: Ctx, flag: NeutralFlag, alias: string, tagMigrated: string): DesiredFlagShell {
  const ownTags = flag.tags.filter((t) => !PROVENANCE_TAG_RE.test(t));
  const stripped = flag.tags.length - ownTags.length;
  if (stripped) ctx.fidelity.push({ fidelity: 'full', message: `${stripped} provenance tag${stripped === 1 ? '' : 's'} from an earlier migration into ${sourceLabel(ctx)} not copied.` });
  const renamed = ownTags.filter((t) => sanitizeTag(t) !== t);
  if (renamed.length) ctx.fidelity.push({ fidelity: 'full', message: `Tag${renamed.length === 1 ? '' : 's'} ${renamed.map((t) => `“${t}”`).join(', ')} renamed to fit LaunchDarkly's tag format.` });
  const tags = unique([tagMigrated, sourceTag(alias), ...ownTags.map(sanitizeTag)].filter(Boolean));

  const props: Record<string, CustomProperty> = provenanceProperties({ id: flag.key, ...(flag.version !== undefined ? { version: flag.version } : {}) }, alias, 'flag', ctx.kind);
  const own = Object.entries(flag.customProperties).filter(([k]) => !PROVENANCE_PROPERTY_RE.test(k));
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
  const fp = fingerprint(source ? { rules: source.rules, included: source.included, excluded: source.excluded, unbounded: source.unbounded ?? null } : null);

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
    if (source.unbounded) {
      const caps = ctx.args.capabilities.bigSegments;
      if (caps === 'unavailable' || caps === 'not_permitted') throw new SkipItem(`it is a big segment and the target ${caps === 'not_permitted' ? 'token may not create' : 'plan has no'} big segments`);
      const choice = ctx.decisions.choose(
        {
          type: 'big_segment',
          severity: 'blocking',
          subject: { ...ctx.subject, location: 'membership' },
          path: 'big_segment',
          title: `Big segment “${seg.key}”: membership can't be read`,
          explanation: `LaunchDarkly only answers whether one key is a member of a big segment, so the console cannot read the list. It can create the big segment in the target (Enterprise) for you to fill with a CSV import, or skip it; rules that match it are blocked until it exists.`,
          sourceFragment: { key: seg.key, unbounded: true, contextKind: source.unbounded.contextKind },
          options: [
            { key: 'create_empty', label: 'Create it empty; import the members yourself', explanation: `A big segment on the “${source.unbounded.contextKind}” kind with no members. Export the list from ${sourceLabel(ctx)} (or its store) and import it in the target.`, resultingFidelity: 'manual' },
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
    for (const inc of source.included) {
      const kind = resolveSourceKind(ctx, inc.contextKind);
      if (inc.values.length > LIST_SEGMENT_MAX) throw new SkipItem(`${inc.values.length.toLocaleString('en-US')} included ${kind} keys exceed LaunchDarkly's ${LIST_SEGMENT_MAX.toLocaleString('en-US')}-key limit`);
      if (kind === 'user') base.included = [...inc.values];
      else base.includedContexts.push({ contextKind: kind, values: [...inc.values] });
    }
    for (const exc of source.excluded) {
      const kind = resolveSourceKind(ctx, exc.contextKind);
      if (kind === 'user') base.excluded = [...exc.values];
      else (base.excludedContexts ??= []).push({ contextKind: kind, values: [...exc.values] });
    }
    return finish(base);
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

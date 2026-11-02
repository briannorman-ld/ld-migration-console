/**
 * StatSig segment → LD segment in one environment (PLAN §6: rule-based and ID-list segments are
 * per environment in LD). ID lists above LD's 15,000-ID limit become big (unbounded) segments
 * filled by a CSV import (`big_segment`); spec-sourced hashed lists need a reconciled raw-ID
 * upload first (`hashed_id_list`). Both decisions are shared with the gates that reference the
 * segment (same decision id), so one answer covers the segment and every rule that needs it.
 */
import { fingerprint, resolveRulesForEnvironment, targetingFingerprint, type Segment } from '@sslm/canonical';
import { andDnf, bigSegmentChoice, hashedListChoice, LIST_SEGMENT_MAX, MAX_EXPANSION, resolveKind, segmentSize, SkipItem, translateCondition, unique, type ConditionContext, resolveUnit } from './conditions.ts';
import { DecisionCollector } from './decisions.ts';
import { report, sourceTag, TAG_MIGRATED, type MapArgs, type MapOutcome } from './gate.ts';
import { sanitizeKey, sanitizeTag } from './profile.ts';
import { inlineGate, type InlineState } from './refs.ts';
import type { Dependency, DesiredSegment, DesiredSegmentRule, FidelityNote, LdClause } from './types.ts';

export interface SegmentMapResult extends MapOutcome {
  segmentKey: string;
  desired: DesiredSegment | null;
}

export function mapSegment(args: MapArgs<Segment>): SegmentMapResult {
  const { entity: seg, canonical, profile, capabilities, env } = args;
  const sourceId = seg.source.sourceId;
  const decisions = new DecisionCollector(args.resolutions, profile);
  const fidelity: FidelityNote[] = [];
  const deps = new Map<string, Dependency>();
  const idLists = canonical.idLists ?? {};
  const ctx: ConditionContext = {
    profile,
    capabilities,
    snapshot: canonical.snapshot,
    sourceId,
    idLists,
    ...(canonical.coverage ? { coverage: canonical.coverage } : {}),
    nowMs: Date.parse(args.now),
    decisions,
    subject: { sourceId, kind: 'segment', uid: seg.uid, id: seg.id },
    fidelity,
    deps,
    userKind: 'user',
    kindCache: new Map(),
  };
  ctx.userKind = resolveKind(ctx, 'userID');
  const key = sanitizeKey(seg.id);
  const size = segmentSize(seg, idLists);
  const inline: InlineState = { env, stack: [], inlined: new Map(), cache: new Map() };

  const finish = (desired: DesiredSegment | null, skipped?: string): SegmentMapResult => ({
    uid: seg.uid,
    entityId: seg.id,
    sourceId,
    segmentKey: key,
    desired,
    fidelity: report(fidelity, skipped),
    unresolved: decisions.unresolved,
    applied: decisions.applied,
    stale: decisions.stale,
    dependencies: [...deps.values()],
    statsigFingerprint: fingerprint({ self: targetingFingerprint(seg, env.statsig), ids: size.ids ? [...size.ids].sort() : null, inlined: [...inline.inlined.entries()].sort() }),
    decisionSetHash: decisions.setHash(),
    ...(skipped ? { skipped } : {}),
  });

  if (seg.archived) return finish(null, 'archived in StatSig');
  const base: DesiredSegment = {
    key,
    ldEnv: env.ld,
    statsigEnv: env.statsig,
    name: seg.name || seg.id,
    description: seg.description ?? '',
    tags: unique([TAG_MIGRATED, sourceTag(canonical.snapshot.source.alias), ...seg.tags.map(sanitizeTag)].filter(Boolean)),
    rules: [],
    included: [],
    includedContexts: [],
  };

  try {
    if (seg.segmentType !== 'rule_based') {
      const fragment = { segment: seg.id, segmentType: seg.segmentType, count: size.count ?? null, hashed: size.hashed };
      if (size.hashed || ctx.coverage?.[seg.uid]) {
        const { choice } = hashedListChoice(ctx, seg, fragment);
        if (choice === 'skip') throw new SkipItem('its hashed ID list is not reconciled closely enough yet');
        if (choice !== 'accept') throw new SkipItem('its ID list is hashed (config spec): read the IDs from StatSig or upload them to reconcile it');
        const cov = ctx.coverage?.[seg.uid];
        if (cov && (cov.missing > 0 || cov.extra > 0 || !cov.verified))
          fidelity.push({ fidelity: cov.missing > 0 || !cov.verified ? 'partial' : 'full', message: cov.verified ? `Reconciled raw IDs: ${cov.matched.toLocaleString('en-US')} of ${cov.total.toLocaleString('en-US')} StatSig hashes matched${cov.missing ? `, ${cov.missing.toLocaleString('en-US')} missing` : ''}${cov.extra ? `, ${cov.extra.toLocaleString('en-US')} uploaded IDs not in the list left out` : ''}.` : `Raw-ID upload of ${cov.matched.toLocaleString('en-US')} IDs against StatSig's count of ${cov.total.toLocaleString('en-US')}; no hash file was uploaded, so membership is unverified.` });
      }
      if (!size.ids) throw new SkipItem('its ID list was not fetched from StatSig');
      const unit = resolveUnit(ctx, seg.idType);
      const kind = unit.contextKind;
      const ids = unique(size.ids);
      if (unit.attribute !== 'key') {
        // The unit type is a user attribute: LD segments list members by key only, so the IDs become a rule.
        if (ids.length > LIST_SEGMENT_MAX) throw new SkipItem(`${ids.length.toLocaleString('en-US')} ${seg.idType} IDs on the user attribute “${unit.attribute}”: LaunchDarkly matches attributes only in rules, and a clause that long is not practical; create a context kind for ${seg.idType} instead`);
        base.rules.push({ description: `${seg.idType} IDs`, clauses: [{ contextKind: kind, attribute: unit.attribute, op: 'in', values: ids, negate: false }] });
        fidelity.push({ fidelity: 'full', message: `${ids.length} ${seg.idType} IDs matched by a rule on user attribute “${unit.attribute}” (LaunchDarkly lists segment members only by context key).` });
        return finish(base);
      }
      if (ids.length > LIST_SEGMENT_MAX) {
        const { choice } = bigSegmentChoice(ctx, seg, ids.length, fragment);
        if (choice === 'skip') throw new SkipItem(`${ids.length.toLocaleString('en-US')} IDs exceed LaunchDarkly's ${LIST_SEGMENT_MAX.toLocaleString('en-US')}-ID list segment limit`);
        if (choice !== 'import') return finish(null, `${ids.length.toLocaleString('en-US')} IDs exceed LaunchDarkly's ${LIST_SEGMENT_MAX.toLocaleString('en-US')}-ID list segment limit; the rules referencing it were changed instead`);
        base.unbounded = { contextKind: kind, ids };
        fidelity.push({ fidelity: 'full', message: `Big segment: ${ids.length.toLocaleString('en-US')} ${seg.idType} IDs imported from CSV (replace mode) on every sync.` });
        return finish(base);
      }
      if (kind === 'user') base.included = ids;
      else base.includedContexts = [{ contextKind: kind, values: ids }];
      fidelity.push({ fidelity: 'full', message: `${ids.length} ${seg.idType} IDs included.` });
      return finish(base);
    }

    ctx.gateReference = (ids, negate, _c, loc) => {
      const parts = ids.map((id) => inlineGate(ctx, inline, id, negate));
      const bad = parts.find((p) => !p.ok);
      // LD segments can't have prerequisites, so a gate reference must inline.
      if (bad && !bad.ok) throw new SkipItem(`rule “${loc.ruleName}” references a gate that can't be inlined (${bad.reason})`);
      return parts.flatMap((p) => (p.ok ? p.dnf : []));
    };
    if (!seg.enabled) fidelity.push({ fidelity: 'full', message: 'Disabled in StatSig: the LaunchDarkly segment has no rules, so nobody matches it.' });
    const rules = seg.enabled ? resolveRulesForEnvironment(seg.rules, env.statsig).rules : [];
    const out: DesiredSegmentRule[] = [];
    for (const r of rules) {
      if (r.passPercentage <= 0) continue;
      const dnf = andDnf(r.conditions.map((c, i) => translateCondition(ctx, c, { ruleId: r.id, ruleName: r.name, index: i })));
      if (!dnf) throw new SkipItem(`rule “${r.name}” expands into more than ${MAX_EXPANSION} LaunchDarkly rules`);
      const unit = resolveUnit(ctx, r.idType || seg.idType);
      const kind = unit.contextKind;
      let weight: number | undefined;
      if (r.passPercentage < 100) {
        const choice = ctx.decisions.choose(
          {
            type: 'partial_rollout_rebucket',
            severity: 'acknowledge',
            subject: { ...ctx.subject, ruleId: r.id, ruleName: r.name, location: `rule “${r.name}”` },
            path: `rule:${r.id}:rollout`,
            title: `${r.passPercentage}% of matching users: re-bucketed`,
            explanation: `StatSig and LaunchDarkly hash users differently, so a different ${r.passPercentage}% of matching users are in the segment.`,
            sourceFragment: { rule: r.name, passPercentage: r.passPercentage },
            fingerprintOf: { passPercentage: r.passPercentage },
            options: [
              { key: 'acknowledge', label: 'Acknowledge: users will be re-bucketed', explanation: 'Migrate with the same percentage.', resultingFidelity: 'partial' },
              { key: 'skip', label: 'Skip this segment', explanation: "Don't migrate it.", resultingFidelity: 'skipped' },
            ],
            recommended: 'acknowledge',
          },
          'acknowledge',
        );
        if (choice === 'skip') throw new SkipItem(`waiting for the ${r.passPercentage}% rule “${r.name}”`);
        weight = Math.round(r.passPercentage * 1000);
        // KNOWN-EDGE-CASES 9.13: StatSig stops at the first matching rule (users outside the percentage
        // fail the segment); LD lets them continue to the next segment rule.
        const later = rules.slice(rules.indexOf(r) + 1).filter((x) => x.passPercentage > 0).length;
        if (later > 0)
          ctx.fidelity.push({
            fidelity: 'partial',
            message: `Users matching “${r.name}” but outside its ${r.passPercentage}% fail the segment in StatSig; in LaunchDarkly they go on to the ${later} later rule${later === 1 ? '' : 's'} and may match there.`,
            location: `rule “${r.name}”`,
          });
      }
      for (const [k, term] of dnf.entries()) {
        // LD segment rules need a clause; "everyone of this kind" is a match-anything key regex.
        const clauses: LdClause[] = term.length ? term : [{ contextKind: kind, attribute: 'key', op: 'matches', values: ['.*'], negate: false }];
        out.push({ description: dnf.length > 1 ? `${r.name} (${k + 1}/${dnf.length})` : r.name, clauses, ...(weight !== undefined ? { weight, rolloutContextKind: kind, ...(unit.attribute !== 'key' ? { bucketBy: unit.attribute } : {}) } : {}) });
      }
    }
    base.rules = out;
    return finish(base);
  } catch (e) {
    if (e instanceof SkipItem) return finish(null, e.reason);
    throw e;
  }
}

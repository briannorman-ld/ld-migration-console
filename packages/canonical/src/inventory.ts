import type { CanonicalSnapshot, Entity, EntityKind } from './model.ts';

export const ENTITY_COLLECTIONS = {
  gate: 'gates',
  config: 'configs',
  segment: 'segments',
  experiment: 'experiments',
  layer: 'layers',
  holdout: 'holdouts',
  autotune: 'autotunes',
  metric: 'metrics',
  param_store: 'paramStores',
  prompt: 'prompts',
} as const satisfies Record<EntityKind, keyof CanonicalSnapshot>;

export const ENTITY_KINDS = Object.keys(ENTITY_COLLECTIONS) as EntityKind[];

/** Snapshots taken before a collection existed lack it (`prompts` since 2026-11-02): read as empty. */
export function entitiesOf(snapshot: CanonicalSnapshot, kind: EntityKind): Entity[] {
  return (snapshot[ENTITY_COLLECTIONS[kind]] ?? []) as Entity[];
}

export function allEntities(snapshot: CanonicalSnapshot): Entity[] {
  return ENTITY_KINDS.flatMap((k) => entitiesOf(snapshot, k));
}

export function countsByKind(snapshot: CanonicalSnapshot, opts: { includeArchived?: boolean } = {}): Record<EntityKind, number> {
  const out = {} as Record<EntityKind, number>;
  for (const k of ENTITY_KINDS) {
    out[k] = entitiesOf(snapshot, k).filter((e) => opts.includeArchived || !e.archived).length;
  }
  return out;
}

/** One logical resource across sources: entities matched by (kind, id) (PLAN §12 "Matching"). */
export interface MatchedResource {
  kind: EntityKind;
  id: string;
  /** Keyed by sourceId. One entry is the common case; more means a consolidation collision. */
  bySource: Record<string, Entity>;
}

export function matchAcrossSources(snapshots: CanonicalSnapshot[], kind: EntityKind): MatchedResource[] {
  const map = new Map<string, MatchedResource>();
  for (const s of snapshots) {
    for (const e of entitiesOf(s, kind)) {
      const m = map.get(e.id) ?? { kind, id: e.id, bySource: {} };
      m.bySource[s.source.sourceId] = e;
      map.set(e.id, m);
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Something whose rules refer to a segment: a gate, a dynamic config or another segment. */
export interface SegmentReference {
  kind: 'gate' | 'config' | 'segment';
  id: string;
  uid: string;
  archived: boolean;
  /** Gates and segments can be disabled; a config is always enabled. */
  enabled: boolean;
}

/**
 * Who uses each segment, by segment id: every `passes_segment` / `fails_segment` condition (and
 * the spec's `in_segment_list` / `not_in_segment_list` operator) in the rules of the snapshot's
 * gates, configs and segments. A segment nothing refers to is one the migration can leave behind;
 * the explorers show the users so that choice is made with the list in view. Experiments, layers
 * and holdouts have no rules of their own in the canonical model, so they never appear here.
 */
export function segmentReferences(snapshot: CanonicalSnapshot): Map<string, SegmentReference[]> {
  const out = new Map<string, SegmentReference[]>();
  const note = (segmentId: string, ref: SegmentReference) => {
    const list = out.get(segmentId) ?? [];
    if (!list.some((r) => r.uid === ref.uid)) list.push(ref);
    out.set(segmentId, list);
  };
  const scan = (ref: SegmentReference, rules: { conditions: { type: string; operator: unknown; targetValue: unknown }[] }[]) => {
    for (const rule of rules) {
      for (const c of rule.conditions) {
        const bySegment = c.type === 'passes_segment' || c.type === 'fails_segment' || c.operator === 'in_segment_list' || c.operator === 'not_in_segment_list';
        if (!bySegment) continue;
        for (const v of Array.isArray(c.targetValue) ? c.targetValue : c.targetValue === null || c.targetValue === undefined ? [] : [c.targetValue]) note(String(v), ref);
      }
    }
  };
  for (const g of snapshot.gates) scan({ kind: 'gate', id: g.id, uid: g.uid, archived: g.archived, enabled: g.enabled }, g.rules);
  for (const c of snapshot.configs) scan({ kind: 'config', id: c.id, uid: c.uid, archived: c.archived, enabled: true }, c.rules);
  for (const s of snapshot.segments) scan({ kind: 'segment', id: s.id, uid: s.uid, archived: s.archived, enabled: s.enabled }, s.rules);
  return out;
}

/** "2 gates, 1 config" for a segment's users; "not used" when there are none. Archived users are counted apart. */
export function describeSegmentUsers(refs: readonly SegmentReference[] | undefined): string {
  const live = (refs ?? []).filter((r) => !r.archived);
  const archived = (refs ?? []).length - live.length;
  if (live.length === 0) return archived ? `not used (${archived} archived ${archived === 1 ? 'user' : 'users'})` : 'not used';
  const counts = new Map<SegmentReference['kind'], number>();
  for (const r of live) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const noun: Record<SegmentReference['kind'], [string, string]> = { gate: ['gate', 'gates'], config: ['config', 'configs'], segment: ['segment', 'segments'] };
  const parts = (['gate', 'config', 'segment'] as const).filter((k) => counts.get(k)).map((k) => `${counts.get(k)} ${noun[k][counts.get(k) === 1 ? 0 : 1]}`);
  return `used by ${parts.join(', ')}${archived ? ` (+${archived} archived)` : ''}`;
}

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

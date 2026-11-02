import { fingerprint } from './hash.ts';
import { ENTITY_KINDS, entitiesOf } from './inventory.ts';
import type { CanonicalSnapshot, Entity, EntityKind } from './model.ts';
import { effectiveTargeting } from './targeting.ts';

export interface EntityChange {
  kind: EntityKind;
  id: string;
  /** Environments whose effective targeting changed (gates, configs, segments). */
  targetingChangedIn: string[];
  /** Something other than per-environment targeting changed (variations, metadata, status…). */
  otherChanged: boolean;
}

export interface SnapshotDiff {
  added: { kind: EntityKind; id: string }[];
  removed: { kind: EntityKind; id: string }[];
  changed: EntityChange[];
  /** True when nothing but timestamps / the spec `time` moved (PLAN §4.2: dedupe such uploads). */
  onlyTimeChanged: boolean;
}

/** Fields that change on every save and say nothing about behaviour. */
const VOLATILE = new Set(['lastModifiedTime', 'version', 'checksPerHour', 'usage', 'uid', 'source', 'createdTime']);

/**
 * Entity-level diff between two snapshots of the same source (PLAN §4.2 "Regular re-uploads",
 * §14 drift). Rule- and condition-level detail comes from comparing effectiveTargeting output.
 */
export function diffSnapshots(prev: CanonicalSnapshot, next: CanonicalSnapshot, envs?: string[]): SnapshotDiff {
  const environments = envs ?? [...new Set([...prev.environments, ...next.environments].map((e) => e.name))];
  const out: SnapshotDiff = { added: [], removed: [], changed: [], onlyTimeChanged: false };
  for (const kind of ENTITY_KINDS) {
    const a = new Map(entitiesOf(prev, kind).map((e) => [e.id, e]));
    const b = new Map(entitiesOf(next, kind).map((e) => [e.id, e]));
    for (const id of b.keys()) if (!a.has(id)) out.added.push({ kind, id });
    for (const id of a.keys()) if (!b.has(id)) out.removed.push({ kind, id });
    for (const [id, before] of a) {
      const after = b.get(id);
      if (!after) continue;
      const targetingChangedIn = hasTargeting(before) && hasTargeting(after)
        ? environments.filter((env) => fingerprint(effectiveTargeting(before, env)) !== fingerprint(effectiveTargeting(after, env)))
        : [];
      const otherChanged = fingerprint(nonTargeting(before)) !== fingerprint(nonTargeting(after));
      if (targetingChangedIn.length || otherChanged) out.changed.push({ kind, id, targetingChangedIn, otherChanged });
    }
  }
  out.onlyTimeChanged = out.added.length === 0 && out.removed.length === 0 && out.changed.length === 0 && prev.sourceTime !== next.sourceTime;
  return out;
}

export interface UploadSanity {
  /** Blocking: probably the wrong project. */
  companyMismatch?: { previous: string; next: string };
  /** Entities that disappeared: archived, deleted, or the key's scope is partial. */
  disappeared: { kind: EntityKind; id: string }[];
  /** Duplicate of the previous upload apart from `time`. */
  duplicate: boolean;
}

/** PLAN §4.2 "Sanity checks on each upload". */
export function checkUpload(prev: CanonicalSnapshot | undefined, next: CanonicalSnapshot): UploadSanity {
  if (!prev) return { disappeared: [], duplicate: false };
  const d = diffSnapshots(prev, next);
  const out: UploadSanity = { disappeared: d.removed, duplicate: d.onlyTimeChanged || (d.added.length + d.removed.length + d.changed.length === 0) };
  if (prev.companyId && next.companyId && prev.companyId !== next.companyId) out.companyMismatch = { previous: prev.companyId, next: next.companyId };
  return out;
}

function hasTargeting(e: Entity): e is Extract<Entity, { kind: 'gate' | 'config' | 'segment' }> {
  return e.kind === 'gate' || e.kind === 'config' || e.kind === 'segment';
}

function nonTargeting(e: Entity): unknown {
  return Object.fromEntries(Object.entries(e).filter(([k]) => !VOLATILE.has(k) && k !== 'rules' && k !== 'overrides'));
}

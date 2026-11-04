import type { CanonicalSnapshot, Gate, NeutralFlag, NeutralSegment, Segment } from '@sslm/canonical';
import type { LdDirectory } from './types.ts';

/**
 * Per-snapshot indexes, built once and kept for the snapshot's lifetime. Mapping a project of
 * thousands of gates looks a referenced gate or segment up for every condition in every
 * environment; a scan of the whole list each time made that quadratic.
 */
function indexed<K extends object, V>(cache: WeakMap<K, V>, key: K, build: () => V): V {
  let v = cache.get(key);
  if (!v) cache.set(key, (v = build()));
  return v;
}

const gates = new WeakMap<CanonicalSnapshot, Map<string, Gate>>();
const segments = new WeakMap<CanonicalSnapshot, Map<string, Segment>>();
const neutralFlags = new WeakMap<CanonicalSnapshot, Map<string, NeutralFlag>>();
const neutralSegments = new WeakMap<CanonicalSnapshot, Map<string, NeutralSegment>>();
const members = new WeakMap<LdDirectory, Map<string, LdDirectory['members'][number]>>();

/** The snapshot's gates by StatSig id. */
export const gateById = (s: CanonicalSnapshot): Map<string, Gate> => indexed(gates, s, () => new Map(s.gates.map((g) => [g.id, g])));
/** The snapshot's segments by StatSig id. */
export const segmentById = (s: CanonicalSnapshot): Map<string, Segment> => indexed(segments, s, () => new Map(s.segments.map((g) => [g.id, g])));
/** A LaunchDarkly-source snapshot's flags by key. */
export const neutralFlagByKey = (s: CanonicalSnapshot): Map<string, NeutralFlag> => indexed(neutralFlags, s, () => new Map((s.neutral?.flags ?? []).map((f) => [f.key, f])));
/** A LaunchDarkly-source snapshot's segments by key. */
export const neutralSegmentByKey = (s: CanonicalSnapshot): Map<string, NeutralSegment> => indexed(neutralSegments, s, () => new Map((s.neutral?.segments ?? []).map((g) => [g.key, g])));
/** The directory's members by lower-cased email (the first member listed under an email wins, as a scan would). */
export function memberByEmail(d: LdDirectory): Map<string, LdDirectory['members'][number]> {
  return indexed(members, d, () => {
    const out = new Map<string, LdDirectory['members'][number]>();
    for (const m of d.members) {
      const email = m.email.toLowerCase();
      if (!out.has(email)) out.set(email, m);
    }
    return out;
  });
}

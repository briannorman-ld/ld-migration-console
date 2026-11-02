/**
 * The Unit types page (PLAN §9, §10.3): every StatSig unit type a source declares or uses, where
 * it is used, and where it goes in LaunchDarkly. The choice is kept in the mapping profile
 * (`SourceProfile.unitTypeKinds`): a context kind key, or `attribute:<name>` / `attribute:<kind>/<name>`
 * to keep the unit type as an attribute of the `user` context or of any other kind (existing, or
 * created by the migration). A configured unit type raises no `unit_type_kind` decision (the
 * mapper reads the same entry through `configuredUnit`).
 */
import type { CanonicalSnapshot, EntityKind, Rule } from '@sslm/canonical';
import { attributeOption, attributeTarget, configuredUnit, defaultKindFor, isValidAttributeName, isValidContextKindKey, kindFromChoice, type MappingProfile, type Resolution, type UnitTarget } from '@sslm/mapper';

/** Resource kinds that are keyed by a unit type (`idType`), in display order. */
export const KEYED_KINDS = ['gate', 'config', 'segment', 'experiment', 'layer', 'holdout', 'autotune'] as const satisfies readonly EntityKind[];
export type KeyedKind = (typeof KEYED_KINDS)[number];

export interface UnitTypeUsage {
  name: string;
  description?: string;
  /** Declared by the source (Console API `unitIdTypes`); spec sources only list unit types in use. */
  declared: boolean;
  /** Items whose `idType` is this unit type. */
  keyed: Partial<Record<KeyedKind, number>>;
  /** Rules that bucket on it while their item is keyed by another unit type. */
  ruleBuckets: number;
  /** `unit_id` conditions on it. */
  conditions: number;
  /** ID override groups on it. */
  overrides: number;
}

function key(name: string): string {
  return name.toLowerCase();
}

/**
 * Unit types of a snapshot, declared ones first in declaration order, then any that items use but
 * the source does not declare (an undeclared `customID` from an ambiguous override, say). Names are
 * compared case-insensitively, as StatSig does.
 */
export function unitTypeUsage(snapshot: CanonicalSnapshot): UnitTypeUsage[] {
  const out = new Map<string, UnitTypeUsage>();
  const get = (name: string): UnitTypeUsage => {
    const k = key(name);
    let u = out.get(k);
    if (!u) {
      u = { name, declared: false, keyed: {}, ruleBuckets: 0, conditions: 0, overrides: 0 };
      out.set(k, u);
    }
    return u;
  };
  for (const u of snapshot.unitTypes) {
    const x = get(u.name);
    x.declared = true;
    if (u.description) x.description = u.description;
  }
  const rules = (itemIdType: string, rs: Rule[]) => {
    for (const r of rs) {
      if (r.idType && key(r.idType) !== key(itemIdType)) get(r.idType).ruleBuckets += 1;
      for (const c of r.conditions) if (c.type === 'unit_id' && c.customID) get(c.customID).conditions += 1;
    }
  };
  const keyed = (kind: KeyedKind, items: { idType: string; archived?: boolean; rules?: Rule[]; overrides?: { unitType: string }[] }[]) => {
    for (const it of items) {
      if (it.archived) continue;
      const u = get(it.idType);
      u.keyed[kind] = (u.keyed[kind] ?? 0) + 1;
      if (it.rules) rules(it.idType, it.rules);
      for (const o of it.overrides ?? []) get(o.unitType).overrides += 1;
    }
  };
  keyed('gate', snapshot.gates);
  keyed('config', snapshot.configs);
  keyed('segment', snapshot.segments);
  keyed('experiment', snapshot.experiments);
  keyed('layer', snapshot.layers);
  keyed('holdout', snapshot.holdouts);
  keyed('autotune', snapshot.autotunes);
  return [...out.values()];
}

export const KEYED_LABEL: Record<KeyedKind, [string, string]> = {
  gate: ['gate', 'gates'],
  config: ['dynamic config', 'dynamic configs'],
  segment: ['segment', 'segments'],
  experiment: ['experiment', 'experiments'],
  layer: ['layer', 'layers'],
  holdout: ['holdout', 'holdouts'],
  autotune: ['autotune', 'autotunes'],
};

/** "12 gates · 3 dynamic configs · 4 conditions · 2 overrides"; "not used" when nothing refers to it. */
export function describeUsage(u: UnitTypeUsage): string {
  const parts: string[] = [];
  for (const k of KEYED_KINDS) {
    const n = u.keyed[k];
    if (n) parts.push(`${n} ${KEYED_LABEL[k][n === 1 ? 0 : 1]}`);
  }
  if (u.ruleBuckets) parts.push(`${u.ruleBuckets} rule${u.ruleBuckets === 1 ? '' : 's'} bucket on it`);
  if (u.conditions) parts.push(`${u.conditions} condition${u.conditions === 1 ? '' : 's'}`);
  if (u.overrides) parts.push(`${u.overrides} override${u.overrides === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'not used';
}

export type UnitTypeMode = 'kind' | 'attribute';

export interface UnitChoice {
  mode: UnitTypeMode;
  /** The context kind key (`kind` mode) or the attribute name (`attribute` mode). */
  key: string;
  /** `attribute` mode: the context kind that carries the attribute (`user` by default). */
  contextKind: string;
  configured: boolean;
}

/** The page's reading of one profile value: which mode, which key or attribute name, and on which kind. Lenient, so an invalid value is shown with its error rather than dropped. */
export function parseChoice(value: string | undefined, unitType: string): UnitChoice {
  if (value?.startsWith('attribute:')) {
    const rest = value.slice('attribute:'.length);
    const slash = rest.indexOf('/');
    return { mode: 'attribute', key: slash === -1 ? rest : rest.slice(slash + 1), contextKind: slash === -1 ? 'user' : rest.slice(0, slash), configured: true };
  }
  if (value) return { mode: 'kind', key: value, contextKind: value, configured: true };
  const k = defaultKindFor(unitType);
  return { mode: 'kind', key: k, contextKind: k, configured: false };
}

/** The profile value for a choice made on the page; `null` clears the entry (back to the default). */
export function choiceValue(mode: UnitTypeMode, key: string, contextKind = 'user'): string | null {
  const k = key.trim();
  if (!k) return null;
  return mode === 'attribute' ? attributeOption(k, contextKind.trim() || 'user') : k;
}

/** Why a typed key or attribute name cannot be saved, or `undefined` when it can. */
export function choiceError(mode: UnitTypeMode, key: string, unitType: string, contextKind = 'user'): string | undefined {
  const k = key.trim();
  if (!k) return undefined;
  if (mode === 'attribute') {
    if (/^userid$/i.test(unitType)) return 'userID is the key of the user context, not an attribute.';
    const ck = contextKind.trim();
    if (ck && !isValidContextKindKey(ck)) return 'Not a valid context kind key: letters, digits, “.”, “_” and “-”; “kind” and “multi” are reserved.';
    return isValidAttributeName(k) ? undefined : 'Not a valid attribute name: “key”, “kind”, “_meta” and “anonymous” are reserved, and “/” is not allowed.';
  }
  if (!isValidContextKindKey(k)) return 'Not a valid context kind key: letters, digits, “.”, “_” and “-”; “kind” and “multi” are reserved.';
  if (k === 'user' && !/^userid$/i.test(unitType)) return 'A custom unit ID is never the key of the user context (it would rebucket every user). Keep it as a user attribute instead.';
  return undefined;
}

export type UnitTypeStanding =
  /** Maps to `user`, or to a kind LD already has. */
  | { kind: 'exists'; target: UnitTarget }
  /** Maps to a kind the migration creates on its first run. */
  | { kind: 'creates'; target: UnitTarget }
  /** Kept as an attribute of a context kind; `kindExists` is false when the migration must create that kind first. */
  | { kind: 'attribute'; target: UnitTarget; kindExists: boolean }
  /** Not configured here and its kind is missing: the mapper asks a `unit_type_kind` decision per item (answer so far, if any). */
  | { kind: 'asks'; target: UnitTarget; decided?: string };

/**
 * Where a unit type stands for a source: configured on this page, else answered as a decision,
 * else the default (which asks per item when the kind is missing from LD).
 */
export function unitTypeStanding(profile: MappingProfile, resolutions: Iterable<Resolution>, sourceId: string, unitType: string, existingKinds: readonly string[]): UnitTypeStanding {
  const configured = configuredUnit(profile, sourceId, unitType);
  const proposed = defaultKindFor(unitType);
  if (configured) {
    if (configured.attribute !== 'key') return { kind: 'attribute', target: configured, kindExists: configured.contextKind === 'user' || existingKinds.includes(configured.contextKind) };
    return existingKinds.includes(configured.contextKind) || configured.contextKind === 'user' ? { kind: 'exists', target: configured } : { kind: 'creates', target: configured };
  }
  const target: UnitTarget = { contextKind: proposed, attribute: 'key' };
  if (proposed === 'user' || existingKinds.includes(proposed)) return { kind: 'exists', target };
  const prefix = `unit_type_kind:${sourceId}/unit_type/`;
  for (const r of resolutions) {
    if (r.type !== 'unit_type_kind' || r.scope !== 'resource' || !r.id.startsWith(prefix)) continue;
    const ut = r.id.slice(prefix.length).replace(/:kind$/, '');
    if (key(ut) !== key(unitType)) continue;
    const attr = attributeTarget(r.optionKey);
    return { kind: 'asks', target, decided: attr ? attributeOption(attr.attribute, attr.contextKind) : kindFromChoice(r.optionKey, proposed) };
  }
  return { kind: 'asks', target };
}

/**
 * Context kinds that two or more unit types of one source share (KNOWN-EDGE-CASES 3.2: `stableID`
 * and `deviceID` both default to `device`). Keyed by kind → the unit types, including defaults, so
 * the page can warn before the second one silently shares the kind.
 */
export function sharedKinds(profile: MappingProfile, sourceId: string, unitTypes: readonly string[]): Map<string, string[]> {
  const byKind = new Map<string, string[]>();
  for (const ut of unitTypes) {
    const target = configuredUnit(profile, sourceId, ut) ?? { contextKind: defaultKindFor(ut), attribute: 'key' };
    if (target.attribute !== 'key') continue;
    const list = byKind.get(target.contextKind) ?? [];
    list.push(ut);
    byKind.set(target.contextKind, list);
  }
  return new Map([...byKind].filter(([, uts]) => uts.length > 1));
}

/**
 * Unit types present in more than one source (consolidation, KNOWN-EDGE-CASES 16.5), with the kind
 * each source sends them to; a row whose kinds differ is flagged so the user can decide whether
 * the two sources mean the same thing.
 */
export function acrossSources(profile: MappingProfile, perSource: { sourceId: string; label: string; unitTypes: readonly string[] }[]): { name: string; targets: { sourceId: string; label: string; kind: string }[]; differ: boolean }[] {
  const rows = new Map<string, { name: string; targets: { sourceId: string; label: string; kind: string }[] }>();
  for (const s of perSource) {
    for (const ut of s.unitTypes) {
      const target = configuredUnit(profile, s.sourceId, ut) ?? { contextKind: defaultKindFor(ut), attribute: 'key' };
      const kind = target.attribute === 'key' ? target.contextKind : `${target.contextKind}.${target.attribute}`;
      const row = rows.get(key(ut)) ?? { name: ut, targets: [] };
      row.targets.push({ sourceId: s.sourceId, label: s.label, kind });
      rows.set(key(ut), row);
    }
  }
  return [...rows.values()].filter((r) => r.targets.length > 1).map((r) => ({ ...r, differ: new Set(r.targets.map((t) => t.kind)).size > 1 }));
}

/**
 * Context kinds the page offers for a choice: `user`, the kinds LD already has, and every kind
 * another unit type in the workspace keys or carries an attribute on (so the migration creates
 * it). Sorted, `user` first.
 */
export function knownKinds(profile: MappingProfile, perSource: { sourceId: string; unitTypes: readonly string[] }[], existingKinds: readonly string[]): string[] {
  const kinds = new Set<string>(existingKinds);
  for (const s of perSource) for (const ut of s.unitTypes) kinds.add(configuredUnit(profile, s.sourceId, ut)?.contextKind ?? defaultKindFor(ut));
  kinds.delete('user');
  return ['user', ...[...kinds].sort()];
}

/** Unit types of a source that still ask per item: the nav badge and the guide's nudge. */
export function unsettledUnitTypes(profile: MappingProfile, resolutions: Iterable<Resolution>, sourceId: string, unitTypes: readonly string[], existingKinds: readonly string[]): string[] {
  const rs = [...resolutions];
  return unitTypes.filter((ut) => {
    const s = unitTypeStanding(profile, rs, sourceId, ut, existingKinds);
    return s.kind === 'asks' && !s.decided;
  });
}

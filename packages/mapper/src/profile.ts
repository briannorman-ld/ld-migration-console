import { ownValue, sanitizeTag, type CanonicalSnapshot } from '@sslm/canonical';

export { sanitizeTag };
import type { MappingProfile, SourceProfile } from './types.ts';

/** LD attribute names for StatSig's built-in user fields (PLAN §10.3, "mapped attribute names"). */
export const DEFAULT_ATTRIBUTES: Record<string, string> = {
  email: 'email',
  ip_address: 'ip',
  country: 'country',
  locale: 'locale',
  app_version: 'appVersion',
  browser_name: 'browserName',
  browser_version: 'browserVersion',
  os_name: 'osName',
  os_version: 'osVersion',
  device_model: 'deviceModel',
  user_agent: 'userAgent',
};

/** LD built-in context attributes that a StatSig custom field must not shadow. */
const RESERVED_ATTRIBUTES = new Set(['key', 'kind', '_meta', 'anonymous']);

export function attributeFor(profile: MappingProfile, conditionType: string, field?: string | null): { attribute: string; renamed: boolean } {
  if (conditionType === 'custom_field') {
    const f = field ?? '';
    const mapped = ownValue(profile.attributes, `custom_field:${f}`);
    if (mapped) return { attribute: mapped, renamed: mapped !== f };
    if (RESERVED_ATTRIBUTES.has(f)) return { attribute: `custom_${f}`, renamed: true };
    return { attribute: f, renamed: false };
  }
  const a = ownValue(profile.attributes, conditionType) ?? ownValue(DEFAULT_ATTRIBUTES, conditionType) ?? conditionType;
  return { attribute: a, renamed: false };
}

/**
 * Default context kind for a StatSig unit type. `userID` is LD's `user`; custom unit IDs get their
 * own kind (CLAUDE.md: never collapse them into `user`).
 */
export function defaultKindFor(unitType: string): string {
  const u = unitType.trim();
  if (/^userid$/i.test(u)) return 'user';
  if (/^stableid$/i.test(u)) return 'device';
  const stripped = u.replace(/[_-]?id$/i, '') || u;
  const k = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return k === 'kind' || k === 'multi' || k === '' ? `${k || 'unit'}-id` : k;
}

/** LD context kind keys: letters, digits, `.`, `_` and `-`; `kind` and `multi` are reserved words. */
export const CONTEXT_KIND_KEY = /^[a-zA-Z0-9._-]+$/;

export function isValidContextKindKey(key: string): boolean {
  return CONTEXT_KIND_KEY.test(key) && key !== 'kind' && key !== 'multi';
}

/** The `unit_type_kind` option key that creates `key`; the card also accepts a key the user typed. */
export function createKindOption(key: string): string {
  return `create:${key}`;
}

/**
 * The `unit_type_kind` option key (and profile value) that keeps a unit type as an attribute of a
 * context: `attribute:<name>` on the `user` context, `attribute:<kind>/<name>` on any other kind.
 * `/` separates the two because neither a kind key nor an attribute name may contain it.
 */
export function attributeOption(name: string, contextKind = 'user'): string {
  return contextKind === 'user' ? `attribute:${name}` : `attribute:${contextKind}/${name}`;
}

/** The target an `attribute:` option or profile value names; undefined when it is not one LD would accept. */
export function attributeTarget(choice: string): UnitTarget | undefined {
  if (!choice.startsWith('attribute:')) return undefined;
  const rest = choice.slice('attribute:'.length);
  const slash = rest.indexOf('/');
  const contextKind = slash === -1 ? 'user' : rest.slice(0, slash);
  const attribute = slash === -1 ? rest : rest.slice(slash + 1);
  return isValidContextKindKey(contextKind) && isValidAttributeName(attribute) ? { contextKind, attribute } : undefined;
}

export function isValidAttributeName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n === name && !RESERVED_ATTRIBUTES.has(n) && !n.includes('/');
}

/**
 * Where a unit type's IDs live in LD: the key of a context kind (`attribute: 'key'`), or an
 * attribute of a context kind (`user`, an existing kind, or one the migration creates). Rules
 * match on it, rollouts bucket by it, and ID overrides become targets (key) or a targeting rule
 * (attribute: LD targets individuals only by key).
 */
export interface UnitTarget {
  contextKind: string;
  attribute: string;
}

export function unitFromChoice(choice: string, proposed: string): UnitTarget {
  if (choice.startsWith('attribute:')) return attributeTarget(choice) ?? { contextKind: proposed, attribute: 'key' };
  return { contextKind: kindFromChoice(choice, proposed), attribute: 'key' };
}

/**
 * The context kind a `unit_type_kind` answer names: `create:<key>` or `existing:<key>`. A key the
 * user typed is accepted only when LD would accept it; anything else falls back to the proposal.
 */
export function kindFromChoice(choice: string, proposed: string): string {
  if (choice.startsWith('attribute:')) return proposed;
  const key = choice.split(':').slice(1).join(':');
  return key && isValidContextKindKey(key) ? key : proposed;
}

/**
 * The profile's entry for a unit type, if any. StatSig compares unit types case-insensitively
 * (customIDs lookup), so an exact match wins and a case-insensitive one is accepted.
 */
export function configuredValue(profile: MappingProfile, sourceId: string, unitType: string): string | undefined {
  const sp = profile.sources[sourceId];
  const exact = ownValue(sp?.unitTypeKinds, unitType);
  if (exact) return exact;
  const ci = sp && Object.entries(sp.unitTypeKinds).find(([k]) => k.toLowerCase() === unitType.toLowerCase());
  return ci?.[1];
}

/**
 * Where the profile (the guide's Context kinds step) sends a unit type: a context kind key, or
 * `attribute:<name>` / `attribute:<kind>/<name>` to keep it as an attribute of the `user` context
 * or of another kind. A value LD would not accept counts as not configured, so the mapper falls
 * back to the default and asks.
 */
export function configuredUnit(profile: MappingProfile, sourceId: string, unitType: string): UnitTarget | undefined {
  const v = configuredValue(profile, sourceId, unitType);
  if (!v) return undefined;
  if (v.startsWith('attribute:')) return attributeTarget(v);
  return isValidContextKindKey(v) ? { contextKind: v, attribute: 'key' } : undefined;
}

/** The context kind a unit type maps to by profile or by default (the attribute's kind when kept as an attribute). */
export function kindFor(profile: MappingProfile, sourceId: string, unitType: string): string {
  return configuredUnit(profile, sourceId, unitType)?.contextKind ?? defaultKindFor(unitType);
}

/**
 * A fresh profile for a set of snapshots: environments map to the LD environment with the same
 * key or name (case-insensitive), otherwise unmapped. Unit types are left to their defaults, so
 * `unit_type_kind` decisions are raised until the user confirms them.
 */
export function defaultProfile(snapshots: CanonicalSnapshot[], ldEnvs: { key: string; name: string }[]): MappingProfile {
  const sources: Record<string, SourceProfile> = {};
  for (const s of snapshots) sources[s.source.sourceId] = { envMapping: autoEnvMapping(s, ldEnvs), unitTypeKinds: {} };
  return { version: 1, sources, attributes: {}, policies: {} };
}

export function autoEnvMapping(snapshot: CanonicalSnapshot, ldEnvs: { key: string; name: string }[]): Record<string, string | null> {
  const out: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const used = new Set<string>();
  for (const e of snapshot.environments) {
    const m = ldEnvs.find((l) => !used.has(l.key) && (l.key.toLowerCase() === e.name.toLowerCase() || l.name.toLowerCase() === e.name.toLowerCase()));
    out[e.name] = m?.key ?? null;
    if (m) used.add(m.key);
  }
  return out;
}

/**
 * Merge a stored profile with what a new snapshot or LD project adds, never overwriting choices.
 * `hints` (StatSig env → LD env) fill environments that have no exact match, e.g. the demo's
 * `staging → test`.
 */
export function reconcileProfile(profile: MappingProfile, snapshots: CanonicalSnapshot[], ldEnvs: { key: string; name: string }[], hints: Record<string, string> = {}): MappingProfile {
  const sources = { ...profile.sources };
  for (const s of snapshots) {
    const existing = sources[s.source.sourceId];
    const auto = autoEnvMapping(s, ldEnvs);
    for (const [from, to] of Object.entries(hints)) {
      if (auto[from] === null && ldEnvs.some((e) => e.key === to) && !Object.values(auto).includes(to)) auto[from] = to;
    }
    const valid = new Set(ldEnvs.map((e) => e.key));
    const envMapping: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
    for (const e of s.environments) {
      const prev = ownValue(existing?.envMapping, e.name);
      envMapping[e.name] = prev === undefined || (prev !== null && !valid.has(prev)) ? (ownValue(auto, e.name) ?? null) : prev;
    }
    sources[s.source.sourceId] = { envMapping, unitTypeKinds: existing?.unitTypeKinds ?? {} };
  }
  return { ...profile, sources };
}

/** LD keys allow letters, digits, `.`, `_` and `-`. */
export function sanitizeKey(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '') || 'statsig_item';
}


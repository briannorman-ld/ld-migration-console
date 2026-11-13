/**
 * Provenance the console writes into the user's LD project (PLAN §3.3).
 *
 * The scheme is source-neutral: every tag and property says which *kind* of source a resource
 * came from, so StatSig and later sources (FeatureHub, Unleash, another LD project, …) can share
 * one LD project and the console can tell their resources apart. Keys are stable identifiers
 * (`migration.id`); the human-facing names (`StatSig ID`) carry the provider for the LD UI.
 *
 * Legacy scheme (written before 2026-10-30, while the app was StatSig-only): `statsig-migrated`
 * and `statsig-src-<alias>` tags, `statsig.*` custom properties and `[statsig-migration: …]`
 * description footers. Everything here still *reads* it, so projects migrated with earlier builds
 * keep their status; nothing writes it any more. A re-sync writes the new keys next to the old
 * ones and the readers prefer the new ones.
 */

import type { SourceKind } from './model.ts';

/** Kinds of source a migration can read from: StatSig (Console API or config spec), another LaunchDarkly project (PLAN §20) and PostHog (API or payload, PLAN §22). */
export type MigrationSourceKind = 'statsig' | 'launchdarkly' | 'posthog';
export const SOURCE_KIND_LABEL: Record<MigrationSourceKind, string> = { statsig: 'StatSig', launchdarkly: 'LaunchDarkly', posthog: 'PostHog' };
export const MIGRATION_SOURCE_KINDS: readonly MigrationSourceKind[] = ['statsig', 'launchdarkly', 'posthog'];

/** The provenance kind written for resources read from a source of this kind (both StatSig source kinds are `statsig`, both PostHog kinds `posthog`). */
export function migrationKindOf(sourceKind: SourceKind): MigrationSourceKind {
  if (sourceKind === 'launchdarkly') return 'launchdarkly';
  if (sourceKind === 'posthog' || sourceKind === 'posthog_payload') return 'posthog';
  return 'statsig';
}

/** LD tags: letters, digits, `.`, `_`, `-`; at most 64 characters. */
export function sanitizeTag(tag: string): string {
  return tag
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64);
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

const MIGRATED_PREFIX = 'migrated-from-';
const SOURCE_PREFIX = 'migration-src-';
const LEGACY_TAG_MIGRATED = 'statsig-migrated';
const LEGACY_SOURCE_PREFIX = 'statsig-src-';

/** `migrated-from-<kind>`: on every resource and environment the console creates. */
export const migratedFromTag = (kind: MigrationSourceKind): string => `${MIGRATED_PREFIX}${kind}`;
/** `migration-src-<alias>`: which attached source (consolidation, PLAN §12) a resource came from. */
export const sourceTag = (alias: string): string => sanitizeTag(`${SOURCE_PREFIX}${alias}`);

/** True for the marker tag of any source kind, current or legacy. */
export const isMigratedTag = (tag: string): boolean => tag.startsWith(MIGRATED_PREFIX) || tag === LEGACY_TAG_MIGRATED;
/** True when the tag list marks a resource as created by the console (any source kind). */
export const hasMigratedTag = (tags: readonly string[]): boolean => tags.some(isMigratedTag);

/**
 * Context kinds carry no tags or custom properties, so the one the console creates is marked in
 * its description (written by the executor, read by the project reset so it archives only those).
 */
export const CONSOLE_CREATED_MARKER = 'created by the LaunchDarkly Migration Console';
export const createdByConsole = (description: string | null | undefined): boolean => !!description && description.includes(CONSOLE_CREATED_MARKER);
/** True when the tag list says the resource came from the attached source `alias`. */
export const hasSourceTag = (tags: readonly string[], alias: string): boolean =>
  tags.includes(sourceTag(alias)) || tags.includes(sanitizeTag(`${LEGACY_SOURCE_PREFIX}${alias}`));
/** The source kind a tag list records, when it does (legacy tags are StatSig). */
export function sourceKindOf(tags: readonly string[]): MigrationSourceKind | undefined {
  for (const t of tags) {
    if (t === LEGACY_TAG_MIGRATED) return 'statsig';
    if (t.startsWith(MIGRATED_PREFIX)) return t.slice(MIGRATED_PREFIX.length) as MigrationSourceKind;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Flag custom properties
// ---------------------------------------------------------------------------------------------

/** Custom-property keys. Flags only: segments, metrics and experiments use tags plus a footer. */
export const PROP = {
  kind: 'migration.kind',
  id: 'migration.id',
  type: 'migration.type',
  source: 'migration.source',
  version: 'migration.version',
  owner: 'migration.owner',
  permalink: 'migration.permalink',
} as const;
const SYNC_PREFIX = 'migration.sync.';
const LEGACY_SYNC_PREFIX = 'statsig.sync.';
const LEGACY_PROP = { id: 'statsig.id', type: 'statsig.type', source: 'statsig.source' } as const;

/** `migration.sync.<ldEnv>`: `[fingerprint, version, syncedAt, decisionSetHash, sc:<id>…]`. */
export const syncPropertyKey = (ldEnv: string): string => `${SYNC_PREFIX}${ldEnv}`;

type Props = Record<string, { value?: (string | null | undefined)[] | null } | undefined>;

/** The sync record for one environment, current key first, then legacy. */
export function readSync(props: Props, ldEnv: string): (string | null | undefined)[] | undefined {
  const v = props[syncPropertyKey(ldEnv)]?.value ?? props[`${LEGACY_SYNC_PREFIX}${ldEnv}`]?.value;
  return v && v.length ? v : undefined;
}

/** Every LD environment with a non-empty sync record, from current and legacy keys. */
export function syncedEnvsOf(props: Props): string[] {
  const envs = new Set<string>();
  for (const k of Object.keys(props)) {
    const prefix = k.startsWith(SYNC_PREFIX) ? SYNC_PREFIX : k.startsWith(LEGACY_SYNC_PREFIX) ? LEGACY_SYNC_PREFIX : null;
    if (prefix && (props[k]?.value?.length ?? 0) > 0) envs.add(k.slice(prefix.length));
  }
  return [...envs];
}

export interface FlagProvenance {
  kind: MigrationSourceKind;
  /** The source's own ID for the resource. */
  id: string;
  /** Alias of the attached source (PLAN §12). */
  source: string;
  /** Resource type in the source's vocabulary (`gate`, `config`, `autotune`, …). */
  type?: string;
}

/** The provenance a flag carries, or null when the console didn't create it. */
export function readFlagProvenance(f: { tags: readonly string[]; customProperties: Props }): FlagProvenance | null {
  if (!hasMigratedTag(f.tags)) return null;
  const first = (...keys: string[]) => {
    for (const k of keys) {
      const v = f.customProperties[k]?.value?.[0];
      if (v) return v;
    }
    return undefined;
  };
  const id = first(PROP.id, LEGACY_PROP.id);
  const source = first(PROP.source, LEGACY_PROP.source);
  if (!id || !source) return null;
  const type = first(PROP.type, LEGACY_PROP.type);
  const kind = (first(PROP.kind) as MigrationSourceKind | undefined) ?? sourceKindOf(f.tags) ?? 'statsig';
  return { kind, id, source, ...(type ? { type } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Description footer (segments, metrics, experiments)
// ---------------------------------------------------------------------------------------------

const FOOTER_RE = /\n*\[(?:ld-migration|statsig-migration): ([^\]]*)\]\s*$/;

export interface FooterInput {
  kind: MigrationSourceKind;
  sourceAlias: string;
  sourceId: string;
  sourceFingerprint: string;
  decisionSetHash: string;
}

/** `[ld-migration: from=statsig; src=web; id=…; fp=…; d=…; at=…]`. */
export function footer(p: FooterInput, at: Date): string {
  return `[ld-migration: from=${p.kind}; src=${p.sourceAlias}; id=${p.sourceId}; fp=${p.sourceFingerprint}; d=${p.decisionSetHash}; at=${at.toISOString()}]`;
}

/** `description` with any previous footer (current or legacy) replaced by `f`. */
export function withFooter(description: string, f: string): string {
  const base = description.replace(FOOTER_RE, '');
  return base ? `${base}\n\n${f}` : f;
}

/** The footer's fields; legacy footers have no `from` and are reported as StatSig. */
export function parseFooter(description: string | null | undefined): Record<string, string> | null {
  const m = FOOTER_RE.exec(description ?? '');
  if (!m) return null;
  const fields = Object.fromEntries(m[1]!.split(';').map((kv) => kv.trim().split('=') as [string, string]).filter((x) => x.length === 2));
  return { from: 'statsig', ...fields };
}

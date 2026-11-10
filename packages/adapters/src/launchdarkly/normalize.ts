/**
 * LaunchDarkly source adapter, normalize side (PLAN §20.1): raw LD responses → the neutral block
 * of a CanonicalSnapshot. Pure and deterministic. The StatSig collections stay empty; the
 * source's environments are the snapshot's environments (keyed by LD environment key), so the
 * mapping profile auto-maps them to target environments with the same key or name.
 */
import { emptyNeutralProject, emptySnapshot, neutralUid, type CanonicalSnapshot, type NeutralClause, type NeutralFlag, type NeutralFlagEnv, type NeutralRule, type NeutralSegment, type NeutralSegmentEnv, type NeutralServe, type NeutralTarget, type SnapshotWarning, type SourceRef } from '@sslm/canonical';
import type { LdFlag, LdFlagConfig, LdSegment } from '@sslm/ld-client';
import type { RawLdSnapshot } from './read.ts';

export interface NormalizeLdOptions {
  source: SourceRef & { alias: string };
  takenAt?: string;
}

/** What an LD source never provides (PLAN §20.2 "Not readable"). */
export const LD_SOURCE_MISSING_FIELDS: CanonicalSnapshot['completeness']['missing'] = ['checks', 'salts', 'idListMembers'];

export function normalizeLdSnapshot(raw: RawLdSnapshot, opts: NormalizeLdOptions): CanonicalSnapshot {
  const { source } = opts;
  const snap = emptySnapshot(source, opts.takenAt ?? raw.fetchedAt);
  const warn = (w: SnapshotWarning) => snap.warnings.push(w);
  snap.completeness = { missing: [...LD_SOURCE_MISSING_FIELDS] };
  snap.projectName = raw.project.name;
  snap.environments = raw.environments.map((e) => ({ name: e.key, id: e._id, isProduction: e.critical ?? /prod/i.test(e.key), inferred: false }));
  snap.tags = unique(raw.flags.flatMap((f) => f.tags ?? [])).map((name) => ({ name }));
  snap.unitTypes = raw.contextKinds.filter((k) => !k.archived).map((k) => ({ name: k.key, ...(k.name ? { description: k.name } : {}) }));

  for (const i of raw.schemaIssues) warn({ code: 'schema_mismatch', path: i.path, message: i.issues.map((x) => `${x.path || '(root)'}: ${x.message}`).join('; ') });
  for (const s of raw.skipped) warn({ code: 'fetch_skipped', path: s.endpoint, message: s.reason });

  const neutral = emptyNeutralProject();
  neutral.contextKinds = raw.contextKinds.map((k) => ({ key: k.key, ...(k.name ? { name: k.name } : {}), ...(k.archived ? { archived: true } : {}) }));
  const envKeys = raw.environments.map((e) => e.key);

  for (const f of raw.flags) {
    const path = `flags/${f.key}`;
    const environments: NeutralFlagEnv[] = [];
    for (const env of envKeys) {
      const c = f.environments?.[env];
      if (!c) {
        warn({ code: 'partial_spec', path: `${path}/environments/${env}`, message: `LaunchDarkly returned no configuration for environment “${env}”; treated as off with no rules.` });
        environments.push({ env, on: false, offVariation: f.defaults?.offVariation ?? Math.max(0, (f.variations ?? []).length - 1), fallthrough: { variation: f.defaults?.onVariation ?? 0 }, rules: [], targets: [], prerequisites: [] });
        continue;
      }
      environments.push(flagEnv(env, c, f, warn, `${path}/environments/${env}`));
    }
    const customProperties: NeutralFlag['customProperties'] = {};
    for (const [k, v] of Object.entries(f.customProperties ?? {})) customProperties[k] = { name: v.name ?? k, value: v.value ?? [] };
    const purpose = (f as { _purpose?: string | null; purpose?: string | null })._purpose ?? (f as { purpose?: string | null }).purpose ?? undefined;
    const maintainerId = (f as { maintainerId?: string | null }).maintainerId ?? undefined;
    const maintainerTeamKey = (f as { maintainerTeamKey?: string | null }).maintainerTeamKey ?? undefined;
    const maintainerEmail = (f as { _maintainer?: { email?: string | null } | null })._maintainer?.email ?? undefined;
    const experiments = ((f as { experiments?: { items?: { key?: string | null; name?: string | null }[] | null } | null }).experiments?.items ?? []).map((e) => e.key ?? e.name ?? '').filter(Boolean);
    const flag: NeutralFlag = {
      kind: 'flag',
      uid: neutralUid(source.sourceId, 'flag', f.key),
      key: f.key,
      name: f.name,
      description: f.description ?? '',
      flagKind: f.kind === 'multivariate' || (f.variations ?? []).length !== 2 || !(f.variations ?? []).every((v) => typeof v.value === 'boolean') ? 'multivariate' : 'boolean',
      variations: (f.variations ?? []).map((v) => ({ value: v.value, ...(v.name ? { name: v.name } : {}), ...(v.description ? { description: v.description } : {}) })),
      tags: f.tags ?? [],
      temporary: f.temporary ?? true,
      archived: f.archived ?? false,
      ...(purpose ? { purpose } : {}),
      ...((f as { deprecated?: boolean | null }).deprecated ? { deprecated: true } : {}),
      ...(f.clientSideAvailability ? { clientSideAvailability: { usingEnvironmentId: f.clientSideAvailability.usingEnvironmentId ?? false, usingMobileKey: f.clientSideAvailability.usingMobileKey ?? false } } : {}),
      ...(f.defaults ? { defaults: { onVariation: f.defaults.onVariation, offVariation: f.defaults.offVariation } } : {}),
      customProperties,
      ...(maintainerId || maintainerEmail || maintainerTeamKey ? { maintainer: { ...(maintainerId ? { id: maintainerId } : {}), ...(maintainerEmail ? { email: maintainerEmail } : {}), ...(maintainerTeamKey ? { teamKey: maintainerTeamKey } : {}) } } : {}),
      experiments,
      ...(f._version != null ? { version: f._version } : {}),
      ...(typeof f.creationDate === 'number' ? { creationDate: f.creationDate } : {}),
      environments,
    };
    neutral.flags.push(flag);
  }

  // Segments: one neutral segment per key, with the environments it exists in.
  const byKey = new Map<string, { seg: LdSegment; envs: NeutralSegmentEnv[] }>();
  for (const env of envKeys) {
    for (const s of raw.segments[env] ?? []) {
      if (s.deleted) continue;
      const entry = byKey.get(s.key) ?? { seg: s, envs: [] };
      entry.envs.push(segmentEnv(env, s, warn, `segments/${env}/${s.key}`));
      // Name, description and tags can differ per environment in LD; the first environment's win, with a warning.
      if (entry.seg !== s && (entry.seg.name !== s.name || (entry.seg.description ?? '') !== (s.description ?? ''))) {
        warn({ code: 'ambiguous_override', path: `segments/${env}/${s.key}`, message: `Segment “${s.key}” has a different name or description in “${env}” than in “${entry.envs[0]!.env}”; the first environment's is used.` });
      }
      byKey.set(s.key, entry);
    }
  }
  for (const [key, { seg, envs }] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    neutral.segments.push({
      kind: 'segment',
      uid: neutralUid(source.sourceId, 'segment', key),
      key,
      name: seg.name,
      description: seg.description ?? '',
      tags: unique(envs.flatMap((e) => (raw.segments[e.env] ?? []).find((s) => s.key === key)?.tags ?? [])),
      archived: false,
      environments: envs,
    });
  }

  snap.neutral = neutral;
  snap.sourceTime = Math.max(0, ...raw.flags.flatMap((f) => Object.values(f.environments ?? {}).map((c) => c.lastModified ?? 0))) || undefined;
  return snap;
}

function serve(v: { variation?: number | null; rollout?: { variations: { variation: number; weight: number }[]; contextKind?: string | null; bucketBy?: string | null } | null } | null | undefined, warn: (w: SnapshotWarning) => void, path: string): NeutralServe {
  if (v?.rollout) {
    return {
      rollout: {
        contextKind: v.rollout.contextKind ?? 'user',
        ...(v.rollout.bucketBy ? { bucketBy: v.rollout.bucketBy } : {}),
        variations: (v.rollout.variations ?? []).map((w) => ({ variation: w.variation, weight: w.weight })),
      },
    };
  }
  if (v?.variation == null) {
    warn({ code: 'schema_mismatch', path, message: 'neither variation nor rollout; serving variation 0' });
    return { variation: 0 };
  }
  return { variation: v.variation };
}

function clause(c: { contextKind?: string | null; attribute: string; op: string; values: unknown[]; negate?: boolean | null }): NeutralClause {
  return { contextKind: c.contextKind ?? 'user', attribute: c.attribute, op: c.op, values: c.values, negate: c.negate ?? false };
}

function flagEnv(env: string, c: LdFlagConfig, f: LdFlag, warn: (w: SnapshotWarning) => void, path: string): NeutralFlagEnv {
  const rules: NeutralRule[] = (c.rules ?? []).map((r, i) => ({
    ...(r._id ? { id: r._id } : {}),
    description: r.description ?? '',
    clauses: (r.clauses ?? []).map(clause),
    ...serve(r, warn, `${path}/rules[${i}]`),
    ...((r as { disabled?: boolean | null }).disabled ? { disabled: true } : {}),
    ...(r.trackEvents ? { trackEvents: true } : {}),
  }));
  // `targets` is the user kind; `contextTargets` carries every kind (LD repeats user entries there with empty values).
  const targets = new Map<string, NeutralTarget>();
  const addTargets = (list: { values: string[]; variation: number; contextKind?: string | null }[] | null | undefined) => {
    for (const t of list ?? []) {
      if (!t.values.length) continue;
      const kind = t.contextKind ?? 'user';
      const k = `${kind}|${t.variation}`;
      const cur = targets.get(k) ?? { contextKind: kind, variation: t.variation, values: [] };
      for (const v of t.values) if (!cur.values.includes(v)) cur.values.push(v);
      targets.set(k, cur);
    }
  };
  addTargets(c.targets);
  addTargets(c.contextTargets);
  return {
    env,
    on: c.on,
    offVariation: c.offVariation ?? f.defaults?.offVariation ?? Math.max(0, (f.variations ?? []).length - 1),
    fallthrough: serve(c.fallthrough, warn, `${path}/fallthrough`),
    rules,
    targets: [...targets.values()].sort((a, b) => `${a.contextKind}|${a.variation}`.localeCompare(`${b.contextKind}|${b.variation}`)),
    prerequisites: (c.prerequisites ?? []).map((p) => ({ key: p.key, variation: p.variation })),
    ...(c.trackEvents ? { trackEvents: true } : {}),
    ...(c.version != null ? { version: c.version } : {}),
    ...(c.lastModified != null ? { lastModified: c.lastModified } : {}),
  };
}

function segmentEnv(env: string, s: LdSegment, _warn: (w: SnapshotWarning) => void, _path: string): NeutralSegmentEnv {
  const included: NeutralSegmentEnv['included'] = [];
  const excluded: NeutralSegmentEnv['excluded'] = [];
  if (s.included?.length) included.push({ contextKind: 'user', values: [...s.included] });
  for (const c of s.includedContexts ?? []) if (c.values.length && !(c.contextKind === 'user' && s.included?.length)) included.push({ contextKind: c.contextKind, values: [...c.values] });
  if (s.excluded?.length) excluded.push({ contextKind: 'user', values: [...s.excluded] });
  for (const c of s.excludedContexts ?? []) if (c.values.length && !(c.contextKind === 'user' && s.excluded?.length)) excluded.push({ contextKind: c.contextKind, values: [...c.values] });
  const unboundedContextKind = (s as { unboundedContextKind?: string | null }).unboundedContextKind ?? 'user';
  return {
    env,
    rules: (s.rules ?? []).map((r) => ({
      ...(r._id ? { id: r._id } : {}),
      description: r.description ?? '',
      clauses: (r.clauses ?? []).map(clause),
      ...(r.weight != null ? { weight: r.weight, rolloutContextKind: r.rolloutContextKind ?? 'user' } : {}),
      ...(r.bucketBy ? { bucketBy: r.bucketBy } : {}),
    })),
    included,
    excluded,
    ...(s.unbounded ? { unbounded: { contextKind: unboundedContextKind } } : {}),
    ...(s.version != null ? { version: s.version } : {}),
    ...(typeof s.lastModifiedDate === 'number' ? { lastModified: s.lastModifiedDate } : {}),
  };
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

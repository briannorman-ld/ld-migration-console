/**
 * What a finished run wrote that the re-listed LD state does not show (PLAN §9 "Migrate flow").
 *
 * After a run the LD session is refreshed by listing every flag and segment in the project, and the
 * resource pages read their status from those listings. In a large project that listing is 30+
 * pages, and it can disagree with what the run just did: a page served stale, a listing that
 * failed partway, or a refresh that started before the run and finished after it. Each
 * disagreement is settled by reading that one resource directly (`GET /flags/{p}/{key}`, which is
 * authoritative) and merging it into the listing, so a subset migration shows as migrated the
 * moment the modal closes. In the common case the listing agrees and nothing is fetched.
 */
import { readSync } from '@sslm/canonical';
import type { ResourceChange, RunRecord } from '@sslm/executor';
import type { LdFlag, LdFlagSummary, LdSegment } from '@sslm/ld-client';

export interface StaleAfterRun {
  /** Flags to re-read by key. */
  flagKeys: string[];
  /** Segments to re-read, per LD environment. */
  segments: { ldEnv: string; key: string }[];
}

export function staleAfterRun(run: RunRecord, flags: ReadonlyMap<string, LdFlagSummary>, segments: Record<string, LdSegment[]> | undefined): StaleAfterRun {
  const flagKeys = new Set<string>();
  const segs = new Map<string, { ldEnv: string; key: string }>();
  if (run.dryRun) return { flagKeys: [], segments: [] };
  const startedAt = Date.parse(run.startedAt);
  /** Whether the listing's sync record for `ldEnv` was written by this run (undo restores an older one, or none). */
  const syncedByRun = (key: string, ldEnv: string): boolean => {
    const f = flags.get(key);
    const at = f && readSync(f.customProperties ?? {}, ldEnv)?.[2];
    return !!at && Date.parse(at) >= startedAt;
  };
  const listed = (ldEnv: string, key: string) => !!segments?.[ldEnv]?.some((s) => s.key === key);
  for (const rec of run.steps) {
    const s = rec.step;
    if (rec.status === 'done') {
      // The run's result must be in the listing: the flag (or segment) exists and this run's provenance is on it.
      if (s.op === 'upsert_flag_shell' && !flags.has(s.key)) flagKeys.add(s.key);
      else if (s.op === 'update_flag_env' && !syncedByRun(s.key, s.ldEnv)) flagKeys.add(s.key);
      else if (s.op === 'upsert_segment' && !listed(s.ldEnv, s.key)) segs.set(`${s.ldEnv}/${s.key}`, { ldEnv: s.ldEnv, key: s.key });
    } else if (rec.status === 'undone') {
      // Undo deleted what the run created and restored what it changed: a listing still showing the run's result is stale.
      if (s.op === 'upsert_flag_shell' && rec.created && flags.has(s.key)) flagKeys.add(s.key);
      else if (s.op === 'update_flag_env' && syncedByRun(s.key, s.ldEnv)) flagKeys.add(s.key);
      else if (s.op === 'upsert_segment' && rec.created && listed(s.ldEnv, s.key)) segs.set(`${s.ldEnv}/${s.key}`, { ldEnv: s.ldEnv, key: s.key });
    }
  }
  return { flagKeys: [...flagKeys], segments: [...segs.values()] };
}

/** `items` with each update applied by key: a `null` item removes the key, a new key is appended, an existing one is replaced in place. */
export function mergeByKey<T extends { key: string }>(items: readonly T[], updates: readonly { key: string; item: T | null }[]): T[] {
  if (!updates.length) return [...items];
  const byKey = new Map(updates.map((u) => [u.key, u.item]));
  const out: T[] = [];
  for (const it of items) {
    if (!byKey.has(it.key)) out.push(it);
    else {
      const u = byKey.get(it.key);
      if (u) out.push(u);
      byKey.delete(it.key);
    }
  }
  for (const u of byKey.values()) if (u) out.push(u);
  return out;
}

/**
 * What a run reported (executor `onResource`), one entry per flag and per (environment, segment):
 * the last report wins, since each is the resource as the write that made it returned it, and a
 * `null` is a deletion. These go into the session through mergeLdFlags/mergeLdSegments.
 */
export function latestChanges(changes: readonly ResourceChange[]): { flags: { key: string; flag: LdFlag | null }[]; segments: { ldEnv: string; key: string; segment: LdSegment | null }[] } {
  const flags = new Map<string, { key: string; flag: LdFlag | null }>();
  const segments = new Map<string, { ldEnv: string; key: string; segment: LdSegment | null }>();
  for (const c of changes) {
    if (c.kind === 'flag') flags.set(c.key, { key: c.key, flag: c.flag });
    else segments.set(`${c.ldEnv}/${c.key}`, { ldEnv: c.ldEnv, key: c.key, segment: c.segment });
  }
  return { flags: [...flags.values()], segments: [...segments.values()] };
}

/** The project and account listings a run may have changed and does not report item by item (ld.ts `refreshLdLists`). */
export interface LdListNeeds {
  contextKinds: boolean;
  metrics: boolean;
  /** LD environments whose experiments to re-read. */
  experimentEnvs: string[];
  aiConfigs: boolean;
  /** Experimentation settings (randomization units). */
  settings: boolean;
}

/**
 * Which listings `run` touched, from the steps that ran (anything but pending and skipped: a
 * failed step may have written before it failed). Flags and segments are not listed here; the
 * run reports those itself.
 */
export function listsTouchedByRun(run: RunRecord): LdListNeeds {
  const needs: LdListNeeds = { contextKinds: false, metrics: false, experimentEnvs: [], aiConfigs: false, settings: false };
  for (const rec of run.steps) {
    if (rec.status === 'pending' || rec.status === 'skipped') continue;
    const s = rec.step;
    if (s.op === 'ensure_context_kind') needs.contextKinds = true;
    else if (s.op === 'upsert_metric') needs.metrics = true;
    else if (s.op === 'create_bandit' && !needs.experimentEnvs.includes(s.ldEnv)) needs.experimentEnvs.push(s.ldEnv);
    else if (s.op === 'upsert_ai_config') needs.aiConfigs = true;
    else if (s.op === 'ensure_randomization_unit') needs.settings = true;
  }
  return needs;
}

export const needsNothing = (n: LdListNeeds): boolean => !n.contextKinds && !n.metrics && !n.experimentEnvs.length && !n.aiConfigs && !n.settings;

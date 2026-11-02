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
import type { RunRecord } from '@sslm/executor';
import type { LdFlagSummary, LdSegment } from '@sslm/ld-client';

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

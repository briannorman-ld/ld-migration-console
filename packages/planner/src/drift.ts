/**
 * "LD changed" (PLAN §8.3 `ld_drift_on_sync`, §14): did someone change a flag's targeting in
 * LaunchDarkly after the console last synced it? The planner asks before writing over such an
 * edit, the executor refuses to write or to undo over one, and monitoring reports it.
 */

/** What LaunchDarkly tells about one flag environment, as far as change detection needs. */
export interface LdFlagEnvInfo {
  on?: boolean | null;
  version?: number | null;
  /** Epoch milliseconds. */
  lastModified?: number | null;
}

/**
 * Our own provenance write follows the targeting write by a moment, and may touch the flag's
 * modification time; anything inside this window after `syncedAt` is not a change by someone else.
 */
export const LD_CHANGE_GRACE_MS = 2 * 60 * 1000;

/**
 * Compares the environment's `lastModified` with the sync time recorded in the provenance, and,
 * when the caller knows the environment version after our write, the version too. When both are
 * known the modification time decides: our provenance write can bump the version alone.
 */
export function ldChange(env: LdFlagEnvInfo | undefined, syncedAt: string | undefined, versionAtSync?: number, graceMs = LD_CHANGE_GRACE_MS): { changed: boolean; evidence?: string } {
  const syncedMs = syncedAt ? Date.parse(syncedAt) : NaN;
  const modified = env?.lastModified ?? undefined;
  if (modified !== undefined && Number.isFinite(syncedMs)) {
    if (modified > syncedMs + graceMs) return { changed: true, evidence: `modified ${new Date(modified).toISOString()}, after the sync at ${new Date(syncedMs).toISOString()}` };
    return { changed: false };
  }
  const version = env?.version ?? undefined;
  if (versionAtSync !== undefined && version !== undefined && version > versionAtSync) return { changed: true, evidence: `version ${version}, was ${versionAtSync} at sync` };
  return { changed: false };
}

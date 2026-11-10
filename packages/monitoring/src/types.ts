/**
 * Monitoring model (PLAN §14). Read-only: nothing here writes to StatSig or LaunchDarkly.
 *
 * Everything is per (resource, LD environment), like migration state (PLAN §7). The durable
 * part is read from the LD provenance the executor wrote (`migration.sync.<env>`), so the same
 * answers come out on any machine; samples, the "LD authoritative" switch and the alert
 * baseline live in the browser (PLAN §3.3 item 2).
 */
import type { Fidelity } from '@sslm/mapper';
import type { LdFlagEnvInfo, LdFlagState, MigrationStatus } from '@sslm/planner';

/**
 * Drift per (flag, environment).
 * - The first four come from the planner's `migrationStatus` and mean "not under monitoring".
 * - `ld_changed`: LD targeting moved after the sync (someone edited the flag in LD).
 * - `conflict`: StatSig and LD both changed.
 * - `archived_in_statsig`: migrated, then archived in StatSig; the LD flag should be retired, not synced.
 * - `missing_in_statsig`: an LD flag carries our provenance but no current snapshot has the entity.
 * - `ld_authoritative`: the user flipped the per-item switch (PLAN §7): StatSig changes stop alerting.
 */
export type MonitorStatus = MigrationStatus | 'ld_changed' | 'conflict' | 'archived_in_statsig' | 'missing_in_statsig' | 'ld_authoritative';

/** LD flag status names (reference/launchdarkly/openapi.json FlagStatusRep.name), plus unknown. */
export type LdTraffic = 'new' | 'inactive' | 'active' | 'launched' | 'unknown';

/** PLAN §14 lifecycle: Migrated (no LD traffic) → Dual-running → Cut over → safe to archive in StatSig. */
export type Lifecycle = 'not_migrated' | 'migrated' | 'dual_running' | 'cut_over' | 'ld_authoritative';

/** A migratable StatSig entity in one mapped environment, as the app's mapper sees it. */
export interface MonitoredItem {
  /** `flag`: a neutral (LD-source) flag, PLAN §20. */
  kind: 'gate' | 'config' | 'autotune' | 'flag';
  uid: string;
  id: string;
  name: string;
  sourceId: string;
  sourceAlias: string;
  flagKey: string;
  ldEnv: string;
  statsigEnv: string;
  archived: boolean;
  statsigFingerprint: string;
  decisionSetHash: string;
  statsigVersion?: number;
  fidelity: Fidelity;
  openDecisions: number;
  /** StatSig checks per hour across all environments (Console API sources only). */
  checksPerHour?: number | null;
}

export type { LdFlagEnvInfo };

/** What monitoring needs from an LD flag: the planner's state plus per-environment versions. */
export interface LdFlagInfo extends LdFlagState {
  environments?: Record<string, LdFlagEnvInfo> | null;
}

export interface FlagStatusInfo {
  name: string;
  lastRequested?: string | null;
}

/** One reading of a (flag, environment), taken while the app was open. */
export interface MonitorSample {
  flagKey: string;
  ldEnv: string;
  at: string;
  ldStatus: string;
  lastRequested?: string | null;
  /** StatSig checks per hour at the time (all environments); null/undefined = unknown. */
  statsigChecksPerHour?: number | null;
}

export interface MonitorItemSettings {
  flagKey: string;
  ldEnv: string;
  ldAuthoritative: boolean;
  setAt: string;
}

export interface MonitorRow extends MonitoredItem {
  status: MonitorStatus;
  syncedAt?: string;
  statsigChanged: boolean;
  ldChanged: boolean;
  /** Why LD counts as changed, e.g. `modified 2026-10-23T10:00Z, after the sync at 2026-10-22T09:00Z`. */
  ldChangeEvidence?: string;
  ldOn?: boolean;
  traffic: LdTraffic;
  lastRequested?: string;
  lifecycle: Lifecycle;
  ldAuthoritative: boolean;
  /** When StatSig checks were first seen at zero in the current zero streak (cut-over evidence). */
  statsigZeroSince?: string;
}

export interface MonitorInput {
  items: readonly MonitoredItem[];
  ldFlags: ReadonlyMap<string, LdFlagInfo>;
  /** LD environment key → flag key → status. */
  statuses: Readonly<Record<string, Readonly<Record<string, FlagStatusInfo>>>>;
  settings: readonly MonitorItemSettings[];
  samples: readonly MonitorSample[];
  /** `<flagKey>|<ldEnv>` → the LD environment version recorded by the run that synced it (local journal). */
  ldVersionsAtSync?: Readonly<Record<string, number>>;
  /** ISO time of the check. */
  now: string;
}

export type AlertKind = 'drift' | 'archived' | 'missing' | 'cut_over';

export interface MonitorAlert {
  kind: AlertKind;
  row: MonitorRow;
  message: string;
}

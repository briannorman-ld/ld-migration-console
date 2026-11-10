import Dexie, { type EntityTable } from "dexie";
import type { CanonicalSnapshot, SourceDescriptor } from "@sslm/canonical";
import type { MappingProfile, Resolution } from "@sslm/mapper";
import type { RunRecord } from "@sslm/executor";
import type { VaultBlob } from "./vault.ts";

/**
 * Browser state (PLAN §3.3 item 2). Tokens are never stored here: see assertNoSecrets.
 * Version 2 (M3) adds the mapping profile, resolutions, the run journal (with pre-images) and
 * fetched ID lists. Later milestones add waves and cutover samples the same way.
 */

/**
 * How LD account members and teams are managed (guide step 1). `launchdarkly`: the console may
 * invite members and create teams. `scim`: an identity provider provisions members over SCIM;
 * the console creates teams but never invites. `scim_team_sync`: Okta provisions members and
 * teams (Group Push); the console only reports what is missing. Undefined = not answered yet,
 * treated as `launchdarkly`.
 */
export type AccountAccess = "launchdarkly" | "scim" | "scim_team_sync";

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
  /** The single LD target (PLAN §3.6): instance + project. No token. */
  ld?: { instance: "us" | "eu" | "federal"; projectKey?: string };
  /** EU / Federal acknowledgement (PLAN §3.5), stored in the workspace. */
  instanceAcknowledgement?: {
    instance: "eu" | "federal";
    acknowledgedAt: string;
  };
  /** Snapshots kept per source after each sync (plus any a run used). Undefined = DEFAULT_SNAPSHOT_RETENTION. */
  snapshotRetention?: number;
  /**
   * Where this workspace's tokens live (PLAN §3.4). Undefined = `device`: encrypted on this
   * device under a key the browser holds, restored on open. `memory`: this tab only; the user
   * opted out. A passphrase vault is `device` with a passphrase-derived key.
   */
  tokenStorage?: "device" | "memory";
  /** See AccountAccess. Account-level, so once per workspace. */
  accountAccess?: AccountAccess;
}

export interface SourceRecord extends SourceDescriptor {
  workspaceId: string;
}

export interface SnapshotRecord {
  id: string;
  workspaceId: string;
  sourceId: string;
  takenAt: string;
  sourceKind: CanonicalSnapshot["source"]["sourceKind"];
  /**
   * Counts for list views without loading the whole snapshot. The per-kind counts are live
   * entities only, the same numbers the sidebar shows: archived resources are never migrated, so
   * they are tallied apart in `archived`. Records saved before that split counted them in.
   */
  summary: {
    gates: number;
    configs: number;
    segments: number;
    experiments: number;
    /** Archived gates, configs, segments and experiments, which the counts above leave out. */
    archived?: number;
    warnings: number;
  };
  /** Approximate size of `canonical` as JSON, for the storage view. Absent on records saved before it was tracked. */
  bytes?: number;
  canonical: CanonicalSnapshot;
}

/**
 * A snapshot as the `snapshots` table holds it: everything but the canonical payload, which sits
 * in `snapshotBodies` under the same id (IndexedDB reads whole records, and the snapshots view
 * lists a source's history on every change; the payloads are megabytes each).
 */
export type SnapshotMetaRecord = Omit<SnapshotRecord, "canonical">;

export interface SnapshotBodyRecord {
  /** The snapshot's id. */
  id: string;
  canonical: CanonicalSnapshot;
}

/** Raw spec uploads, versioned per source (PLAN §4.2 "Every upload becomes a new immutable snapshot"). */
export interface SpecUploadRecord {
  id: string;
  workspaceId: string;
  sourceId: string;
  uploadedAt: string;
  filename: string;
  bytes: number;
  version: 1 | 2;
  /** Parsed JSON. Contains salts and possibly PII: stays local, never in logs. */
  json: unknown;
  snapshotId: string;
}

export interface CapabilityRecord {
  workspaceId: string;
  probedAt: string;
  /** CapabilityMatrix from @sslm/ld-client (kept structural here to avoid a package cycle). */
  matrix: unknown;
}

/** The mapping profile (PLAN §8.1): one per workspace. */
export interface ProfileRecord {
  workspaceId: string;
  updatedAt: string;
  profile: MappingProfile;
}

export interface ResolutionRecord extends Resolution {
  workspaceId: string;
}

/**
 * Run journal (PLAN §9 step 6): written before and after every step. The steps' pre-images are
 * kept apart in `runPreImages` (see RunPreImageRecord), so this record stays small enough to
 * list and to rewrite twice per step.
 */
export interface RunJournalRecord extends RunRecord {
  /** The snapshots the run was planned from. Those snapshots are never pruned while the run exists. */
  snapshots?: { sourceId: string; takenAt: string }[];
}

/**
 * The state of one LD resource before a run's step touched it (undo restores it). A pre-image is
 * a whole flag with every environment, and a run of a thousand flags has a thousand of them: kept
 * in the run record, listing the runs read all of that on every open and every journal write
 * rewrote it. Written once per step, read back only by `getRun` (undo, resume, approval checks).
 */
export interface RunPreImageRecord {
  /** `<runId>/<stepId>`. */
  id: string;
  runId: string;
  stepId: string;
  preImage: unknown;
}

/**
 * Plaintext ID lists by segment uid (PLAN §4.1, §4.2): fetched on demand from the Console API, or
 * uploaded as a raw-ID CSV for a spec source's hashed list. Customer data: local only.
 */
export interface IdListRecord {
  /** Segment uid. */
  uid: string;
  workspaceId: string;
  sourceId: string;
  fetchedAt: string;
  ids: string[];
  /** Where the IDs came from; absent = Console API fetch (M3 records). */
  origin?: "console" | "upload";
  fileName?: string;
  /** Console fetches for a config-spec source: whose Console API key read the list (the spec source's own, or a Console API source of the workspace). */
  via?: { sourceId: string; label: string };
  /** Reconciliation against StatSig's hashed list, for uploads (mapper `IdListCoverage`). */
  coverage?: { total: number; matched: number; missing: number; extra: number; verified: boolean };
}

/** Hashes from uploaded `get_id_lists` files, by segment uid, so a later raw-ID upload can be reconciled. */
export interface IdListHashesRecord {
  uid: string;
  workspaceId: string;
  sourceId: string;
  listName: string;
  uploadedAt: string;
  fileNames: string[];
  hashes: string[];
}

/**
 * Monitoring (PLAN §14, M5). Local only: the durable half of migration state is the LD provenance.
 * One sample per (flag, environment) reading worth keeping (see @sslm/monitoring shouldSample).
 */
export interface MonitorSampleRecord {
  id: string;
  workspaceId: string;
  flagKey: string;
  ldEnv: string;
  at: string;
  ldStatus: string;
  lastRequested?: string | null;
  statsigChecksPerHour?: number | null;
}

/** Per-(flag, environment) switches: "LD authoritative" (PLAN §7). */
export interface MonitorItemRecord {
  workspaceId: string;
  flagKey: string;
  ldEnv: string;
  ldAuthoritative: boolean;
  setAt: string;
}

/** The last check: when, what LD said, and which alerts have already been shown. */
export interface MonitorStateRecord {
  workspaceId: string;
  lastCheckedAt: string;
  /** LD environment key → flag key → status. */
  statuses: Record<string, Record<string, { name: string; lastRequested?: string }>>;
  /** Environments whose statuses could not be read on the last check, with the reason. */
  errors?: Record<string, string>;
  alertKeys: string[];
  /** Browser notifications requested by the user for this workspace. */
  notify?: boolean;
}

/**
 * A StatSig item the user set aside: it stays in the explorers, but "Select all", the guide's
 * step counts and the plan leave it out until the mark is removed. Typical reason: no checks in
 * the past 7 days (the usage column), or a gate that will be hard-coded instead of migrated.
 */
export interface ExclusionRecord {
  workspaceId: string;
  /** Entity uid (`<sourceId>/<kind>/<id>`). */
  uid: string;
  reason?: string;
  markedAt: string;
}

/**
 * The workspace's tokens, AES-GCM encrypted (PLAN §3.4). The only place a token ever reaches
 * disk, and only as this blob. `device` is the non-extractable key of a device vault: the browser
 * can use it to decrypt the blob but cannot export it. A passphrase vault has no `device`.
 */
export interface VaultRecord {
  workspaceId: string;
  updatedAt: string;
  blob: VaultBlob;
  device?: CryptoKey;
}

/**
 * The last LaunchDarkly listing read for the workspace's project: flags, segments and experiments
 * per environment, context kinds, metrics, members, teams, AI Configs. Shown on the next open,
 * marked as of `loadedAt`, while the live read runs, the way the capability matrix is. No token.
 */
export interface LdStateRecord {
  workspaceId: string;
  instance: string;
  projectKey: string;
  loadedAt: string;
  /** The LdSession listing fields (kept structural here to avoid a package cycle with @sslm/ld-client). */
  state: unknown;
}

export class MigratorDb extends Dexie {
  workspaces!: EntityTable<WorkspaceRecord, "id">;
  sources!: EntityTable<SourceRecord, "id">;
  snapshots!: EntityTable<SnapshotMetaRecord, "id">;
  snapshotBodies!: EntityTable<SnapshotBodyRecord, "id">;
  specUploads!: EntityTable<SpecUploadRecord, "id">;
  capabilities!: EntityTable<CapabilityRecord, "workspaceId">;
  profiles!: EntityTable<ProfileRecord, "workspaceId">;
  resolutions!: Dexie.Table<ResolutionRecord, [string, string]>;
  runs!: EntityTable<RunJournalRecord, "id">;
  idLists!: EntityTable<IdListRecord, "uid">;
  idListHashes!: EntityTable<IdListHashesRecord, "uid">;
  monitorSamples!: EntityTable<MonitorSampleRecord, "id">;
  monitorItems!: Dexie.Table<MonitorItemRecord, [string, string, string]>;
  monitorState!: EntityTable<MonitorStateRecord, "workspaceId">;
  vaults!: EntityTable<VaultRecord, "workspaceId">;
  exclusions!: Dexie.Table<ExclusionRecord, [string, string]>;
  ldState!: EntityTable<LdStateRecord, "workspaceId">;
  runPreImages!: EntityTable<RunPreImageRecord, "id">;

  // The IndexedDB name predates the app's rename and stays: changing it would orphan every
  // user's local workspaces.
  constructor(name = "statsig-ld-migrator") {
    super(name);
    this.version(1).stores({
      workspaces: "id, updatedAt",
      sources: "id, workspaceId",
      snapshots: "id, workspaceId, sourceId, [sourceId+takenAt]",
      specUploads: "id, workspaceId, sourceId, [sourceId+uploadedAt]",
      capabilities: "workspaceId",
    });
    // M3: decisions, mapping profile, run journal, fetched ID lists.
    this.version(2).stores({
      profiles: "workspaceId",
      resolutions: "[workspaceId+id], workspaceId",
      runs: "id, workspaceId, startedAt, [workspaceId+startedAt]",
      idLists: "uid, workspaceId, sourceId",
    });
    // Snapshot history: raw uploads are looked up by snapshot when old snapshots are pruned.
    this.version(3).stores({
      specUploads:
        "id, workspaceId, sourceId, snapshotId, [sourceId+uploadedAt]",
    });
    // M4: hashes from uploaded get_id_lists files (ID-list reconciliation for spec sources).
    this.version(4).stores({
      idListHashes: "uid, workspaceId, sourceId",
    });
    // M5: monitoring samples, per-item switches and the last check.
    this.version(5).stores({
      monitorSamples: "id, workspaceId, [workspaceId+flagKey+ldEnv], at",
      monitorItems: "[workspaceId+flagKey+ldEnv], workspaceId",
      monitorState: "workspaceId",
    });
    // Remember on this device: encrypted token vault per workspace (PLAN §3.4).
    this.version(6).stores({
      vaults: "workspaceId",
    });
    // Items set aside ("Don't migrate"), per workspace.
    this.version(7).stores({
      exclusions: "[workspaceId+uid], workspaceId",
    });
    // The last LD listing per workspace, shown while the next read runs.
    this.version(8).stores({
      ldState: "workspaceId",
    });
    // Pre-images move out of the run records into their own table (see RunPreImageRecord).
    this.version(9)
      .stores({
        runPreImages: "id, runId",
      })
      .upgrade(async (tx) => {
        const parts: RunPreImageRecord[] = [];
        await tx
          .table<RunJournalRecord, string>("runs")
          .toCollection()
          .modify((run) => {
            for (const s of run.steps) {
              if (s.preImage === undefined) continue;
              parts.push({ id: `${run.id}/${s.id}`, runId: run.id, stepId: s.id, preImage: s.preImage });
              delete s.preImage;
              s.hasPreImage = true;
            }
          });
        if (parts.length) await tx.table<RunPreImageRecord, string>("runPreImages").bulkPut(parts);
      });
    // The canonical payload moves out of the snapshot records into its own table (see
    // SnapshotMetaRecord), one record at a time: a workspace may hold tens of megabytes of them.
    this.version(10)
      .stores({
        snapshotBodies: "id",
      })
      .upgrade(async (tx) => {
        const snapshots = tx.table<SnapshotMetaRecord & { canonical?: CanonicalSnapshot }, string>("snapshots");
        const bodies = tx.table<SnapshotBodyRecord, string>("snapshotBodies");
        for (const id of await snapshots.toCollection().primaryKeys()) {
          const rec = await snapshots.get(id);
          if (!rec || rec.canonical === undefined) continue;
          await bodies.put({ id, canonical: rec.canonical });
          delete rec.canonical;
          await snapshots.put(rec);
        }
      });
  }
}

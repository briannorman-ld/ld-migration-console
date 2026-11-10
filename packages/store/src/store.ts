import type { CanonicalSnapshot, SourceDescriptor } from "@sslm/canonical";
import type { MappingProfile, Resolution } from "@sslm/mapper";
import type { RunRecord } from "@sslm/executor";
import {
  MigratorDb,
  type CapabilityRecord,
  type ExclusionRecord,
  type IdListHashesRecord,
  type IdListRecord,
  type LdStateRecord,
  type MonitorItemRecord,
  type MonitorSampleRecord,
  type MonitorStateRecord,
  type ProfileRecord,
  type RunJournalRecord,
  type RunPreImageRecord,
  type SnapshotMetaRecord,
  type SnapshotRecord,
  type SourceRecord,
  type SpecUploadRecord,
  type VaultRecord,
  type WorkspaceRecord,
} from "./db.ts";
import type { VaultBlob } from "./vault.ts";

/** Property names that must never be persisted (CLAUDE.md: tokens never persisted unencrypted). */
const SECRET_KEYS =
  /^(token|apiKey|api_key|statsigApiKey|consoleKey|clientKey|ldToken|accessToken|authorization|secret|password|sdkKey|mobileKey)$/i;

export class SecretInStoreError extends Error {
  constructor(path: string) {
    super(
      `Refusing to persist a secret-looking field at ${path}. Tokens stay in memory.`,
    );
    this.name = "SecretInStoreError";
  }
}

/** Throws if any object key anywhere in `value` looks like a credential. */
export function assertNoSecrets(value: unknown, path = "$", depth = 0): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    // Snapshots can hold large arrays (ID lists); only objects can carry secret keys.
    for (let i = 0; i < value.length; i++)
      if (value[i] && typeof value[i] === "object")
        assertNoSecrets(value[i], `${path}[${i}]`, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k) && v !== undefined && v !== null && v !== "")
      throw new SecretInStoreError(`${path}.${k}`);
    assertNoSecrets(v, `${path}.${k}`, depth + 1);
  }
}

const now = () => new Date().toISOString();

/** UTF-16 code units of the JSON; close enough to bytes for a storage readout, and cheap (one stringify). */
export function approximateJsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export class DuplicateWorkspaceNameError extends Error {
  constructor(readonly workspaceName: string) {
    super(`A workspace named “${workspaceName}” already exists.`);
    this.name = "DuplicateWorkspaceNameError";
  }
}

/** Names compare trimmed and case-insensitively: "Contoso" and "contoso " are the same workspace to a person. */
export const normalizeWorkspaceName = (name: string) =>
  name.trim().toLocaleLowerCase();

export class WorkspaceStore {
  constructor(readonly db: MigratorDb = new MigratorDb()) {}

  async createWorkspace(input: {
    id?: string;
    name: string;
    isDemo?: boolean;
    ld?: WorkspaceRecord["ld"];
  }): Promise<WorkspaceRecord> {
    const name = input.name.trim();
    const ws: WorkspaceRecord = {
      id: input.id ?? crypto.randomUUID(),
      name,
      isDemo: input.isDemo ?? false,
      createdAt: now(),
      updatedAt: now(),
      ...(input.ld ? { ld: input.ld } : {}),
    };
    assertNoSecrets(ws);
    await this.db.transaction("rw", this.db.workspaces, async () => {
      if (await this.findWorkspaceByName(name, ws.id))
        throw new DuplicateWorkspaceNameError(name);
      await this.db.workspaces.put(ws);
    });
    return ws;
  }

  /** The workspace with this name (trimmed, case-insensitive), ignoring `exceptId`. */
  async findWorkspaceByName(
    name: string,
    exceptId?: string,
  ): Promise<WorkspaceRecord | undefined> {
    const key = normalizeWorkspaceName(name);
    const all = await this.db.workspaces.toArray();
    return all.find(
      (w) => w.id !== exceptId && normalizeWorkspaceName(w.name) === key,
    );
  }

  listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.db.workspaces.orderBy("updatedAt").reverse().toArray();
  }

  getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    return this.db.workspaces.get(id);
  }

  async updateWorkspace(
    id: string,
    patch: Partial<Omit<WorkspaceRecord, "id" | "createdAt">>,
  ): Promise<void> {
    assertNoSecrets(patch);
    if (patch.name !== undefined) {
      patch = { ...patch, name: patch.name.trim() };
      if (await this.findWorkspaceByName(patch.name!, id))
        throw new DuplicateWorkspaceNameError(patch.name!);
    }
    await this.db.workspaces.update(id, { ...patch, updatedAt: now() });
  }

  /** Deletes the workspace and everything under it. */
  async deleteWorkspace(id: string): Promise<void> {
    const tables = [
      this.db.workspaces,
      this.db.sources,
      this.db.snapshots,
      this.db.snapshotBodies,
      this.db.specUploads,
      this.db.capabilities,
      this.db.profiles,
      this.db.resolutions,
      this.db.runs,
      this.db.idLists,
      this.db.idListHashes,
      this.db.monitorSamples,
      this.db.monitorItems,
      this.db.monitorState,
      this.db.vaults,
      this.db.exclusions,
      this.db.ldState,
      this.db.runPreImages,
    ];
    await this.db.transaction("rw", tables, async () => {
      const runIds = await this.db.runs.where("workspaceId").equals(id).primaryKeys();
      if (runIds.length) await this.db.runPreImages.where("runId").anyOf(runIds).delete();
      await this.db.ldState.delete(id);
      await this.db.vaults.delete(id);
      await this.db.exclusions.where("workspaceId").equals(id).delete();
      await this.db.monitorSamples.where("workspaceId").equals(id).delete();
      await this.db.monitorItems.where("workspaceId").equals(id).delete();
      await this.db.monitorState.delete(id);
      await this.db.profiles.delete(id);
      await this.db.resolutions.where("workspaceId").equals(id).delete();
      await this.db.runs.where("workspaceId").equals(id).delete();
      await this.db.idLists.where("workspaceId").equals(id).delete();
      await this.db.idListHashes.where("workspaceId").equals(id).delete();
      await this.db.sources.where("workspaceId").equals(id).delete();
      await this.deleteSnapshots(await this.db.snapshots.where("workspaceId").equals(id).primaryKeys());
      await this.db.specUploads.where("workspaceId").equals(id).delete();
      await this.db.capabilities.delete(id);
      await this.db.workspaces.delete(id);
    });
  }

  async addSource(
    workspaceId: string,
    source: SourceDescriptor,
  ): Promise<SourceRecord> {
    const rec: SourceRecord = { ...source, workspaceId };
    assertNoSecrets(rec);
    await this.db.sources.put(rec);
    await this.touch(workspaceId);
    return rec;
  }

  /**
   * A source is named after the project it reads, so the label follows a rename there. Only the
   * label: the alias is in tags and provenance and never changes (see sourceNaming.ts).
   */
  async renameSource(sourceId: string, label: string): Promise<void> {
    await this.db.sources.update(sourceId, { label });
  }

  listSources(workspaceId: string): Promise<SourceRecord[]> {
    return this.db.sources
      .where("workspaceId")
      .equals(workspaceId)
      .sortBy("createdAt");
  }

  /** Removes a source and everything fetched from it (snapshots, raw uploads, ID lists). */
  async removeSource(sourceId: string): Promise<void> {
    const src = await this.db.sources.get(sourceId);
    await this.db.transaction(
      "rw",
      [
        this.db.sources,
        this.db.snapshots,
        this.db.snapshotBodies,
        this.db.specUploads,
        this.db.idLists,
        this.db.idListHashes,
      ],
      async () => {
        await this.deleteSnapshots(await this.db.snapshots.where("sourceId").equals(sourceId).primaryKeys());
        await this.db.specUploads.where("sourceId").equals(sourceId).delete();
        await this.db.idLists.where("sourceId").equals(sourceId).delete();
        await this.db.idListHashes.where("sourceId").equals(sourceId).delete();
        await this.db.sources.delete(sourceId);
      },
    );
    if (src) await this.touch(src.workspaceId);
  }

  /** How many snapshots a source keeps by default; see pruneSnapshots. */
  static readonly DEFAULT_SNAPSHOT_RETENTION = 10;

  /** Snapshots are immutable: each save is a new record (metadata and payload in their own tables, see SnapshotMetaRecord). */
  async saveSnapshot(
    workspaceId: string,
    snapshot: CanonicalSnapshot,
  ): Promise<SnapshotRecord> {
    // No assertNoSecrets here: snapshots hold customer config values, which may legitimately
    // have keys like "token". Our credentials can only reach the records we shape ourselves.
    const meta: SnapshotMetaRecord = {
      id: crypto.randomUUID(),
      workspaceId,
      sourceId: snapshot.source.sourceId,
      takenAt: snapshot.takenAt,
      sourceKind: snapshot.source.sourceKind,
      summary: {
        gates: snapshot.gates.length,
        configs: snapshot.configs.length,
        segments: snapshot.segments.length,
        experiments: snapshot.experiments.length,
        warnings: snapshot.warnings.length,
      },
      bytes: approximateJsonBytes(snapshot),
    };
    await this.db.transaction("rw", [this.db.snapshots, this.db.snapshotBodies], async () => {
      await this.db.snapshotBodies.add({ id: meta.id, canonical: snapshot });
      await this.db.snapshots.add(meta);
    });
    await this.touch(workspaceId);
    return { ...meta, canonical: snapshot };
  }

  async getSnapshot(id: string): Promise<SnapshotRecord | undefined> {
    return this.withBody(await this.db.snapshots.get(id));
  }

  /** The record with its payload; undefined when either is missing. */
  private async withBody(meta: SnapshotMetaRecord | undefined): Promise<SnapshotRecord | undefined> {
    if (!meta) return undefined;
    const body = await this.db.snapshotBodies.get(meta.id);
    return body ? { ...meta, canonical: body.canonical } : undefined;
  }

  /** Both halves of each snapshot. Inside a transaction that holds `snapshots` and `snapshotBodies`. */
  private async deleteSnapshots(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.snapshotBodies.bulkDelete(ids);
    await this.db.snapshots.bulkDelete(ids);
  }

  /**
   * Keeps the newest `keep` snapshots of a source plus every snapshot a migration run in the
   * workspace was planned from, and deletes the rest (with their raw spec uploads). Returns the
   * ids removed. Nothing in StatSig or LD is affected: this is local history only.
   */
  async pruneSnapshots(
    workspaceId: string,
    sourceId: string,
    keep: number = WorkspaceStore.DEFAULT_SNAPSHOT_RETENTION,
  ): Promise<string[]> {
    if (!Number.isFinite(keep) || keep < 1) return [];
    return this.db.transaction(
      "rw",
      [this.db.snapshots, this.db.snapshotBodies, this.db.specUploads, this.db.runs],
      async () => {
        const runs = await this.db.runs
          .where("workspaceId")
          .equals(workspaceId)
          .toArray();
        const protectedTimes = new Set(
          runs.flatMap((r) =>
            (r.snapshots ?? [])
              .filter((s) => s.sourceId === sourceId)
              .map((s) => s.takenAt),
          ),
        );
        const all = await this.db.snapshots
          .where("[sourceId+takenAt]")
          .between([sourceId, ""], [sourceId, "￿"])
          .reverse()
          .toArray();
        const doomed = all
          .slice(keep)
          .filter((s) => !protectedTimes.has(s.takenAt));
        if (doomed.length === 0) return [];
        const ids = doomed.map((s) => s.id);
        await this.db.specUploads.where("snapshotId").anyOf(ids).delete();
        await this.deleteSnapshots(ids);
        return ids;
      },
    );
  }

  async latestSnapshot(sourceId: string): Promise<SnapshotRecord | undefined> {
    return this.withBody(
      await this.db.snapshots
        .where("[sourceId+takenAt]")
        .between([sourceId, ""], [sourceId, "￿"])
        .last(),
    );
  }

  /** Newest first, without the canonical payload: the metadata table alone is read. */
  async listSnapshots(sourceId: string): Promise<SnapshotMetaRecord[]> {
    return this.db.snapshots
      .where("[sourceId+takenAt]")
      .between([sourceId, ""], [sourceId, "￿"])
      .reverse()
      .toArray();
  }

  async saveSpecUpload(
    rec: Omit<SpecUploadRecord, "id" | "uploadedAt">,
  ): Promise<SpecUploadRecord> {
    const full: SpecUploadRecord = {
      ...rec,
      id: crypto.randomUUID(),
      uploadedAt: now(),
    };
    await this.db.specUploads.add(full);
    return full;
  }

  listSpecUploads(sourceId: string): Promise<SpecUploadRecord[]> {
    return this.db.specUploads
      .where("[sourceId+uploadedAt]")
      .between([sourceId, ""], [sourceId, "￿"])
      .reverse()
      .toArray();
  }

  async saveCapabilities(workspaceId: string, matrix: unknown): Promise<void> {
    assertNoSecrets(matrix);
    const rec: CapabilityRecord = { workspaceId, probedAt: now(), matrix };
    await this.db.capabilities.put(rec);
  }

  getCapabilities(workspaceId: string): Promise<CapabilityRecord | undefined> {
    return this.db.capabilities.get(workspaceId);
  }

  /** Keep the LD listing just read, replacing the previous one. */
  async saveLdState(workspaceId: string, rec: Omit<LdStateRecord, "workspaceId">): Promise<void> {
    // No assertNoSecrets: the listing is LaunchDarkly's own resources (flags, segments, members),
    // which may carry user-chosen keys such as a custom property named "token". Our credentials
    // never reach it: `state` holds only what the LD client returned.
    await this.db.ldState.put({ workspaceId, ...rec });
  }

  getLdState(workspaceId: string): Promise<LdStateRecord | undefined> {
    return this.db.ldState.get(workspaceId);
  }

  // --- Mapping profile and decisions (PLAN §8) --------------------------------------------------

  async getProfile(workspaceId: string): Promise<MappingProfile | undefined> {
    return (await this.db.profiles.get(workspaceId))?.profile;
  }

  async saveProfile(
    workspaceId: string,
    profile: MappingProfile,
  ): Promise<void> {
    const rec: ProfileRecord = { workspaceId, updatedAt: now(), profile };
    assertNoSecrets(rec);
    await this.db.profiles.put(rec);
  }

  async listResolutions(workspaceId: string): Promise<Resolution[]> {
    return (
      await this.db.resolutions
        .where("workspaceId")
        .equals(workspaceId)
        .toArray()
    ).map(({ workspaceId: _w, ...r }) => r);
  }

  async saveResolutions(
    workspaceId: string,
    resolutions: Resolution[],
  ): Promise<void> {
    const recs = resolutions.map((r) => ({ ...r, workspaceId }));
    assertNoSecrets(recs);
    await this.db.resolutions.bulkPut(recs);
  }

  async deleteResolutions(workspaceId: string, ids: string[]): Promise<void> {
    await this.db.resolutions.bulkDelete(
      ids.map((id) => [workspaceId, id] as [string, string]),
    );
  }

  // --- Run journal (PLAN §9 step 6, §15) --------------------------------------------------------

  /** Pre-image objects already in `runPreImages`, by identity: each is written once per run, not with every journal write. */
  private readonly journaledPreImages = new WeakSet<object>();

  /**
   * Called before and after every step. No assertNoSecrets: pre-images are LD flag/segment
   * configurations, whose JSON values are customer data (like snapshots), not our credentials.
   * The record is stored without its pre-images (`hasPreImage` marks the steps that have one);
   * those go to `runPreImages`, new ones only, so a write mid-run costs the run's steps and the
   * pre-images captured since the last write rather than everything the run has read so far.
   */
  async saveRun(run: RunJournalRecord): Promise<void> {
    const parts: RunPreImageRecord[] = [];
    const steps = run.steps.map((s) => {
      if (s.preImage === undefined) return s;
      const { preImage, ...rest } = s;
      if (!this.journaledPreImages.has(preImage)) parts.push({ id: `${run.id}/${s.id}`, runId: run.id, stepId: s.id, preImage });
      return { ...rest, hasPreImage: true };
    });
    await this.db.transaction("rw", [this.db.runs, this.db.runPreImages], async () => {
      if (parts.length) await this.db.runPreImages.bulkPut(parts);
      await this.db.runs.put({ ...run, steps });
    });
    for (const p of parts) this.journaledPreImages.add(p.preImage as object);
  }

  /** The run with its pre-images in place (undo, resume, approval checks). */
  async getRun(id: string): Promise<RunJournalRecord | undefined> {
    const run = await this.db.runs.get(id);
    if (!run) return undefined;
    const parts = await this.db.runPreImages.where("runId").equals(id).toArray();
    if (!parts.length) return run;
    const byStep = new Map(parts.map((p) => [p.stepId, p.preImage]));
    for (const p of parts) this.journaledPreImages.add(p.preImage as object);
    return { ...run, steps: run.steps.map((s) => (byStep.has(s.id) ? { ...s, preImage: byStep.get(s.id) as RunJournalRecord["steps"][number]["preImage"] } : s)) };
  }

  /** Newest first, without pre-images (`hasPreImage` says which steps have one; `getRun` reads them). */
  listRuns(workspaceId: string): Promise<RunJournalRecord[]> {
    return this.db.runs
      .where("[workspaceId+startedAt]")
      .between([workspaceId, ""], [workspaceId, "￿"])
      .reverse()
      .toArray();
  }

  // --- On-demand ID lists ---------------------------------------------------------------------

  async saveIdList(rec: IdListRecord): Promise<void> {
    await this.db.idLists.put(rec);
  }

  async listIdLists(workspaceId: string): Promise<IdListRecord[]> {
    return this.db.idLists.where("workspaceId").equals(workspaceId).toArray();
  }

  async deleteIdList(uid: string): Promise<void> {
    await this.db.idLists.delete(uid);
  }

  // --- Uploaded get_id_lists hashes (PLAN §4.2 reconciliation) ---------------------------------

  async saveIdListHashes(rec: IdListHashesRecord): Promise<void> {
    await this.db.idListHashes.put(rec);
  }

  getIdListHashes(uid: string): Promise<IdListHashesRecord | undefined> {
    return this.db.idListHashes.get(uid);
  }

  listIdListHashes(workspaceId: string): Promise<IdListHashesRecord[]> {
    return this.db.idListHashes.where("workspaceId").equals(workspaceId).toArray();
  }

  // --- Monitoring (PLAN §14) --------------------------------------------------------------------

  getMonitorState(workspaceId: string): Promise<MonitorStateRecord | undefined> {
    return this.db.monitorState.get(workspaceId);
  }

  async saveMonitorState(rec: MonitorStateRecord): Promise<void> {
    assertNoSecrets(rec);
    await this.db.monitorState.put(rec);
  }

  listMonitorItems(workspaceId: string): Promise<MonitorItemRecord[]> {
    return this.db.monitorItems.where("workspaceId").equals(workspaceId).toArray();
  }

  async setMonitorItem(rec: MonitorItemRecord): Promise<void> {
    await this.db.monitorItems.put(rec);
  }

  listMonitorSamples(workspaceId: string): Promise<MonitorSampleRecord[]> {
    return this.db.monitorSamples.where("workspaceId").equals(workspaceId).toArray();
  }

  async addMonitorSamples(recs: MonitorSampleRecord[]): Promise<void> {
    if (recs.length) await this.db.monitorSamples.bulkPut(recs);
  }

  /** Deletes the samples with these ids (retention; see @sslm/monitoring pruneSamples). */
  async deleteMonitorSamples(ids: string[]): Promise<void> {
    if (ids.length) await this.db.monitorSamples.bulkDelete(ids);
  }

  /** Forget monitoring state for a workspace (project reset): samples, switches and the last check. */
  async clearMonitoring(workspaceId: string): Promise<void> {
    await this.db.transaction("rw", [this.db.monitorSamples, this.db.monitorItems, this.db.monitorState], async () => {
      await this.db.monitorSamples.where("workspaceId").equals(workspaceId).delete();
      await this.db.monitorItems.where("workspaceId").equals(workspaceId).delete();
      await this.db.monitorState.delete(workspaceId);
    });
  }

  // --- Encrypted token vault (PLAN §3.4 "Remember on this device") ----------------------------

  getVault(workspaceId: string): Promise<VaultRecord | undefined> {
    return this.db.vaults.get(workspaceId);
  }

  /**
   * Only the encrypted blob is accepted here; assertNoSecrets refuses anything that looks like a
   * raw token. `device` is the non-extractable key of a device vault (a passphrase vault has none).
   */
  // --- Items set aside ("Don't migrate") -----------------------------------------------------

  listExclusions(workspaceId: string): Promise<ExclusionRecord[]> {
    return this.db.exclusions.where("workspaceId").equals(workspaceId).toArray();
  }

  /** Mark items as not to be migrated (replacing an earlier mark on the same uid). */
  async setExclusions(workspaceId: string, items: { uid: string; reason?: string }[], markedAt = now()): Promise<void> {
    const recs: ExclusionRecord[] = items.map((i) => ({ workspaceId, uid: i.uid, markedAt, ...(i.reason?.trim() ? { reason: i.reason.trim() } : {}) }));
    assertNoSecrets(recs);
    await this.db.exclusions.bulkPut(recs);
    await this.touch(workspaceId);
  }

  async deleteExclusions(workspaceId: string, uids: string[]): Promise<void> {
    await this.db.exclusions.bulkDelete(uids.map((uid) => [workspaceId, uid] as [string, string]));
    await this.touch(workspaceId);
  }

  async saveVault(workspaceId: string, blob: VaultBlob, device?: CryptoKey): Promise<void> {
    const rec: VaultRecord = { workspaceId, updatedAt: now(), blob, ...(device ? { device } : {}) };
    assertNoSecrets({ ...rec, device: undefined });
    await this.db.vaults.put(rec);
  }

  async deleteVault(workspaceId: string): Promise<void> {
    await this.db.vaults.delete(workspaceId);
  }

  private async touch(workspaceId: string): Promise<void> {
    await this.db.workspaces.update(workspaceId, { updatedAt: now() });
  }
}

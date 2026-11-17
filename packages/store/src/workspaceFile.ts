/**
 * Workspace file (PLAN §3.3 "Workspace file (.sslm)"): everything IndexedDB holds for one
 * workspace, exported to share decisions with a teammate, move to another machine, hand off to a
 * customer or keep a backup. Tokens are never in it: the vault table is not read.
 *
 * Layout of the bytes: a magic line, one JSON header line (format, workspace id and name, export
 * time, and the encryption parameters when there are any), then the body. The body is the JSON of
 * a WorkspaceBundle, by default AES-GCM encrypted under a key derived from a passphrase chosen for
 * the file (PBKDF2, the same parameters as the token vault): snapshots carry override lists and ID
 * lists, which are PII, and raw spec uploads carry the project's salts. Nothing is base64-encoded,
 * so a workspace of tens of megabytes stays that size.
 *
 * Importing merges: records keyed by id that the file has and the browser lacks are added, and a
 * record both have is replaced when the file's copy is newer by its own timestamp (a decision's
 * decidedAt, the profile's updatedAt). Immutable records (snapshots, uploads, pre-images, samples)
 * are only ever added. The plan is computed first so the app can show it before anything is
 * written; `applyWorkspaceImport` then writes it in one transaction.
 */
import type { MigratorDb, WorkspaceRecord, SourceRecord, SnapshotMetaRecord, SnapshotBodyRecord, SpecUploadRecord, CapabilityRecord, ProfileRecord, ResolutionRecord, RunJournalRecord, RunPreImageRecord, IdListRecord, IdListHashesRecord, MonitorSampleRecord, MonitorItemRecord, MonitorStateRecord, ExclusionRecord, LdStateRecord } from "./db.ts";
import { assertNoSecrets, MONITOR_DATA_KEYED, normalizeWorkspaceName, PROFILE_DATA_KEYED, type WorkspaceStore } from "./store.ts";
import { deriveVaultKey, fromBase64, toBase64, VAULT_ITERATIONS, WrongPassphraseError } from "./vault.ts";

export const WORKSPACE_FILE_FORMAT = "ld-migration-console/workspace";
export const WORKSPACE_FILE_VERSION = 1;
export const WORKSPACE_FILE_EXTENSION = ".sslm";
export const WORKSPACE_FILE_MIME = "application/vnd.ld-migration-console.workspace";
const MAGIC = "SSLM1";

/** The tables a workspace file carries, in the order they are written and read. */
export interface WorkspaceBundleTables {
  sources: SourceRecord[];
  snapshots: SnapshotMetaRecord[];
  snapshotBodies: SnapshotBodyRecord[];
  specUploads: SpecUploadRecord[];
  capabilities: CapabilityRecord[];
  profiles: ProfileRecord[];
  resolutions: ResolutionRecord[];
  runs: RunJournalRecord[];
  runPreImages: RunPreImageRecord[];
  idLists: IdListRecord[];
  idListHashes: IdListHashesRecord[];
  monitorSamples: MonitorSampleRecord[];
  monitorItems: MonitorItemRecord[];
  monitorState: MonitorStateRecord[];
  exclusions: ExclusionRecord[];
  ldState: LdStateRecord[];
}
export type WorkspaceBundleTable = keyof WorkspaceBundleTables;

export const WORKSPACE_BUNDLE_TABLES: readonly WorkspaceBundleTable[] = [
  "sources",
  "snapshots",
  "snapshotBodies",
  "specUploads",
  "capabilities",
  "profiles",
  "resolutions",
  "runs",
  "runPreImages",
  "idLists",
  "idListHashes",
  "monitorSamples",
  "monitorItems",
  "monitorState",
  "exclusions",
  "ldState",
];

/** What the import plan calls each table, for people. */
export const WORKSPACE_BUNDLE_TABLE_LABEL: Record<WorkspaceBundleTable, string> = {
  sources: "Sources",
  snapshots: "Snapshots",
  snapshotBodies: "Snapshot payloads",
  specUploads: "Spec uploads",
  capabilities: "LaunchDarkly capability probe",
  profiles: "Mapping profile",
  resolutions: "Decisions",
  runs: "Runs",
  runPreImages: "Undo pre-images",
  idLists: "ID lists",
  idListHashes: "ID-list hashes",
  monitorSamples: "Monitoring samples",
  monitorItems: "LaunchDarkly-authoritative switches",
  monitorState: "Last monitoring check",
  exclusions: "Items set aside",
  ldState: "LaunchDarkly listing",
};

export interface WorkspaceBundle {
  format: typeof WORKSPACE_FILE_FORMAT;
  version: typeof WORKSPACE_FILE_VERSION;
  exportedAt: string;
  /** The workspace record without `tokenStorage`, which is a choice per device. */
  workspace: Omit<WorkspaceRecord, "tokenStorage">;
  tables: WorkspaceBundleTables;
}

/** The clear-text header of a workspace file: enough to name the file before it is decrypted. */
export interface WorkspaceFileHeader {
  format: typeof WORKSPACE_FILE_FORMAT;
  version: number;
  workspaceId: string;
  workspaceName: string;
  exportedAt: string;
  /** Absent or null: the body is plain JSON (the user chose to export without a passphrase). */
  encryption?: { cipher: "AES-GCM"; kdf: "PBKDF2-SHA-256"; iterations: number; salt: string; iv: string } | null;
}

export class WorkspaceFileFormatError extends Error {
  constructor(detail: string) {
    super(`Not a workspace file: ${detail}`);
    this.name = "WorkspaceFileFormatError";
  }
}

export class WorkspaceFilePassphraseRequired extends Error {
  constructor() {
    super("This workspace file is encrypted; its passphrase is needed to open it.");
    this.name = "WorkspaceFilePassphraseRequired";
  }
}

// --- Export ------------------------------------------------------------------------------------

/** Everything the browser holds for the workspace, except its tokens. Reads every table in one transaction. */
export async function exportWorkspaceBundle(store: WorkspaceStore, workspaceId: string): Promise<WorkspaceBundle> {
  const db = store.db;
  return db.transaction("r", bundleTables(db), async () => {
    const ws = await db.workspaces.get(workspaceId);
    if (!ws) throw new Error("Workspace not found.");
    const { tokenStorage: _device, ...workspace } = ws;
    const byWorkspace = <T>(t: { where(idx: string): { equals(v: string): { toArray(): Promise<T[]> } } }) => t.where("workspaceId").equals(workspaceId).toArray();
    const one = async <T>(rec: Promise<T | undefined>): Promise<T[]> => {
      const r = await rec;
      return r ? [r] : [];
    };
    const snapshots = await byWorkspace<SnapshotMetaRecord>(db.snapshots);
    const runs = await byWorkspace<RunJournalRecord>(db.runs);
    const snapshotBodies = snapshots.length ? await db.snapshotBodies.where("id").anyOf(snapshots.map((s) => s.id)).toArray() : [];
    const runPreImages = runs.length ? await db.runPreImages.where("runId").anyOf(runs.map((r) => r.id)).toArray() : [];
    const tables: WorkspaceBundleTables = {
      sources: await byWorkspace(db.sources),
      snapshots,
      snapshotBodies,
      specUploads: await byWorkspace(db.specUploads),
      capabilities: await one(db.capabilities.get(workspaceId)),
      profiles: await one(db.profiles.get(workspaceId)),
      resolutions: await byWorkspace(db.resolutions),
      runs,
      runPreImages,
      idLists: await byWorkspace(db.idLists),
      idListHashes: await byWorkspace(db.idListHashes),
      monitorSamples: await byWorkspace(db.monitorSamples),
      monitorItems: await byWorkspace(db.monitorItems),
      monitorState: await one(db.monitorState.get(workspaceId)),
      exclusions: await byWorkspace(db.exclusions),
      ldState: await one(db.ldState.get(workspaceId)),
    };
    return { format: WORKSPACE_FILE_FORMAT, version: WORKSPACE_FILE_VERSION, exportedAt: new Date().toISOString(), workspace, tables };
  });
}

/** The vault is deliberately not here: tokens never reach a workspace file. */
function bundleTables(db: MigratorDb) {
  return [db.workspaces, db.sources, db.snapshots, db.snapshotBodies, db.specUploads, db.capabilities, db.profiles, db.resolutions, db.runs, db.runPreImages, db.idLists, db.idListHashes, db.monitorSamples, db.monitorItems, db.monitorState, db.exclusions, db.ldState];
}

const subtle = () => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this context.");
  return c.subtle;
};

/**
 * The bytes of a workspace file. With a passphrase (the default the app insists on) the body is
 * encrypted; without one it is plain JSON, for a user who has decided the file holds nothing
 * they need to protect.
 */
export async function encodeWorkspaceFile(bundle: WorkspaceBundle, opts: { passphrase?: string; iterations?: number } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  const header: WorkspaceFileHeader = { format: WORKSPACE_FILE_FORMAT, version: WORKSPACE_FILE_VERSION, workspaceId: bundle.workspace.id, workspaceName: bundle.workspace.name, exportedAt: bundle.exportedAt, encryption: null };
  let body: Uint8Array = plaintext;
  if (opts.passphrase !== undefined) {
    if (!opts.passphrase) throw new Error("The passphrase is empty.");
    const iterations = opts.iterations ?? VAULT_ITERATIONS;
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveVaultKey(opts.passphrase, salt, iterations);
    body = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource));
    header.encryption = { cipher: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations, salt: toBase64(salt), iv: toBase64(iv) };
  }
  const head = new TextEncoder().encode(`${MAGIC}\n${JSON.stringify(header)}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** The clear-text header and the body's offset; throws WorkspaceFileFormatError on anything else. */
export function readWorkspaceFileHeader(bytes: Uint8Array): { header: WorkspaceFileHeader; bodyOffset: number } {
  const nl1 = bytes.indexOf(10);
  if (nl1 < 0 || new TextDecoder().decode(bytes.subarray(0, nl1)) !== MAGIC) throw new WorkspaceFileFormatError("it does not start with the workspace-file marker.");
  const nl2 = bytes.indexOf(10, nl1 + 1);
  if (nl2 < 0) throw new WorkspaceFileFormatError("the header line is missing.");
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(nl1 + 1, nl2)));
  } catch {
    throw new WorkspaceFileFormatError("the header is not JSON.");
  }
  if (!isRecord(header) || header.format !== WORKSPACE_FILE_FORMAT) throw new WorkspaceFileFormatError("the header names another format.");
  if (header.version !== WORKSPACE_FILE_VERSION) throw new WorkspaceFileFormatError(`it was written by a newer console (file version ${String(header.version)}; this one reads version ${WORKSPACE_FILE_VERSION}).`);
  if (typeof header.workspaceId !== "string" || typeof header.workspaceName !== "string" || typeof header.exportedAt !== "string") throw new WorkspaceFileFormatError("the header is incomplete.");
  const enc = header.encryption;
  if (enc !== undefined && enc !== null) {
    if (!isRecord(enc) || enc.cipher !== "AES-GCM" || enc.kdf !== "PBKDF2-SHA-256" || typeof enc.iterations !== "number" || typeof enc.salt !== "string" || typeof enc.iv !== "string")
      throw new WorkspaceFileFormatError("its encryption parameters are not ones this console knows.");
  }
  return { header: header as unknown as WorkspaceFileHeader, bodyOffset: nl2 + 1 };
}

export const isEncryptedWorkspaceFile = (header: WorkspaceFileHeader): boolean => !!header.encryption;

/**
 * The bundle in a workspace file. Throws WorkspaceFilePassphraseRequired for an encrypted file
 * opened without one, WrongPassphraseError when it does not fit, WorkspaceFileFormatError for
 * anything that is not a workspace file this console can read.
 */
export async function decodeWorkspaceFile(bytes: Uint8Array, opts: { passphrase?: string } = {}): Promise<WorkspaceBundle> {
  const { header, bodyOffset } = readWorkspaceFileHeader(bytes);
  let body = bytes.subarray(bodyOffset);
  if (header.encryption) {
    if (!opts.passphrase) throw new WorkspaceFilePassphraseRequired();
    const key = await deriveVaultKey(opts.passphrase, fromBase64(header.encryption.salt), header.encryption.iterations);
    try {
      body = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(header.encryption.iv) as BufferSource }, key, body as BufferSource));
    } catch {
      throw new WrongPassphraseError();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new WorkspaceFileFormatError("the body is not JSON.");
  }
  assertWorkspaceBundle(parsed);
  if (parsed.workspace.id !== header.workspaceId) throw new WorkspaceFileFormatError("the header and the body name different workspaces.");
  return parsed;
}

// --- Validation --------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The fields every record of a table must have, as strings, for the import to key it. */
const REQUIRED: Record<WorkspaceBundleTable, readonly string[]> = {
  sources: ["id", "workspaceId", "kind", "alias"],
  snapshots: ["id", "workspaceId", "sourceId", "takenAt"],
  snapshotBodies: ["id"],
  specUploads: ["id", "workspaceId", "sourceId", "snapshotId"],
  capabilities: ["workspaceId", "probedAt"],
  profiles: ["workspaceId", "updatedAt"],
  resolutions: ["workspaceId", "id", "decidedAt"],
  runs: ["id", "workspaceId", "startedAt"],
  runPreImages: ["id", "runId", "stepId"],
  idLists: ["uid", "workspaceId", "sourceId", "fetchedAt"],
  idListHashes: ["uid", "workspaceId", "sourceId", "uploadedAt"],
  monitorSamples: ["id", "workspaceId", "flagKey", "ldEnv", "at"],
  monitorItems: ["workspaceId", "flagKey", "ldEnv", "setAt"],
  monitorState: ["workspaceId", "lastCheckedAt"],
  exclusions: ["workspaceId", "uid", "markedAt"],
  ldState: ["workspaceId", "loadedAt"],
};

/**
 * Structural check of a parsed body: the shape the merge relies on, lenient about everything
 * else (records keep whatever fields they have, the way the store's own tables do). Then the
 * same secret scan the store runs on the records it shapes itself; snapshots, uploads, the
 * LaunchDarkly listing, runs and pre-images are customer data and are not scanned, as in the store.
 */
export function assertWorkspaceBundle(v: unknown): asserts v is WorkspaceBundle {
  if (!isRecord(v) || v.format !== WORKSPACE_FILE_FORMAT) throw new WorkspaceFileFormatError("the body names another format.");
  if (v.version !== WORKSPACE_FILE_VERSION) throw new WorkspaceFileFormatError(`body version ${String(v.version)} is not one this console reads.`);
  if (typeof v.exportedAt !== "string") throw new WorkspaceFileFormatError("the export time is missing.");
  const ws = v.workspace;
  if (!isRecord(ws) || typeof ws.id !== "string" || !ws.id || typeof ws.name !== "string" || typeof ws.createdAt !== "string" || typeof ws.updatedAt !== "string")
    throw new WorkspaceFileFormatError("the workspace record is incomplete.");
  if (!isRecord(v.tables)) throw new WorkspaceFileFormatError("the tables are missing.");
  for (const t of WORKSPACE_BUNDLE_TABLES) {
    const rows = v.tables[t];
    if (rows === undefined) {
      v.tables[t] = [];
      continue;
    }
    if (!Array.isArray(rows)) throw new WorkspaceFileFormatError(`“${t}” is not a list.`);
    rows.forEach((r, i) => {
      if (!isRecord(r)) throw new WorkspaceFileFormatError(`${t}[${i}] is not a record.`);
      for (const f of REQUIRED[t]) if (typeof r[f] !== "string" || r[f] === "") throw new WorkspaceFileFormatError(`${t}[${i}] has no ${f}.`);
      if (r.workspaceId !== undefined && r.workspaceId !== ws.id) throw new WorkspaceFileFormatError(`${t}[${i}] belongs to another workspace.`);
    });
  }
  const tables = v.tables as unknown as WorkspaceBundleTables;
  assertNoSecrets(ws);
  assertNoSecrets(tables.sources);
  for (const p of tables.profiles) assertNoSecrets(p, { dataKeyed: PROFILE_DATA_KEYED });
  assertNoSecrets(tables.resolutions);
  assertNoSecrets(tables.exclusions);
  for (const m of tables.monitorState) assertNoSecrets(m, { dataKeyed: MONITOR_DATA_KEYED });
  for (const c of tables.capabilities) assertNoSecrets(c.matrix);
  assertNoSecrets(tables.monitorItems);
  assertNoSecrets(tables.idListHashes);
}

// --- Import ------------------------------------------------------------------------------------

/** How a table merges: by which key, and whether a newer copy replaces an older one (absent: records are immutable, only ever added). */
interface Merge<T> {
  key: (r: T) => string;
  stamp?: (r: T) => string;
  /** Keyed across workspaces (a snapshot id, a segment uid), not under one: a key held by another local workspace is a conflict. */
  global?: boolean;
}

const runStamp = (r: RunJournalRecord) => r.undoneAt ?? r.finishedAt ?? r.startedAt;

const MERGE: { [T in WorkspaceBundleTable]: Merge<WorkspaceBundleTables[T][number]> } = {
  sources: { key: (r) => r.id, global: true },
  snapshots: { key: (r) => r.id, global: true },
  snapshotBodies: { key: (r) => r.id, global: true },
  specUploads: { key: (r) => r.id, global: true },
  capabilities: { key: (r) => r.workspaceId, stamp: (r) => r.probedAt },
  profiles: { key: (r) => r.workspaceId, stamp: (r) => r.updatedAt },
  resolutions: { key: (r) => r.id, stamp: (r) => r.decidedAt },
  runs: { key: (r) => r.id, stamp: runStamp, global: true },
  runPreImages: { key: (r) => r.id, global: true },
  idLists: { key: (r) => r.uid, stamp: (r) => r.fetchedAt, global: true },
  idListHashes: { key: (r) => r.uid, stamp: (r) => r.uploadedAt, global: true },
  monitorSamples: { key: (r) => r.id, global: true },
  monitorItems: { key: (r) => `${r.flagKey}\u0000${r.ldEnv}`, stamp: (r) => r.setAt },
  monitorState: { key: (r) => r.workspaceId, stamp: (r) => r.lastCheckedAt },
  exclusions: { key: (r) => r.uid, stamp: (r) => r.markedAt },
  ldState: { key: (r) => r.workspaceId, stamp: (r) => r.loadedAt },
};

export interface TableImportCounts {
  /** In the file, not in this browser: written. */
  add: number;
  /** In both, the file's copy newer: the file's replaces the local one. */
  replace: number;
  /** In both, the local copy newer or the same, or the record is immutable: left alone. */
  keep: number;
  /** The key belongs to another workspace in this browser (the file was imported before as a different workspace): left alone. */
  conflict: number;
}

export interface WorkspaceImportPlan {
  /** The workspace the records go to. */
  workspaceId: string;
  /** The workspace does not exist here yet and will be created with this record. */
  create?: WorkspaceRecord;
  /** The name the new workspace gets, when the file's name is already taken here. */
  renamed?: string;
  counts: Record<WorkspaceBundleTable, TableImportCounts>;
  /** What the apply writes, by table. */
  writes: WorkspaceBundleTables;
  exportedAt: string;
}

/** Sum of records the plan writes. */
export const importPlanSize = (plan: WorkspaceImportPlan): number => WORKSPACE_BUNDLE_TABLES.reduce((n, t) => n + plan.writes[t].length, 0);

/**
 * Compare a bundle with what this browser holds and say what an import would write, without
 * writing. The target is the file's own workspace unless `into` names a local one to merge into
 * (then every record is re-homed there). `tokenStorage` is set on a workspace this plan creates.
 */
export async function planWorkspaceImport(store: WorkspaceStore, bundle: WorkspaceBundle, opts: { into?: string; tokenStorage?: WorkspaceRecord["tokenStorage"] } = {}): Promise<WorkspaceImportPlan> {
  const db = store.db;
  const workspaceId = opts.into ?? bundle.workspace.id;
  return db.transaction("r", bundleTables(db), async () => {
    const existing = await db.workspaces.get(workspaceId);
    if (opts.into && !existing) throw new Error("The workspace to merge into does not exist here.");
    let create: WorkspaceRecord | undefined;
    let renamed: string | undefined;
    if (!existing) {
      let name = bundle.workspace.name;
      const names = new Set((await db.workspaces.toArray()).map((w) => normalizeWorkspaceName(w.name)));
      for (let n = 2; names.has(normalizeWorkspaceName(name)); n++) name = `${bundle.workspace.name} (imported${n > 2 ? ` ${n - 1}` : ""})`;
      if (name !== bundle.workspace.name) renamed = name;
      create = { ...bundle.workspace, id: workspaceId, name, ...(opts.tokenStorage ? { tokenStorage: opts.tokenStorage } : {}) };
    }
    const counts = {} as Record<WorkspaceBundleTable, TableImportCounts>;
    const writes = {} as WorkspaceBundleTables;
    for (const t of WORKSPACE_BUNDLE_TABLES) {
      const r = await planTable(db, t, bundle.tables[t], workspaceId);
      counts[t] = r.counts;
      (writes as unknown as Record<string, unknown[]>)[t] = r.writes;
    }
    return { workspaceId, ...(create ? { create } : {}), ...(renamed ? { renamed } : {}), counts, writes, exportedAt: bundle.exportedAt };
  });
}

async function planTable<T extends WorkspaceBundleTable>(db: MigratorDb, t: T, rows: WorkspaceBundleTables[T], workspaceId: string): Promise<{ counts: TableImportCounts; writes: WorkspaceBundleTables[T] }> {
  type R = WorkspaceBundleTables[T][number];
  const m = MERGE[t] as Merge<R>;
  const counts: TableImportCounts = { add: 0, replace: 0, keep: 0, conflict: 0 };
  const writes: R[] = [];
  if (!rows.length) return { counts, writes: writes as WorkspaceBundleTables[T] };
  const local = await localRows(db, t, rows as R[], workspaceId, m);
  for (const raw of rows as R[]) {
    const rec = rehome(raw, workspaceId);
    const cur = local.get(m.key(rec));
    if (!cur) {
      counts.add++;
      writes.push(rec);
    } else if (cur.conflict) {
      counts.conflict++;
    } else if (m.stamp && m.stamp(rec) > m.stamp(cur.rec)) {
      counts.replace++;
      writes.push(rec);
    } else counts.keep++;
  }
  return { counts, writes: writes as WorkspaceBundleTables[T] };
}

/** A record's local counterpart by merge key; `conflict` when a global key is held by another workspace. */
async function localRows<R>(db: MigratorDb, t: WorkspaceBundleTable, rows: R[], workspaceId: string, m: Merge<R>): Promise<Map<string, { rec: R; conflict: boolean }>> {
  const out = new Map<string, { rec: R; conflict: boolean }>();
  const table = db.table(t);
  if (t === "snapshotBodies" || t === "runPreImages") {
    // No workspaceId on these: a body is owned through its snapshot, a pre-image through its run.
    const found = (await table.where("id").anyOf(rows.map((r) => (r as { id: string }).id)).toArray()) as R[];
    const ownerIds = new Set<string>(
      t === "snapshotBodies"
        ? (await db.snapshots.where("workspaceId").equals(workspaceId).primaryKeys()) as string[]
        : (await db.runs.where("workspaceId").equals(workspaceId).primaryKeys()) as string[],
    );
    for (const f of found) {
      const owner = t === "snapshotBodies" ? (f as SnapshotBodyRecord).id : (f as RunPreImageRecord).runId;
      out.set(m.key(f), { rec: f, conflict: !ownerIds.has(owner) });
    }
    return out;
  }
  if (m.global) {
    const keyField = t === "idLists" || t === "idListHashes" ? "uid" : "id";
    const found = (await table.where(keyField).anyOf(rows.map((r) => (r as Record<string, string>)[keyField]!)).toArray()) as (R & { workspaceId: string })[];
    for (const f of found) out.set(m.key(f), { rec: f, conflict: f.workspaceId !== workspaceId });
    return out;
  }
  const found = (await table.where("workspaceId").equals(workspaceId).toArray()) as R[];
  for (const f of found) out.set(m.key(f), { rec: f, conflict: false });
  return out;
}

/** The record as it will be stored: under the target workspace (a merge into another local workspace re-homes it). */
function rehome<R>(rec: R, workspaceId: string): R {
  return (rec as { workspaceId?: string }).workspaceId !== undefined && (rec as { workspaceId?: string }).workspaceId !== workspaceId ? { ...rec, workspaceId } : rec;
}

/** Write the plan, in one transaction. The workspace's `updatedAt` moves to now. */
export async function applyWorkspaceImport(store: WorkspaceStore, plan: WorkspaceImportPlan): Promise<void> {
  const db = store.db;
  await db.transaction("rw", bundleTables(db), async () => {
    if (plan.create) {
      if (await db.workspaces.get(plan.workspaceId)) throw new Error("The workspace was created since the plan was made; import again.");
      await db.workspaces.put(plan.create);
    } else if (!(await db.workspaces.get(plan.workspaceId))) throw new Error("The workspace was deleted since the plan was made.");
    // Payloads before their metadata and pre-images before their runs: a reader that sees the
    // metadata always finds the payload.
    await db.snapshotBodies.bulkPut(plan.writes.snapshotBodies);
    await db.runPreImages.bulkPut(plan.writes.runPreImages);
    for (const t of WORKSPACE_BUNDLE_TABLES) {
      if (t === "snapshotBodies" || t === "runPreImages") continue;
      const rows = plan.writes[t] as unknown[];
      if (rows.length) await db.table(t).bulkPut(rows);
    }
    await db.workspaces.update(plan.workspaceId, { updatedAt: new Date().toISOString() });
  });
}

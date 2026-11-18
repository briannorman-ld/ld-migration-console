import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@sslm/canonical";
import type { Resolution } from "@sslm/mapper";
import {
  applyWorkspaceImport,
  decodeWorkspaceFile,
  deriveVaultKey,
  encodeWorkspaceFile,
  exportWorkspaceBundle,
  importPlanSize,
  MIN_FILE_ITERATIONS,
  MigratorDb,
  planWorkspaceImport,
  readWorkspaceFileHeader,
  SecretInStoreError,
  toBase64,
  WorkspaceFileFormatError,
  WorkspaceFilePassphraseRequired,
  WorkspaceStore,
  WrongPassphraseError,
  type RunJournalRecord,
  type WorkspaceBundle,
} from "../src/index.ts";

const store = () => new WorkspaceStore(new MigratorDb(`wf-${crypto.randomUUID()}`));
/** The fewest PBKDF2 iterations a file may ask for; the app uses VAULT_ITERATIONS. */
const FAST = { iterations: MIN_FILE_ITERATIONS };

const resolution = (id: string, decidedAt: string, optionKey = "a"): Resolution => ({ id, type: "value_type", optionKey, scope: "resource", decidedAt });

/** A finished run of one flag step with a pre-image, as the executor journals it. */
const run = (workspaceId: string, id: string, over: Partial<RunJournalRecord> = {}): RunJournalRecord => ({
  id,
  workspaceId,
  projectKey: "shop",
  label: "Checkout gates",
  dryRun: false,
  startedAt: "2026-01-04T00:00:00Z",
  finishedAt: "2026-01-04T00:01:00Z",
  status: "done",
  steps: [
    {
      id: "s1",
      label: "Flag new_checkout",
      status: "done",
      step: { id: "s1", deps: [], op: "upsert_flag_shell", key: "new_checkout", exists: true, adopt: false, desired: {} } as unknown as RunJournalRecord["steps"][number]["step"],
      preImage: { key: "new_checkout", environments: { production: { on: false } } } as unknown as RunJournalRecord["steps"][number]["preImage"],
    },
  ],
  ...over,
});

/** The bytes of a version-1 file (body encrypted without the header as additional data), as the previous console wrote them. */
async function encodeV1(bundle: WorkspaceBundle, passphrase: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt, FAST.iterations);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify({ ...bundle, version: 1 }))));
  const header = { format: "ld-migration-console/workspace", version: 1, workspaceId: bundle.workspace.id, workspaceName: bundle.workspace.name, exportedAt: bundle.exportedAt, encryption: { cipher: "AES-GCM", kdf: "PBKDF2-SHA-256", iterations: FAST.iterations, salt: toBase64(salt), iv: toBase64(iv) } };
  const head = new TextEncoder().encode(`SSLM1\n${JSON.stringify(header)}\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** The same file with one header field changed and the body left alone. */
function withHeader(bytes: Uint8Array, patch: (h: Record<string, unknown>) => void): Uint8Array {
  const { headerBytes, bodyOffset } = readWorkspaceFileHeader(bytes);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as Record<string, unknown>;
  patch(header);
  const head = new TextEncoder().encode(`SSLM1\n${JSON.stringify(header)}\n`);
  const body = bytes.subarray(bodyOffset);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** A workspace with a source, two snapshots, a decision, an exclusion and a token vault. */
async function seed(s: WorkspaceStore, name = "Contoso migration") {
  const ws = await s.createWorkspace({ name, tokenStorage: "memory" });
  await s.addSource(ws.id, { id: "src-web", alias: "web", label: "acme-web", kind: "console_api", createdAt: "2026-01-01T00:00:00Z" });
  const snap = emptySnapshot({ sourceId: "src-web", sourceKind: "console_api", alias: "web" }, "2026-01-01T00:00:00Z");
  await s.saveSnapshot(ws.id, snap);
  await s.saveSnapshot(ws.id, { ...snap, takenAt: "2026-01-02T00:00:00Z" });
  await s.saveResolutions(ws.id, [resolution("d1", "2026-01-03T00:00:00Z")]);
  await s.setExclusions(ws.id, [{ uid: "src-web/gate/old", reason: "unused" }], "2026-01-03T00:00:00Z");
  await s.saveVault(ws.id, { version: 1, iv: "aXY=", ciphertext: "c2VjcmV0" });
  return ws;
}

describe("workspace file", () => {
  it("round-trips an encrypted export; the header stays readable without the passphrase", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    expect(bundle.tables.snapshots).toHaveLength(2);
    expect(bundle.tables.snapshotBodies).toHaveLength(2);
    expect(bundle.tables.resolutions.map((r) => r.id)).toEqual(["d1"]);
    // The device's token-storage choice is not the file's business.
    expect("tokenStorage" in bundle.workspace).toBe(false);

    const bytes = await encodeWorkspaceFile(bundle, { passphrase: "correct horse", ...FAST });
    const { header } = readWorkspaceFileHeader(bytes);
    expect(header.workspaceName).toBe("Contoso migration");
    expect(header.encryption?.cipher).toBe("AES-GCM");
    // The body is ciphertext: no record name survives in the clear.
    expect(new TextDecoder().decode(bytes)).not.toContain("acme-web");

    await expect(decodeWorkspaceFile(bytes)).rejects.toBeInstanceOf(WorkspaceFilePassphraseRequired);
    await expect(decodeWorkspaceFile(bytes, { passphrase: "wrong" })).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await decodeWorkspaceFile(bytes, { passphrase: "correct horse" })).toEqual(bundle);
  });

  it("never carries tokens: the vault is not exported, and a secret-looking field in the file is refused", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("vault");
    expect(text).not.toContain("c2VjcmV0");

    const tampered = JSON.parse(text) as WorkspaceBundle;
    (tampered.tables.sources[0] as unknown as Record<string, unknown>).apiKey = "console-xyz";
    const bytes = await encodeWorkspaceFile(tampered);
    await expect(decodeWorkspaceFile(bytes)).rejects.toBeInstanceOf(SecretInStoreError);
  });

  it("exports without a passphrase on request, and refuses files that are not its own", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    const bytes = await encodeWorkspaceFile(bundle);
    expect(readWorkspaceFileHeader(bytes).header.encryption).toBeNull();
    expect(await decodeWorkspaceFile(bytes)).toEqual(bundle);

    expect(() => readWorkspaceFileHeader(new TextEncoder().encode('{"not":"ours"}'))).toThrow(WorkspaceFileFormatError);
    expect(() => readWorkspaceFileHeader(new TextEncoder().encode("SSLM1\n{\"format\":\"ld-migration-console/workspace\",\"version\":9,\"workspaceId\":\"w\",\"workspaceName\":\"n\",\"exportedAt\":\"t\"}\n{}"))).toThrow(/newer console/);
  });

  it("imports into an empty browser as a new workspace, renamed when the name is taken", async () => {
    const a = store();
    const ws = await seed(a);
    const bundle = await exportWorkspaceBundle(a, ws.id);

    const b = store();
    await b.createWorkspace({ name: "contoso migration" });
    const plan = await planWorkspaceImport(b, bundle, { tokenStorage: "memory" });
    expect(plan.create?.id).toBe(ws.id);
    expect(plan.create?.tokenStorage).toBe("memory");
    expect(plan.renamed).toBe("Contoso migration (imported)");
    expect(plan.counts.snapshots).toEqual({ add: 2, replace: 0, keep: 0, conflict: 0 });
    expect(plan.counts.resolutions.add).toBe(1);
    expect(importPlanSize(plan)).toBe(2 + 2 + 1 + 1 + 1);

    await applyWorkspaceImport(b, plan);
    expect((await b.getWorkspace(ws.id))?.name).toBe("Contoso migration (imported)");
    expect((await b.listSources(ws.id)).map((x) => x.alias)).toEqual(["web"]);
    expect((await b.latestSnapshot("src-web"))?.takenAt).toBe("2026-01-02T00:00:00Z");
    expect(await b.listResolutions(ws.id)).toEqual([resolution("d1", "2026-01-03T00:00:00Z")]);
    expect((await b.listExclusions(ws.id)).map((e) => e.uid)).toEqual(["src-web/gate/old"]);
    expect(await b.getVault(ws.id)).toBeUndefined();
  });

  it("merges into an existing workspace: newer decisions win by timestamp, snapshots are only added", async () => {
    const a = store();
    const ws = await seed(a);
    // The teammate's copy: one decision changed later, one older, one new, and a third snapshot.
    const b = store();
    await applyWorkspaceImport(b, await planWorkspaceImport(b, await exportWorkspaceBundle(a, ws.id)));
    await b.saveResolutions(ws.id, [resolution("d1", "2026-01-05T00:00:00Z", "b"), resolution("d2", "2026-01-04T00:00:00Z")]);
    const snap = emptySnapshot({ sourceId: "src-web", sourceKind: "console_api", alias: "web" }, "2026-01-06T00:00:00Z");
    await b.saveSnapshot(ws.id, snap);
    // Meanwhile here: d1 was also changed, but earlier than the teammate's, and d3 was decided.
    await a.saveResolutions(ws.id, [resolution("d1", "2026-01-04T12:00:00Z", "c"), resolution("d3", "2026-01-04T00:00:00Z")]);

    const plan = await planWorkspaceImport(a, await exportWorkspaceBundle(b, ws.id));
    expect(plan.create).toBeUndefined();
    expect(plan.counts.resolutions).toEqual({ add: 1, replace: 1, keep: 0, conflict: 0 });
    expect(plan.counts.snapshots).toEqual({ add: 1, replace: 0, keep: 2, conflict: 0 });
    expect(plan.counts.sources).toEqual({ add: 0, replace: 0, keep: 1, conflict: 0 });
    expect(plan.counts.exclusions.keep).toBe(1);

    await applyWorkspaceImport(a, plan);
    const got = Object.fromEntries((await a.listResolutions(ws.id)).map((r) => [r.id, r.optionKey]));
    expect(got).toEqual({ d1: "b", d2: "a", d3: "a" });
    expect((await a.listSnapshots("src-web")).map((x) => x.takenAt)).toEqual(["2026-01-06T00:00:00Z", "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"]);
    expect((await a.latestSnapshot("src-web"))?.canonical).toEqual(snap);
    // Importing the same file again changes nothing.
    const again = await planWorkspaceImport(a, await exportWorkspaceBundle(b, ws.id));
    expect(importPlanSize(again)).toBe(0);
  });

  it("merging into another local workspace re-homes the records, and keys another workspace holds are conflicts", async () => {
    const a = store();
    const ws = await seed(a);
    const bundle = await exportWorkspaceBundle(a, ws.id);
    const other = await a.createWorkspace({ name: "Other" });
    const plan = await planWorkspaceImport(a, bundle, { into: other.id });
    // The source and its snapshots belong to the first workspace here: not moved.
    expect(plan.counts.sources).toEqual({ add: 0, replace: 0, keep: 0, conflict: 1 });
    expect(plan.counts.snapshots.conflict).toBe(2);
    expect(plan.counts.snapshotBodies.conflict).toBe(2);
    // Per-workspace records come along, under the target.
    expect(plan.counts.resolutions.add).toBe(1);
    expect(plan.writes.resolutions[0]?.workspaceId).toBe(other.id);
    await applyWorkspaceImport(a, plan);
    expect((await a.listResolutions(other.id)).map((r) => r.id)).toEqual(["d1"]);
    expect((await a.listResolutions(ws.id)).map((r) => r.id)).toEqual(["d1"]);
    await expect(planWorkspaceImport(a, bundle, { into: "nope" })).rejects.toThrow(/does not exist/);
  });

  it("binds the header to the body: an edited header no longer opens it, and version-1 files still do", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    const bytes = await encodeWorkspaceFile(bundle, { passphrase: "correct horse", ...FAST });
    expect(readWorkspaceFileHeader(bytes).header.version).toBe(2);
    expect(await decodeWorkspaceFile(bytes, { passphrase: "correct horse" })).toEqual(bundle);
    // The same ciphertext under a header that names another workspace or export time.
    const renamed = withHeader(bytes, (h) => (h.workspaceName = "Someone else's"));
    await expect(decodeWorkspaceFile(renamed, { passphrase: "correct horse" })).rejects.toBeInstanceOf(WrongPassphraseError);
    const redated = withHeader(bytes, (h) => (h.exportedAt = "2030-01-01T00:00:00.000Z"));
    await expect(decodeWorkspaceFile(redated, { passphrase: "correct horse" })).rejects.toBeInstanceOf(WrongPassphraseError);
    // A file the previous console wrote (no additional data) opens as before.
    const v1 = await encodeV1(bundle, "correct horse");
    expect(readWorkspaceFileHeader(v1).header.version).toBe(1);
    expect(await decodeWorkspaceFile(v1, { passphrase: "correct horse" })).toEqual({ ...bundle, version: 1 });
  });

  it("refuses key-derivation counts outside the accepted range, on export and on open", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    await expect(encodeWorkspaceFile(bundle, { passphrase: "correct horse", iterations: 1_000 })).rejects.toThrow(/between 100,000 and 2,000,000/);
    const bytes = await encodeWorkspaceFile(bundle, { passphrase: "correct horse", ...FAST });
    for (const iterations of [1_000, 2_000_001, 50_000_000, 150_000.5]) {
      const tampered = withHeader(bytes, (h) => ((h.encryption as Record<string, unknown>).iterations = iterations));
      expect(() => readWorkspaceFileHeader(tampered)).toThrow(/key-derivation count .* outside the range/);
      await expect(decodeWorkspaceFile(tampered, { passphrase: "correct horse" })).rejects.toBeInstanceOf(WorkspaceFileFormatError);
    }
  });

  it("refuses a record whose merge timestamp is not a UTC instant or is in the future", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    const now = new Date("2026-01-10T00:00:00Z");
    const withStamp = async (patch: (b: WorkspaceBundle) => void) => {
      const b = structuredClone(bundle);
      patch(b);
      return decodeWorkspaceFile(await encodeWorkspaceFile(b), { now });
    };
    // Lexically after any real date: would replace the local decision for ever.
    await expect(withStamp((b) => (b.tables.resolutions[0]!.decidedAt = "zzz"))).rejects.toThrow(/resolutions\[0\]\.decidedAt is not a UTC timestamp/);
    await expect(withStamp((b) => (b.tables.resolutions[0]!.decidedAt = "2026-01-03T00:00:00+05:00"))).rejects.toThrow(/not a UTC timestamp/);
    await expect(withStamp((b) => (b.tables.exclusions[0]!.markedAt = "2027-01-01T00:00:00.000Z"))).rejects.toThrow(/exclusions\[0\]\.markedAt \(2027-01-01T00:00:00.000Z\) is in the future/);
    // Clock skew of a few minutes is not tampering.
    await expect(withStamp((b) => (b.tables.resolutions[0]!.decidedAt = "2026-01-10T00:04:00.000Z"))).resolves.toBeTruthy();
    await expect(withStamp((b) => (b.tables.resolutions[0]!.decidedAt = "2026-01-10T00:06:00.000Z"))).rejects.toThrow(/in the future/);
    // A run's three stamps are checked too, when present.
    await expect(withStamp((b) => b.tables.runs.push(run(ws.id, "r1", { undoneAt: "soon" })))).rejects.toThrow(/runs\[0\]\.undoneAt is not a UTC timestamp/);
  });

  it("refuses a workspace or source that names an instance or region this console does not connect to", async () => {
    const s = store();
    const ws = await seed(s);
    const bundle = await exportWorkspaceBundle(s, ws.id);
    const decode = async (patch: (b: WorkspaceBundle) => void) => {
      const b = structuredClone(bundle);
      patch(b);
      return decodeWorkspaceFile(await encodeWorkspaceFile(b));
    };
    await expect(decode((b) => (b.workspace.ld = { instance: "us", projectKey: "shop" }))).resolves.toBeTruthy();
    await expect(decode((b) => (b.workspace.ld = { instance: "evil.example" as "us", projectKey: "shop" }))).rejects.toThrow(/LaunchDarkly instance this console does not know \(evil\.example\)/);
    await expect(decode((b) => (b.tables.sources[0]!.posthog = { region: "us", projectId: "1" }))).resolves.toBeTruthy();
    await expect(decode((b) => (b.tables.sources[0]!.posthog = { region: "https://evil.example" as "us", projectId: "1" }))).rejects.toThrow(/PostHog region this console does not know/);
  });

  it("names what a merge replaces: the profile, and each decision by id", async () => {
    const a = store();
    const ws = await seed(a);
    await a.db.profiles.put({ workspaceId: ws.id, updatedAt: "2026-01-05T00:00:00Z", profile: { version: 1, sources: {}, attributes: {}, policies: {} } });
    const b = store();
    await applyWorkspaceImport(b, await planWorkspaceImport(b, await exportWorkspaceBundle(a, ws.id)));
    await b.saveResolutions(ws.id, [resolution("d1", "2026-01-06T00:00:00Z", "b"), resolution("d2", "2026-01-06T00:00:00Z")]);
    await b.db.profiles.put({ workspaceId: ws.id, updatedAt: "2026-01-06T00:00:00Z", profile: { version: 1, sources: {}, attributes: { country: "nation" }, policies: {} } });
    const plan = await planWorkspaceImport(a, await exportWorkspaceBundle(b, ws.id));
    expect(plan.counts.resolutions).toEqual({ add: 1, replace: 1, keep: 0, conflict: 0 });
    expect(plan.replaced.resolutions).toEqual(["d1"]);
    expect(plan.counts.profiles.replace).toBe(1);
    expect(plan.replaced.profiles).toEqual([""]);
    expect(plan.replaced.exclusions).toEqual([]);
  });

  it("marks runs and pre-images from a file as imported, and leaves imported pre-images out of getRun", async () => {
    const a = store();
    const ws = await seed(a);
    await a.saveRun(run(ws.id, "r-done"));
    await a.saveRun(run(ws.id, "r-stopped", { status: "stopped", finishedAt: "2026-01-04T00:02:00Z", steps: [{ ...run(ws.id, "x").steps[0]!, status: "pending" }] }));
    const bundle = await exportWorkspaceBundle(a, ws.id);
    expect(bundle.tables.runs).toHaveLength(2);
    expect(bundle.tables.runPreImages).toHaveLength(2);
    expect(bundle.tables.runs.every((r) => r.importedAt === undefined)).toBe(true);

    const b = store();
    const plan = await planWorkspaceImport(b, bundle);
    expect(plan.writes.runs.map((r) => r.importedAt)).toEqual([plan.importedAt, plan.importedAt]);
    expect(plan.writes.runPreImages.map((p) => p.importedAt)).toEqual([plan.importedAt, plan.importedAt]);
    await applyWorkspaceImport(b, plan);
    const listed = await b.listRuns(ws.id);
    expect(listed.map((r) => [r.id, r.importedAt])).toEqual([
      ["r-stopped", plan.importedAt],
      ["r-done", plan.importedAt],
    ]);
    // The pre-image is on file but never handed back: undo could not restore from it.
    const got = (await b.getRun("r-done"))!;
    expect(got.importedAt).toBe(plan.importedAt);
    expect(got.steps[0]!.hasPreImage).toBe(true);
    expect(got.steps[0]!.preImage).toBeUndefined();
    // The browser's own run keeps its pre-image.
    expect((await a.getRun("r-done"))!.steps[0]!.preImage).toBeDefined();

    // A file whose copy of a local run is newer replaces it, and the replacement is marked too:
    // the local record of the run is gone, so nothing may act on it any more.
    const laterCopy = structuredClone(bundle);
    laterCopy.tables.runs = [run(ws.id, "r-stopped", { status: "done", finishedAt: "2026-01-04T00:05:00Z" })];
    laterCopy.tables.runPreImages = [];
    const replace = await planWorkspaceImport(a, laterCopy);
    expect(replace.counts.runs).toEqual({ add: 0, replace: 1, keep: 0, conflict: 0 });
    expect(replace.replaced.runs).toEqual(["Checkout gates (#r-stoppe)"]);
    await applyWorkspaceImport(a, replace);
    expect((await a.getRun("r-stopped"))?.importedAt).toBe(replace.importedAt);
    expect((await a.getRun("r-done"))?.importedAt).toBeUndefined();
  });
});

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@sslm/canonical";
import type { Resolution } from "@sslm/mapper";
import {
  applyWorkspaceImport,
  decodeWorkspaceFile,
  encodeWorkspaceFile,
  exportWorkspaceBundle,
  importPlanSize,
  MigratorDb,
  planWorkspaceImport,
  readWorkspaceFileHeader,
  SecretInStoreError,
  WorkspaceFileFormatError,
  WorkspaceFilePassphraseRequired,
  WorkspaceStore,
  WrongPassphraseError,
  type WorkspaceBundle,
} from "../src/index.ts";

const store = () => new WorkspaceStore(new MigratorDb(`wf-${crypto.randomUUID()}`));
/** Fast PBKDF2 for tests; the app uses VAULT_ITERATIONS. */
const FAST = { iterations: 1_000 };

const resolution = (id: string, decidedAt: string, optionKey = "a"): Resolution => ({ id, type: "value_type", optionKey, scope: "resource", decidedAt });

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
});

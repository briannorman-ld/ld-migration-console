import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@sslm/canonical";
import {
  assertNoSecrets,
  DuplicateWorkspaceNameError,
  MigratorDb,
  SecretInStoreError,
  WorkspaceStore,
} from "../src/index.ts";

const store = () =>
  new WorkspaceStore(new MigratorDb(`test-${crypto.randomUUID()}`));
let n = 0;
const source = (id: string) => ({
  id,
  alias: id,
  label: `acme-${id}`,
  kind: "console_api" as const,
  createdAt: `2026-01-01T00:00:0${n++}Z`,
});

describe("WorkspaceStore (Dexie / IndexedDB)", () => {
  it("stores a workspace with N sources and immutable snapshots", async () => {
    const s = store();
    const ws = await s.createWorkspace({
      name: "Acme Retail (Demo)",
      isDemo: true,
    });
    await s.addSource(ws.id, source("web"));
    await s.addSource(ws.id, source("mobile"));
    expect((await s.listSources(ws.id)).map((x) => x.alias)).toEqual([
      "web",
      "mobile",
    ]);

    const snap1 = emptySnapshot(
      { sourceId: "web", sourceKind: "console_api", alias: "web" },
      "2026-01-01T00:00:00Z",
    );
    const snap2 = { ...snap1, takenAt: "2026-01-02T00:00:00Z" };
    await s.saveSnapshot(ws.id, snap1);
    const r2 = await s.saveSnapshot(ws.id, snap2);
    expect((await s.latestSnapshot("web"))?.id).toBe(r2.id);
    expect((await s.listSnapshots("web")).map((x) => x.takenAt)).toEqual([
      "2026-01-02T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ]);
    expect(await s.latestSnapshot("mobile")).toBeUndefined();
  });

  it("refuses a second workspace with the same name, ignoring case and surrounding spaces", async () => {
    const s = store();
    const a = await s.createWorkspace({ name: "  Contoso migration " });
    expect(a.name).toBe("Contoso migration");
    await expect(
      s.createWorkspace({ name: "contoso MIGRATION" }),
    ).rejects.toBeInstanceOf(DuplicateWorkspaceNameError);
    const b = await s.createWorkspace({ name: "Contoso staging" });
    await expect(
      s.updateWorkspace(b.id, { name: "Contoso Migration" }),
    ).rejects.toBeInstanceOf(DuplicateWorkspaceNameError);
    await s.updateWorkspace(b.id, { name: "Contoso staging" }); // renaming to your own name is fine
    expect((await s.listWorkspaces()).map((w) => w.name).sort()).toEqual([
      "Contoso migration",
      "Contoso staging",
    ]);
  });

  it("prunes old snapshots per source, keeping the newest N and any a run was planned from", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "x" });
    await s.addSource(ws.id, source("web"));
    await s.addSource(ws.id, source("mobile"));
    const at = (i: number) => `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`;
    for (let i = 1; i <= 6; i++)
      await s.saveSnapshot(
        ws.id,
        emptySnapshot(
          { sourceId: "web", sourceKind: "console_api", alias: "web" },
          at(i),
        ),
      );
    const mobile = await s.saveSnapshot(
      ws.id,
      emptySnapshot(
        { sourceId: "mobile", sourceKind: "console_api", alias: "mobile" },
        at(1),
      ),
    );
    await s.saveSpecUpload({
      workspaceId: ws.id,
      sourceId: "web",
      filename: "a.json",
      bytes: 1,
      version: 2,
      json: {},
      snapshotId: (await s.listSnapshots("web")).at(-1)!.id,
    });
    // A run planned from the oldest web snapshot protects it.
    await s.saveRun({
      id: "run1",
      workspaceId: ws.id,
      projectKey: "p",
      label: "l",
      dryRun: false,
      startedAt: at(6),
      status: "succeeded",
      steps: [],
      snapshots: [{ sourceId: "web", takenAt: at(1) }],
    } as never);
    const removed = await s.pruneSnapshots(ws.id, "web", 3);
    expect(removed).toHaveLength(2); // at(2) and at(3): at(1) is protected, at(4..6) are the newest three
    expect((await s.listSnapshots("web")).map((x) => x.takenAt)).toEqual([
      at(6),
      at(5),
      at(4),
      at(1),
    ]);
    expect((await s.listSnapshots("mobile")).map((x) => x.id)).toEqual([
      mobile.id,
    ]); // other sources untouched
    expect(await s.listSpecUploads("web")).toHaveLength(1); // upload of the protected snapshot stays
    expect((await s.listSnapshots("web"))[0]!.bytes).toBeGreaterThan(0);
    expect(await s.pruneSnapshots(ws.id, "web", 0)).toEqual([]); // nonsense retention is ignored
  });

  it("cascades deletes", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "x" });
    await s.addSource(ws.id, source("web"));
    await s.saveSnapshot(
      ws.id,
      emptySnapshot(
        { sourceId: "web", sourceKind: "console_api", alias: "web" },
        "t",
      ),
    );
    await s.saveCapabilities(ws.id, { capabilities: [] });
    await s.deleteWorkspace(ws.id);
    expect(await s.db.sources.count()).toBe(0);
    expect(await s.db.snapshots.count()).toBe(0);
    expect(await s.getCapabilities(ws.id)).toBeUndefined();
  });

  it("removes one source with its snapshots and ID lists, leaving the others", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "x" });
    await s.addSource(ws.id, source("web"));
    await s.addSource(ws.id, source("mobile"));
    await s.saveSnapshot(
      ws.id,
      emptySnapshot(
        { sourceId: "web", sourceKind: "console_api", alias: "web" },
        "t",
      ),
    );
    await s.saveSnapshot(
      ws.id,
      emptySnapshot(
        { sourceId: "mobile", sourceKind: "console_api", alias: "mobile" },
        "t",
      ),
    );
    await s.saveIdList({
      uid: "web:seg",
      workspaceId: ws.id,
      sourceId: "web",
      fetchedAt: "t",
      ids: ["u1"],
    });
    await s.saveIdList({
      uid: "mobile:seg",
      workspaceId: ws.id,
      sourceId: "mobile",
      fetchedAt: "t",
      ids: ["u2"],
    });
    await s.removeSource("web");
    expect((await s.listSources(ws.id)).map((x) => x.id)).toEqual(["mobile"]);
    expect(await s.latestSnapshot("web")).toBeUndefined();
    expect((await s.latestSnapshot("mobile"))?.sourceId).toBe("mobile");
    expect((await s.listIdLists(ws.id)).map((x) => x.uid)).toEqual([
      "mobile:seg",
    ]);
  });

  it("refuses to persist anything that looks like a token", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "x" });
    await expect(
      s.addSource(ws.id, { ...source("web"), apiKey: "console-abc" } as never),
    ).rejects.toBeInstanceOf(SecretInStoreError);
    await expect(
      s.updateWorkspace(ws.id, {
        ld: { instance: "us", token: "api-x" } as never,
      }),
    ).rejects.toBeInstanceOf(SecretInStoreError);
    await expect(
      s.saveCapabilities(ws.id, {
        token: { tokenKind: "auth" },
        nested: { accessToken: "x" },
      }),
    ).rejects.toBeInstanceOf(SecretInStoreError);
    expect(() => assertNoSecrets({ token: { tokenKind: "auth" } })).toThrow(); // keys named token are refused, even when nested objects
    expect(() =>
      assertNoSecrets({ tokenInfo: { tokenKind: "auth" }, emptyToken: "" }),
    ).not.toThrow();
  });
});

describe("M3 tables", () => {
  it("keeps resolutions per workspace and refuses secrets in the profile", async () => {
    const { WorkspaceStore, MigratorDb, SecretInStoreError } =
      await import("../src/index.ts");
    const s = new WorkspaceStore(new MigratorDb(`m3-${Math.random()}`));
    await s.saveResolutions("w1", [
      {
        id: "d1",
        type: "client_side_availability",
        optionKey: "both",
        scope: "resource",
        fingerprint: "f",
        decidedAt: "t",
      },
    ]);
    await s.saveResolutions("w2", [
      {
        id: "d1",
        type: "client_side_availability",
        optionKey: "server",
        scope: "resource",
        fingerprint: "f",
        decidedAt: "t",
      },
    ]);
    expect((await s.listResolutions("w1")).map((r) => r.optionKey)).toEqual([
      "both",
    ]);
    await s.deleteResolutions("w1", ["d1"]);
    expect(await s.listResolutions("w1")).toEqual([]);
    await expect(
      s.saveProfile("w1", {
        version: 1,
        sources: {},
        attributes: { token: "x" } as never,
        policies: {},
      }),
    ).rejects.toBeInstanceOf(SecretInStoreError);
  });

  it("lists runs newest first", async () => {
    const { WorkspaceStore, MigratorDb } = await import("../src/index.ts");
    const s = new WorkspaceStore(new MigratorDb(`runs-${Math.random()}`));
    for (const [id, at] of [
      ["a", "2026-01-01"],
      ["b", "2026-02-01"],
    ])
      await s.saveRun({
        id: id!,
        workspaceId: "w",
        projectKey: "p",
        label: id!,
        dryRun: false,
        startedAt: at!,
        status: "done",
        steps: [],
      });
    expect((await s.listRuns("w")).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("monitoring tables (M5)", () => {
  it("round-trips the last check, per-item switches and samples, and deletes them with the workspace", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "Monitored" });
    await s.saveMonitorState({ workspaceId: ws.id, lastCheckedAt: "2026-10-23T12:00:00Z", statuses: { test: { a: { name: "active", lastRequested: "2026-10-23T11:00:00Z" } } }, alertKeys: ["a|test:statsig_changed:"] });
    await s.setMonitorItem({ workspaceId: ws.id, flagKey: "a", ldEnv: "test", ldAuthoritative: true, setAt: "2026-10-23T12:00:00Z" });
    await s.setMonitorItem({ workspaceId: ws.id, flagKey: "a", ldEnv: "test", ldAuthoritative: false, setAt: "2026-10-23T12:01:00Z" });
    await s.addMonitorSamples([
      { id: "s1", workspaceId: ws.id, flagKey: "a", ldEnv: "test", at: "2026-10-23T12:00:00Z", ldStatus: "active", statsigChecksPerHour: 0 },
      { id: "s2", workspaceId: ws.id, flagKey: "b", ldEnv: "test", at: "2026-10-23T12:00:00Z", ldStatus: "new" },
    ]);
    expect((await s.getMonitorState(ws.id))?.statuses.test?.a?.name).toBe("active");
    expect(await s.listMonitorItems(ws.id)).toEqual([{ workspaceId: ws.id, flagKey: "a", ldEnv: "test", ldAuthoritative: false, setAt: "2026-10-23T12:01:00Z" }]);
    expect((await s.listMonitorSamples(ws.id)).map((x) => x.id).sort()).toEqual(["s1", "s2"]);
    await s.deleteMonitorSamples(["s2"]);
    expect((await s.listMonitorSamples(ws.id)).map((x) => x.id)).toEqual(["s1"]);
    await s.deleteWorkspace(ws.id);
    expect(await s.getMonitorState(ws.id)).toBeUndefined();
    expect(await s.listMonitorItems(ws.id)).toEqual([]);
    expect(await s.listMonitorSamples(ws.id)).toEqual([]);
  });

  it("refuses monitor state that carries a secret-looking field", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "Leaky" });
    await expect(s.saveMonitorState({ workspaceId: ws.id, lastCheckedAt: "x", statuses: {}, alertKeys: [], ...({ token: "sdk-123" } as object) })).rejects.toBeInstanceOf(SecretInStoreError);
  });
});

describe("exclusions (items set aside)", () => {
  it("marks, replaces and unmarks items per workspace, and deletes them with the workspace", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "Set aside" });
    const other = await s.createWorkspace({ name: "Other" });
    await s.setExclusions(ws.id, [{ uid: "web/gate/stale_reviews_widget", reason: "No checks in 7 days" }, { uid: "web/gate/old_cart_drawer", reason: "  " }], "2026-11-02T10:00:00Z");
    await s.setExclusions(other.id, [{ uid: "web/gate/stale_reviews_widget" }], "2026-11-02T10:00:00Z");
    expect((await s.listExclusions(ws.id)).sort((a, b) => a.uid.localeCompare(b.uid))).toEqual([
      { workspaceId: ws.id, uid: "web/gate/old_cart_drawer", markedAt: "2026-11-02T10:00:00Z" },
      { workspaceId: ws.id, uid: "web/gate/stale_reviews_widget", reason: "No checks in 7 days", markedAt: "2026-11-02T10:00:00Z" },
    ]);
    // A second mark on the same uid replaces the first.
    await s.setExclusions(ws.id, [{ uid: "web/gate/stale_reviews_widget", reason: "Hard-coded instead" }], "2026-11-02T11:00:00Z");
    expect((await s.listExclusions(ws.id)).find((x) => x.uid === "web/gate/stale_reviews_widget")).toMatchObject({ reason: "Hard-coded instead", markedAt: "2026-11-02T11:00:00Z" });
    await s.deleteExclusions(ws.id, ["web/gate/old_cart_drawer"]);
    expect((await s.listExclusions(ws.id)).map((x) => x.uid)).toEqual(["web/gate/stale_reviews_widget"]);
    await s.deleteWorkspace(ws.id);
    expect(await s.listExclusions(ws.id)).toEqual([]);
    expect(await s.listExclusions(other.id)).toHaveLength(1);
  });
});

describe("last LaunchDarkly listing (shown while the next read runs)", () => {
  it("keeps one listing per workspace, replaces it, and deletes it with the workspace", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "Listing" });
    expect(await s.getLdState(ws.id)).toBeUndefined();
    await s.saveLdState(ws.id, { instance: "us", projectKey: "shop", loadedAt: "2026-11-02T10:00:00Z", state: { flags: { items: [{ key: "f1" }], loadedAt: "2026-11-02T10:00:00Z" }, segments: { test: [] } } });
    await s.saveLdState(ws.id, { instance: "us", projectKey: "shop", loadedAt: "2026-11-02T11:00:00Z", state: { flags: { items: [{ key: "f1" }, { key: "f2" }], loadedAt: "2026-11-02T11:00:00Z" }, segments: { test: [{ key: "beta" }] } } });
    const rec = await s.getLdState(ws.id);
    expect(rec?.loadedAt).toBe("2026-11-02T11:00:00Z");
    expect((rec?.state as { segments: Record<string, unknown[]> }).segments.test).toHaveLength(1);
    await s.deleteWorkspace(ws.id);
    expect(await s.getLdState(ws.id)).toBeUndefined();
  });
});

describe("run journal: pre-images kept apart", () => {
  const run = (id: string, steps: { id: string; preImage?: unknown }[]) => ({
    id,
    workspaceId: "w",
    projectKey: "p",
    label: id,
    dryRun: false,
    startedAt: "2026-11-03T10:00:00Z",
    status: "running" as const,
    steps: steps.map((s) => ({ id: s.id, label: s.id, status: "done" as const, step: { op: "upsert_flag_shell", key: s.id } as never, ...(s.preImage !== undefined ? { preImage: s.preImage as never } : {}) })),
  });

  it("lists runs without pre-images, reads one back with them, and writes each pre-image once", async () => {
    const s = store();
    const pre = { key: "f1", environments: { production: { on: true } } };
    const r = run("r1", [{ id: "s1", preImage: pre }, { id: "s2" }]);
    await s.saveRun(r);
    const listed = (await s.listRuns("w"))[0]!;
    expect(listed.steps[0]).not.toHaveProperty("preImage");
    expect(listed.steps[0]!.hasPreImage).toBe(true);
    expect(listed.steps[1]!.hasPreImage).toBeUndefined();
    const full = await s.getRun("r1");
    expect(full?.steps[0]!.preImage).toEqual(pre);
    expect(full?.steps[1]!.preImage).toBeUndefined();
    // The next journal write (same pre-image object, a step further) rewrites the run, not the pre-image.
    const again = { ...r, status: "done" as const, steps: [...r.steps, { id: "s3", label: "s3", status: "done" as const, step: { op: "upsert_flag_shell", key: "s3" } as never, preImage: { key: "f3" } as never }] };
    await s.saveRun(again);
    expect(await s.db.runPreImages.count()).toBe(2);
    expect((await s.getRun("r1"))?.steps.map((x) => x.preImage)).toEqual([pre, undefined, { key: "f3" }]);
    // A record read back (resume after a reload) carries pre-images the journal already holds: saving it adds none.
    await s.saveRun({ ...(await s.getRun("r1"))!, status: "done" });
    expect(await s.db.runPreImages.count()).toBe(2);
  });

  it("deletes the pre-images with the workspace", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "Journal" });
    await s.saveRun({ ...run("r2", [{ id: "s1", preImage: { key: "f" } }]), workspaceId: ws.id });
    await s.saveRun({ ...run("r3", [{ id: "s1", preImage: { key: "g" } }]), workspaceId: "other" });
    expect(await s.db.runPreImages.count()).toBe(2);
    await s.deleteWorkspace(ws.id);
    expect(await s.db.runPreImages.toArray()).toEqual([{ id: "r3/s1", runId: "r3", stepId: "s1", preImage: { key: "g" } }]);
  });

  it("moves the pre-images of runs journaled before version 9 out of their records on upgrade", async () => {
    const name = `upgrade-${crypto.randomUUID()}`;
    const { default: Dexie } = await import("dexie");
    const old = new Dexie(name);
    old.version(8).stores({ runs: "id, workspaceId, startedAt, [workspaceId+startedAt]" });
    await old.table("runs").put(run("r1", [{ id: "s1", preImage: { key: "f1" } }, { id: "s2" }]));
    old.close();
    const s = new WorkspaceStore(new MigratorDb(name));
    const listed = (await s.listRuns("w"))[0]!;
    expect(listed.steps[0]).not.toHaveProperty("preImage");
    expect(listed.steps[0]!.hasPreImage).toBe(true);
    expect((await s.getRun("r1"))?.steps[0]!.preImage).toEqual({ key: "f1" });
    expect(await s.db.runPreImages.count()).toBe(1);
  });
});

describe("snapshots: payloads kept apart", () => {
  const desc = { sourceId: "web", sourceKind: "console_api" as const, alias: "web" };

  it("lists a source's history from the metadata table alone and joins the payload on a read", async () => {
    const s = store();
    const ws = await s.createWorkspace({ name: "x" });
    await s.addSource(ws.id, source("web"));
    const snap = { ...emptySnapshot(desc, "2026-01-01T00:00:00Z"), warnings: [{ code: "x", message: "y" } as never] };
    const saved = await s.saveSnapshot(ws.id, snap);
    expect(saved.canonical).toBe(snap);
    const listed = await s.listSnapshots("web");
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("canonical");
    expect(listed[0]!.summary.warnings).toBe(1);
    expect(await s.db.snapshots.get(saved.id)).not.toHaveProperty("canonical");
    expect((await s.getSnapshot(saved.id))?.canonical).toEqual(snap);
    expect((await s.latestSnapshot("web"))?.canonical).toEqual(snap);
    // Pruning, removing the source and deleting the workspace take both halves.
    await s.saveSnapshot(ws.id, { ...snap, takenAt: "2026-01-02T00:00:00Z" });
    await s.pruneSnapshots(ws.id, "web", 1);
    expect(await s.db.snapshotBodies.count()).toBe(1);
    expect(await s.db.snapshotBodies.get(saved.id)).toBeUndefined();
    await s.removeSource("web");
    expect(await s.db.snapshotBodies.count()).toBe(0);
    await s.addSource(ws.id, source("web"));
    await s.saveSnapshot(ws.id, snap);
    await s.deleteWorkspace(ws.id);
    expect(await s.db.snapshotBodies.count()).toBe(0);
    expect(await s.db.snapshots.count()).toBe(0);
  });

  it("moves the payloads of snapshots saved before version 10 into their own table on upgrade", async () => {
    const name = `upgrade-${crypto.randomUUID()}`;
    const { default: Dexie } = await import("dexie");
    const old = new Dexie(name);
    old.version(9).stores({ snapshots: "id, workspaceId, sourceId, [sourceId+takenAt]" });
    const canonical = emptySnapshot(desc, "2026-01-01T00:00:00Z");
    await old.table("snapshots").put({ id: "s1", workspaceId: "w", sourceId: "web", takenAt: canonical.takenAt, sourceKind: "console_api", summary: { gates: 0, configs: 0, segments: 0, experiments: 0, warnings: 0 }, bytes: 10, canonical });
    old.close();
    const s = new WorkspaceStore(new MigratorDb(name));
    expect((await s.listSnapshots("web")).map((x) => x.id)).toEqual(["s1"]);
    expect(await s.db.snapshots.get("s1")).not.toHaveProperty("canonical");
    expect((await s.getSnapshot("s1"))?.canonical).toEqual(canonical);
    expect((await s.latestSnapshot("web"))?.canonical).toEqual(canonical);
  });
});

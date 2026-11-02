import {
  checkUpload,
  type CanonicalSnapshot,
  type SourceDescriptor,
} from "@sslm/canonical";
import {
  crawlConsoleProject,
  normalizeConsoleSnapshot,
  normalizeLdSnapshot,
  readLdProject,
  type CrawlProgress,
} from "@sslm/adapters";
import { LD_INSTANCES, LdClient } from "@sslm/ld-client";
import type { TransportEvent } from "@sslm/http";
import { WorkspaceStore } from "@sslm/store";
import { StatsigConsoleClient, type SchemaIssue } from "@sslm/statsig-client";
import { pipeline } from "../pipeline/client.ts";
import { demoKey, demoLdSourceToken, startDemoMock } from "./demo.ts";
import { secrets } from "./secrets.ts";
import { store } from "./store.ts";

/** Keep the workspace's retention count of snapshots for this source (plus any a run used). */
async function pruneAfterSync(
  workspaceId: string,
  sourceId: string,
): Promise<void> {
  const ws = await store.getWorkspace(workspaceId);
  await store.pruneSnapshots(
    workspaceId,
    sourceId,
    ws?.snapshotRetention ?? WorkspaceStore.DEFAULT_SNAPSHOT_RETENTION,
  );
}

export interface SyncHandlers {
  onProgress?: (p: CrawlProgress) => void;
  onRetry?: (message: string) => void;
  /** Every request, response, retry and throttle event, for the live activity log. No headers or bodies. */
  onTransport?: (e: TransportEvent) => void;
}

/** Re-read any live source (Console API or LaunchDarkly project) into a new immutable snapshot. */
export async function syncSource(workspaceId: string, source: SourceDescriptor, h: SyncHandlers = {}): Promise<CanonicalSnapshot> {
  if (source.kind === "launchdarkly") return syncLdSource(workspaceId, source, h);
  return syncConsoleSource(workspaceId, source, h);
}

/**
 * Read an LD project attached as a source (PLAN §20.2) with its own read token, through the
 * real LD client and adapter, on the main thread (LD reads are few and fast; the demo's mock only
 * intercepts this page's requests). Read-only: the adapter has no write path.
 */
export async function syncLdSource(workspaceId: string, source: SourceDescriptor, h: SyncHandlers = {}): Promise<CanonicalSnapshot> {
  if (source.kind !== "launchdarkly" || !source.ld) throw new Error("Not a LaunchDarkly source.");
  let token: string | undefined;
  if (source.isDemo) {
    await startDemoMock();
    token = await demoLdSourceToken();
  } else token = secrets.get("ld_source", source.id);
  if (!token) throw new Error("Enter the LaunchDarkly read token for this source again.");
  const instance = source.ld.baseUrl ? { ...LD_INSTANCES[source.ld.instance], origin: source.ld.baseUrl } : source.ld.instance;
  const client = new LdClient({ instance, token, transport: { onEvent: (e) => h.onTransport?.(e) } });
  const raw = await readLdProject(client, source.ld.projectKey, { onProgress: h.onProgress });
  const snapshot = normalizeLdSnapshot(raw, { source: { sourceId: source.id, sourceKind: "launchdarkly", alias: source.alias } });
  await store.saveSnapshot(workspaceId, snapshot);
  await pruneAfterSync(workspaceId, source.id);
  return snapshot;
}

/** Re-crawl a Console API source and save a new immutable snapshot. */
export async function syncConsoleSource(
  workspaceId: string,
  source: SourceDescriptor,
  h: SyncHandlers = {},
): Promise<CanonicalSnapshot> {
  if (source.kind !== "console_api" || !source.baseUrl)
    throw new Error("Not a Console API source.");
  let apiKey: string | undefined;
  if (source.isDemo) {
    await startDemoMock();
    apiKey = await demoKey();
  } else {
    apiKey = secrets.get("statsig", source.id);
  }
  if (!apiKey)
    throw new Error(
      "Enter the Console API key for this source again.",
    );
  const onRetry = (url: string, delayMs: number, reason: string) =>
    h.onRetry?.(
      `Retrying ${new URL(url, location.href).pathname.split("/console/v1")[1] ?? url} in ${Math.round(delayMs / 100) / 10}s (${reason})`,
    );
  const onTransport = (e: TransportEvent) => {
    h.onTransport?.(e);
    if (e.type === "retry") onRetry(e.url, e.delayMs, e.reason);
  };
  if (source.isDemo) {
    // The demo's MSW mock reliably intercepts only this page's own requests: after a reload, the
    // service worker doesn't serve requests from the pipeline worker. So demo sources crawl on the
    // main thread, through the same adapters; the dataset is small.
    const issues: SchemaIssue[] = [];
    const client = new StatsigConsoleClient({
      baseUrl: source.baseUrl,
      apiKey,
      onSchemaIssue: (i) => issues.push(i),
      transport: { onEvent: onTransport },
    });
    const raw = await crawlConsoleProject(client, issues, {
      onProgress: h.onProgress,
      kinds: source.resources,
    });
    const snapshot = normalizeConsoleSnapshot(raw, {
      source: {
        sourceId: source.id,
        sourceKind: "console_api",
        alias: source.alias,
      },
    });
    await store.saveSnapshot(workspaceId, snapshot);
    await pruneAfterSync(workspaceId, source.id);
    return snapshot;
  }
  const job = pipeline().crawlConsole(
    {
      source: { sourceId: source.id, alias: source.alias },
      baseUrl: source.baseUrl,
      apiKey,
      kinds: source.resources,
    },
    {
      onProgress: h.onProgress,
      onTransport,
    },
  );
  const { snapshot } = await job.promise;
  await store.saveSnapshot(workspaceId, snapshot);
  await pruneAfterSync(workspaceId, source.id);
  return snapshot;
}

/** Upload a config spec for a spec source: parse in the worker, sanity-check, save. */
export async function uploadSpec(
  workspaceId: string,
  source: SourceDescriptor,
  file: File,
) {
  const bytes = await file.arrayBuffer();
  const { snapshot, spec } = await pipeline().parseSpec({
    source: { sourceId: source.id, alias: source.alias },
    bytes,
    filename: file.name,
  }).promise;
  const prev = (await store.latestSnapshot(source.id))?.canonical;
  const sanity = checkUpload(prev, snapshot);
  if (sanity.companyMismatch) {
    throw new Error(
      `This spec belongs to a different StatSig project (company ${sanity.companyMismatch.next}, previously ${sanity.companyMismatch.previous}).`,
    );
  }
  if (sanity.duplicate) return { snapshot, sanity, saved: false };
  const rec = await store.saveSnapshot(workspaceId, snapshot);
  if (spec)
    await store.saveSpecUpload({
      workspaceId,
      sourceId: source.id,
      filename: file.name,
      bytes: spec.bytes,
      version: spec.version,
      json: spec.json,
      snapshotId: rec.id,
    });
  await pruneAfterSync(workspaceId, source.id);
  if (!source.companyId && snapshot.companyId)
    await store.addSource(workspaceId, {
      ...source,
      companyId: snapshot.companyId,
    });
  return { snapshot, sanity, saved: true };
}

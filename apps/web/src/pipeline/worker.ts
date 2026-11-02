/// <reference lib="webworker" />
/**
 * Pipeline Web Worker (PLAN §3): crawl the Console API, parse config specs, normalize to the
 * canonical model, off the UI thread. Pure packages only; no DOM, no storage, no logging of keys.
 */
import { CrawlAuthError, crawlConsoleProject, normalizeConsoleSnapshot, normalizeSpec, parseRawIdCsv, parseSpecBytes, reconcileIdList, SpecRejectedError } from '@sslm/adapters';
import { StatsigConsoleClient, type SchemaIssue } from '@sslm/statsig-client';
import type { PipelineEvent, PipelineRequest } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;
const controllers = new Map<number, AbortController>();
const post = (e: PipelineEvent) => self.postMessage(e);

self.onmessage = async (ev: MessageEvent<PipelineRequest>) => {
  const req = ev.data;
  if (req.type === 'cancel') {
    controllers.get(req.target)?.abort();
    return;
  }
  const ctrl = new AbortController();
  controllers.set(req.id, ctrl);
  try {
    if (req.type === 'crawl-console') {
      const issues: SchemaIssue[] = [];
      const client = new StatsigConsoleClient({
        baseUrl: req.baseUrl,
        apiKey: req.apiKey,
        onSchemaIssue: (i) => issues.push(i),
        transport: { onEvent: (e) => post({ id: req.id, type: 'transport', event: e }) },
      });
      const raw = await crawlConsoleProject(client, issues, {
        signal: ctrl.signal,
        eagerIdListMax: req.eagerIdListMax,
        kinds: req.kinds,
        onProgress: (progress) => post({ id: req.id, type: 'progress', progress }),
      });
      const snapshot = normalizeConsoleSnapshot(raw, { source: { sourceId: req.source.sourceId, sourceKind: 'console_api', alias: req.source.alias } });
      post({ id: req.id, type: 'result', snapshot });
    } else if (req.type === 'reconcile-id-list') {
      const result = await reconcileIdList(req.ids ?? parseRawIdCsv(req.rawCsv ?? ''), req.hashes ? new Set(req.hashes) : undefined, req.count);
      post({ id: req.id, type: 'reconciled', result });
    } else {
      const parsed = await parseSpecBytes(new Uint8Array(req.bytes), req.filename);
      const snapshot = normalizeSpec(parsed, {
        source: { sourceId: req.source.sourceId, sourceKind: 'config_spec', alias: req.source.alias },
        takenAt: new Date().toISOString(),
      });
      post({ id: req.id, type: 'result', snapshot, spec: { version: parsed.version, json: parsed.json, bytes: req.bytes.byteLength } });
    }
  } catch (e) {
    if (ctrl.signal.aborted) post({ id: req.id, type: 'error', code: 'aborted', message: 'Cancelled.' });
    else if (e instanceof CrawlAuthError) post({ id: req.id, type: 'error', code: 'auth', message: e.message });
    else if (e instanceof SpecRejectedError) post({ id: req.id, type: 'error', code: 'rejected', message: e.message });
    else post({ id: req.id, type: 'error', code: 'failed', message: e instanceof Error ? e.message : String(e) });
  } finally {
    controllers.delete(req.id);
  }
};

import { HttpError, Transport, UnreachableError, type TransportOptions } from '@sslm/http';
import type { z } from 'zod';
import { ExposureCountSchema, GateChecksSchema, IdListSchema, PaginationSchema, ProjectSchema, ProjectSettingsSchema, RuleSchema, type StatsigExposureCounts, type StatsigGateChecks, type StatsigIdList, type StatsigProject, type StatsigRule } from './schemas.ts';

export const STATSIG_API_VERSION = '20240601';
export const STATSIG_CONSOLE_BASE_URL = 'https://statsigapi.net/console/v1';

/**
 * PLAN §4.1 rate budget: about 900 requests / 15 min and 12 / 10 s per project.
 * (The OpenAPI description says ~100 / 10 s; we stay well under it.)
 */
/**
 * Self-imposed request budget per project (PLAN §4.1). StatSig documents roughly 100 requests per
 * 10 seconds and 900 per 15 minutes; we take 40% of the burst and the full 15-minute ceiling, which
 * leaves room for other Console API clients on the same project. 429s still halve concurrency.
 */
export const STATSIG_DEFAULT_BUDGETS = [
  { limit: 40, windowMs: 10_000 },
  { limit: 900, windowMs: 15 * 60_000 },
];

export const PAGE_SIZE = 100;
const MAX_PAGES = 1000;
/** `/exposure_count` takes at most this many IDs per kind per call (`maxItems: 25`). */
export const EXPOSURE_COUNT_BATCH = 25;

/** Query values; an array is sent as a repeated key (`gates=a&gates=b`), how the Console API takes its list parameters. */
export type Query = Record<string, string | string[]>;

export interface SchemaIssue {
  endpoint: string;
  /** Index within a list response, when the issue is per item. */
  index?: number;
  /** Zod issue paths and messages. Values are never included (they may contain PII). */
  issues: { path: string; message: string }[];
}

/** A raw response recorded by capture-fixture mode, to build fixtures from a real project later. */
export interface CapturedResponse {
  path: string;
  query: Query;
  status: number;
  body: unknown;
}

export interface StatsigClientOptions {
  /** e.g. https://statsigapi.net/console/v1, or the demo mock's base URL. */
  baseUrl: string;
  /** Console API key. Held in memory by this instance only; never logged. */
  apiKey: string;
  transport?: Transport | TransportOptions;
  onSchemaIssue?: (issue: SchemaIssue) => void;
  /** Capture-fixture mode. Bodies may contain PII; the caller decides where they go. */
  capture?: (c: CapturedResponse) => void;
  pageSize?: number;
}

export class StatsigAuthError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? 'StatSig rejected the API key (401).' : `StatSig denied access (${status}). The key may lack read scope for this resource.`);
    this.name = 'StatsigAuthError';
  }
}

/**
 * The request failed with no readable status. From a browser this is how StatSig's 401 and 429
 * responses look, because they carry no CORS header (PLAN §3.1).
 */
export class StatsigUnreachableError extends Error {
  constructor(override readonly cause: UnreachableError) {
    super('StatSig unreachable, the key may be invalid.');
    this.name = 'StatsigUnreachableError';
  }
}

export class StatsigConsoleClient {
  readonly transport: Transport;
  readonly baseUrl: string;
  readonly #apiKey: string;
  private readonly onSchemaIssue: (issue: SchemaIssue) => void;
  private readonly capture?: (c: CapturedResponse) => void;
  private readonly pageSize: number;

  constructor(opts: StatsigClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.transport =
      opts.transport instanceof Transport ? opts.transport : new Transport({ budgets: STATSIG_DEFAULT_BUDGETS, ...opts.transport });
    this.onSchemaIssue = opts.onSchemaIssue ?? (() => undefined);
    this.capture = opts.capture;
    this.pageSize = opts.pageSize ?? PAGE_SIZE;
  }

  /** PLAN §4.1: the key is validated first with a single `GET /project`. */
  validateKey(signal?: AbortSignal): Promise<StatsigProject> {
    return this.get('/project', ProjectSchema, {}, signal);
  }

  /**
   * The project's name. `GET /project` returns only an id (ExternalProjectDto; the id is the one
   * in the StatSig console's URL), so the name is a project setting. A key without the settings
   * scope, or a plan without the endpoint, gets `undefined` rather than a failed add.
   */
  async projectName(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const settings = await this.get('/settings/project', ProjectSettingsSchema, {}, signal);
      return settings.name?.trim() || undefined;
    } catch (e) {
      if (signal?.aborted) throw e;
      return undefined;
    }
  }

  /** Single-object endpoint: returns `data`. */
  async get<S extends z.ZodType>(path: string, schema: S, query: Query = {}, signal?: AbortSignal): Promise<z.infer<S>> {
    const body = await this.raw(path, query, signal);
    const data = envelopeData(body);
    return this.check(path, schema, data);
  }

  /** Paginated list: loops `page` with `limit` until `pagination.nextPage` is null. */
  async list<S extends z.ZodType>(path: string, itemSchema: S, query: Query = {}, signal?: AbortSignal): Promise<z.infer<S>[]> {
    const out: z.infer<S>[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.raw(path, { ...query, page: String(page), limit: String(this.pageSize) }, signal);
      const data = envelopeData(body);
      const items = Array.isArray(data) ? data : data == null ? [] : [data];
      const offset = out.length;
      items.forEach((item, i) => out.push(this.check(path, itemSchema, item, offset + i)));
      if (!hasNextPage(body, items.length, this.pageSize, (i) => this.issue({ endpoint: path, issues: i }))) break;
    }
    return out;
  }

  /**
   * `/segments/{id}/id_list`. The published schema contradicts itself (data is both the ID-list
   * object and a paginated array), so accept either and page through `ids` if paginated.
   */
  async getIdList(segmentId: string, signal?: AbortSignal): Promise<StatsigIdList> {
    const path = `/segments/${encodeURIComponent(segmentId)}/id_list`;
    let name: string | null | undefined;
    let count: number | null | undefined;
    const ids: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.raw(path, { page: String(page), limit: String(this.pageSize) }, signal);
      let data = envelopeData(body);
      if (Array.isArray(data)) data = data[0];
      const parsed = this.check(path, IdListSchema, data ?? {});
      name ??= parsed.name;
      count ??= parsed.count;
      const pageIds = Array.isArray(parsed.ids) ? parsed.ids : [];
      ids.push(...pageIds);
      if (!hasNextPage(body, pageIds.length, this.pageSize, () => undefined)) break;
      if (count != null && ids.length >= count) break;
    }
    return { name, count: count ?? ids.length, ids };
  }

  /**
   * `/exposure_count`: recent exposure events for up to `EXPOSURE_COUNT_BATCH` IDs per kind, in one
   * request. Callers batch; the ids are sent as repeated query keys per the OpenAPI `oneOf` (a
   * single id arrives as a string, several as an array).
   */
  getExposureCounts(ids: { gates?: string[]; dynamicConfigs?: string[]; experiments?: string[] }, signal?: AbortSignal): Promise<StatsigExposureCounts> {
    const query: Query = {};
    for (const k of ['gates', 'dynamicConfigs', 'experiments'] as const) {
      const list = ids[k] ?? [];
      if (list.length > EXPOSURE_COUNT_BATCH) throw new RangeError(`/exposure_count takes at most ${EXPOSURE_COUNT_BATCH} ${k} per call (got ${list.length}).`);
      if (list.length) query[k] = list;
    }
    return this.get('/exposure_count', ExposureCountSchema, query, signal);
  }

  /** `/gates/{id}/checks`: whether the gate was checked in production in the last 7 days. */
  getGateChecks(gateId: string, signal?: AbortSignal): Promise<StatsigGateChecks> {
    return this.get(`/gates/${encodeURIComponent(gateId)}/checks`, GateChecksSchema, {}, signal);
  }

  /** `/gates/{id}/rules` returns `data.rules` or `data[].rules` depending on the version; accept both. */
  async getGateRules(gateId: string, signal?: AbortSignal): Promise<StatsigRule[]> {
    const path = `/gates/${encodeURIComponent(gateId)}/rules`;
    const data = envelopeData(await this.raw(path, {}, signal));
    const containers = Array.isArray(data) ? data : [data];
    const rules: unknown[] = [];
    for (const c of containers) {
      if (Array.isArray(c)) rules.push(...c);
      else if (c && typeof c === 'object' && Array.isArray((c as { rules?: unknown }).rules)) rules.push(...(c as { rules: unknown[] }).rules);
    }
    return rules.map((r, i) => this.check(path, RuleSchema, r, i));
  }

  /** GET and return the parsed body, mapping errors to StatSig-specific ones. */
  async raw(path: string, query: Query = {}, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) for (const x of Array.isArray(v) ? v : [v]) params.append(k, x);
    const qs = params.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    try {
      const res = await this.transport.request({
        method: 'GET',
        url,
        headers: { 'STATSIG-API-KEY': this.#apiKey, 'STATSIG-API-VERSION': STATSIG_API_VERSION },
        signal,
      });
      this.capture?.({ path, query, status: res.status, body: res.body });
      return res.body;
    } catch (e) {
      if (e instanceof HttpError) {
        this.capture?.({ path, query, status: e.status, body: e.body });
        if (e.status === 401 || e.status === 403) throw new StatsigAuthError(e.status);
      }
      if (e instanceof UnreachableError) throw new StatsigUnreachableError(e);
      throw e;
    }
  }

  private check<S extends z.ZodType>(endpoint: string, schema: S, data: unknown, index?: number): z.infer<S> {
    const r = schema.safeParse(data);
    if (!r.success) {
      this.issue({
        endpoint,
        ...(index !== undefined ? { index } : {}),
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      // Lenient: hand back the raw data; adapters are defensive about missing fields.
      return data as z.infer<S>;
    }
    return r.data;
  }

  private issue(i: SchemaIssue): void {
    this.onSchemaIssue(i);
  }
}

function envelopeData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data: unknown }).data;
  return body;
}

function hasNextPage(body: unknown, pageLen: number, pageSize: number, onIssue: (i: SchemaIssue['issues']) => void): boolean {
  const pagination = body && typeof body === 'object' ? (body as { pagination?: unknown }).pagination : undefined;
  if (pagination === undefined) {
    // Defensive: no pagination block. A full page might mean more data; a short page means done.
    if (pageLen >= pageSize) onIssue([{ path: 'pagination', message: 'missing on a full page; continuing' }]);
    return pageLen >= pageSize;
  }
  const p = PaginationSchema.safeParse(pagination);
  if (!p.success) {
    onIssue(p.error.issues.map((i) => ({ path: `pagination.${i.path.join('.')}`, message: i.message })));
    return pageLen >= pageSize;
  }
  return p.data.nextPage != null && p.data.nextPage !== '' && pageLen > 0;
}

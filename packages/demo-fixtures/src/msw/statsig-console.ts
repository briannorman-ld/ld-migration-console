import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import { expandIdList, type JsonObject } from '../console/builders.ts';
import type { ConsoleProjectDataset } from '../console/dataset.ts';
import { paginated, single } from '../console/envelopes.ts';

export interface MockStatsigOptions {
  /** Base URL the adapter is pointed at, e.g. `https://demo-statsig.test/web/console/v1`. */
  baseUrl: string;
  /** Read on every request, so "Advance timeline" takes effect immediately. */
  getDataset: () => ConsoleProjectDataset;
  /** Expected STATSIG-API-KEY. Any non-empty key is accepted when omitted. */
  apiKey?: string;
  /**
   * Mimic what a browser sees from the real StatSig: 401/429 responses carry no CORS header, so
   * fetch rejects with a network error instead of exposing the status (PLAN §3.1).
   */
  browserCors?: boolean;
  /** Fraction of requests answered with 429 (deterministic for a given seed). PLAN §19.1. */
  throttleRate?: number;
  seed?: number;
  /** Simulated latency per request, ms. */
  latencyMs?: number;
  onRequest?: (info: { path: string; status: number }) => void;
}

/**
 * A simulated StatSig Console API (PLAN §19.1). It sits *behind* the real adapters: the app talks
 * to it through the normal Console API client, with a dummy key. Response shapes match the
 * OpenAPI spec (validated by test/console-shapes.test.ts).
 */
export function createStatsigConsoleHandlers(opts: MockStatsigOptions): HttpHandler[] {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const rand = mulberry32(opts.seed ?? 42);
  const basePath = new URL(base).pathname;

  type Resolver = (args: { params: Record<string, string>; url: URL; d: ConsoleProjectDataset }) => unknown;

  const route = (path: string, resolver: Resolver) =>
    http.get(`${base}${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      const rel = url.pathname.slice(basePath.length) || '/';
      if (opts.latencyMs) await delay(opts.latencyMs);
      const key = request.headers.get('statsig-api-key');
      if (!key || (opts.apiKey !== undefined && key !== opts.apiKey)) {
        opts.onRequest?.({ path: rel, status: 401 });
        return opts.browserCors ? HttpResponse.error() : HttpResponse.json({ status: 401, message: 'Invalid API key' }, { status: 401 });
      }
      if (opts.throttleRate && rand() < opts.throttleRate) {
        opts.onRequest?.({ path: rel, status: 429 });
        return opts.browserCors ? HttpResponse.error() : HttpResponse.json({ status: 429, message: 'Too many requests' }, { status: 429 });
      }
      const result = resolver({ params: params as Record<string, string>, url, d: opts.getDataset() });
      if (result === NOT_FOUND) {
        opts.onRequest?.({ path: rel, status: 404 });
        return HttpResponse.json({ status: 404, message: 'Not found' }, { status: 404 });
      }
      opts.onRequest?.({ path: rel, status: 200 });
      return HttpResponse.json(result as JsonObject);
    });

  const list = (path: string, items: (d: ConsoleProjectDataset, url: URL) => unknown[]) =>
    route(path, ({ url, d }) => paginated(items(d, url), pageOpts(basePath + path, url)));
  const byId = (path: string, items: (d: ConsoleProjectDataset) => JsonObject[], key = 'id') =>
    route(path, ({ params, d }) => {
      const found = items(d).find((x) => x[key] === params.id);
      return found ? single(found) : NOT_FOUND;
    });

  const visibleGates = (d: ConsoleProjectDataset, url: URL) =>
    url.searchParams.get('includeArchived') === 'true' ? d.gates : d.gates.filter((g) => g.status !== 'Archived');

  return [
    route('/project', ({ d }) => single(d.project)),
    route('/company', ({ d }) => single(d.company)),
    route('/environments', ({ d }) => single({ environments: d.environments })),

    list('/gates', visibleGates),
    byId('/gates/:id', (d) => d.gates),
    route('/gates/:id/rules', ({ params, d, url }) => {
      const g = d.gates.find((x) => x.id === params.id);
      return g ? paginated([{ rules: g.rules }], pageOpts(`${basePath}/gates/${params.id}/rules`, url)) : NOT_FOUND;
    }),
    route('/gates/:id/overrides', ({ params, d }) => {
      if (!d.gates.some((x) => x.id === params.id)) return NOT_FOUND;
      const o = ((d.overrides.gates ?? []) as JsonObject[]).find((x) => x.id === params.id);
      return single(
        o
          ? { passingUserIDs: o.passingUserIDs, failingUserIDs: o.failingUserIDs, passingCustomIDs: o.passingCustomIDs, failingCustomIDs: o.failingCustomIDs, environmentOverrides: o.environmentOverrides }
          : { passingUserIDs: [], failingUserIDs: [], passingCustomIDs: [], failingCustomIDs: [], environmentOverrides: [] },
      );
    }),
    route('/gates/:id/checks', ({ params, d }) => {
      const g = d.gates.find((x) => x.id === params.id);
      return g ? single({ has_production_checks_in_last_7_days: (g.checksPerHour as number | null) ? true : false }) : NOT_FOUND;
    }),

    list('/dynamic_configs', (d) => d.dynamicConfigs),
    byId('/dynamic_configs/:id', (d) => d.dynamicConfigs),
    route('/dynamic_configs/:id/rules', ({ params, d, url }) => {
      const c = d.dynamicConfigs.find((x) => x.id === params.id);
      return c ? paginated([{ rules: c.rules }], pageOpts(`${basePath}/dynamic_configs/${params.id}/rules`, url)) : NOT_FOUND;
    }),

    list('/segments', (d) => d.segments),
    byId('/segments/:id', (d) => d.segments),
    route('/segments/:id/id_list', ({ params, d, url }) => {
      const seed = d.idLists[params.id ?? ''];
      if (!seed) return NOT_FOUND;
      // Paginate the IDs; `data` is the ID-list object (see the spec note in the client).
      const page = paginated(expandIdList(seed), pageOpts(`${basePath}/segments/${params.id}/id_list`, url));
      return { ...page, data: { name: params.id, count: seed.count, ids: page.data } };
    }),

    list('/experiments', (d) => d.experiments),
    byId('/experiments/:id', (d) => d.experiments),
    list('/layers', (d) => d.layers),
    byId('/layers/:id', (d) => d.layers),
    route('/layers/:id/experiments', ({ params, d, url }) =>
      d.layers.some((l) => l.id === params.id)
        ? paginated(d.experiments.filter((e) => e.layerID === params.id), pageOpts(`${basePath}/layers/${params.id}/experiments`, url))
        : NOT_FOUND,
    ),
    list('/holdouts', (d) => d.holdouts),
    byId('/holdouts/:id', (d) => d.holdouts),
    list('/autotunes', (d) => d.autotunes),
    byId('/autotunes/:id', (d) => d.autotunes),

    list('/unit_id_types', (d) => d.unitIdTypes),
    list('/tags', (d) => d.tags),
    list('/target_app', (d) => d.targetApps),
    list('/metrics/list', (d) => d.metrics),
    list('/metrics/metric_source/list', (d) => d.metricSources),
    list('/param_stores', (d) => d.paramStores),
    list('/users', (d) => d.users),
    // The list omits members (TeamDtoWithoutMembersDto); the detail has them (TeamDto).
    list('/users/teams', (d) => d.teams.map(({ members: _m, admins: _a, ...t }) => t)),
    byId('/users/teams/:id', (d) => d.teams),
    list('/prompts', (d) => d.prompts),
    byId('/prompts/:id', (d) => d.prompts),
    list('/alerts', (d) => d.alerts),
    byId('/alerts/:id', (d) => d.alerts),
    route('/settings/reviews', ({ d }) => single(d.reviewSettings)),
    route('/settings/project', ({ d }) => single(d.projectSettings)),
    route('/overrides', ({ d }) => single(d.overrides)),
    route('/exposure_count', ({ url, d }) => {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 25);
      const counts = (items: JsonObject[]) =>
        items.filter((x) => ids.includes(x.id as string)).map((x) => {
          const perHour = typeof x.checksPerHour === 'number' ? x.checksPerHour : 0;
          return { id: x.id as string, pastDay: perHour * 24, past7Days: perHour * 24 * 7 };
        });
      return single({ gates: counts(d.gates), experiments: counts(d.experiments), dynamicConfigs: counts(d.dynamicConfigs) });
    }),
    // Anything else under the base URL: a 404 like the real API, rather than falling through.
    http.get(`${base}/*`, () => HttpResponse.json({ status: 404, message: 'Not found' }, { status: 404 })),
  ];
}

const NOT_FOUND = Symbol('not-found');

function pageOpts(path: string, url: URL) {
  const page = Number(url.searchParams.get('page') ?? '1') || 1;
  const limit = Number(url.searchParams.get('limit') ?? '100') || 100;
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== 'page' && k !== 'limit') query[k] = v;
  });
  return { path, page, limit, query };
}

/** Small deterministic PRNG so injected faults are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import type { LdProjectFixture } from '../ld/acme-legacy.ts';

export interface MockLdApiOptions {
  /** Origin the LD client is pointed at, e.g. `https://demo-ld.test` (paths are under /api/v2). */
  baseUrl: string;
  getProject: () => LdProjectFixture;
  /** Expected `Authorization` header value. Any non-empty token is accepted when omitted. */
  token?: string;
  latencyMs?: number;
  onRequest?: (info: { path: string; status: number }) => void;
}

/**
 * A simulated LaunchDarkly REST API, enough for the LD *source* adapter (PLAN §20.2): project,
 * environments, context kinds, flags (list + full), segments per environment. Read-only; any
 * write method is answered 405 so a bug that wrote to a source would show up in tests.
 */
export function createLdApiHandlers(opts: MockLdApiOptions): HttpHandler[] {
  const base = `${opts.baseUrl.replace(/\/+$/, '')}/api/v2`;
  const basePath = new URL(base).pathname;
  type Resolver = (args: { params: Record<string, string>; url: URL; p: LdProjectFixture }) => unknown;
  const NOT_FOUND = Symbol('404');

  const route = (path: string, resolver: Resolver) =>
    http.get(`${base}${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      const rel = url.pathname.slice(basePath.length) || '/';
      if (opts.latencyMs) await delay(opts.latencyMs);
      const auth = request.headers.get('authorization');
      if (!auth || (opts.token !== undefined && auth !== opts.token)) {
        opts.onRequest?.({ path: rel, status: 401 });
        return HttpResponse.json({ code: 'unauthorized', message: 'Invalid access token' }, { status: 401 });
      }
      const p = opts.getProject();
      const result = resolver({ params: params as Record<string, string>, url, p });
      if (result === NOT_FOUND) {
        opts.onRequest?.({ path: rel, status: 404 });
        return HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
      }
      opts.onRequest?.({ path: rel, status: 200 });
      return HttpResponse.json(result as Record<string, unknown>);
    });

  const projectKey = (p: LdProjectFixture) => String(p.project.key);
  const inProject = (params: Record<string, string>, p: LdProjectFixture) => params.projectKey === projectKey(p);
  const page = <T,>(items: T[], url: URL) => {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 20), 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
    return { items: items.slice(offset, offset + limit), totalCount: items.length, _links: {} };
  };
  const summary = (f: Record<string, unknown>) => {
    const { environments, ...rest } = f;
    const envs = Object.fromEntries(Object.entries((environments ?? {}) as Record<string, Record<string, unknown>>).map(([k, c]) => [k, { on: c.on, _environmentName: c._environmentName, lastModified: c.lastModified, version: c.version, _summary: c._summary }]));
    return { ...rest, environments: envs };
  };

  const writes = ['post', 'patch', 'put', 'delete'] as const;
  return [
    route('/caller-identity', ({ p }) => ({ accountId: 'acct-legacy', tokenKind: 'auth', tokenName: 'demo read-only', projectKey: projectKey(p), authKind: 'token', serviceToken: false })),
    route('/projects', ({ p, url }) => page([p.project], url)),
    route('/projects/:projectKey', ({ params, p }) => (inProject(params, p) ? p.project : NOT_FOUND)),
    route('/projects/:projectKey/environments', ({ params, p, url }) => (inProject(params, p) ? page(p.environments, url) : NOT_FOUND)),
    route('/projects/:projectKey/environments/:envKey', ({ params, p }) => (inProject(params, p) ? (p.environments.find((e) => e.key === params.envKey) ?? NOT_FOUND) : NOT_FOUND)),
    route('/projects/:projectKey/context-kinds', ({ params, p }) => (inProject(params, p) ? { items: p.contextKinds } : NOT_FOUND)),
    route('/flags/:projectKey', ({ params, p, url }) => {
      if (!inProject(params, p)) return NOT_FOUND;
      const archived = (url.searchParams.get('filter') ?? '').includes('state:archived');
      const items = p.flags.filter((f) => !!f.archived === archived).map((f) => (url.searchParams.get('summary') === 'false' || url.searchParams.get('summary') === '0' ? f : summary(f)));
      return page(items, url);
    }),
    route('/flags/:projectKey/:key', ({ params, p }) => (inProject(params, p) ? (p.flags.find((f) => f.key === params.key) ?? NOT_FOUND) : NOT_FOUND)),
    route('/segments/:projectKey/:envKey', ({ params, p, url }) => (inProject(params, p) ? page(p.segments[params.envKey!] ?? [], url) : NOT_FOUND)),
    route('/segments/:projectKey/:envKey/:key', ({ params, p }) => (inProject(params, p) ? ((p.segments[params.envKey!] ?? []).find((s) => s.key === params.key) ?? NOT_FOUND) : NOT_FOUND)),
    ...writes.map((m) => http[m](`${base}/*`, () => HttpResponse.json({ code: 'method_not_allowed', message: 'The demo LD source is read-only.' }, { status: 405 }))),
  ];
}

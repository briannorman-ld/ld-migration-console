import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import type { JsonObject } from '../console/builders.ts';
import type { PostHogProjectFixture } from '../posthog/acme-hog.ts';

export interface MockPostHogApiOptions {
  /** Origin the PostHog client is pointed at, e.g. `https://demo-posthog.test` (paths are under /api). */
  baseUrl: string;
  getProject: () => PostHogProjectFixture;
  /** Expected personal API key (`Authorization: Bearer <key>`). Any non-empty bearer is accepted when omitted. */
  key?: string;
  latencyMs?: number;
  onRequest?: (info: { path: string; status: number }) => void;
}

/**
 * A simulated PostHog private API, enough for the PostHog *source* adapter (PLAN §22.2): current
 * user, organization projects and members, project, feature flags, cohorts and their members,
 * persons, group types, property definitions, scheduled changes, early-access features and
 * experiments. Paths and envelopes are PostHog's (`{ count, next, previous, results }` with `limit`
 * + `offset`; `next` is a full URL). Read-only; any write method is answered 405 so a bug that
 * wrote to a source would show up in tests.
 */
export function createPostHogApiHandlers(opts: MockPostHogApiOptions): HttpHandler[] {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  type Resolver = (args: { params: Record<string, string>; url: URL; p: PostHogProjectFixture }) => unknown;
  const NOT_FOUND = Symbol('404');

  const error = (status: number, type: string, code: string, detail: string) => HttpResponse.json({ type, code, detail, attr: null }, { status });

  const route = (path: string, resolver: Resolver) =>
    http.get(`${base}${path}`, async ({ request, params }) => {
      const url = new URL(request.url);
      const rel = url.pathname.slice(basePath.length) || '/';
      if (opts.latencyMs) await delay(opts.latencyMs);
      const auth = request.headers.get('authorization');
      const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!bearer || (opts.key !== undefined && bearer !== opts.key)) {
        opts.onRequest?.({ path: rel, status: 401 });
        return error(401, 'authentication_error', 'not_authenticated', 'Invalid personal API key.');
      }
      const p = opts.getProject();
      const result = resolver({ params: params as Record<string, string>, url, p });
      if (result === NOT_FOUND) {
        opts.onRequest?.({ path: rel, status: 404 });
        return error(404, 'invalid_request', 'not_found', 'Not found.');
      }
      opts.onRequest?.({ path: rel, status: 200 });
      return HttpResponse.json(result as Record<string, unknown> | unknown[]);
    });

  const projectId = (p: PostHogProjectFixture) => String(p.project.id);
  const inProject = (params: Record<string, string>, p: PostHogProjectFixture) => params.projectId === projectId(p);
  const inOrg = (params: Record<string, string>, p: PostHogProjectFixture) => params.orgId === String(p.organization.id);

  /** PostHog's list envelope. `next`/`previous` are full URLs carrying the neighbouring offset, or null. */
  const page = <T,>(items: T[], url: URL, withCount = true) => {
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 100), 1000));
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
    const at = (o: number) => {
      const u = new URL(url);
      u.searchParams.set('limit', String(limit));
      u.searchParams.set('offset', String(o));
      return u.toString();
    };
    return {
      ...(withCount ? { count: items.length } : {}),
      next: offset + limit < items.length ? at(offset + limit) : null,
      previous: offset > 0 ? at(Math.max(0, offset - limit)) : null,
      results: items.slice(offset, offset + limit),
    };
  };
  /** A `true`/`false` query flag, or undefined when absent. */
  const boolParam = (url: URL, name: string): boolean | undefined => {
    const v = url.searchParams.get(name);
    return v === null ? undefined : v === 'true' || v === '1';
  };
  const byId = (items: JsonObject[], id: string) => items.find((x) => String(x.id) === id) ?? NOT_FOUND;
  const membersOf = (p: PostHogProjectFixture, cohortId: string): JsonObject[] => {
    const ids = p.cohortMembers[cohortId] ?? [];
    return ids.flatMap((id) => p.persons.filter((x) => String(x.id) === id));
  };
  /** What `/cohorts/{id}/persons/` returns per member: a person *actor*, without distinct ids. */
  const actor = (x: JsonObject): JsonObject => ({ id: String(x.uuid), uuid: x.uuid ?? null, type: 'person', name: x.name ?? null, properties: x.properties ?? {}, created_at: x.created_at ?? null });
  const liveCohorts = (p: PostHogProjectFixture) => p.cohorts.filter((c) => c.deleted !== true);

  const writes = ['post', 'patch', 'put', 'delete'] as const;
  return [
    route('/api/users/@me/', ({ p }) => p.user),
    route('/api/organizations/:orgId/projects/', ({ params, p, url }) => (inOrg(params, p) ? page([p.project], url) : NOT_FOUND)),
    route('/api/organizations/:orgId/members/', ({ params, p, url }) => (inOrg(params, p) ? page(p.members, url) : NOT_FOUND)),
    route('/api/projects/:projectId/', ({ params, p }) => (inProject(params, p) ? p.project : NOT_FOUND)),
    route('/api/projects/:projectId/feature_flags/', ({ params, p, url }) => {
      if (!inProject(params, p)) return NOT_FOUND;
      const deleted = boolParam(url, 'deleted') ?? false;
      const archived = boolParam(url, 'archived');
      const active = boolParam(url, 'active');
      const items = p.flags.filter((f) => (f.deleted === true) === deleted && (archived === undefined || (f.archived === true) === archived) && (active === undefined || (f.active === true) === active));
      return page(items, url);
    }),
    route('/api/projects/:projectId/feature_flags/:id/', ({ params, p }) => (inProject(params, p) ? byId(p.flags, params.id!) : NOT_FOUND)),
    route('/api/projects/:projectId/cohorts/', ({ params, p, url }) => (inProject(params, p) ? page(liveCohorts(p), url) : NOT_FOUND)),
    route('/api/projects/:projectId/cohorts/:id/', ({ params, p }) => (inProject(params, p) ? byId(liveCohorts(p), params.id!) : NOT_FOUND)),
    route('/api/projects/:projectId/cohorts/:id/persons/', ({ params, p, url }) => {
      if (!inProject(params, p) || byId(liveCohorts(p), params.id!) === NOT_FOUND) return NOT_FOUND;
      // CohortPersonsResponse carries no `count`.
      return page(membersOf(p, params.id!).map(actor), url, false);
    }),
    route('/api/projects/:projectId/persons/', ({ params, p, url }) => {
      if (!inProject(params, p)) return NOT_FOUND;
      const cohort = url.searchParams.get('cohort');
      return page(cohort === null ? p.persons : membersOf(p, cohort), url);
    }),
    route('/api/projects/:projectId/persons/:id/', ({ params, p }) => (inProject(params, p) ? byId(p.persons, params.id!) : NOT_FOUND)),
    route('/api/projects/:projectId/groups_types/', ({ params, p }) => (inProject(params, p) ? p.groupTypes : NOT_FOUND)),
    route('/api/projects/:projectId/property_definitions/', ({ params, p, url }) => {
      if (!inProject(params, p)) return NOT_FOUND;
      const type = url.searchParams.get('type');
      const gti = url.searchParams.get('group_type_index');
      const items = p.propertyDefinitions.filter((d) => (type === null || d.type === type) && (gti === null || String(d.group_type_index) === gti));
      return page(items, url);
    }),
    route('/api/projects/:projectId/scheduled_changes/', ({ params, p, url }) => {
      if (!inProject(params, p)) return NOT_FOUND;
      const model = url.searchParams.get('model_name');
      return page(p.scheduledChanges.filter((c) => model === null || c.model_name === model), url);
    }),
    route('/api/projects/:projectId/early_access_feature/', ({ params, p, url }) => (inProject(params, p) ? page(p.earlyAccessFeatures, url) : NOT_FOUND)),
    route('/api/projects/:projectId/experiments/', ({ params, p, url }) => (inProject(params, p) ? page(p.experiments, url) : NOT_FOUND)),
    ...writes.map((m) => http[m](`${base}/api/*`, () => error(405, 'invalid_request', 'method_not_allowed', 'The demo PostHog source is read-only.'))),
  ];
}

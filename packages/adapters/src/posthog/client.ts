/**
 * PostHog private-API client, read side only (PLAN §22.2). Routes are those of
 * reference/posthog/openapi.yaml.gz; auth is `Authorization: Bearer <personal or project secret key>`.
 * Reads are lenient-validated (schemas.ts); nothing here ever writes, and the demo mock answers
 * every write method with 405 so a bug that tried would show up in tests.
 *
 * Browser facts (reference/README.md, checked 2026-11-12): `us.posthog.com` answers CORS with
 * `*` on preflight and on 401, so the console talks to PostHog Cloud directly; no rate-limit
 * header is exposed to JS, so the transport's AIMD limiter adapts to 429s (documented limits:
 * 480/min and 4800/hour per key).
 */
import { HttpError, Transport, type TransportOptions } from '@sslm/http';
import type { z } from 'zod';
import {
  pagedSchema,
  PhCohortSchema,
  PhEarlyAccessFeatureSchema,
  PhExperimentSchema,
  PhFeatureFlagSchema,
  PhGroupTypeSchema,
  PhMemberSchema,
  PhMeSchema,
  PhPersonActorSchema,
  PhPersonSchema,
  PhProjectSchema,
  PhPropertyDefinitionSchema,
  PhScheduledChangeSchema,
  type PhCohort,
  type PhEarlyAccessFeature,
  type PhExperiment,
  type PhFeatureFlag,
  type PhGroupType,
  type PhMe,
  type PhMember,
  type PhPerson,
  type PhPersonActor,
  type PhProject,
  type PhPropertyDefinition,
  type PhScheduledChange,
} from './schemas.ts';

export type PostHogRegionId = 'us' | 'eu';

export interface PostHogRegion {
  id: PostHogRegionId;
  label: string;
  /** Origin of the private API (`/api/...`). Must match CSP connect-src. */
  origin: string;
}

export const POSTHOG_REGIONS: Record<PostHogRegionId, PostHogRegion> = {
  us: { id: 'us', label: 'PostHog Cloud US', origin: 'https://us.posthog.com' },
  eu: { id: 'eu', label: 'PostHog Cloud EU', origin: 'https://eu.posthog.com' },
};

/**
 * Default page on PostHog's list routes: the schema documents no maximum for most of them
 * (`/cohorts/{id}/persons/` says "defaults to 100"), so 100 is what we send.
 */
export const POSTHOG_PAGE = 100;
/** `/persons/` is the one list route whose `limit` has a stated maximum (openapi.yaml.gz: 1000). */
export const POSTHOG_PERSONS_PAGE = 1000;

/** One page of a list route: PostHog's `{ count, next, previous, results }` envelope, validated. */
export interface PostHogPage<T> {
  /** Absent on `/cohorts/{id}/persons/` (CohortPersonsResponse has no count). */
  count?: number;
  next?: string | null;
  results: T[];
}

export interface PostHogSchemaIssue {
  path: string;
  issues: { path: string; message: string }[];
}

export interface PostHogClientOptions {
  region: PostHogRegionId | { origin: string };
  /** Personal API key (`phx_…`) or project secret key. Held in memory by this instance only; never logged or persisted. */
  key: string;
  transport?: Transport | TransportOptions;
  onSchemaIssue?: (i: PostHogSchemaIssue) => void;
}

export class PostHogAuthError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(status === 401 ? 'PostHog rejected the key (401).' : `PostHog denied access to ${path} (${status}): the key lacks a read scope, or is limited to other projects.`);
    this.name = 'PostHogAuthError';
  }
}

/** A read came back in a shape the schema does not accept and nothing could be salvaged. */
export class PostHogSchemaError extends Error {
  constructor(
    readonly path: string,
    readonly issues: PostHogSchemaIssue['issues'],
  ) {
    super(`PostHog returned an unexpected shape for ${path}: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`);
    this.name = 'PostHogSchemaError';
  }
}

export interface PostHogReadableProject {
  /** `team_id`, as a string (the source descriptor stores it that way). */
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
}

type Query = Record<string, string>;

export class PostHogClient {
  readonly origin: string;
  readonly transport: Transport;
  readonly #key: string;
  private readonly onSchemaIssue: (i: PostHogSchemaIssue) => void;

  constructor(opts: PostHogClientOptions) {
    this.origin = (typeof opts.region === 'string' ? POSTHOG_REGIONS[opts.region].origin : opts.region.origin).replace(/\/+$/, '');
    this.#key = opts.key;
    // PostHog's 429s are readable (CORS `*` on errors) but carry no exposed Retry-After, so the
    // AIMD limiter does the pacing; the documented budget is 480 requests a minute per key.
    this.transport =
      opts.transport instanceof Transport
        ? opts.transport
        : new Transport({ budgets: [{ limit: 400, windowMs: 60_000 }], ...opts.transport, retry: { retryOpaqueFailures: true, maxOpaqueAttempts: 3, maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 30_000, ...opts.transport?.retry } });
    this.onSchemaIssue = opts.onSchemaIssue ?? (() => undefined);
  }

  /** `GET /api/users/@me/`: validates the key and names the organizations it belongs to. */
  me(signal?: AbortSignal): Promise<PhMe> {
    return this.get('/api/users/@me/', PhMeSchema, { signal });
  }

  listOrganizationProjects(organizationId: string, signal?: AbortSignal): Promise<PhProject[]> {
    return this.allPages(`/api/organizations/${encodeURIComponent(organizationId)}/projects/`, PhProjectSchema, {}, signal);
  }

  /** Every project the key can read, across the user's organizations, sorted by name. */
  async listReadableProjects(signal?: AbortSignal): Promise<PostHogReadableProject[]> {
    const me = await this.me(signal);
    const orgs = me.organizations?.length ? me.organizations : me.organization ? [me.organization] : [];
    const out: PostHogReadableProject[] = [];
    for (const org of orgs) {
      let projects: PhProject[];
      try {
        projects = await this.listOrganizationProjects(org.id, signal);
      } catch (e) {
        // A key limited to some projects may not list another organization's: skip it.
        if (e instanceof PostHogAuthError) continue;
        throw e;
      }
      for (const p of projects) out.push({ id: String(p.id), name: p.name, organizationId: org.id, organizationName: org.name ?? org.slug ?? org.id });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.organizationName.localeCompare(b.organizationName));
  }

  getProject(projectId: string, signal?: AbortSignal): Promise<PhProject> {
    return this.get(this.p(projectId, ''), PhProjectSchema, { signal });
  }

  /**
   * Every flag of the project, archived ones included; deleted ones are never requested (the
   * list hides them by default). The list route carries the full `filters`, so no per-flag read.
   */
  listFeatureFlags(projectId: string, opts: { signal?: AbortSignal; onPage?: (read: number, total?: number) => void } = {}): Promise<PhFeatureFlag[]> {
    return this.allPages(this.p(projectId, 'feature_flags/'), PhFeatureFlagSchema, {}, opts.signal, opts.onPage);
  }

  listCohorts(projectId: string, signal?: AbortSignal): Promise<PhCohort[]> {
    return this.allPages(this.p(projectId, 'cohorts/'), PhCohortSchema, {}, signal);
  }

  /** Member *actors* of a cohort (ids, no distinct ids), 100 a page (the route states no maximum). */
  listCohortPersons(projectId: string, cohortId: string | number, opts: { signal?: AbortSignal; onPage?: (read: number, total?: number) => void } = {}): Promise<PhPersonActor[]> {
    return this.allPages(this.p(projectId, `cohorts/${encodeURIComponent(String(cohortId))}/persons/`), PhPersonActorSchema, {}, opts.signal, opts.onPage);
  }

  /**
   * Full persons (with `distinct_ids`) filtered to a cohort: the filter the PostHog UI uses on the
   * persons list. Not in the published schema, so callers fall back to `getPerson` when it is
   * ignored (PLAN §22.6 P0). Pages of 1,000, the route's maximum.
   */
  listPersonsInCohort(projectId: string, cohortId: string | number, opts: { signal?: AbortSignal; onPage?: (read: number, total?: number) => void } = {}): Promise<PhPerson[]> {
    return this.allPages(this.p(projectId, 'persons/'), PhPersonSchema, { cohort: String(cohortId) }, opts.signal, opts.onPage, POSTHOG_PERSONS_PAGE);
  }

  /**
   * One page of `/persons/`, optionally filtered to a cohort, with its envelope: read.ts pages the
   * members of a large cohort itself so it can stop at a cap, report progress and notice a server
   * that ignored the `cohort` filter (the envelope `count` is the list's total).
   */
  listPersonsPage(projectId: string, opts: { cohortId?: string | number; limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<PostHogPage<PhPerson>> {
    const query: Query = {};
    if (opts.cohortId !== undefined) query.cohort = String(opts.cohortId);
    query.limit = String(Math.min(opts.limit ?? POSTHOG_PERSONS_PAGE, POSTHOG_PERSONS_PAGE));
    query.offset = String(opts.offset ?? 0);
    return this.get(this.p(projectId, 'persons/'), pagedSchema(PhPersonSchema), { query, signal: opts.signal }).then((page) => ({ count: page.count ?? undefined, next: page.next, results: page.results }));
  }

  async getPerson(projectId: string, personId: string, signal?: AbortSignal): Promise<PhPerson | null> {
    try {
      return await this.get(this.p(projectId, `persons/${encodeURIComponent(personId)}/`), PhPersonSchema, { signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** `GET /groups_types/` returns a bare array. */
  async listGroupTypes(projectId: string, signal?: AbortSignal): Promise<PhGroupType[]> {
    const path = this.p(projectId, 'groups_types/');
    const body = await this.raw(path, signal);
    const list = Array.isArray(body) ? body : ((body as { results?: unknown })?.results ?? []);
    const out: PhGroupType[] = [];
    for (const [i, item] of (Array.isArray(list) ? list : []).entries()) {
      const parsed = PhGroupTypeSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
      else this.onSchemaIssue({ path, issues: parsed.error.issues.map((x) => ({ path: `[${i}].${x.path.join('.')}`, message: x.message })) });
    }
    return out;
  }

  listPropertyDefinitions(projectId: string, opts: { type: 'person' | 'group'; groupTypeIndex?: number; signal?: AbortSignal }): Promise<PhPropertyDefinition[]> {
    const query: Query = { type: opts.type };
    if (opts.groupTypeIndex !== undefined) query.group_type_index = String(opts.groupTypeIndex);
    return this.allPages(this.p(projectId, 'property_definitions/'), PhPropertyDefinitionSchema, query, opts.signal);
  }

  listScheduledChanges(projectId: string, signal?: AbortSignal): Promise<PhScheduledChange[]> {
    return this.allPages(this.p(projectId, 'scheduled_changes/'), PhScheduledChangeSchema, { model_name: 'FeatureFlag' }, signal);
  }

  listEarlyAccessFeatures(projectId: string, signal?: AbortSignal): Promise<PhEarlyAccessFeature[]> {
    return this.allPages(this.p(projectId, 'early_access_feature/'), PhEarlyAccessFeatureSchema, {}, signal);
  }

  listExperiments(projectId: string, signal?: AbortSignal): Promise<PhExperiment[]> {
    return this.allPages(this.p(projectId, 'experiments/'), PhExperimentSchema, {}, signal);
  }

  listMembers(organizationId: string, signal?: AbortSignal): Promise<PhMember[]> {
    return this.allPages(`/api/organizations/${encodeURIComponent(organizationId)}/members/`, PhMemberSchema, {}, signal);
  }

  // -------------------------------------------------------------------------------------------

  private p(projectId: string, rest: string): string {
    return `/api/projects/${encodeURIComponent(projectId)}/${rest}`;
  }

  /** Walk an offset-paged list by following `next` until it is null or a page comes back short. */
  private async allPages<S extends z.ZodType>(path: string, item: S, query: Query, signal?: AbortSignal, onPage?: (read: number, total?: number) => void, pageSize = POSTHOG_PAGE): Promise<z.output<S>[]> {
    const schema = pagedSchema(item);
    const out: z.output<S>[] = [];
    let offset = 0;
    // A hard stop well above any real project (2,000 active flags is PostHog's own limit).
    for (let guard = 0; guard < 1000; guard++) {
      const page = await this.get(path, schema, { query: { ...query, limit: String(pageSize), offset: String(offset) }, signal });
      out.push(...(page.results as z.output<S>[]));
      onPage?.(out.length, page.count ?? undefined);
      if (!page.next || page.results.length === 0 || page.results.length < pageSize) break;
      offset += page.results.length;
    }
    return out;
  }

  async get<S extends z.ZodType>(path: string, schema: S, opts: { query?: Query; signal?: AbortSignal } = {}): Promise<z.output<S>> {
    const body = await this.raw(path, opts.signal, opts.query);
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    this.onSchemaIssue({ path, issues });
    // Salvage a list whose envelope is fine but holds a few odd items: keep the object items.
    if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as { results?: unknown }).results)) {
      const results = (body as { results: unknown[] }).results.filter((r) => typeof r === 'object' && r !== null && !Array.isArray(r));
      const again = schema.safeParse({ ...(body as object), results });
      if (again.success) return again.data;
    }
    throw new PostHogSchemaError(path, issues);
  }

  private async raw(path: string, signal?: AbortSignal, query?: Query): Promise<unknown> {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
    try {
      const res = await this.transport.request({ method: 'GET', url: `${this.origin}${path}${qs}`, headers: { Authorization: `Bearer ${this.#key}` }, signal });
      return res.body;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new PostHogAuthError(e.status, path);
      throw e;
    }
  }
}

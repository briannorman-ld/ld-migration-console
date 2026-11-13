import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { ACME_HOG_ORG_ID, ACME_HOG_PROJECT_ID, acmeHogLocalEvaluationPayload, acmeHogProject, createPostHogApiHandlers, type JsonObject } from '../src/index.ts';

const ORIGIN = 'https://demo-posthog.test';
const KEY = 'phx_test-key';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface Page {
  count?: number;
  next: string | null;
  previous: string | null;
  results: JsonObject[];
}

function serve() {
  const requests: string[] = [];
  server.use(...createPostHogApiHandlers({ baseUrl: ORIGIN, getProject: acmeHogProject, key: KEY, onRequest: (r) => requests.push(`${r.status} ${r.path}`) }));
  return requests;
}
const get = (path: string, key: string | null = KEY, init: RequestInit = {}) =>
  fetch(`${ORIGIN}${path}`, { ...init, headers: key === null ? {} : { authorization: `Bearer ${key}` } });
const json = async <T,>(res: Response) => (await res.json()) as T;
const P = `/api/projects/${ACME_HOG_PROJECT_ID}`;

describe('Acme Hog PostHog fixture', () => {
  it('is deterministic and names every construct once', () => {
    const a = acmeHogProject();
    expect(a).toEqual(acmeHogProject());
    expect(a.flags).toHaveLength(24);
    expect(new Set(a.flags.map((f) => f.key)).size).toBe(24);
    expect(new Set(a.flags.map((f) => f.id)).size).toBe(24);
    expect(a.cohorts.map((c) => c.id)).toEqual([301, 302, 303, 304, 305, 306]);
    // PostHog's `name` is the description; `key` is the display key.
    expect(a.flags.find((f) => f.id === 1001)).toMatchObject({ key: 'hog-kill-switch', name: 'Turns the storefront off entirely.' });
    expect(a.flags.find((f) => f.id === 1013)?.key).toBe('survey-targeting-checkout-nps');
  });

  it('builds the local-evaluation payload from the same objects', () => {
    const payload = acmeHogLocalEvaluationPayload();
    const flags = payload.flags as JsonObject[];
    // Active, not deleted, not archived: 24 minus archived 1014, disabled 1015 and 1019, deleted 1023.
    expect(flags.map((f) => f.id)).not.toContain(1014);
    expect(flags.map((f) => f.id)).not.toContain(1015);
    expect(flags.map((f) => f.id)).not.toContain(1019);
    expect(flags.map((f) => f.id)).not.toContain(1023);
    expect(flags).toHaveLength(20);
    expect(payload.group_type_mapping).toEqual({ '0': 'company', '1': 'workspace' });
    // Property-defined (non-static, non-deleted) cohorts inlined as their PropertyGroup.
    expect(Object.keys(payload.cohorts as JsonObject).sort()).toEqual(['302', '303', '304', '305']);
    expect((payload.cohorts as Record<string, JsonObject>)['302']).toMatchObject({ type: 'AND' });
  });
});

describe('PostHog API mock (PLAN §22.2)', () => {
  it('enforces the bearer key', async () => {
    const requests = serve();
    expect((await get(`${P}/feature_flags/`, null)).status).toBe(401);
    const wrong = await get(`${P}/feature_flags/`, 'phx_wrong');
    expect(wrong.status).toBe(401);
    expect(await json<JsonObject>(wrong)).toMatchObject({ type: 'authentication_error', code: 'not_authenticated' });
    expect((await get('/api/users/@me/')).status).toBe(200);
    expect(requests).toEqual([`401 /api/projects/${ACME_HOG_PROJECT_ID}/feature_flags/`, `401 /api/projects/${ACME_HOG_PROJECT_ID}/feature_flags/`, '200 /api/users/@me/']);
  });

  it('pages with limit and offset, and `next` is a full URL', async () => {
    serve();
    const first = await json<Page>(await get(`${P}/feature_flags/?limit=5`));
    expect(first.count).toBe(23);
    expect(first.results).toHaveLength(5);
    expect(first.previous).toBeNull();
    expect(first.next).toBe(`${ORIGIN}${P}/feature_flags/?limit=5&offset=5`);
    const ids: number[] = first.results.map((f) => f.id as number);
    let next = first.next;
    let pages = 1;
    while (next) {
      const page = await json<Page>(await fetch(next, { headers: { authorization: `Bearer ${KEY}` } }));
      ids.push(...page.results.map((f) => f.id as number));
      next = page.next;
      pages++;
    }
    expect(pages).toBe(5);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    // Default limit is 100: everything in one page.
    const all = await json<Page>(await get(`${P}/feature_flags/`));
    expect(all.results).toHaveLength(23);
    expect(all.next).toBeNull();
  });

  it('hides deleted flags unless deleted=true, and filters archived and active', async () => {
    serve();
    const listed = (await json<Page>(await get(`${P}/feature_flags/`))).results.map((f) => f.id);
    expect(listed).not.toContain(1023);
    expect(listed).toContain(1014); // archived flags are listed by default
    const deleted = (await json<Page>(await get(`${P}/feature_flags/?deleted=true`))).results.map((f) => f.id);
    expect(deleted).toEqual([1023]);
    const archived = (await json<Page>(await get(`${P}/feature_flags/?archived=true`))).results.map((f) => f.id);
    expect(archived).toEqual([1014]);
    const live = (await json<Page>(await get(`${P}/feature_flags/?archived=false&active=true`))).results.map((f) => f.id);
    expect(live).toHaveLength(20);
    const off = (await json<Page>(await get(`${P}/feature_flags/?active=false`))).results.map((f) => f.id);
    expect(off).toEqual([1014, 1015, 1019]);
    // By id, with the full filters document.
    const one = await json<JsonObject>(await get(`${P}/feature_flags/1003/`));
    expect((one.filters as JsonObject).multivariate).toBeDefined();
    expect((await get(`${P}/feature_flags/999999/`)).status).toBe(404);
  });

  it('serves cohorts, their members as actors, and persons filtered by cohort with distinct ids', async () => {
    serve();
    const cohorts = (await json<Page>(await get(`${P}/cohorts/`))).results.map((c) => c.id);
    expect(cohorts).toEqual([301, 302, 303, 304, 305]); // 306 is deleted
    const actors = await json<Page>(await get(`${P}/cohorts/301/persons/`));
    expect(actors.count).toBeUndefined();
    expect(actors.results).toHaveLength(3);
    expect(actors.results[0]).toMatchObject({ type: 'person' });
    expect(actors.results[0]!.distinct_ids).toBeUndefined();
    const members = await json<Page>(await get(`${P}/persons/?cohort=301`));
    expect(members.count).toBe(3);
    expect(members.results.map((m) => m.distinct_ids)).toEqual([['u-1'], ['u-2', 'u-2-legacy'], ['u-3']]);
    expect(members.results.map((m) => m.uuid)).toEqual(actors.results.map((a) => a.uuid));
    expect((await json<Page>(await get(`${P}/persons/`))).count).toBe(5);
    expect((await json<Page>(await get(`${P}/persons/?cohort=302`))).results).toEqual([]);
    expect((await json<JsonObject>(await get(`${P}/persons/502/`))).distinct_ids).toEqual(['u-2', 'u-2-legacy']);
  });

  it('serves the rest of the reads with PostHog shapes', async () => {
    serve();
    const me = await json<JsonObject>(await get('/api/users/@me/'));
    expect(me.email).toBe('alice.chen@acmeretail.example');
    expect((me.organizations as JsonObject[])[0]?.id).toBe(ACME_HOG_ORG_ID);
    const projects = await json<Page>(await get(`/api/organizations/${ACME_HOG_ORG_ID}/projects/`));
    expect(projects.results.map((p) => p.id)).toEqual([4242]);
    const members = await json<Page>(await get(`/api/organizations/${ACME_HOG_ORG_ID}/members/`));
    expect(members.results.map((m) => [(m.user as JsonObject).email, m.level])).toEqual([['alice.chen@acmeretail.example', 15], ['bob.okafor@acmeretail.example', 8]]);
    expect((await json<JsonObject>(await get(`${P}/`))).name).toBe('Acme Hog');
    // groups_types is a bare array.
    const groupTypes = await json<JsonObject[]>(await get(`${P}/groups_types/`));
    expect(Array.isArray(groupTypes)).toBe(true);
    expect(groupTypes.map((g) => g.group_type)).toEqual(['company', 'workspace']);
    expect((await json<Page>(await get(`${P}/property_definitions/?type=person`))).results).toHaveLength(10);
    expect((await json<Page>(await get(`${P}/property_definitions/?type=group&group_type_index=0`))).results.map((d) => d.name)).toEqual(['tier', 'mrr']);
    expect((await json<Page>(await get(`${P}/scheduled_changes/?model_name=FeatureFlag`))).results.map((c) => c.record_id)).toEqual(['1019', '1007']);
    expect((await json<Page>(await get(`${P}/scheduled_changes/?model_name=Cohort`))).results).toEqual([]);
    expect((await json<Page>(await get(`${P}/early_access_feature/`))).results).toHaveLength(1);
    expect((await json<Page>(await get(`${P}/experiments/`))).results[0]?.feature_flag_key).toBe('hog-holdout-experiment');
  });

  it('answers a wrong project or organization with 404 and every write with 405', async () => {
    serve();
    const missing = await get('/api/projects/1/feature_flags/');
    expect(missing.status).toBe(404);
    expect(await json<JsonObject>(missing)).toMatchObject({ type: 'invalid_request', code: 'not_found' });
    expect((await get('/api/organizations/not-this-org/projects/')).status).toBe(404);
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await fetch(`${ORIGIN}${P}/feature_flags/1001/`, { method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: method === 'DELETE' ? null : '{}' });
      expect(res.status, method).toBe(405);
    }
  });
});

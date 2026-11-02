import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LdClient, probeCapabilities, stripSdkKeys } from '../src/index.ts';

const ORIGIN = 'https://app.launchdarkly.com/api/v2';
const TOKEN = 'api-00000000-test-token-never-logged';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const env = (key: string, extra: Record<string, unknown> = {}) => ({
  _id: `id-${key}`, key, name: key, apiKey: `sdk-SECRET-${key}`, mobileKey: `mob-SECRET-${key}`, color: 'fff', critical: key === 'production', _links: {}, ...extra,
});
const seenHeaders: Record<string, string | null> = {};

function mockLd(opts: { serviceToken?: boolean; teams?: number; tokenLookup?: number; deniedContextKinds?: boolean } = {}) {
  const auth = (req: Request) => req.headers.get('authorization') === TOKEN;
  const j = (req: Request, body: unknown, status = 200) => (auth(req) ? HttpResponse.json(body as object, { status }) : HttpResponse.json({ code: 'unauthorized' }, { status: 401 }));
  server.use(
    http.get(`${ORIGIN}/caller-identity`, ({ request }) => j(request, { accountId: 'acct', tokenId: 'tok1', tokenKind: 'auth', authKind: 'token', memberId: 'm1', serviceToken: opts.serviceToken ?? false, tokenName: 'migrator' })),
    http.get(`${ORIGIN}/tokens/tok1`, ({ request }) => (opts.tokenLookup ? j(request, { message: 'no' }, opts.tokenLookup) : j(request, { _id: 'tok1', role: 'writer', customRoleIds: [], token: 'abcd', ownerId: 'o', memberId: 'm1', creationDate: 1, lastModified: 1, _links: {} }))),
    http.get(`${ORIGIN}/projects/acme`, ({ request }) => j(request, { _id: 'p', key: 'acme', name: 'Acme', tags: [], includeInSnippetByDefault: false, _links: {}, _access: { denied: opts.deniedContextKinds ? [{ action: 'createContextKind', reason: { effect: 'deny' } }] : [], allowed: [] } })),
    http.get(`${ORIGIN}/projects/acme/environments`, ({ request }) => j(request, { items: [env('staging'), env('production')], totalCount: 2, _links: {} })),
    http.get(`${ORIGIN}/projects/acme/environments/:e`, ({ request, params }) =>
      j(request, env(String(params.e), params.e === 'production' ? { approvalSettings: { required: true, minNumApprovals: 1 }, resourceApprovalSettings: { segment: { required: true } } } : {})),
    ),
    http.get(`${ORIGIN}/projects/acme/context-kinds`, ({ request }) => j(request, { items: [{ key: 'user', name: 'User' }], _links: {} })),
    http.get(`${ORIGIN}/projects/acme/layers`, ({ request }) => j(request, { items: [], totalCount: 0, _links: {} })),
    http.get(`${ORIGIN}/metrics/acme`, ({ request }) => j(request, { items: [], _links: {} })),
    http.get(`${ORIGIN}/projects/acme/metric-groups`, ({ request }) => {
      seenHeaders.metricGroups = request.headers.get('ld-api-version');
      // Beta routes 403 without the beta header (PLAN §5.1).
      return request.headers.get('ld-api-version') === 'beta' ? j(request, { items: [], _links: {} }) : j(request, { message: 'beta' }, 403);
    }),
    http.get(`${ORIGIN}/projects/acme/release-pipelines`, ({ request }) => j(request, { message: 'not found' }, 404)),
    http.get(`${ORIGIN}/members`, ({ request }) => j(request, { items: [], _links: {} })),
    http.get(`${ORIGIN}/teams`, ({ request }) => (opts.teams ? j(request, { message: 'enterprise' }, opts.teams) : j(request, { items: [] }))),
    http.get(`${ORIGIN}/projects/acme/environments/staging/holdouts`, ({ request }) => j(request, { items: [] })),
    http.get(`${ORIGIN}/projects/acme/environments/staging/experiments`, ({ request }) => j(request, { items: [], _links: {} })),
  );
}

const client = () => new LdClient({ instance: 'us', token: TOKEN, transport: { retry: { baseDelayMs: 1, maxDelayMs: 2 } } });

describe('LaunchDarkly capability probe (PLAN §5.2)', () => {
  it('builds the capability matrix from read-only probes', async () => {
    mockLd({ teams: 405 });
    const m = await probeCapabilities(client(), 'acme');
    // Regression: the store refuses any key named `token`, so a matrix with one could never be
    // saved and the probe reported "failed".
    const keys = JSON.stringify(m).match(/"([^"]+)":/g)!.map((k) => k.slice(1, -2));
    expect(keys.filter((k) => /^(token|apiKey|accessToken|secret|password)$/i.test(k))).toEqual([]);
    const status = Object.fromEntries(m.capabilities.map((c) => [c.key, c.status]));
    expect(status).toMatchObject({
      flags: 'available',
      context_kinds: 'unknown',
      approvals: 'available',
      experimentation: 'available',
      metric_groups: 'available',
      release_pipelines: 'unavailable',
      teams: 'unavailable',
      prerequisites: 'unknown',
      warehouse_native: 'manual',
    });
    expect(seenHeaders.metricGroups).toBe('beta');
    expect(m.environments).toEqual([
      { key: 'staging', name: 'staging', critical: false, flagApprovalsRequired: false, segmentApprovalsRequired: false, deniedActions: [] },
      { key: 'production', name: 'production', critical: true, flagApprovalsRequired: true, segmentApprovalsRequired: true, deniedActions: [] },
    ]);
    expect(m.tokenInfo).toMatchObject({ role: 'writer', serviceToken: false, tokenLookup: 'ok' });
    expect(m.tokenInfo.warnings.join(' ')).toMatch(/personal access token/);
  });

  it('never exposes SDK keys, mobile keys or the token', async () => {
    mockLd();
    const c = client();
    const m = await probeCapabilities(c, 'acme');
    const envs = await c.listEnvironments('acme');
    const dump = JSON.stringify([m, envs]);
    expect(dump).not.toContain('SECRET');
    expect(dump).not.toContain(TOKEN);
    expect(stripSdkKeys({ a: [{ apiKey: 'x', ok: 1 }] })).toEqual({ a: [{ ok: 1 }] });
  });

  it('maps _access denials and a forbidden token lookup', async () => {
    mockLd({ deniedContextKinds: true, tokenLookup: 403, serviceToken: true });
    const m = await probeCapabilities(client(), 'acme');
    expect(m.capabilities.find((c) => c.key === 'context_kinds')!.status).toBe('not_permitted');
    expect(m.tokenInfo.tokenLookup).toBe('forbidden');
    expect(m.tokenInfo.warnings).toEqual([]);
  });

  it('rejects a bad token with a readable error', async () => {
    mockLd();
    const bad = new LdClient({ instance: 'us', token: 'api-wrong' });
    await expect(bad.callerIdentity()).rejects.toThrow(/401/);
  });
});


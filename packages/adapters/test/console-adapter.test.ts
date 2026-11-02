import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildAcmeDataset } from '@sslm/demo-fixtures';
import { countsByKind, effectiveTargeting } from '@sslm/canonical';
import { CrawlAuthError, crawlConsoleProject, normalizeConsoleSnapshot, CrawlTransientError } from '../src/index.ts';
import { mockProject, server, testClient } from './msw-server.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SOURCE = { sourceId: 'src-web', sourceKind: 'console_api' as const, alias: 'web' };

async function crawlWeb(opts: Parameters<typeof testClient>[1] = {}) {
  const { client, issues } = testClient('web', opts);
  const raw = await crawlConsoleProject(client, issues);
  return { raw, snap: normalizeConsoleSnapshot(raw, { source: SOURCE, takenAt: '2026-10-01T00:00:00.000Z' }), client, issues };
}

describe('Console API adapter against the simulated StatSig', () => {
  it('reads only the kinds asked for, without requesting the others', async () => {
    const d = mockProject('web');
    const { client, issues } = testClient('web');
    const requested: string[] = [];
    const seen = new Set<string>();
    const raw = await crawlConsoleProject(client, issues, {
      kinds: ['gate', 'segment'],
      onProgress: (p) => {
        requested.push(p.endpoint);
        seen.add(`${p.total}`);
      },
    });
    const snap = normalizeConsoleSnapshot(raw, { source: SOURCE, takenAt: '2026-10-01T00:00:00.000Z' });
    expect(snap.gates).toHaveLength(d.gates.length);
    expect(countsByKind(snap)).toMatchObject({ segment: 11, config: 0, experiment: 0, layer: 0, holdout: 0, autotune: 0, metric: 0, param_store: 0 });
    expect(requested).toContain('/gates');
    expect(requested).toContain('/segments');
    expect(requested).toContain('/environments'); // project-level endpoints always run
    expect(requested).not.toContain('/experiments');
    expect(requested).not.toContain('/metrics/list');
    // Left out by choice is not a skipped fetch (only the usual deferred big ID lists appear).
    expect(raw.skipped.map((x) => x.endpoint).filter((e) => !e.endsWith('/id_list'))).toEqual([]);
  });

  it('crawls and normalizes acme-web', async () => {
    const d = mockProject('web');
    const { snap, issues } = await crawlWeb();
    expect(issues).toEqual([]);
    expect(snap.gates).toHaveLength(d.gates.length); // includes the archived gate
    expect(snap.gates.find((g) => g.id === 'legacy_wishlist')?.archived).toBe(true);
    expect(countsByKind(snap)).toMatchObject({ gate: d.gates.length - 1, config: d.dynamicConfigs.length, segment: 11, experiment: 7, layer: 2, holdout: 2, autotune: 6, metric: 7, param_store: 1 });
    expect(snap.environments.map((e) => e.name)).toEqual(['development', 'staging', 'production', 'qa']);
    expect(snap.unitTypes.map((u) => u.name)).toEqual(['userID', 'stableID', 'companyID']);
    expect(snap.completeness.missing).toEqual(['salts']);
  });

  it('maps conditions, overrides, segments and experiments into the canonical model', async () => {
    mockProject('web');
    const { snap } = await crawlWeb();
    const ncf = snap.gates.find((g) => g.id === 'new_checkout_flow')!;
    expect(ncf.rules.map((r) => [r.name, r.passPercentage])).toEqual([['Acme staff', 100], ['Beta testers', 100], ['Public 20%', 20]]);
    expect(ncf.overrides).toEqual([
      { unitType: 'userID', ids: ['user-qa-1', 'user-qa-2'], value: { kind: 'gate', pass: true }, environment: null },
      { unitType: 'userID', ids: ['user-vip-complainer'], value: { kind: 'gate', pass: false }, environment: null },
      { unitType: 'userID', ids: ['user-staging-tester', 'user-vip-complainer'], value: { kind: 'gate', pass: true }, environment: 'staging' },
    ]);
    expect(ncf.owner?.email).toBe('bob.okafor@acmeretail.example');

    const b2b = snap.gates.find((g) => g.id === 'b2b_bulk_ordering')!;
    expect(b2b.idType).toBe('companyID');
    expect(b2b.rules[0]!.conditions[0]).toMatchObject({ type: 'unit_id', customID: 'companyID', operator: 'any' });
    expect(b2b.overrides.map((o) => [o.unitType, o.environment, o.value])).toEqual([
      ['companyID', null, { kind: 'gate', pass: true }],
      ['companyID', 'production', { kind: 'gate', pass: true }],
      ['companyID', 'production', { kind: 'gate', pass: false }],
    ]);

    expect(snap.gates.find((g) => g.id === 'dark_mode')!.rules[0]!.conditions[0]!.derivedFrom).toBe('user_agent');
    expect(snap.gates.find((g) => g.id === 'eu_cookie_banner')!.rules[0]!.conditions[0]!.derivedFrom).toBe('ip');

    const vip = snap.segments.find((s) => s.id === 'vip_customers')!;
    expect(vip.idList?.ids).toHaveLength(25);
    const fraud = snap.segments.find((s) => s.id === 'fraud_blocklist')!;
    expect(fraud.idList).toEqual({ count: 20000 });
    expect(fraud.completeness.missing).toContain('idListMembers');
    expect(snap.warnings.filter((w) => w.code === 'fetch_skipped').map((w) => w.path).sort()).toEqual(['/segments/fraud_blocklist/id_list', '/segments/wholesale_partners/id_list']);

    const exp = snap.experiments.find((e) => e.id === 'search_ranking_v3')!;
    expect(exp).toMatchObject({ status: 'active', allocation: 50, targetingGateId: 'checkout_targeting_gate', layerId: null });
    expect(exp.overrides).toEqual([{ unitType: 'userID', ids: ['user-search-qa'], value: { kind: 'group', groupId: exp.groups[1]!.id, groupName: 'Model v3' }, environment: null }]);
    expect(snap.layers.find((l) => l.id === 'checkout_layer')!.experimentIds).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    expect(snap.paramStores[0]!.parameters.map((p) => p.ref?.kind ?? 'static')).toEqual(['static', 'gate', 'experiment', 'config']);

    const hero = snap.configs.find((c) => c.id === 'homepage_hero')!;
    expect(hero.rules[0]!.variants?.map((v) => v.passPercentage)).toEqual([50, 30, 20]);
    expect(effectiveTargeting(snap.configs.find((c) => c.id === 'search_ranking_weights')!, 'production').rules).toEqual([]);
  });

  it('paginates with small pages and gets identical results', async () => {
    mockProject('web');
    const a = (await crawlWeb()).snap;
    const b = (await crawlWeb({ pageSize: 4 })).snap;
    expect(b.gates.map((g) => g.id)).toEqual(a.gates.map((g) => g.id));
    expect(b.segments.find((s) => s.id === 'vip_customers')!.idList?.ids).toEqual(a.segments.find((s) => s.id === 'vip_customers')!.idList?.ids);
  });

  it('backs off through injected 429s', async () => {
    mockProject('web', { throttleRate: 0.25, seed: 7 });
    const { snap, client } = await crawlWeb({ maxAttempts: 12 });
    expect(snap.gates.length).toBeGreaterThan(30);
    expect(client.transport.stats.throttles).toBeGreaterThan(0);
  });

  it('reports "unreachable, key may be invalid" when the browser cannot read StatSig errors', async () => {
    mockProject('web', { browserCors: true });
    const { client, issues } = testClient('web', { apiKey: 'console-wrong', maxAttempts: 3 });
    const err = await crawlConsoleProject(client, issues).catch((e) => e);
    expect(err).toBeInstanceOf(CrawlAuthError);
    expect(err.message).toBe('StatSig unreachable, the key may be invalid.');
    expect(client.transport.stats.opaqueFailures).toBe(3);
  });

  it('reports a readable 401 outside the browser', async () => {
    mockProject('web');
    const { client, issues } = testClient('web', { apiKey: 'console-wrong' });
    const err = await crawlConsoleProject(client, issues).catch((e) => e);
    expect(err).toBeInstanceOf(CrawlAuthError);
    expect(err.message).toMatch(/401/);
  });

  it('logs schema mismatches instead of crashing', async () => {
    const d = buildAcmeDataset('web', 1);
    const broken = structuredClone(d);
    delete (broken.gates[0] as Record<string, unknown>).rules;
    (broken.gates[1] as Record<string, unknown>).isEnabled = 'yes';
    mockProject('web', { dataset: broken });
    const { snap, issues } = await crawlWeb();
    expect(issues.map((i) => [i.endpoint, i.index])).toEqual([['/gates', 0], ['/gates', 1]]);
    expect(snap.gates[0]!.rules).toEqual([]);
    expect(snap.warnings.filter((w) => w.code === 'schema_mismatch')).toHaveLength(2);
  });

  it('fails the crawl, rather than saving an empty list, when an endpoint stays rate-limited', async () => {
    mockProject('web');
    const { http, HttpResponse } = await import('msw');
    server.use(http.get('https://demo-statsig.test/web/console/v1/gates', () => HttpResponse.json({ message: 'slow down' }, { status: 429 })));
    const err = await crawlWeb({ maxAttempts: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(CrawlTransientError);
    expect(err.endpoint).toBe('/gates');
    expect(err.message).toMatch(/rate-limited \/gates/);
  });

  it('degrades gracefully when an optional endpoint fails', async () => {
    mockProject('web');
    const { http, HttpResponse } = await import('msw');
    server.use(http.get('https://demo-statsig.test/web/console/v1/users/teams', () => HttpResponse.json({ message: 'Enterprise only' }, { status: 403 })));
    const { snap } = await crawlWeb();
    expect(snap.warnings.find((w) => w.path === '/users/teams')?.code).toBe('fetch_skipped');
    expect(snap.gates.length).toBeGreaterThan(0);
  });
});

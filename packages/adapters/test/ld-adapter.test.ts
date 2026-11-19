import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { acmeLegacyProject, ACME_LEGACY_PROJECT_KEY, createLdApiHandlers } from '@sslm/demo-fixtures';
import { LdClient } from '@sslm/ld-client';
import { LdReadAuthError, normalizeLdSnapshot, readLdProject } from '../src/index.ts';

const ORIGIN = 'https://demo-ld.test';
const TOKEN = 'api-test-token';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SOURCE = { sourceId: 'src-legacy', sourceKind: 'launchdarkly' as const, alias: 'legacy' };

function client(token = TOKEN) {
  const requests: string[] = [];
  server.use(...createLdApiHandlers({ baseUrl: ORIGIN, getProject: acmeLegacyProject, token: TOKEN, onRequest: (r) => requests.push(`${r.status} ${r.path}`) }));
  return { client: new LdClient({ instance: { id: 'us', label: 'test', origin: ORIGIN }, token, transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 2 } } }), requests };
}

describe('LaunchDarkly source adapter (PLAN §20.2)', () => {
  it('reads project, environments, context kinds, every flag (archived included) and segments per environment', async () => {
    const { client: c, requests } = client();
    const progress: string[] = [];
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY, { onProgress: (p) => progress.push(p.endpoint) });
    const fixture = acmeLegacyProject();
    expect(raw.flags.map((f) => f.key)).toEqual(fixture.flags.map((f) => f.key).sort());
    expect(raw.environments.map((e) => e.key)).toEqual(['test', 'production']);
    expect(Object.keys(raw.segments)).toEqual(['test', 'production']);
    expect(raw.segments.production).toHaveLength(3);
    expect(raw.skipped).toEqual([]);
    // Only GETs, and the archived flag was found through the second listing pass.
    expect(requests.every((r) => r.startsWith('200 '))).toBe(true);
    expect(requests.filter((r) => r.endsWith('/flags/acme-legacy'))).toHaveLength(2);
    expect(progress.at(-1)).toBe('done');
  });

  it('normalizes into the neutral block with the source environments as snapshot environments', async () => {
    const { client: c } = client();
    const snap = normalizeLdSnapshot(await readLdProject(c, ACME_LEGACY_PROJECT_KEY), { source: SOURCE, takenAt: '2026-10-30T00:00:00.000Z' });
    expect(snap.source).toEqual(SOURCE);
    expect(snap.gates).toEqual([]);
    expect(snap.environments.map((e) => [e.name, e.isProduction])).toEqual([
      ['test', false],
      ['production', true],
    ]);
    expect(snap.neutral?.contextKinds.map((k) => k.key)).toEqual(['user', 'organization', 'device', 'legacy-kiosk']);
    expect(snap.unitTypes.map((u) => u.name)).toEqual(['user', 'organization', 'device']);
    const flags = snap.neutral!.flags;
    expect(flags.map((f) => f.key)).toContain('legacy-archived-promo');
    expect(flags.find((f) => f.key === 'legacy-archived-promo')?.archived).toBe(true);

    const checkout = flags.find((f) => f.key === 'legacy-checkout-redesign')!;
    expect(checkout.uid).toBe('src-legacy/flag/legacy-checkout-redesign');
    expect(checkout.flagKind).toBe('boolean');
    expect(checkout.customProperties['jira.issue']).toEqual({ name: 'Jira issue', value: ['ACME-412'] });
    const test = checkout.environments.find((e) => e.env === 'test')!;
    expect(test.rules.map((r) => r.description)).toEqual(['Beta organizations', 'Acme staff']);
    expect(test.rules[0]!.clauses[0]).toEqual({ contextKind: 'organization', attribute: 'key', op: 'segmentMatch', values: ['legacy-beta-orgs'], negate: false });
    // `targets` (user) and `contextTargets` merge; the empty user entry LD repeats is dropped.
    expect(test.targets).toEqual([
      { contextKind: 'organization', variation: 0, values: ['org-pilot'] },
      { contextKind: 'user', variation: 0, values: ['u-qa-1', 'u-qa-2'] },
    ]);
    expect(test.version).toBe(12);
    const prod = checkout.environments.find((e) => e.env === 'production')!;
    expect(prod.fallthrough.rollout).toEqual({ contextKind: 'user', variations: [{ variation: 0, weight: 30_000 }, { variation: 1, weight: 70_000 }] });

    const pricing = flags.find((f) => f.key === 'legacy-pricing-tiers')!;
    expect(pricing.flagKind).toBe('multivariate');
    expect(pricing.environments[0]!.fallthrough.rollout?.bucketBy).toBe('plan');
    expect(pricing.environments[0]!.prerequisites).toEqual([{ key: 'legacy-checkout-redesign', variation: 0 }]);
    expect(pricing.environments.find((e) => e.env === 'production')!.rules[0]!.trackEvents).toBe(true);

    expect(flags.find((f) => f.key === 'legacy-kill-switch')?.maintainer).toEqual({ id: 'mem-legacy-ops', email: 'ops@acme-legacy.example' });
    expect(flags.find((f) => f.key === 'legacy-cta-copy')?.experiments).toEqual(['legacy-cta-copy-test']);
    expect(flags.find((f) => f.key === 'legacy-cta-copy')?.deprecated).toBe(true);

    const segs = snap.neutral!.segments;
    expect(segs.map((s) => s.key)).toEqual(['legacy-beta-orgs', 'legacy-fraud-blocklist', 'legacy-internal-users']);
    const internal = segs.find((s) => s.key === 'legacy-internal-users')!;
    expect(internal.environments.map((e) => e.env)).toEqual(['test', 'production']);
    expect(internal.environments[0]!.included).toEqual([{ contextKind: 'user', values: ['u-1', 'u-2', 'u-3'] }]);
    expect(internal.environments[0]!.excluded).toEqual([{ contextKind: 'user', values: ['u-contractor-9'] }]);
    expect(internal.environments[0]!.rules[0]).toMatchObject({ weight: 50_000, rolloutContextKind: 'user' });
    const blocklist = segs.find((s) => s.key === 'legacy-fraud-blocklist')!;
    expect(blocklist.environments.map((e) => e.env)).toEqual(['production']);
    expect(blocklist.environments[0]!.unbounded).toEqual({ contextKind: 'user' });
    expect(snap.completeness.missing).toEqual(['checks', 'salts', 'idListMembers']);
    expect(snap.warnings).toEqual([]);
  });

  it('turns a rejected token into an auth error on the first request', async () => {
    const { client: c } = client('api-wrong');
    await expect(readLdProject(c, ACME_LEGACY_PROJECT_KEY)).rejects.toBeInstanceOf(LdReadAuthError);
  });

  it('reports a project the token cannot see', async () => {
    const { client: c } = client();
    await expect(readLdProject(c, 'someone-elses-project')).rejects.toThrow(/someone-elses-project/);
  });
});

describe('LaunchDarkly source adapter: experimentation (PLAN §20.5)', () => {
  it('reads metrics, metric groups, experiments, holdouts and layers, resolving ids to keys and indexes', async () => {
    const { client: c } = client();
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY);
    expect(raw.skipped).toEqual([]);
    expect(raw.metrics.map((m) => m.key)).toContain('legacy-wh-revenue');
    expect(raw.experiments.production!.map((x) => x.key)).toContain('legacy-old-banner-test'); // archived ones are listed too
    expect(Object.keys(raw.members).sort()).toEqual(['mem-legacy-growth', 'mem-legacy-ops']);

    const snap = normalizeLdSnapshot(raw, { source: SOURCE, takenAt: '2026-11-19T00:00:00.000Z' });
    const n = snap.neutral!;
    expect(n.metrics!.map((m) => m.key)).toEqual(['legacy-cart-conversion', 'legacy-checkout-completed', 'legacy-cta-click', 'legacy-old-signup', 'legacy-order-value', 'legacy-pricing-pageview', 'legacy-wh-revenue']);
    const order = n.metrics!.find((m) => m.key === 'legacy-order-value')!;
    expect(order).toMatchObject({ metricKind: 'custom', eventKey: 'order_placed', isNumeric: true, unit: 'USD', analysisType: 'percentile', percentileValue: 90, unitAggregationType: 'sum', winsorLowerPercentile: 1, maintainer: { id: 'mem-legacy-growth', email: 'growth@acme-legacy.example' } });
    expect(order.filters).toEqual({ type: 'eventProperty', attribute: 'currency', op: 'in', values: ['USD'], negate: false });
    expect(n.metrics!.find((m) => m.key === 'legacy-checkout-completed')!.dataSource).toBeUndefined(); // LaunchDarkly events: nothing to carry
    expect(n.metrics!.find((m) => m.key === 'legacy-wh-revenue')!.dataSource).toEqual({ key: 'legacy-snowflake', environmentKey: 'production', name: 'Legacy Snowflake', integrationKey: 'snowflake' });
    expect(n.metrics!.find((m) => m.key === 'legacy-old-signup')!.archived).toBe(true);
    expect(n.metricGroups![0]).toMatchObject({ key: 'legacy-checkout-funnel', groupKind: 'funnel', metrics: [{ key: 'legacy-cta-click', nameInGroup: 'Clicked CTA' }, { key: 'legacy-checkout-completed', nameInGroup: 'Completed checkout' }], maintainer: { id: 'mem-legacy-growth', email: 'growth@acme-legacy.example' } });

    // Experiments: the holdout's base experiment is not one; the rest group by key with one entry per environment.
    expect(n.experiments!.map((x) => x.key)).toEqual(['legacy-checkout-redesign-test', 'legacy-cta-copy-test', 'legacy-old-banner-test', 'legacy-pricing-bandit', 'legacy-theme-test']);
    const cta = n.experiments!.find((x) => x.key === 'legacy-cta-copy-test')!;
    expect(cta.environments.map((e) => e.env)).toEqual(['production']);
    const ctaProd = cta.environments[0]!;
    expect(ctaProd).toMatchObject({ experimentType: 'experiment', methodology: 'bayesian', analysisConfig: { bayesianThreshold: '0.95' }, holdout: { id: 'hold-legacy-q3', key: 'legacy-q3-holdout' }, layer: { key: 'legacy-checkout-layer', reservationPercent: 40 }, maintainer: { id: 'mem-legacy-growth', email: 'growth@acme-legacy.example' } });
    expect(ctaProd.currentIteration).toMatchObject({ status: 'running', randomizationUnit: 'user', primary: { key: 'legacy-checkout-funnel', isGroup: true } });
    // Treatments point at variation *indexes*; the flag's rule and "not in experiment" variation too.
    expect(ctaProd.currentIteration!.treatments).toEqual([
      { id: 'v-buy', name: 'Buy now', baseline: true, allocationPercent: '50', parameters: [{ flagKey: 'legacy-cta-copy', variation: 0 }] },
      { id: 'v-checkout', name: 'Checkout', baseline: false, allocationPercent: '50', parameters: [{ flagKey: 'legacy-cta-copy', variation: 1 }] },
    ]);
    expect(ctaProd.currentIteration!.flags).toEqual([{ flagKey: 'legacy-cta-copy', ruleId: 'fallthrough', flagConfigVersion: 3, notInExperimentVariation: 0 }]);
    expect(ctaProd.currentIteration!.metrics.map((m) => `${m.key}${m.isGroup ? ' (group)' : ''}`)).toEqual(['legacy-checkout-funnel (group)', 'legacy-order-value', 'legacy-cta-click']);

    const redesign = n.experiments!.find((x) => x.key === 'legacy-checkout-redesign-test')!.environments[0]!;
    expect(redesign.currentIteration).toMatchObject({ status: 'stopped', winningTreatment: { id: 'v-true', name: 'Redesign' }, winningReason: 'Checkout completed +4.1%, credible.', randomizationUnit: 'organization', attributes: ['plan'] });
    expect(redesign.previousIterations).toHaveLength(1);
    const theme = n.experiments!.find((x) => x.key === 'legacy-theme-test')!.environments[0]!;
    expect(theme.draftIteration!.flags[0]).toEqual({ flagKey: 'legacy-theme', ruleId: 'rule-dark', ruleDescription: 'Dark mode opt-in', flagConfigVersion: 3, notInExperimentVariation: 0 });
    expect(n.experiments!.find((x) => x.key === 'legacy-old-banner-test')!.archived).toBe(true);
    expect(n.experiments!.find((x) => x.key === 'legacy-pricing-bandit')!.environments[0]!.currentIteration!.reallocationFrequencyMillis).toBe(3_600_000);

    expect(n.holdouts).toHaveLength(1);
    expect(n.holdouts![0]!.environments[0]).toMatchObject({ env: 'production', status: 'running', holdoutAmount: '10', randomizationUnit: 'user', primaryMetricKey: 'legacy-checkout-completed', experiments: ['legacy-cta-copy-test'], maintainer: { email: 'growth@acme-legacy.example' } });
    expect(n.layers![0]).toMatchObject({ key: 'legacy-checkout-layer', randomizationUnit: 'user', environments: [{ env: 'production', reservations: [{ experimentKey: 'legacy-cta-copy-test', flagKey: 'legacy-cta-copy', reservationPercent: 40 }] }, { env: 'test', reservations: [] }] });
    expect(snap.users.map((u) => u.email)).toEqual(['growth@acme-legacy.example', 'ops@acme-legacy.example']);
  });

  it('skips experimentation routes a plan or token does not have, and still returns the flags', async () => {
    const { client: c } = client();
    server.use(
      ...['/metrics/:p', '/projects/:p/metric-groups', '/projects/:p/layers', '/projects/:p/environments/:e/experiments', '/projects/:p/environments/:e/holdouts'].map((path) =>
        http.get(`${ORIGIN}/api/v2${path}`, () => HttpResponse.json({ code: 'forbidden', message: 'Experimentation is not on this plan' }, { status: 403 })),
      ),
    );
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY);
    expect(raw.flags.length).toBeGreaterThan(0);
    expect(raw.metrics).toEqual([]);
    expect(raw.experiments).toEqual({ test: [], production: [] });
    expect(raw.skipped.map((s) => s.endpoint).sort()).toEqual(['/metrics/acme-legacy', '/projects/acme-legacy/environments/production/experiments', '/projects/acme-legacy/environments/production/holdouts', '/projects/acme-legacy/environments/test/experiments', '/projects/acme-legacy/environments/test/holdouts', '/projects/acme-legacy/layers', '/projects/acme-legacy/metric-groups']);
    const snap = normalizeLdSnapshot(raw, { source: SOURCE });
    expect(snap.neutral!.experiments).toEqual([]);
    expect(snap.warnings.filter((w) => w.code === 'fetch_skipped')).toHaveLength(7);
  });
});

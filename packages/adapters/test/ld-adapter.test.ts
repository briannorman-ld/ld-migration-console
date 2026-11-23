import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { acmeLegacyProject, ACME_LEGACY_PROJECT_KEY, createLdApiHandlers } from '@sslm/demo-fixtures';
import { LdClient } from '@sslm/ld-client';
import { LD_DEFAULT_RESOURCES } from '@sslm/canonical';
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
    // With `members` in the default scope the maintainers resolve from the one listing, which also carries members nobody maintains with.
    expect(Object.keys(raw.members).sort()).toEqual(['mem-legacy-growth', 'mem-legacy-ops', 'mem-legacy-pm']);

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
    expect(snap.users.map((u) => u.email)).toEqual(['growth@acme-legacy.example', 'ops@acme-legacy.example', 'pm@acme-legacy.example']);
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

describe('LaunchDarkly source adapter: every other resource type (PLAN §20.6)', () => {
  it('reads the default scope: every kind but the per-flag ones, with nothing skipped and no credential kept', async () => {
    const { client: c, requests } = client();
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY);
    expect(raw.scope).toEqual(LD_DEFAULT_RESOURCES);
    expect(raw.skipped).toEqual([]);
    // No per-flag route was called.
    expect(requests.some((r) => r.includes('/scheduled-changes') || r.includes('/triggers/') || r.includes('/workflows') || r.includes('/flag-links/'))).toBe(false);
    // Members came from the one listing, so no GET /members/{id}.
    expect(requests.filter((r) => /\/members\/[^/]+$/.test(r))).toHaveLength(0);
    expect(raw.accountMembers.map((m) => m.email)).toEqual(['growth@acme-legacy.example', 'ops@acme-legacy.example', 'pm@acme-legacy.example']);
    expect(raw.aiConfigs.map((a) => a.key)).toEqual(['legacy-support-assistant']);
    expect(raw.aiConfigs[0]!.variations?.map((v) => v.modelConfigKey)).toEqual(['gpt-4o-mini', 'legacy-claude-haiku']);
    expect(raw.releasePipelines[0]?.phases?.length).toBe(2);
    // The other project's destination is filtered out by its self link.
    expect(Object.keys(raw.destinations)).toEqual(['production']);
    expect(raw.destinations.production!.map((d) => d._id)).toEqual(['dest-prod-segment']);
    // Credentials never enter the raw snapshot: destination config, webhook secret, Relay key.
    expect(JSON.stringify(raw)).not.toContain('DO-NOT-STORE');
    expect('config' in raw.destinations.production![0]!).toBe(false);
    expect('secret' in raw.webhooks[0]!).toBe(false);
    expect('fullKey' in raw.relayProxyConfigs[0]!).toBe(false);

    const snap = normalizeLdSnapshot(raw, { source: SOURCE, takenAt: '2026-11-23T00:00:00.000Z' });
    expect(snap.warnings).toEqual([]);
    expect(snap.neutral!.readScope).toEqual(LD_DEFAULT_RESOURCES);
    const inv = snap.neutral!.inventory!;
    const count = (k: string) => inv.filter((i) => i.resourceKind === k).length;
    expect(count('experimentation_settings')).toBe(1);
    expect(count('ai_configs')).toBe(1);
    expect(count('model_configs')).toBe(1);
    expect(count('release_pipelines')).toBe(1);
    expect(count('release_policies')).toBe(1);
    expect(count('views')).toBe(1);
    expect(count('approval_settings')).toBe(1); // production requires approvals; test does not
    expect(count('destinations')).toBe(1);
    expect(count('adaptive_triggers')).toBe(1);
    expect(count('teams')).toBe(2);
    expect(count('members')).toBe(3);
    expect(count('custom_roles')).toBe(1);
    expect(count('webhooks')).toBe(1);
    expect(count('relay_proxy_configs')).toBe(1);
    expect(count('code_references')).toBe(1);
    expect(count('workflow_templates')).toBe(1);
    expect(count('applications')).toBe(1);
    expect(count('scheduled_changes')).toBe(0);
    expect(JSON.stringify(snap)).not.toContain('DO-NOT-STORE');

    const ai = inv.find((i) => i.resourceKind === 'ai_configs')!;
    expect(ai.uid).toBe('src-legacy/ai_configs/legacy-support-assistant');
    expect(ai.maintainer).toEqual({ id: 'mem-legacy-growth', email: 'growth@acme-legacy.example' });
    expect(ai.facts.find((f) => f.label === 'Variations')?.value).toBe('Concise (gpt-4o-mini), Friendly (Claude) (legacy-claude-haiku)');
    const approvals = inv.find((i) => i.resourceKind === 'approval_settings')!;
    expect(approvals.env).toBe('production');
    expect(approvals.facts.find((f) => f.label === 'Minimum approvals')?.value).toBe('1');
    const trigger = inv.find((i) => i.resourceKind === 'adaptive_triggers')!;
    expect(trigger).toMatchObject({ env: 'production', flagKey: 'legacy-fraud-shield' });
    const relay = inv.find((i) => i.resourceKind === 'relay_proxy_configs')!;
    expect(relay.facts.find((f) => f.label === 'Key')?.value).toBe('…a1b2');

    // Teams and members feed the guide's Teams and People steps.
    expect(snap.teams?.map((t) => [t.id, t.memberEmails])).toEqual([
      ['legacy-growth', ['growth@acme-legacy.example', 'pm@acme-legacy.example']],
      ['legacy-platform-ops', ['ops@acme-legacy.example']],
    ]);
    expect(snap.users.map((u) => u.email)).toEqual(['growth@acme-legacy.example', 'ops@acme-legacy.example', 'pm@acme-legacy.example']);
  });

  it('reads the per-flag kinds when asked, and turns scheduled changes into a caveat on their flag', async () => {
    const { client: c, requests } = client();
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY, { resources: [...LD_DEFAULT_RESOURCES, 'scheduled_changes', 'flag_triggers', 'workflows', 'flag_links'] });
    expect(raw.skipped).toEqual([]);
    const live = acmeLegacyProject().flags.filter((f) => !f.archived).length;
    // One request per live flag per environment for each per-flag-per-environment kind; one per live flag for links.
    expect(requests.filter((r) => r.includes('/scheduled-changes'))).toHaveLength(live * 2);
    expect(requests.filter((r) => r.includes('/triggers/'))).toHaveLength(live * 2);
    expect(requests.filter((r) => r.includes('/flag-links/'))).toHaveLength(live);
    expect('triggerURL' in raw.flagTriggers.production!['legacy-kill-switch']![0]!).toBe(false);

    const snap = normalizeLdSnapshot(raw, { source: SOURCE, takenAt: '2026-11-23T00:00:00.000Z' });
    expect(snap.warnings).toEqual([]);
    const inv = snap.neutral!.inventory!;
    expect(inv.filter((i) => i.resourceKind === 'scheduled_changes').map((i) => [i.env, i.flagKey, i.key])).toEqual([
      ['production', 'legacy-kill-switch', 'sc-kill-fallthrough'],
      ['production', 'legacy-theme', 'sc-theme-on'],
      ['test', 'legacy-pricing-tiers', 'sc-pricing-rule'],
    ]);
    expect(inv.filter((i) => i.resourceKind === 'flag_triggers')).toHaveLength(1);
    expect(inv.filter((i) => i.resourceKind === 'workflows')[0]?.facts.find((f) => f.label === 'Stages')?.value).toBe('Approve, 10%, 100%');
    expect(inv.filter((i) => i.resourceKind === 'flag_links')[0]).toMatchObject({ flagKey: 'legacy-checkout-redesign', name: 'ACME-412: New checkout' });

    const flags = snap.neutral!.flags;
    const theme = flags.find((f) => f.key === 'legacy-theme')!;
    expect(theme.caveats).toEqual([{ kind: 'scheduled_changes', detail: { changes: [{ id: 'sc-theme-on', env: 'production', at: '2027-06-01T09:00:00.000Z', operation: 'turnFlagOn', recurring: false, on: true }] } }]);
    const pricing = flags.find((f) => f.key === 'legacy-pricing-tiers')!;
    const change = pricing.caveats!.find((c) => c.kind === 'scheduled_changes')!.detail.changes[0]!;
    expect(change.env).toBe('test');
    // The variation id resolved to its index on the flag (standard, plus, enterprise).
    expect(change.rules).toEqual([{ description: 'Plus for design partners', clauses: [{ contextKind: 'organization', attribute: 'tier', op: 'in', values: ['design-partner'], negate: false }], variation: 1 }]);
    // A fallthrough change is not translated: kept as its operation name, nothing half-carried.
    const kill = flags.find((f) => f.key === 'legacy-kill-switch')!;
    const untranslated = kill.caveats!.find((c) => c.kind === 'scheduled_changes')!.detail.changes[0]!;
    expect(untranslated).toEqual({ id: 'sc-kill-fallthrough', env: 'production', at: '2027-01-15T09:00:00.000Z', operation: 'updateFallthroughVariationOrRollout', recurring: false });
    expect(flags.find((f) => f.key === 'legacy-checkout-redesign')!.caveats).toBeUndefined();
  });

  it('skips a per-flag kind once when the plan or token lacks it, and reads on', async () => {
    const { client: c, requests } = client();
    server.use(http.get(`${ORIGIN}/api/v2/projects/:p/flags/:f/environments/:e/scheduled-changes`, () => HttpResponse.json({ code: 'forbidden', message: 'Scheduled changes are an Enterprise feature' }, { status: 403 })));
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY, { resources: ['flags', 'scheduled_changes', 'flag_triggers'] });
    const scheduled = raw.skipped.filter((s) => s.endpoint.includes('/scheduled-changes'));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.reason).toMatch(/HTTP 403; the rest of this kind was not read/);
    // At most one request per worker was in flight when the first 403 came back.
    expect(requests.filter((r) => r.includes('/scheduled-changes')).length).toBeLessThanOrEqual(4);
    // The next kind was still read in full.
    expect(requests.filter((r) => r.includes('/triggers/')).length).toBeGreaterThan(1);
    expect(raw.flagTriggers.production!['legacy-kill-switch']).toHaveLength(1);
  });

  it('narrows the read to the scope: no flags means no flag requests and no per-flag kinds', async () => {
    const { client: c, requests } = client();
    const raw = await readLdProject(c, ACME_LEGACY_PROJECT_KEY, { resources: ['segments', 'teams', 'scheduled_changes'] });
    expect(raw.scope).toEqual(['segments', 'teams']);
    expect(raw.flags).toEqual([]);
    expect(requests.some((r) => r.includes('/flags/'))).toBe(false);
    expect(requests.some((r) => r.includes('/metrics/') || r.includes('/ai-configs'))).toBe(false);
    expect(Object.keys(raw.segments)).toEqual(['test', 'production']);
    expect(raw.teams).toHaveLength(2);
    const snap = normalizeLdSnapshot(raw, { source: SOURCE, takenAt: '2026-11-23T00:00:00.000Z' });
    expect(snap.neutral!.flags).toEqual([]);
    expect(snap.neutral!.readScope).toEqual(['segments', 'teams']);
    expect(snap.neutral!.inventory!.map((i) => i.resourceKind)).toEqual(['teams', 'teams']);
  });
});

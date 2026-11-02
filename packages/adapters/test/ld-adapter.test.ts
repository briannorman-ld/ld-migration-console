import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
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

import { setupServer } from 'msw/node';
import { acmeHogProject, ACME_HOG_PROJECT_ID, acmeLegacyProject, ACME_LEGACY_PROJECT_KEY, buildAcmeDataset, createLdApiHandlers, createPostHogApiHandlers, createStatsigConsoleHandlers, DEMO_STATSIG_API_KEY, type AcmeAlias } from '@sslm/demo-fixtures';
import { crawlConsoleProject, normalizeConsoleSnapshot, normalizeLdSnapshot, normalizePostHogSnapshot, PostHogClient, readLdProject, readPostHogProject } from '@sslm/adapters';
import { LdClient } from '@sslm/ld-client';
import { StatsigConsoleClient } from '@sslm/statsig-client';
import type { CanonicalSnapshot } from '@sslm/canonical';
import type { LdDirectory, MapperCapabilities, MappingProfile } from '../src/index.ts';

/**
 * Canonical snapshots of the demo dataset, read through the real Console API adapter against the
 * MSW mock (the same path the app uses). Deferred ID lists stay deferred, as in the app.
 */
export const server = setupServer();

export async function acmeSnapshot(alias: AcmeAlias, snapshot = 1): Promise<CanonicalSnapshot> {
  const baseUrl = `https://demo-statsig.test/${alias}/console/v1`;
  server.use(...createStatsigConsoleHandlers({ baseUrl, getDataset: () => buildAcmeDataset(alias, snapshot), apiKey: DEMO_STATSIG_API_KEY }));
  const client = new StatsigConsoleClient({ baseUrl, apiKey: DEMO_STATSIG_API_KEY, transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5 } } });
  const raw = await crawlConsoleProject(client, []);
  return normalizeConsoleSnapshot(raw, { source: { sourceId: `src-${alias}`, sourceKind: 'console_api', alias }, takenAt: '2026-10-22T00:00:00.000Z' });
}

/**
 * The demo's LD *source* project ("Acme Legacy", PLAN §20), read through the real LD client and
 * adapter against the MSW mock. Its environments `test` and `production` auto-map to the target's.
 */
export async function legacySnapshot(): Promise<CanonicalSnapshot> {
  const origin = 'https://demo-ld.test';
  server.use(...createLdApiHandlers({ baseUrl: origin, getProject: acmeLegacyProject, token: 'api-test' }));
  const client = new LdClient({ instance: { id: 'us', label: 'test', origin }, token: 'api-test', transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5 } } });
  const raw = await readLdProject(client, ACME_LEGACY_PROJECT_KEY);
  return normalizeLdSnapshot(raw, { source: { sourceId: 'src-legacy', sourceKind: 'launchdarkly', alias: 'legacy' }, takenAt: '2026-10-30T00:00:00.000Z' });
}

/**
 * The demo's PostHog *source* project ("Acme Hog", PLAN §22), read through the real PostHog client
 * and adapter against the MSW mock. Its one environment is named after the project.
 */
export async function hogSnapshot(): Promise<CanonicalSnapshot> {
  const origin = 'https://demo-posthog.test';
  server.use(...createPostHogApiHandlers({ baseUrl: origin, getProject: acmeHogProject, key: 'phx_test' }));
  const client = new PostHogClient({ region: { origin }, key: 'phx_test', transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5 } } });
  const raw = await readPostHogProject(client, ACME_HOG_PROJECT_ID);
  return normalizePostHogSnapshot(raw, { source: { sourceId: 'src-hog', sourceKind: 'posthog', alias: 'hog' }, takenAt: '2026-11-12T00:00:00.000Z' });
}

/** Mirrors the real `statsig-migration` LD project: environments `test` and `production`. */
export const LD_ENVS = [
  { key: 'test', name: 'Test' },
  { key: 'production', name: 'Production' },
];

export const CAPS: MapperCapabilities = { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] };

/**
 * The LD account's people as the demo's `statsig-migration` project would show them: every Acme
 * owner except Jordan Former (who left) is a member, and the Checkout team exists (PLAN §19.2
 * `maintainer_unknown`). Member IDs are stable fakes.
 */
export const DIRECTORY: LdDirectory = {
  members: [...['alice.chen', 'bob.okafor', 'priya.raman', 'marco.rossi', 'sam.taylor', 'dana.kim'].map((u) => ({ id: `mem-${u.split('.')[0]}`, email: `${u}@acmeretail.example` })), { id: 'mem-legacy-ops', email: 'ops@acme-legacy.example' }],
  teams: [{ key: 'checkout', name: 'Checkout' }],
  membersReadable: true,
  teamsReadable: true,
};

export const NOW = '2026-10-22T12:00:00.000Z';

export function profileFor(snap: CanonicalSnapshot, envMapping: Record<string, string | null>): MappingProfile {
  return { version: 1, sources: { [snap.source.sourceId]: { envMapping, unitTypeKinds: {} } }, attributes: {}, policies: {} };
}

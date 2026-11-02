import { setupServer } from 'msw/node';
import { acmeLegacyProject, ACME_LEGACY_PROJECT_KEY, buildAcmeDataset, createLdApiHandlers, createStatsigConsoleHandlers, DEMO_STATSIG_API_KEY, type AcmeAlias } from '@sslm/demo-fixtures';
import { crawlConsoleProject, normalizeConsoleSnapshot, normalizeLdSnapshot, readLdProject } from '@sslm/adapters';
import { LdClient } from '@sslm/ld-client';
import { StatsigConsoleClient } from '@sslm/statsig-client';
import type { CanonicalSnapshot } from '@sslm/canonical';
import type { MapperCapabilities, MappingProfile } from '@sslm/mapper';

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

/** Mirrors the real `statsig-migration` LD project: environments `test` and `production`. */
export const LD_ENVS = [
  { key: 'test', name: 'Test' },
  { key: 'production', name: 'Production' },
];

export const CAPS: MapperCapabilities = { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] };

export const NOW = '2026-10-22T12:00:00.000Z';

export function profileFor(snap: CanonicalSnapshot, envMapping: Record<string, string | null>): MappingProfile {
  return { version: 1, sources: { [snap.source.sourceId]: { envMapping, unitTypeKinds: {} } }, attributes: {}, policies: {} };
}

/** The demo's LD *source* project ("Acme Legacy", PLAN §20), read through the real LD client and adapter against the MSW mock. */
export async function legacySnapshot(): Promise<CanonicalSnapshot> {
  const origin = 'https://demo-ld.test';
  server.use(...createLdApiHandlers({ baseUrl: origin, getProject: acmeLegacyProject, token: 'api-test' }));
  const client = new LdClient({ instance: { id: 'us', label: 'test', origin }, token: 'api-test', transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5 } } });
  const raw = await readLdProject(client, ACME_LEGACY_PROJECT_KEY);
  return normalizeLdSnapshot(raw, { source: { sourceId: 'src-legacy', sourceKind: 'launchdarkly', alias: 'legacy' }, takenAt: '2026-10-30T00:00:00.000Z' });
}

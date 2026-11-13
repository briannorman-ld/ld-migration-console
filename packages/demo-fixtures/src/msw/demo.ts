import type { HttpHandler } from 'msw';
import { ACME_PROJECTS, type AcmeAlias } from '../acme/index.ts';
import type { ConsoleProjectDataset } from '../console/dataset.ts';
import { acmeLegacyProject } from '../ld/acme-legacy.ts';
import { acmeHogProject } from '../posthog/acme-hog.ts';
import { createLdApiHandlers } from './ld-api.ts';
import { createPostHogApiHandlers } from './posthog-api.ts';
import { createStatsigConsoleHandlers, type MockStatsigOptions } from './statsig-console.ts';

/** A dummy Console key for demo sources. The mock checks it so the auth path is exercised. */
export const DEMO_STATSIG_API_KEY = 'console-DEMO-acme-retail-not-a-real-key';
/** A dummy LD access token for the demo's LD *source* project (PLAN §20); checked by the mock. */
export const DEMO_LD_SOURCE_TOKEN = 'api-DEMO-acme-legacy-not-a-real-token';
/** A dummy PostHog personal API key for the demo's PostHog source project (PLAN §22); checked by the mock. */
export const DEMO_POSTHOG_KEY = 'phx_DEMO-acme-hog-not-a-real-key';

/** Same-origin origin for the simulated LD API the demo's LD source reads (paths under /api/v2). */
export function demoLdBaseUrl(root: string): string {
  return `${root.replace(/\/+$/, '')}/__demo/ld`;
}

/** Same-origin origin for the simulated PostHog API the demo's PostHog source reads (paths under /api). */
export function demoPostHogBaseUrl(root: string): string {
  return `${root.replace(/\/+$/, '')}/__demo/posthog`;
}

/**
 * Same-origin path, so the strict CSP (`connect-src 'self' …`) needs no extra host for the demo.
 * `root` is the app's origin plus any base path (GitHub Pages serves under /<repo>/), which also
 * keeps the URL inside the mock service worker's scope.
 */
export function demoStatsigBaseUrl(root: string, alias: AcmeAlias): string {
  return `${root.replace(/\/+$/, '')}/__demo/statsig/${alias}/console/v1`;
}

export interface DemoHandlerOptions extends Omit<MockStatsigOptions, 'baseUrl' | 'getDataset' | 'apiKey'> {
  origin: string;
  getDataset: (alias: AcmeAlias) => ConsoleProjectDataset;
}

/** Handlers for both Acme StatSig demo projects, the "Acme Legacy" LD source project and the "Acme Hog" PostHog project. */
export function createAcmeDemoHandlers(opts: DemoHandlerOptions): HttpHandler[] {
  const { origin, getDataset, ...rest } = opts;
  return [
    ...(Object.keys(ACME_PROJECTS) as AcmeAlias[]).flatMap((alias, i) =>
      createStatsigConsoleHandlers({
        ...rest,
        seed: (rest.seed ?? 42) + i,
        baseUrl: demoStatsigBaseUrl(origin, alias),
        apiKey: DEMO_STATSIG_API_KEY,
        getDataset: () => getDataset(alias),
      }),
    ),
    ...createLdApiHandlers({ baseUrl: demoLdBaseUrl(origin), getProject: acmeLegacyProject, token: DEMO_LD_SOURCE_TOKEN, ...(rest.latencyMs ? { latencyMs: rest.latencyMs } : {}) }),
    ...createPostHogApiHandlers({ baseUrl: demoPostHogBaseUrl(origin), getProject: acmeHogProject, key: DEMO_POSTHOG_KEY, ...(rest.latencyMs ? { latencyMs: rest.latencyMs } : {}) }),
  ];
}

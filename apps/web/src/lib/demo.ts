/**
 * Demo mode (PLAN §19). The StatSig side is simulated by MSW *behind* the real Console API
 * adapter: a demo source is an ordinary Console API source whose base URL points at a
 * same-origin path the service worker intercepts. Loaded lazily so non-demo users never fetch
 * the dataset or the mock.
 */
import type { SourceDescriptor } from '@sslm/canonical';
import { flagEnabled, whenFlagsReady } from './flags.ts';
import { isSharedOrigin } from './origin.ts';
import { store } from './store.ts';

export const DEMO_WORKSPACE_ID = 'demo-acme-retail';
export const DEMO_TAG = 'statsig-migration-demo';
/**
 * The LD project the demo targets: an existing project chosen by the user (not one the demo
 * created). It is not tagged `statsig-migration-demo`, so PLAN §19.3 "Reset demo" must never
 * delete anything in it beyond resources carrying our own provenance.
 */
export const DEMO_LD_PROJECT = { instance: 'us' as const, projectKey: 'statsig-migration' };

/**
 * The demo LD project has only `test` and `production`, so StatSig `staging` is pre-mapped to
 * `test` (editable under Mapping). `development` and `qa` stay unmapped, to show that state.
 * A PostHog project has no environments (PLAN §22.1): the demo's "Acme Hog" source has the one
 * source environment named after the project, pre-mapped to `production`.
 */
export const DEMO_ENV_HINTS: Record<string, string> = { staging: 'test', 'Acme Hog': 'production' };

/** Where the app is served from, e.g. `https://x.github.io/ld-migration-console` (no trailing slash). */
export function appRoot(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href.replace(/\/+$/, '');
}

/**
 * The demo's service worker is registered at the app root and persists across reloads, so after
 * a demo it would still sit in front of every fetch, including real StatSig and LD calls (it
 * passes them through, but it needn't see them). Unregister it when the page loads anywhere but
 * the demo; the demo registers it again on its next start.
 */
export async function stopStaleDemoMock(): Promise<void> {
  if (started || !('serviceWorker' in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.filter((r) => /mockServiceWorker\.js$/.test(r.active?.scriptURL ?? r.waiting?.scriptURL ?? r.installing?.scriptURL ?? '')).map((r) => r.unregister()));
  } catch {
    // Private mode or a blocked API: nothing to clean up.
  }
}

let started: Promise<void> | undefined;
let demoSnapshot = 1;
let timelineSteps = 2;

/** Current position on the scripted StatSig timeline (PLAN §19.3). */
export function demoTimeline() {
  return demoSnapshot;
}

/** How many scripted snapshots the dataset has (known once the mock has loaded; 2 until then). */
export function demoTimelineSteps() {
  return timelineSteps;
}

/**
 * "Advance StatSig timeline" (PLAN §19.3): the simulated StatSig project starts answering with a
 * later scripted snapshot, so the next sync shows drift, an archive and a new gate. Nothing is
 * written anywhere; a re-sync of the demo sources picks the new state up.
 */
export function setDemoTimeline(step: number): void {
  demoSnapshot = Math.max(1, Math.min(timelineSteps, Math.round(step)));
}

export function startDemoMock(): Promise<void> {
  started ??= (async () => {
    const [{ setupWorker }, fixtures, data] = await Promise.all([
      import('msw/browser'),
      import('@sslm/demo-fixtures'),
      import('@sslm/demo-fixtures/data/acme-retail.json'),
    ]);
    const file = (data as unknown as { default: import('@sslm/demo-fixtures').AcmeRetailFile }).default;
    timelineSteps = file.snapshots;
    const worker = setupWorker(
      ...fixtures.createAcmeDemoHandlers({
        origin: appRoot(),
        getDataset: (alias) => file.projects[alias][demoSnapshot - 1]!,
        // Occasional 429s so the adaptive backoff is visible (PLAN §19.1). Browser-realistic:
        // StatSig's 429s carry no CORS header, so they surface as network errors.
        throttleRate: 0.06,
        browserCors: true,
        latencyMs: 40,
      }),
    );
    await worker.start({ serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` }, onUnhandledFrame: 'bypass', quiet: true });
  })();
  return started;
}

export async function demoKey(): Promise<string> {
  return (await import('@sslm/demo-fixtures')).DEMO_STATSIG_API_KEY;
}

/** The dummy read token of the demo's LD *source* project (checked by the mock). */
export async function demoLdSourceToken(): Promise<string> {
  return (await import('@sslm/demo-fixtures')).DEMO_LD_SOURCE_TOKEN;
}

/** The dummy personal API key of the demo's PostHog *source* project (checked by the mock). */
export async function demoPostHogKey(): Promise<string> {
  return (await import('@sslm/demo-fixtures')).DEMO_POSTHOG_KEY;
}

/**
 * Create (or reuse) the "Acme Retail (Demo)" workspace with the two StatSig demo sources, the
 * "Acme Legacy" LD source and the "Acme Hog" PostHog source preconnected.
 */
export async function ensureDemoWorkspace(): Promise<string> {
  const { demoStatsigBaseUrl, demoLdBaseUrl, demoPostHogBaseUrl, ACME_LEGACY_PROJECT_KEY, ACME_HOG_PROJECT_ID } = await import('@sslm/demo-fixtures');
  const existing = await store.getWorkspace(DEMO_WORKSPACE_ID);
  // The demo writes with a real LaunchDarkly token, so it follows the same origin rule as any workspace.
  if (!existing) await store.createWorkspace({ id: DEMO_WORKSPACE_ID, name: 'Acme Retail (Demo)', isDemo: true, ld: DEMO_LD_PROJECT, ...(isSharedOrigin() ? { tokenStorage: 'memory' as const } : {}) });
  else if (!existing.ld?.projectKey) await store.updateWorkspace(DEMO_WORKSPACE_ID, { ld: DEMO_LD_PROJECT });
  const have = new Set((await store.listSources(DEMO_WORKSPACE_ID)).map((s) => s.id));
  const sources: SourceDescriptor[] = (['web', 'mobile'] as const).map((alias, i) => ({
    id: `${DEMO_WORKSPACE_ID}-${alias}`,
    alias,
    label: `acme-${alias}`,
    kind: 'console_api',
    baseUrl: demoStatsigBaseUrl(appRoot(), alias),
    isDemo: true,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  // PLAN §20: an acquired business unit's LD project, read as a source through the simulated LD API.
  sources.push({
    id: `${DEMO_WORKSPACE_ID}-legacy`,
    alias: 'legacy',
    label: 'acme-legacy (LaunchDarkly)',
    kind: 'launchdarkly',
    ld: { instance: 'us', projectKey: ACME_LEGACY_PROJECT_KEY, baseUrl: demoLdBaseUrl(appRoot()) },
    isDemo: true,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString(),
  });
  // PLAN §22: a PostHog project, read as a source through the simulated PostHog API. One source
  // environment, named after the project (PostHog has no environments inside a project). Only
  // while the console's `posthog-source` flag is on (the workspace screen hides it when off).
  await whenFlagsReady();
  if (flagEnabled('posthogSource')) sources.push({
    id: `${DEMO_WORKSPACE_ID}-hog`,
    alias: 'hog',
    label: 'acme-hog (PostHog)',
    kind: 'posthog',
    posthog: { region: 'us', projectId: ACME_HOG_PROJECT_ID, projectName: 'Acme Hog', baseUrl: demoPostHogBaseUrl(appRoot()) },
    isDemo: true,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString(),
  });
  for (const s of sources) if (!have.has(s.id)) await store.addSource(DEMO_WORKSPACE_ID, s);
  return DEMO_WORKSPACE_ID;
}

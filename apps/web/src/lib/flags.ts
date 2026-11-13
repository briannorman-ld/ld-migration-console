/**
 * The console's own feature flags, read from LaunchDarkly with the JavaScript client SDK.
 *
 * The flags live in the `statsig-migration` project (the same one the demo writes into): the
 * deployed app reads the Production environment, `vite dev` the Test one, and a build can point
 * elsewhere with VITE_LD_CLIENT_SIDE_ID (a client-side ID is public; it only reads flags). The
 * context is anonymous and carries no attributes, so nothing about the person reaches
 * LaunchDarkly beyond the SDK's own random per-browser key. Every flag has a default here that is
 * the safe behaviour when the SDK cannot connect; the defaults are also what tests see, unless a
 * test sets an override.
 */
import { initialize, type LDClient, type LDFlagSet } from 'launchdarkly-js-client-sdk';
import { useSyncExternalStore } from 'react';

export const CONSOLE_FLAGS = {
  /** PLAN §22: PostHog as a source. Off hides the Add-source tile, the demo's "Acme Hog" source, the coverage rows and any PostHog source a workspace already has. */
  posthogSource: { key: 'posthog-source', default: false },
} as const;

export type ConsoleFlag = keyof typeof CONSOLE_FLAGS;

const CLIENT_SIDE_IDS = { production: '6ac6d145a34ff3079754b7b5', test: '6ac6d145a34ff3079754b7b4' } as const;

/** Resolved once, when the first flag is read (main.tsx renders nothing before that). */
let client: LDClient | undefined;
let ready: Promise<void> | undefined;
let started = false;
const overrides = new Map<ConsoleFlag, boolean>();
const listeners = new Set<() => void>();

function clientSideId(): string | undefined {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  if (env.MODE === 'test') return undefined;
  const chosen = typeof env.VITE_LD_CLIENT_SIDE_ID === 'string' ? env.VITE_LD_CLIENT_SIDE_ID.trim() : undefined;
  if (chosen !== undefined) return chosen || undefined; // an empty VITE_LD_CLIENT_SIDE_ID runs with the defaults only
  return env.PROD ? CLIENT_SIDE_IDS.production : CLIENT_SIDE_IDS.test;
}

function start(): void {
  if (started) return;
  started = true;
  const id = clientSideId();
  if (!id || typeof window === 'undefined') {
    ready = Promise.resolve();
    return;
  }
  const bootstrap = cachedFlags();
  const c = initialize(id, { kind: 'user', anonymous: true }, { diagnosticOptOut: true, ...(bootstrap ? { bootstrap } : {}) });
  client = c;
  const notify = () => listeners.forEach((l) => l());
  c.on('change', () => {
    cacheFlags(c.allFlags());
    notify();
  });
  ready = c
    .waitForInitialization(5)
    .then(() => cacheFlags(c.allFlags()))
    .catch(() => undefined)
    .finally(notify);
}

/** Last known values, so a reload does not flash the default while the SDK connects. */
const CACHE_KEY = 'console-flags';
function cachedFlags(): LDFlagSet | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as LDFlagSet) : undefined;
  } catch {
    return undefined;
  }
}
function cacheFlags(flags: LDFlagSet): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(flags));
  } catch {
    // private mode or storage disabled: the next load starts from the defaults again
  }
}

/** The flag's current value: an override, else what LaunchDarkly serves, else the default. */
export function flagEnabled(flag: ConsoleFlag): boolean {
  start();
  const o = overrides.get(flag);
  if (o !== undefined) return o;
  const spec = CONSOLE_FLAGS[flag];
  const v: unknown = client ? client.variation(spec.key, spec.default) : (cachedFlags()?.[spec.key] ?? spec.default);
  return typeof v === 'boolean' ? v : spec.default;
}

/** Resolves once LaunchDarkly answered (or gave up, after 5 s); non-React code awaits this before reading a flag. */
export function whenFlagsReady(): Promise<void> {
  start();
  return ready ?? Promise.resolve();
}

/** React view of a flag; re-renders when LaunchDarkly changes it. */
export function useFlag(flag: ConsoleFlag): boolean {
  return useSyncExternalStore(subscribe, () => flagEnabled(flag), () => CONSOLE_FLAGS[flag].default);
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests (and a dev console) pin a flag; `undefined` lifts the pin. Never shipped behaviour. */
export function setFlagOverride(flag: ConsoleFlag, value: boolean | undefined): void {
  if (value === undefined) overrides.delete(flag);
  else overrides.set(flag, value);
  listeners.forEach((l) => l());
}

/** PostHog sources (PLAN §22) exist only while `posthog-source` is on. */
export function isPostHogKind(kind: string): boolean {
  return kind === 'posthog' || kind === 'posthog_payload';
}

/** The coverage matrix's PostHog area, shown only while `posthog-source` is on. */
export function isPostHogArea(area: string): boolean {
  return area === 'posthog';
}

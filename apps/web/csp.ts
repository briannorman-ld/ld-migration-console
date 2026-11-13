/**
 * Content-Security-Policy (PLAN §3.4, CLAUDE.md): connect-src is limited to this origin (the
 * static app and the in-browser demo mock under /__demo) plus the StatSig, LD and PostHog API hosts
 * and the LaunchDarkly client SDK hosts the console's own flags come from.
 * No third-party scripts, no analytics. One source of truth for the build-time <meta> tag and
 * the hosting headers (vercel.json, checked by csp.test.ts).
 */
export const CONNECT_HOSTS = [
  'https://statsigapi.net', // Console API (read-only key)
  'https://api.statsigcdn.com', // config spec CDN (Fetch spec)
  'https://app.launchdarkly.com',
  'https://app.eu.launchdarkly.com',
  'https://app.launchdarkly.us',
  // PostHog Cloud (PLAN §22.1): a PostHog project read as a source. Both regions answer CORS
  // themselves, so no relay. Self-hosted PostHog goes through the payload upload instead.
  'https://us.posthog.com',
  'https://eu.posthog.com',
  // The console's own feature flags (apps/web/src/lib/flags.ts): the LaunchDarkly client SDK's
  // flag, stream and event hosts. Anonymous context, no attributes.
  'https://clientsdk.launchdarkly.com',
  'https://clientstream.launchdarkly.com',
  'https://events.launchdarkly.com',
] as const;

// TODO(M0 spike #1): if StatSig's 200 responses lack CORS headers, add the stateless relay's
// origin here, and only here (PLAN §3.1). Ask the user first: it's a server component.

export type CspMode = 'production' | 'development';

export function buildCsp(mode: CspMode, opts: { includeFrameAncestors?: boolean } = {}): string {
  const dev = mode === 'development';
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    // Dev: Vite's React Refresh preamble is an inline script.
    'script-src': ["'self'", ...(dev ? ["'unsafe-inline'"] : [])],
    // Dev: Vite injects CSS through <style> tags. Prod: one external stylesheet.
    'style-src': ["'self'", ...(dev ? ["'unsafe-inline'"] : [])],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...CONNECT_HOSTS, ...(dev ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : [])],
    // Pipeline Web Worker and the demo's MSW service worker, both same-origin.
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'object-src': ["'none'"],
  };
  // frame-ancestors is ignored in <meta>; send it as a header.
  if (opts.includeFrameAncestors) directives['frame-ancestors'] = ["'none'"];
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}

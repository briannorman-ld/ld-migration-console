/**
 * Where a source's key is sent (SECURITY-REVIEW-2026-11-12 L4). A `baseUrl` stored on a source
 * descriptor is honoured only for a demo source, and only when it is this page's own origin: the
 * demo's in-browser mock under `/__demo`. A real source always talks to its region's or instance's
 * API host, whatever the stored descriptor says, so nothing that can write this origin's
 * IndexedDB can redirect a key.
 */
export function demoBaseUrl(source: { isDemo?: boolean }, baseUrl: string | undefined, origin: string = location.origin): string | undefined {
  if (!source.isDemo || !baseUrl) return undefined;
  try {
    return new URL(baseUrl).origin === origin ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the app is served from decides who else can read its IndexedDB. On GitHub Pages every
 * project site of one account shares the origin `<owner>.github.io`, so any other site published
 * there (or any script injected into one) can open this app's database, including the token
 * vault and the device key that decrypts it. On such an origin new workspaces keep tokens in
 * memory only, and the start screen says why. Vercel and a custom domain give the app an origin
 * of its own.
 */
export function isSharedOrigin(hostname: string = globalThis.location?.hostname ?? ''): boolean {
  return /(^|\.)github\.io$/i.test(hostname);
}

export const SHARED_ORIGIN_NOTE =
  'This copy of the app is served from a GitHub Pages origin that other sites share. Tokens are therefore kept in memory only (entered again after a reload) instead of encrypted on this device. For day-to-day use, run the app from an origin of its own.';

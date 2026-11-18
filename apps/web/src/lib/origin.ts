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

/**
 * Whether the page is inside someone else's frame. Vercel sends `frame-ancestors 'none'` as a
 * header, but GitHub Pages cannot send headers and browsers ignore frame-ancestors in a <meta>
 * CSP, so the app checks for itself before rendering (main.tsx). A cross-origin parent makes
 * `window.top` throw, which is also an answer: framed.
 */
export function isFramed(win: { readonly top: unknown; readonly self: unknown } = window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

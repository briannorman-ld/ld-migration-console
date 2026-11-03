/**
 * The environment the workspace screen is showing. Kept per workspace in localStorage, so a
 * reload (or a new tab) comes back to the environment the user was working in instead of
 * falling back to production, the one environment a slip matters most in.
 */
const storageKey = (workspaceId: string) => `ld-migration:env:${workspaceId}`;

export function loadEnv(workspaceId: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(storageKey(workspaceId)) || undefined;
  } catch {
    return undefined;
  }
}

export function saveEnv(workspaceId: string, env: string): void {
  try {
    if (!env) globalThis.localStorage?.removeItem(storageKey(workspaceId));
    else globalThis.localStorage?.setItem(storageKey(workspaceId), env);
  } catch {
    // Storage blocked or full: the choice still lives in memory for this tab.
  }
}

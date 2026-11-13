import type { WorkspaceRecord } from '@sslm/store';
import { connectLd, expectReconnect, reconnectSkipped } from './ld.ts';
import { restoreDeviceVault, secrets, unlockDeviceVault, type Restored } from './secrets.ts';

export interface Reconnected {
  ld: boolean;
  statsig: number;
  ldSources: number;
  phSources: number;
}

/** After tokens come back: reconnect LaunchDarkly (the saved project is kept and re-probed by connectLd). */
function reconnect(workspaceId: string, workspace: WorkspaceRecord, restored: Restored): Reconnected {
  const token = secrets.get('ld', workspaceId);
  if (restored.ld && token) void connectLd(workspaceId, workspace.ld?.instance ?? 'us', token);
  else reconnectSkipped(workspaceId);
  return { ld: restored.ld, statsig: restored.statsig.length, ldSources: restored.ldSources.length, phSources: restored.phSources.length };
}

/** Unlock a passphrase vault and bring the workspace back to where it was. */
export async function unlockAndReconnect(workspaceId: string, workspace: WorkspaceRecord, passphrase: string): Promise<Reconnected> {
  return reconnect(workspaceId, workspace, await unlockDeviceVault(workspaceId, passphrase));
}

/**
 * On workspace open: restore a device vault without a prompt and reconnect LaunchDarkly. The
 * StatSig keys are simply back in memory for the next sync. Undefined when there is nothing to
 * restore (memory only, a passphrase vault, or already open).
 */
export async function restoreAndReconnect(workspaceId: string, workspace: WorkspaceRecord): Promise<Reconnected | undefined> {
  // A workspace that connected LaunchDarkly before, with tokens kept on the device, is about to
  // reconnect: show "connecting" from the first paint rather than "not connected".
  if (workspace.ld && workspace.tokenStorage !== 'memory') expectReconnect(workspaceId);
  try {
    const restored = await restoreDeviceVault(workspaceId);
    if (!restored) reconnectSkipped(workspaceId);
    return restored ? reconnect(workspaceId, workspace, restored) : undefined;
  } catch (e) {
    reconnectSkipped(workspaceId);
    throw e;
  }
}

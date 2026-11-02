import type { WorkspaceRecord } from '@sslm/store';
import { connectLd } from './ld.ts';
import { secrets, unlockDeviceVault } from './secrets.ts';

/**
 * Unlock the device vault and bring the workspace back to where it was: the LD token reconnects
 * (the saved project is kept and re-probed by connectLd), StatSig keys are simply back in memory
 * for the next sync. Returns what was restored, for the confirmation line.
 */
export async function unlockAndReconnect(workspaceId: string, workspace: WorkspaceRecord, passphrase: string): Promise<{ ld: boolean; statsig: number; ldSources: number }> {
  const restored = await unlockDeviceVault(workspaceId, passphrase);
  const token = secrets.get('ld', workspaceId);
  if (restored.ld && token) void connectLd(workspaceId, workspace.ld?.instance ?? 'us', token);
  return { ld: restored.ld, statsig: restored.statsig.length, ldSources: restored.ldSources.length };
}

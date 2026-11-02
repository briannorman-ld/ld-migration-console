/**
 * The migration selection: every item ticked across the explorers (gates, dynamic configs,
 * autotunes, LD-source flags and segments) in one set of uids, so switching views keeps what was
 * picked and one click plans all of it. Uids are `<sourceId>/<kind>/<id>` (canonical model), so
 * the kind is read from the uid. Kept per workspace in sessionStorage: a reload keeps the pick,
 * closing the tab drops it.
 */
import type { MigrationSelection } from './migration.ts';

export type SelectionKind = 'gate' | 'config' | 'autotune' | 'flag' | 'segment';
const KINDS: ReadonlySet<string> = new Set<SelectionKind>(['gate', 'config', 'autotune', 'flag', 'segment']);

export function kindOfUid(uid: string): SelectionKind | undefined {
  const k = uid.split('/')[1];
  return k && KINDS.has(k) ? (k as SelectionKind) : undefined;
}

/** The plan request for a set of uids; uids of other kinds (experiments, say) are left out. */
export function toSelection(uids: Iterable<string>): MigrationSelection {
  const sel: Required<Omit<MigrationSelection, 'contextKinds'>> = { gates: [], configs: [], autotunes: [], flags: [], segments: [] };
  for (const uid of uids) {
    switch (kindOfUid(uid)) {
      case 'gate':
        sel.gates.push(uid);
        break;
      case 'config':
        sel.configs.push(uid);
        break;
      case 'autotune':
        sel.autotunes.push(uid);
        break;
      case 'flag':
        sel.flags.push(uid);
        break;
      case 'segment':
        sel.segments.push(uid);
        break;
    }
  }
  return sel;
}

const NOUN: Record<SelectionKind, [string, string]> = {
  gate: ['gate', 'gates'],
  config: ['dynamic config', 'dynamic configs'],
  autotune: ['autotune', 'autotunes'],
  flag: ['flag', 'flags'],
  segment: ['segment', 'segments'],
};

/** "5 gates, 2 dynamic configs and 1 segment" (kinds in migration order). */
export function describeUids(uids: Iterable<string>): string {
  const counts = new Map<SelectionKind, number>();
  for (const uid of uids) {
    const k = kindOfUid(uid);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = (['segment', 'gate', 'config', 'flag', 'autotune'] as SelectionKind[]).filter((k) => counts.get(k)).map((k) => `${counts.get(k)} ${NOUN[k][counts.get(k) === 1 ? 0 : 1]}`);
  if (parts.length <= 1) return parts[0] ?? 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

const storageKey = (workspaceId: string) => `ld-migration:selection:${workspaceId}`;

export function loadSelection(workspaceId: string): Set<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(storageKey(workspaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && !!kindOfUid(x)) : []);
  } catch {
    return new Set();
  }
}

export function saveSelection(workspaceId: string, uids: Set<string>): void {
  try {
    if (uids.size === 0) globalThis.sessionStorage?.removeItem(storageKey(workspaceId));
    else globalThis.sessionStorage?.setItem(storageKey(workspaceId), JSON.stringify([...uids]));
  } catch {
    // Storage blocked or full: the selection still lives in memory for this tab.
  }
}

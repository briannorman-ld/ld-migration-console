import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import type { ExclusionRecord, IdListRecord } from '@sslm/store';
import { type DecisionPoint, type DecisionType, type IdLists, type MappingProfile, type Resolution, acceptsOption } from '@sslm/mapper';
import { DEMO_ENV_HINTS, DEMO_WORKSPACE_ID } from './demo.ts';
import { useLdSessionData, type LdSession } from './ld.ts';
import { ensureProfile, ldDirectory, mapperCapabilities, type MappingInputs } from './migration.ts';
import { store } from './store.ts';

export interface MigrationContext extends MappingInputs {
  /**
   * The mapping inputs as one object that keeps its identity until one of them changes: what a
   * memo that only maps (the decision list, the monitored items, an explorer's rows) keys on,
   * instead of the context, which is rebuilt on every LD session patch and exclusion too.
   */
  inputs: MappingInputs;
  ld: LdSession;
  /** LD connected with a project chosen and probed: environment mapping is meaningful. */
  connected: boolean;
  ldEnvs: { key: string; name: string; critical: boolean }[];
  resolutionList: Resolution[];
  resolve: (decisions: DecisionPoint[], optionKey: string) => Promise<void>;
  saveResolutions: (rs: Resolution[]) => Promise<void>;
  setPolicy: (type: DecisionType, optionKey: string | null) => Promise<void>;
  clear: (ids: string[]) => Promise<void>;
  saveProfile: (p: MappingProfile) => Promise<void>;
  /** Items set aside ("Don't migrate"), by uid. They stay listed but leave "Select all", the guide counts and plans. */
  exclusions: ReadonlyMap<string, ExclusionRecord>;
  exclude: (uids: string[], reason?: string) => Promise<void>;
  include: (uids: string[]) => Promise<void>;
}

/** Everything the mapper needs, live from IndexedDB and the LD session. `null` until loaded. */
export function useMigration(workspaceId: string, snapshots: CanonicalSnapshot[]): MigrationContext | null {
  // The data view: a probe's steps and a read's page counter do not rebuild the context.
  const ld = useLdSessionData(workspaceId);
  const ldEnvs = useMemo(() => (ld.matrix?.environments ?? []).map((e) => ({ key: e.key, name: e.name, critical: e.critical || /prod/i.test(e.key) })), [ld.matrix]);
  const snapKey = snapshots.map((s) => `${s.source.sourceId}@${s.takenAt}`).join('|');
  const envKey = ldEnvs.map((e) => e.key).join('|');
  useEffect(() => {
    if (snapshots.length) void ensureProfile(workspaceId, snapshots, ldEnvs, workspaceId === DEMO_WORKSPACE_ID ? DEMO_ENV_HINTS : undefined);
  }, [workspaceId, snapKey, envKey]);

  const profile = useLiveQuery(() => store.getProfile(workspaceId), [workspaceId]);
  const resolutionList = useLiveQuery(() => store.listResolutions(workspaceId), [workspaceId]);
  const idListRecs = useLiveQuery(() => store.listIdLists(workspaceId), [workspaceId]);
  const exclusionRecs = useLiveQuery(() => store.listExclusions(workspaceId), [workspaceId]);
  // Time conditions are evaluated against the time the workspace was opened (deterministic per session).
  const [now] = useState(() => new Date().toISOString());

  // Each mapping input keeps its identity until what it is made of changes: the mapping memo
  // (lib/migration.ts) keys on them, and a new identity with the same content re-maps the whole
  // project (seconds of frozen page on a large one). The session's matrix is a new object after
  // every probe and its members and teams after every listing refresh, with the same content
  // nearly every time, so the capabilities, directory and coverage keep their identity while
  // their content is unchanged; the ID lists keep each list's array while that list is unchanged
  // (the memo tracks which lists a mapping looked up).
  const resolutions = useMemo(() => (resolutionList ? new Map(resolutionList.map((r) => [r.id, r])) : undefined), [resolutionList]);
  const exclusions = useMemo(() => (exclusionRecs ? new Map(exclusionRecs.map((r) => [r.uid, r])) : undefined), [exclusionRecs]);
  const capabilities = useStable(useMemo(() => mapperCapabilities(ld.matrix, ld.contextKinds), [ld.matrix, ld.contextKinds]))!;
  const directory = useStable(useMemo(() => ldDirectory(ld), [ld.members, ld.teams, ld.matrix]))!;
  const idLists = useStableIdLists(idListRecs);
  const coverage = useStable(useMemo(() => (idListRecs ? Object.fromEntries(idListRecs.flatMap((r) => (r.coverage ? [[r.uid, r.coverage] as const] : []))) : undefined), [idListRecs]));
  const inputs = useMemo<MappingInputs | undefined>(
    () => (profile && resolutions && idLists && coverage ? { profile, resolutions, capabilities, directory, idLists, coverage, now } : undefined),
    [profile, resolutions, capabilities, directory, idLists, coverage, now],
  );

  return useMemo(() => {
    if (!profile || !resolutionList || !resolutions || !exclusions || !idLists || !coverage || !inputs) return null;
    return {
      ...inputs,
      inputs,
      ld,
      connected: ld.status === 'connected' && !!ld.matrix,
      ldEnvs,
      resolutionList,
      resolve: (decisions, optionKey) => store.saveResolutions(workspaceId, resolutionsFor(decisions, optionKey, new Date().toISOString())),
      saveResolutions: (rs) => store.saveResolutions(workspaceId, rs),
      setPolicy: async (type, optionKey) => {
        const policies = { ...profile.policies };
        if (optionKey) policies[type] = optionKey;
        else delete policies[type];
        await store.saveProfile(workspaceId, { ...profile, policies });
      },
      clear: (ids) => store.deleteResolutions(workspaceId, ids),
      saveProfile: (p) => store.saveProfile(workspaceId, p),
      exclusions,
      exclude: (uids, reason) => store.setExclusions(workspaceId, uids.map((uid) => (reason ? { uid, reason } : { uid }))),
      include: (uids) => store.deleteExclusions(workspaceId, uids),
    };
  }, [profile, resolutionList, resolutions, exclusions, idLists, coverage, inputs, ld, ldEnvs, workspaceId]);
}

/**
 * `value`, keeping the previous one while its content (as JSON) is unchanged. For small inputs
 * whose source object is rebuilt more often than it changes. The JSON is taken once per new
 * object, not per render: the LD directory (every account member) goes through here.
 */
export function useStable<T>(value: T): T {
  const key = useMemo(() => (value === undefined ? '' : JSON.stringify(value)), [value]);
  // The key is the identity that matters here: the same JSON means the same input to the mapper.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => value, [key]);
}

/**
 * The fetched ID lists as the mapper reads them (segment uid → IDs), each list's array kept
 * from the previous result while its record is unchanged (same fetch time and size), and the
 * whole object kept while no list changed. `undefined` until the records have loaded.
 */
export function useStableIdLists(recs: IdListRecord[] | undefined): IdLists | undefined {
  const prev = useRef<{ byUid: Map<string, { stamp: string; ids: string[] }>; value: IdLists }>(undefined);
  return useMemo(() => {
    if (!recs) return undefined;
    const byUid = new Map<string, { stamp: string; ids: string[] }>();
    const value: IdLists = {};
    let changed = !prev.current || prev.current.byUid.size !== recs.length;
    for (const r of recs) {
      const stamp = `${r.fetchedAt}|${r.ids.length}`;
      const old = prev.current?.byUid.get(r.uid);
      const ids = old && old.stamp === stamp ? old.ids : r.ids;
      if (ids !== old?.ids) changed = true;
      byUid.set(r.uid, { stamp, ids });
      value[r.uid] = ids;
    }
    if (!changed && prev.current) return prev.current.value;
    prev.current = { byUid, value };
    return value;
  }, [recs]);
}

/**
 * The resource-scoped resolutions that answer `decisions` with `optionKey`. Decisions that don't
 * take the answer are left out: `acceptsOption`, not the listed options, because a
 * `unit_type_kind` answer may be a kind key or attribute the user typed rather than a listed one.
 */
export function resolutionsFor(decisions: DecisionPoint[], optionKey: string, decidedAt: string): Resolution[] {
  return decisions.filter((d) => acceptsOption(d, optionKey)).map((d) => ({ id: d.id, type: d.type, optionKey, scope: 'resource', fingerprint: d.fingerprint, decidedAt }));
}

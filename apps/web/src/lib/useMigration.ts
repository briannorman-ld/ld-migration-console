import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import type { ExclusionRecord } from '@sslm/store';
import { type DecisionPoint, type DecisionType, type MappingProfile, type Resolution, acceptsOption } from '@sslm/mapper';
import { DEMO_ENV_HINTS, DEMO_WORKSPACE_ID } from './demo.ts';
import { useLdSession, type LdSession } from './ld.ts';
import { ensureProfile, ldDirectory, mapperCapabilities, type MappingInputs } from './migration.ts';
import { store } from './store.ts';

export interface MigrationContext extends MappingInputs {
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
  const ld = useLdSession(workspaceId);
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
  // (lib/migration.ts) keys on them, and the session object `ld` below changes on every probe
  // step, flag refresh and monitoring check, which must not re-map the whole project.
  const resolutions = useMemo(() => (resolutionList ? new Map(resolutionList.map((r) => [r.id, r])) : undefined), [resolutionList]);
  const exclusions = useMemo(() => (exclusionRecs ? new Map(exclusionRecs.map((r) => [r.uid, r])) : undefined), [exclusionRecs]);
  const capabilities = useMemo(() => mapperCapabilities(ld.matrix, ld.contextKinds), [ld.matrix, ld.contextKinds]);
  const directory = useMemo(() => ldDirectory(ld), [ld.members, ld.teams, ld.matrix]);
  const idLists = useMemo(() => (idListRecs ? Object.fromEntries(idListRecs.map((r) => [r.uid, r.ids])) : undefined), [idListRecs]);
  const coverage = useMemo(() => (idListRecs ? Object.fromEntries(idListRecs.flatMap((r) => (r.coverage ? [[r.uid, r.coverage] as const] : []))) : undefined), [idListRecs]);

  return useMemo(() => {
    if (!profile || !resolutionList || !resolutions || !exclusions || !idLists || !coverage) return null;
    return {
      ld,
      connected: ld.status === 'connected' && !!ld.matrix,
      ldEnvs,
      profile,
      resolutions,
      resolutionList,
      capabilities,
      directory,
      idLists,
      coverage,
      now,
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
  }, [profile, resolutionList, resolutions, exclusions, capabilities, directory, idLists, coverage, ld, ldEnvs, now, workspaceId]);
}

/**
 * The resource-scoped resolutions that answer `decisions` with `optionKey`. Decisions that don't
 * take the answer are left out: `acceptsOption`, not the listed options, because a
 * `unit_type_kind` answer may be a kind key or attribute the user typed rather than a listed one.
 */
export function resolutionsFor(decisions: DecisionPoint[], optionKey: string, decidedAt: string): Resolution[] {
  return decisions.filter((d) => acceptsOption(d, optionKey)).map((d) => ({ id: d.id, type: d.type, optionKey, scope: 'resource', fingerprint: d.fingerprint, decidedAt }));
}

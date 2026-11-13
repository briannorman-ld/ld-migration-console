/**
 * PostHog source adapter, read side (PLAN §22.2): everything the console needs from one PostHog
 * project, read with the lenient schemas of client.ts and never written to. The flag list carries
 * the full `filters`, so a 450-flag project is about a dozen requests plus the members of the
 * static and computed cohorts its flags reference.
 */
import { HttpError } from '@sslm/http';
import { PostHogAuthError, type PostHogClient, type PostHogSchemaIssue } from './client.ts';
import type { PhCohort, PhEarlyAccessFeature, PhExperiment, PhFeatureFlag, PhGroupType, PhMember, PhPerson, PhProject, PhPropertyDefinition, PhScheduledChange } from './schemas.ts';

export interface RawPostHogSnapshot {
  kind: 'posthog';
  fetchedAt: string;
  projectId: string;
  project: PhProject;
  organization?: { id: string; name?: string };
  /** Every flag but the deleted ones (the list never returns them); archived ones included. */
  flags: PhFeatureFlag[];
  /** Every cohort but the deleted ones. */
  cohorts: PhCohort[];
  /**
   * Members (persons with their distinct ids) of the static and computed cohorts a flag references,
   * by cohort id. A cohort whose members could not be read is absent; `membersUnreadable` says why.
   */
  cohortMembers: Record<string, PhPerson[]>;
  membersUnreadable: Record<string, string>;
  groupTypes: PhGroupType[];
  propertyDefinitions: PhPropertyDefinition[];
  /** Pending scheduled changes of flags (`executed_at` null). */
  scheduledChanges: PhScheduledChange[];
  earlyAccessFeatures: PhEarlyAccessFeature[];
  experiments: PhExperiment[];
  /** Organization members, for owner emails (the People step). */
  members: PhMember[];
  schemaIssues: PostHogSchemaIssue[];
  /** Reads that failed without failing the whole read (a 403 on one route). */
  skipped: { endpoint: string; reason: string }[];
}

export interface PostHogReadProgress {
  done: number;
  total: number;
  endpoint: string;
}

export interface PostHogReadOptions {
  signal?: AbortSignal;
  onProgress?: (p: PostHogReadProgress) => void;
  /**
   * Most members a cohort may have before the console stops reading them one by one and reports
   * the membership as unreadable (export a CSV from PostHog instead). The persons list filtered by
   * cohort normally returns them in pages of 100, so this only matters when that filter is ignored.
   */
  maxMembersPerCohort?: number;
}

export class PostHogReadAuthError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
    this.name = 'PostHogReadAuthError';
  }
}

/** Cohort ids every flag's condition sets reference (type `cohort` filters, any operator). */
export function referencedCohortIds(flags: PhFeatureFlag[]): Set<string> {
  const out = new Set<string>();
  for (const f of flags) {
    const sets = [...(f.filters?.groups ?? []), ...(f.filters?.super_groups ?? [])];
    for (const s of sets) for (const p of s.properties ?? []) if (p.type === 'cohort' && p.value !== undefined && p.value !== null) out.add(String(p.value));
  }
  return out;
}

/** Cohort ids a cohort's own filters reference (nested cohorts), recursively through the group tree. */
export function nestedCohortIds(cohort: PhCohort): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string | null; values?: unknown[] | null; value?: unknown };
    if (n.type === 'cohort' && n.value !== undefined && n.value !== null) out.add(String(n.value));
    for (const v of n.values ?? []) walk(v);
  };
  walk(cohort.filters?.properties);
  return out;
}

/** Read one PostHog project. A 401/403 on the project itself is an auth error; later 403s are skipped routes. */
export async function readPostHogProject(client: PostHogClient, projectId: string, opts: PostHogReadOptions = {}): Promise<RawPostHogSnapshot> {
  const skipped: RawPostHogSnapshot['skipped'] = [];
  const schemaIssues: PostHogSchemaIssue[] = [];
  const onIssue = (client as unknown as { onSchemaIssue?: (i: PostHogSchemaIssue) => void }).onSchemaIssue;
  void onIssue;
  let done = 0;
  let total = 9;
  const progress = (endpoint: string) => opts.onProgress?.({ done, total, endpoint });
  const base = `/api/projects/${projectId}`;

  progress(`${base}/`);
  let project: PhProject;
  try {
    project = await client.getProject(projectId, opts.signal);
  } catch (e) {
    throw new PostHogReadAuthError(`Could not read PostHog project “${projectId}”: ${(e as Error).message}`, e);
  }
  done++;

  // Optional routes: a key without the scope skips the route and the snapshot says so.
  const optional = async <T>(endpoint: string, read: () => Promise<T>, empty: T): Promise<T> => {
    progress(endpoint);
    try {
      return await read();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      skipped.push({ endpoint, reason: reason(e) });
      return empty;
    } finally {
      done++;
    }
  };

  progress(`${base}/feature_flags/`);
  const flags = await client.listFeatureFlags(projectId, { signal: opts.signal, onPage: (read, count) => opts.onProgress?.({ done, total, endpoint: `${base}/feature_flags/ (${read}${count ? `/${count}` : ''})` }) });
  done++;
  // The listing order is PostHog's (by creation); keep snapshots deterministic.
  flags.sort((a, b) => a.key.localeCompare(b.key) || a.id - b.id);

  const cohorts = (await optional(`${base}/cohorts/`, () => client.listCohorts(projectId, opts.signal), [] as PhCohort[])).filter((c) => !c.deleted).sort((a, b) => a.id - b.id);
  const groupTypes = (await optional(`${base}/groups_types/`, () => client.listGroupTypes(projectId, opts.signal), [] as PhGroupType[])).sort((a, b) => a.group_type_index - b.group_type_index);

  const propertyDefinitions: PhPropertyDefinition[] = await optional(`${base}/property_definitions/?type=person`, () => client.listPropertyDefinitions(projectId, { type: 'person', signal: opts.signal }), [] as PhPropertyDefinition[]);
  total += groupTypes.length;
  for (const g of groupTypes) {
    const defs = await optional(`${base}/property_definitions/?type=group&group_type_index=${g.group_type_index}`, () => client.listPropertyDefinitions(projectId, { type: 'group', groupTypeIndex: g.group_type_index, signal: opts.signal }), [] as PhPropertyDefinition[]);
    for (const d of defs) propertyDefinitions.push({ ...d, type: 'group', group_type_index: d.group_type_index ?? g.group_type_index });
  }

  const scheduledChanges = (await optional(`${base}/scheduled_changes/`, () => client.listScheduledChanges(projectId, opts.signal), [] as PhScheduledChange[])).filter((s) => !s.executed_at && (s.model_name ?? 'FeatureFlag') === 'FeatureFlag');
  const earlyAccessFeatures = await optional(`${base}/early_access_feature/`, () => client.listEarlyAccessFeatures(projectId, opts.signal), [] as PhEarlyAccessFeature[]);
  const experiments = await optional(`${base}/experiments/`, () => client.listExperiments(projectId, opts.signal), [] as PhExperiment[]);

  const orgId = project.organization ?? undefined;
  const members = orgId ? await optional(`/api/organizations/${orgId}/members/`, () => client.listMembers(orgId, opts.signal), [] as PhMember[]) : [];
  if (!orgId) done++;

  // Members of the static and computed cohorts the flags (and their nested cohorts) reference.
  const byId = new Map(cohorts.map((c) => [String(c.id), c]));
  const wanted = new Set<string>();
  const queue = [...referencedCohortIds(flags)];
  while (queue.length) {
    const cid = queue.shift()!;
    if (wanted.has(cid)) continue;
    wanted.add(cid);
    const c = byId.get(cid);
    if (c) for (const n of nestedCohortIds(c)) queue.push(n);
  }
  const listCohorts = [...wanted].map((cid) => byId.get(cid)).filter((c): c is PhCohort => !!c && needsMembers(c));
  total += listCohorts.length;
  const cohortMembers: Record<string, PhPerson[]> = {};
  const membersUnreadable: Record<string, string> = {};
  const cap = opts.maxMembersPerCohort ?? 5000;
  for (const c of listCohorts) {
    const endpoint = `${base}/cohorts/${c.id}/persons/`;
    progress(endpoint);
    try {
      cohortMembers[String(c.id)] = await readMembers(client, projectId, c, cap, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (e instanceof TooManyMembers) membersUnreadable[String(c.id)] = e.message;
      else {
        membersUnreadable[String(c.id)] = reason(e);
        skipped.push({ endpoint, reason: reason(e) });
      }
    }
    done++;
  }
  progress('done');

  return {
    kind: 'posthog',
    fetchedAt: new Date().toISOString(),
    projectId,
    project,
    ...(orgId ? { organization: { id: orgId } } : {}),
    flags,
    cohorts,
    cohortMembers,
    membersUnreadable,
    groupTypes,
    propertyDefinitions,
    scheduledChanges,
    earlyAccessFeatures,
    experiments,
    members,
    schemaIssues,
    skipped,
  };
}

/** Static cohorts and computed (behavioral, realtime, analytical) ones have a member list; property cohorts have rules. */
export function needsMembers(c: PhCohort): boolean {
  if (c.is_static) return true;
  const t = c.cohort_type ?? '';
  return t === 'behavioral' || t === 'realtime' || t === 'analytical';
}

class TooManyMembers extends Error {}

/**
 * The cohort's members with their distinct ids. `/cohorts/{id}/persons/` names the members but
 * has no distinct ids; `/persons/?cohort=` has them but is not in the published schema, so its
 * result is checked against the member list and any member it missed is read on its own.
 */
async function readMembers(client: PostHogClient, projectId: string, c: PhCohort, cap: number, signal?: AbortSignal): Promise<PhPerson[]> {
  const actors = await client.listCohortPersons(projectId, c.id, signal);
  if (actors.length > cap) throw new TooManyMembers(`${actors.length.toLocaleString('en-US')} members; more than the console reads from the API (${cap.toLocaleString('en-US')}). Export the cohort as CSV in PostHog and import it into the LaunchDarkly segment.`);
  const wanted = new Map<string, (typeof actors)[number]>();
  for (const a of actors) {
    wanted.set(a.id, a);
    if (a.uuid) wanted.set(a.uuid, a);
  }
  const out = new Map<string, PhPerson>();
  let filtered: PhPerson[] = [];
  try {
    filtered = await client.listPersonsInCohort(projectId, c.id, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // The persons list may be closed to this key; the per-person reads below still work.
  }
  for (const p of filtered) {
    const hit = wanted.get(p.id) ?? (p.uuid ? wanted.get(p.uuid) : undefined);
    if (hit) out.set(hit.id, p);
  }
  for (const a of actors) {
    if (out.has(a.id)) continue;
    const p = await client.getPerson(projectId, a.id, signal);
    if (p) out.set(a.id, p);
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function reason(e: unknown): string {
  if (e instanceof PostHogAuthError) return `HTTP ${e.status} (missing scope)`;
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  return (e as Error).message;
}

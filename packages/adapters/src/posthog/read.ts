/**
 * PostHog source adapter, read side (PLAN §22.2): everything the console needs from one PostHog
 * project, read with the lenient schemas of client.ts and never written to. The flag list carries
 * the full `filters`, so a 450-flag project is about a dozen requests plus the members of the
 * static and computed cohorts its flags reference (a page of 1,000 persons per request; see
 * `readMembers` for the cap and the fallback when the persons filter is ignored).
 */
import { HttpError } from '@sslm/http';
import { POSTHOG_PERSONS_PAGE, PostHogAuthError, type PostHogClient, type PostHogSchemaIssue } from './client.ts';
import type { PhCohort, PhEarlyAccessFeature, PhExperiment, PhFeatureFlag, PhGroupType, PhMember, PhPerson, PhPersonActor, PhProject, PhPropertyDefinition, PhScheduledChange } from './schemas.ts';

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
   * Most members a cohort may have before the console reports its membership as unreadable
   * (export the cohort as CSV in PostHog and import it into the LaunchDarkly segment) instead of
   * reading it. Default `DEFAULT_MAX_MEMBERS_PER_COHORT` (100,000): at 1,000 members a page that
   * is 100 requests, a quarter of the per-key minute budget, and the mapper already turns lists
   * above 15,000 ids into big segments, so the cap is about the console's time, not LD's limits.
   * A cohort whose own `count` is above it is refused before any member request.
   */
  maxMembersPerCohort?: number;
  /**
   * Most members read one by one (`GET /persons/{id}/`) when the server ignored the `cohort`
   * filter of the persons list and the actor list is the only way to the distinct ids. Default
   * `DEFAULT_MAX_SINGLE_PERSON_READS` (500); beyond it the membership is reported unreadable.
   */
  maxSinglePersonReads?: number;
}

export const DEFAULT_MAX_MEMBERS_PER_COHORT = 100_000;
export const DEFAULT_MAX_SINGLE_PERSON_READS = 500;

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
  const limits: MemberLimits = { cap: opts.maxMembersPerCohort ?? DEFAULT_MAX_MEMBERS_PER_COHORT, singleReads: opts.maxSinglePersonReads ?? DEFAULT_MAX_SINGLE_PERSON_READS };
  for (const c of listCohorts) {
    const endpoint = `${base}/persons/?cohort=${c.id}`;
    progress(endpoint);
    try {
      const r = await readMembers(client, projectId, c, limits, opts.signal, (detail) => progress(`${endpoint} ${detail}`));
      if (r.kind === 'members') cohortMembers[String(c.id)] = r.members;
      else membersUnreadable[String(c.id)] = r.reason;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      membersUnreadable[String(c.id)] = reason(e);
      skipped.push({ endpoint, reason: reason(e) });
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

interface MemberLimits {
  cap: number;
  singleReads: number;
}

type MembersResult = { kind: 'members'; members: PhPerson[] } | { kind: 'unreadable'; reason: string };

const fmt = (x: number) => x.toLocaleString('en-US');
const CSV_HINT = 'Export the cohort as CSV in PostHog and import it into the LaunchDarkly segment.';

/**
 * The cohort's members with their distinct ids, at scale (PLAN §22.2):
 *
 * 1. The cohort's own `count` refuses a cohort above the cap before any member request (the count
 *    is PostHog's last calculation; while `is_calculating` it may be stale, which the progress
 *    string says).
 * 2. `/persons/?cohort=<id>` is paged at 1,000 (the route's maximum), with progress per page and
 *    the AbortSignal honoured between pages (the transport honours it within one). Reading past
 *    the cap stops with an "unreadable" result, not an error.
 * 3. That filter is not in the published schema. It is judged ignored when the envelope `count`
 *    differs from the cohort's known `count`, when the list is empty although the cohort is not,
 *    or (count unknown or being recalculated) when the filtered total equals the project's whole
 *    person count, probed with one `/persons/?limit=1`. Then `/cohorts/{id}/persons/` names the
 *    members (actors without distinct ids): persons already read that match an actor are kept and
 *    the rest are read one by one with `GET /persons/{id}/`, up to `singleReads`.
 */
async function readMembers(client: PostHogClient, projectId: string, c: PhCohort, limits: MemberLimits, signal: AbortSignal | undefined, detail: (s: string) => void): Promise<MembersResult> {
  const calculating = c.is_calculating === true;
  const declared = typeof c.count === 'number' ? c.count : undefined;
  const known = calculating ? undefined : declared;
  const state = calculating ? ' (recalculating)' : '';
  if (declared !== undefined && declared > limits.cap) {
    return { kind: 'unreadable', reason: `${fmt(declared)} members${calculating ? ' at the last calculation' : ''}; more than the console reads from the API (${fmt(limits.cap)}). ${CSV_HINT}` };
  }

  // 2. The filtered persons list, a page at a time.
  const filtered: PhPerson[] = [];
  let envelopeCount: number | undefined;
  let filterIgnored = false;
  let offset = 0;
  for (let guard = 0; guard < 1000; guard++) {
    if (signal?.aborted) throw abortError(signal);
    const page = await client.listPersonsPage(projectId, { cohortId: c.id, limit: POSTHOG_PERSONS_PAGE, offset, signal });
    filtered.push(...page.results);
    envelopeCount ??= page.count;
    detail(`(${fmt(filtered.length)}/${fmt(envelopeCount ?? known ?? declared ?? filtered.length)})${state}`);
    // 3. Mismatch against the cohort's own count: the server ignored the filter. Stop paging now;
    // the project's whole person list is not what we want and may be far larger than the cohort.
    if (known !== undefined && envelopeCount !== undefined && envelopeCount !== known) {
      filterIgnored = true;
      break;
    }
    if (filtered.length > limits.cap || (envelopeCount !== undefined && envelopeCount > limits.cap)) {
      return { kind: 'unreadable', reason: `${fmt(Math.max(filtered.length, envelopeCount ?? 0))} members; more than the console reads from the API (${fmt(limits.cap)}). ${CSV_HINT}` };
    }
    // A server may clamp `limit` below what was asked (the schema says 1,000; Cloud is unverified), so
    // a short page is not the end: only a missing `next` or an empty page is.
    if (!page.next || page.results.length === 0) break;
    offset += page.results.length;
  }
  if (!filterIgnored && filtered.length === 0 && (known ?? declared ?? 0) > 0) filterIgnored = true;
  if (!filterIgnored && known === undefined && filtered.length > 0) {
    // No trustworthy count to compare with: the filter was ignored if it returned everyone.
    const probe = await client.listPersonsPage(projectId, { limit: 1, signal });
    if (probe.count !== undefined && probe.count > 0 && probe.count === (envelopeCount ?? filtered.length)) filterIgnored = true;
  }
  if (!filterIgnored) return { kind: 'members', members: dedupe(filtered) };

  // Fallback: the actor list names the members; distinct ids come from what was read, else one by one.
  detail(`(the cohort filter was ignored; reading /cohorts/${c.id}/persons/)${state}`);
  const actors = await client.listCohortPersons(projectId, c.id, { signal, onPage: (read) => detail(`(${fmt(read)} members named)${state}`) });
  if (actors.length > limits.cap) return { kind: 'unreadable', reason: `${fmt(actors.length)} members; more than the console reads from the API (${fmt(limits.cap)}). ${CSV_HINT}` };
  const byKey = new Map<string, PhPerson>();
  for (const p of filtered) {
    byKey.set(p.id, p);
    if (p.uuid) byKey.set(p.uuid, p);
  }
  const out = new Map<string, PhPerson>();
  const missing: PhPersonActor[] = [];
  for (const a of actors) {
    const hit = byKey.get(a.id) ?? (a.uuid ? byKey.get(a.uuid) : undefined);
    if (hit) out.set(a.id, hit);
    else missing.push(a);
  }
  if (missing.length > limits.singleReads) {
    return { kind: 'unreadable', reason: `${fmt(actors.length)} members, ${fmt(missing.length)} of them readable only one by one because the persons list ignored the cohort filter; more than the console reads that way (${fmt(limits.singleReads)}). ${CSV_HINT}` };
  }
  for (const [i, a] of missing.entries()) {
    if (signal?.aborted) throw abortError(signal);
    detail(`(${fmt(out.size)}/${fmt(actors.length)}, reading member ${fmt(i + 1)} of ${fmt(missing.length)} singly)${state}`);
    const p = (await client.getPerson(projectId, a.id, signal)) ?? (a.uuid && a.uuid !== a.id ? await client.getPerson(projectId, a.uuid, signal) : null);
    if (p) out.set(a.id, p);
  }
  return { kind: 'members', members: [...out.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

/** A paged list can repeat a person when the list shifts under it; keep one per id, sorted. */
function dedupe(persons: PhPerson[]): PhPerson[] {
  const out = new Map<string, PhPerson>();
  for (const p of persons) if (!out.has(p.id)) out.set(p.id, p);
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function reason(e: unknown): string {
  if (e instanceof PostHogAuthError) return `HTTP ${e.status} (missing scope)`;
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  return (e as Error).message;
}

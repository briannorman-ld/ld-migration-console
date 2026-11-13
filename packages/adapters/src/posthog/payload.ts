/**
 * The uploaded PostHog local-evaluation payload (PLAN §22.1 "Two input modes"): the JSON a server
 * SDK polls from `GET /flags/definitions?token=<project token>&send_cohorts`, i.e.
 * `{ flags, group_type_mapping, cohorts }`. It carries every active flag's full `filters` and the
 * property-based cohorts inlined as filter trees, but no archived or deleted flags, no static-cohort
 * members, no tags, owners, timestamps or scheduled changes. The counterpart of the StatSig
 * config-spec upload; it goes through the same normalizer as the API read.
 */
import type { CanonicalSnapshot, SourceRef } from '@sslm/canonical';
import { normalizePostHogSnapshot, POSTHOG_PAYLOAD_MISSING_FIELDS } from './normalize.ts';
import { referencedCohortIds, type RawPostHogSnapshot } from './read.ts';
import { PhLocalEvaluationPayloadSchema, type PhCohort, type PhGroupType } from './schemas.ts';

export class PostHogPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostHogPayloadError';
  }
}

export interface ParsePostHogPayloadOptions {
  source: SourceRef & { alias: string };
  takenAt?: string;
  /** Names the single environment; the payload does not name its project. */
  projectName?: string;
}

/** Largest payload the console reads (the flag API itself caps a flag's filters at 512 KB). */
export const MAX_POSTHOG_PAYLOAD_BYTES = 50 * 1024 * 1024;

export function parsePostHogPayload(json: unknown, opts: ParsePostHogPayloadOptions): CanonicalSnapshot {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new PostHogPayloadError('This file is not a PostHog local-evaluation payload (expected a JSON object with a “flags” list).');
  const obj = json as Record<string, unknown>;
  if ('featureFlags' in obj || 'flags' in obj && !Array.isArray(obj.flags) && typeof obj.flags === 'object') {
    throw new PostHogPayloadError('This is a client /flags (or /decide) response, which holds evaluated values for one user, not the flag definitions. Download GET /flags/definitions?token=<project token>&send_cohorts with a personal or project secret key instead.');
  }
  if (!Array.isArray(obj.flags)) throw new PostHogPayloadError('This file has no “flags” list. Download GET /flags/definitions?token=<project token>&send_cohorts with a personal or project secret key.');
  const parsed = PhLocalEvaluationPayloadSchema.safeParse(obj);
  const issues: RawPostHogSnapshot['schemaIssues'] = [];
  let payload: ReturnType<typeof PhLocalEvaluationPayloadSchema.parse>;
  if (parsed.success) payload = parsed.data;
  else {
    // Keep the flags that parse; report the rest.
    issues.push({ path: 'payload', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const flags = (obj.flags as unknown[]).map((f) => PhLocalEvaluationPayloadSchema.shape.flags.element.safeParse(f)).filter((r) => r.success).map((r) => r.data);
    const cohorts = PhLocalEvaluationPayloadSchema.shape.cohorts.safeParse(obj.cohorts);
    const mapping = PhLocalEvaluationPayloadSchema.shape.group_type_mapping.safeParse(obj.group_type_mapping);
    payload = { flags, cohorts: cohorts.success ? cohorts.data : undefined, group_type_mapping: mapping.success ? mapping.data : undefined } as typeof payload;
    if (flags.length === 0) throw new PostHogPayloadError('None of the entries in “flags” looks like a PostHog flag definition.');
  }

  const flags = payload.flags.filter((f) => !f.deleted);
  const groupTypes: PhGroupType[] = Object.entries(payload.group_type_mapping ?? {})
    .map(([index, name]) => ({ group_type: name, group_type_index: Number(index) }))
    .filter((g) => Number.isInteger(g.group_type_index))
    .sort((a, b) => a.group_type_index - b.group_type_index);

  // Inlined cohorts are property cohorts; a referenced cohort the payload lacks is a static (or computed) one whose members a payload never has.
  const cohorts: PhCohort[] = [];
  const membersUnreadable: Record<string, string> = {};
  for (const [id, group] of Object.entries(payload.cohorts ?? {})) cohorts.push({ id: Number(id), name: `Cohort ${id}`, cohort_type: 'person_property', is_static: false, filters: { properties: group } });
  for (const id of referencedCohortIds(flags)) {
    if (cohorts.some((c) => String(c.id) === id)) continue;
    cohorts.push({ id: Number(id), name: `Cohort ${id}`, cohort_type: 'static', is_static: true });
    membersUnreadable[id] = 'static-cohort members are not part of a local-evaluation payload; export the cohort as CSV in PostHog';
  }
  cohorts.sort((a, b) => a.id - b.id);

  const projectName = opts.projectName?.trim() || 'PostHog payload';
  const raw: RawPostHogSnapshot = {
    kind: 'posthog',
    fetchedAt: opts.takenAt ?? new Date().toISOString(),
    projectId: String((flags[0] as { team_id?: number } | undefined)?.team_id ?? ''),
    project: { id: Number((flags[0] as { team_id?: number } | undefined)?.team_id ?? 0), name: projectName },
    flags,
    cohorts,
    cohortMembers: {},
    membersUnreadable,
    groupTypes,
    propertyDefinitions: [],
    scheduledChanges: [],
    earlyAccessFeatures: [],
    experiments: [],
    members: [],
    schemaIssues: issues,
    skipped: [],
  };
  const snap = normalizePostHogSnapshot(raw, { source: opts.source, ...(opts.takenAt ? { takenAt: opts.takenAt } : {}), environmentName: projectName, missingFields: POSTHOG_PAYLOAD_MISSING_FIELDS });
  snap.warnings.push({ code: 'partial_spec', path: 'payload', message: 'A local-evaluation payload has no archived flags, static-cohort members, tags, owners, scheduled changes or property types; connect the API for those.' });
  return snap;
}

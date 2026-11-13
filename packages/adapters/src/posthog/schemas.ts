/**
 * Lenient Zod schemas for the PostHog API responses the adapter reads (PLAN §22.2). Field names
 * come from reference/posthog/openapi.yaml.gz (FeatureFlag, Cohort, GroupType, PropertyDefinition,
 * ScheduledChange, Person) and, for the `filters` document, from the Rust flags service
 * (reference/posthog/server-flag_models.rs, server-property_models.rs). Unknown fields pass
 * through; a field in an unexpected shape becomes a snapshot warning, never a crash.
 */
import { z } from 'zod';

const optStr = z.string().nullish();
const optBool = z.boolean().nullish();
const optNum = z.number().nullish();
/** PostHog ids are integers in most routes and strings in a few (`record_id`, flag-dependency keys). */
const id = z.union([z.number(), z.string()]);

/** `{ count, next, previous, results }`, PostHog's list envelope. */
export const pagedSchema = <S extends z.ZodType>(item: S) =>
  z.looseObject({
    count: optNum,
    next: optStr,
    previous: optStr,
    results: z.array(item),
  });

export const PhUserBasicSchema = z.looseObject({
  id: optNum,
  uuid: optStr,
  distinct_id: optStr,
  first_name: optStr,
  last_name: optStr,
  email: optStr,
});

export const PhOrganizationBasicSchema = z.looseObject({ id: z.string(), name: optStr, slug: optStr });

/** `GET /api/users/@me/`. */
export const PhMeSchema = z.looseObject({
  uuid: optStr,
  email: optStr,
  first_name: optStr,
  organization: PhOrganizationBasicSchema.nullish(),
  organizations: z.array(PhOrganizationBasicSchema).nullish(),
  /** The project the UI last opened; irrelevant here but harmless. */
  team: z.looseObject({ id: optNum, name: optStr }).nullish(),
});
export type PhMe = z.output<typeof PhMeSchema>;

/** `GET /api/organizations/{id}/projects/` items and `GET /api/projects/{id}/`. */
export const PhProjectSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  organization: optStr,
  timezone: optStr,
  created_at: optStr,
  updated_at: optStr,
  /** The public project token (`phc_…`), not a secret; the payload route takes it as `token`. */
  api_token: optStr,
});
export type PhProject = z.output<typeof PhProjectSchema>;

/** `GET /api/organizations/{id}/members/` items. */
export const PhMemberSchema = z.looseObject({
  id: optStr,
  user: PhUserBasicSchema.nullish(),
  level: optNum,
  joined_at: optStr,
});
export type PhMember = z.output<typeof PhMemberSchema>;

// ---------------------------------------------------------------------------------------------
// Flags and their `filters` document
// ---------------------------------------------------------------------------------------------

/**
 * One property filter of a condition set (server-property_models.rs `PropertyFilter`). `operator`
 * absent means `exact`; `type` absent means `person`. `value` is anything: a string, a number, a
 * boolean, a list, or null for `is_set` / `is_not_set`.
 */
export const PhPropertyFilterSchema = z.looseObject({
  key: z.union([z.string(), z.number()]).transform(String),
  value: z.unknown().optional(),
  operator: optStr,
  type: optStr,
  group_type_index: optNum,
  negation: optBool,
  /** Flag dependencies: the parent flag keys, outermost first (an annotation; the adapter ignores it). */
  dependency_chain: z.array(z.string()).nullish(),
});
export type PhPropertyFilter = z.output<typeof PhPropertyFilterSchema>;

/** A condition set (`filters.groups[i]`, `FlagPropertyGroup`). */
export const PhConditionSetSchema = z.looseObject({
  properties: z.array(PhPropertyFilterSchema).nullish(),
  rollout_percentage: optNum,
  variant: optStr,
  aggregation_group_type_index: optNum,
});
export type PhConditionSet = z.output<typeof PhConditionSetSchema>;

export const PhVariantSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  rollout_percentage: z.number().nullish(),
});

export const PhFlagFiltersSchema = z.looseObject({
  groups: z.array(PhConditionSetSchema).nullish(),
  multivariate: z.looseObject({ variants: z.array(PhVariantSchema).nullish() }).nullish(),
  /** Flag-level: a group-targeted flag. Per-set indexes override it (mixed targeting). */
  aggregation_group_type_index: optNum,
  /** `{ "true": json }` for boolean flags, `{ "<variant key>": json }` for multivariate ones; values are usually JSON-encoded strings. */
  payloads: z.record(z.string(), z.unknown()).nullish(),
  /** Early-access enrollment (`$feature_enrollment/<key>`) overrides every set. */
  feature_enrollment: optBool,
  /** Legacy form of the same thing: condition sets on the enrollment property. */
  super_groups: z.array(PhConditionSetSchema).nullish(),
  holdout: z.looseObject({ id: id.nullish(), exclusion_percentage: optNum }).nullish(),
  /** Legacy holdout form, kept only to report it. */
  holdout_groups: z.array(z.unknown()).nullish(),
  /** "Stop evaluation at first matching condition set". */
  early_exit: optBool,
});
export type PhFlagFilters = z.output<typeof PhFlagFiltersSchema>;

/** `GET /api/projects/{id}/feature_flags/` items (also what `/flags/definitions` carries, minus the read-only blocks). */
export const PhFeatureFlagSchema = z.looseObject({
  id: z.number(),
  key: z.string(),
  /** Holds the DESCRIPTION; the field name is kept for backwards compatibility (the API schema says so). */
  name: optStr,
  filters: PhFlagFiltersSchema.nullish(),
  deleted: optBool,
  active: optBool,
  archived: optBool,
  created_by: PhUserBasicSchema.nullish(),
  created_at: optStr,
  updated_at: optStr,
  version: optNum,
  ensure_experience_continuity: optBool,
  experiment_set: z.array(id).nullish(),
  /** Linked surveys (read-only): a non-empty value marks a survey's backing flag. */
  surveys: z.unknown().optional(),
  /** Linked early-access features (read-only): a list in practice, an object in the schema. */
  features: z.unknown().optional(),
  tags: z.array(z.unknown()).nullish(),
  evaluation_runtime: optStr,
  evaluation_contexts: z.array(z.string()).nullish(),
  bucketing_identifier: optStr,
  is_remote_configuration: optBool,
  has_encrypted_payloads: optBool,
  status: optStr,
  last_called_at: optStr,
});
export type PhFeatureFlag = z.output<typeof PhFeatureFlagSchema>;

// ---------------------------------------------------------------------------------------------
// Cohorts, persons, group types, property definitions, scheduled changes
// ---------------------------------------------------------------------------------------------

/** A cohort filter group: `{ type: AND|OR, values: [filter | group] }`, recursive. */
export interface PhPropertyGroup {
  type?: string | null;
  values?: (PhPropertyGroup | PhPropertyFilter)[] | null;
  [k: string]: unknown;
}
export const PhPropertyGroupSchema: z.ZodType<PhPropertyGroup> = z.lazy(() =>
  z.looseObject({
    type: optStr,
    values: z.array(z.union([PhPropertyGroupSchema, PhPropertyFilterSchema])).nullish(),
  }),
) as unknown as z.ZodType<PhPropertyGroup>;

export const PhCohortSchema = z.looseObject({
  id: z.number(),
  name: optStr,
  description: optStr,
  deleted: optBool,
  is_static: optBool,
  /** `static`, `person_property`, `behavioral`, `realtime`, `analytical`. */
  cohort_type: optStr,
  filters: z.looseObject({ properties: PhPropertyGroupSchema.nullish(), filterTestAccounts: optBool }).nullish(),
  /** Legacy form of `filters` (a list of `{ properties: [...] }`). */
  groups: z.unknown().optional(),
  count: optNum,
  is_calculating: optBool,
  created_by: PhUserBasicSchema.nullish(),
  created_at: optStr,
  last_calculation: optStr,
  version: optNum,
  experiment_set: z.array(id).nullish(),
});
export type PhCohort = z.output<typeof PhCohortSchema>;

/** `GET /api/projects/{id}/cohorts/{id}/persons/` items: person actors, without distinct ids. */
export const PhPersonActorSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  uuid: optStr,
  type: optStr,
  name: optStr,
  properties: z.record(z.string(), z.unknown()).nullish(),
});
export type PhPersonActor = z.output<typeof PhPersonActorSchema>;

/** `GET /api/projects/{id}/persons/` items and `GET /persons/{id}/`. */
export const PhPersonSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  uuid: optStr,
  name: optStr,
  distinct_ids: z.array(z.string()).nullish(),
  properties: z.record(z.string(), z.unknown()).nullish(),
  created_at: optStr,
});
export type PhPerson = z.output<typeof PhPersonSchema>;

export const PhGroupTypeSchema = z.looseObject({
  group_type: z.string(),
  group_type_index: z.number(),
  name_singular: optStr,
  name_plural: optStr,
});
export type PhGroupType = z.output<typeof PhGroupTypeSchema>;

export const PhPropertyDefinitionSchema = z.looseObject({
  id: optStr,
  name: z.string(),
  is_numerical: optBool,
  /** `String`, `Numeric`, `Boolean`, `DateTime`, `Duration`, or null when PostHog has not inferred it. */
  property_type: optStr,
  type: optStr,
  group_type_index: optNum,
  tags: z.array(z.string()).nullish(),
});
export type PhPropertyDefinition = z.output<typeof PhPropertyDefinitionSchema>;

export const PhScheduledChangeSchema = z.looseObject({
  id: z.number(),
  record_id: id.transform(String),
  model_name: optStr,
  payload: z.looseObject({ operation: optStr, value: z.unknown().optional() }).nullish(),
  scheduled_at: optStr,
  executed_at: optStr,
  failure_reason: optStr,
  recurrence_rule: optStr,
  is_recurring: optBool,
  created_by: PhUserBasicSchema.nullish(),
});
export type PhScheduledChange = z.output<typeof PhScheduledChangeSchema>;

export const PhEarlyAccessFeatureSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  name: optStr,
  stage: optStr,
  feature_flag: z.looseObject({ id: optNum, key: optStr }).nullish(),
});
export type PhEarlyAccessFeature = z.output<typeof PhEarlyAccessFeatureSchema>;

export const PhExperimentSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  name: optStr,
  feature_flag_key: optStr,
  feature_flag: z.looseObject({ id: optNum, key: optStr }).nullish(),
  start_date: optStr,
  end_date: optStr,
  archived: optBool,
});
export type PhExperiment = z.output<typeof PhExperimentSchema>;

// ---------------------------------------------------------------------------------------------
// The local-evaluation payload (`GET /flags/definitions?token=…&send_cohorts`)
// ---------------------------------------------------------------------------------------------

export const PhLocalEvaluationPayloadSchema = z.looseObject({
  flags: z.array(PhFeatureFlagSchema),
  group_type_mapping: z.record(z.string(), z.string()).nullish(),
  /** Cohort id → property group; only property-based cohorts are included. */
  cohorts: z.record(z.string(), PhPropertyGroupSchema).nullish(),
});
export type PhLocalEvaluationPayload = z.output<typeof PhLocalEvaluationPayloadSchema>;

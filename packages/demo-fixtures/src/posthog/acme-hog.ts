/**
 * "Acme Hog": a PostHog project the demo attaches as a *source* (PLAN §22). Shapes are PostHog REST
 * API responses (reference/posthog/openapi.yaml.gz: FeatureFlag, Cohort, GroupType,
 * EnterprisePropertyDefinition, ScheduledChange, PersonListRecord, SerializedPersonActor,
 * OrganizationMember, ProjectBackwardCompat, User), with the `filters` document shaped as
 * reference/posthog/server-flag_models.rs (FlagFilters, FlagPropertyGroup, MultivariateFlagOptions)
 * and reference/posthog/server-property_models.rs (PropertyFilter, OperatorType) read it. Served by
 * the MSW mock in ../msw/posthog-api.ts. Each flag exercises one PostHog construct (PLAN §22.3).
 *
 * Conventions that differ from LD: PostHog's `key` is the display key and its `name` field holds the
 * DESCRIPTION; `payloads` values are JSON-encoded strings; a cohort filter is `{ key: 'id', type:
 * 'cohort', value: <cohort id> }`; a flag dependency is `{ key: '<flag id>', type: 'flag', operator:
 * 'flag_evaluates_to', value: true | false | '<variant key>' }`.
 */
import type { Json, JsonObject } from '../console/builders.ts';

export const ACME_HOG_PROJECT_ID = '4242';
export const ACME_HOG_ORG_ID = '018f3a2b-9c7d-7e11-8a3b-acme0hog0001';

export interface PostHogProjectFixture {
  /** OrganizationBasic shape. */
  organization: JsonObject;
  /** `GET /api/users/@me/` (User shape, trimmed to what the console reads). */
  user: JsonObject;
  /** `GET /api/projects/{id}/` (ProjectBackwardCompat shape; also the list item). */
  project: JsonObject;
  /** `GET /api/organizations/{id}/members/` items (OrganizationMember shape). */
  members: JsonObject[];
  /** `GET /api/projects/{id}/groups_types/` (GroupType shape, bare array). */
  groupTypes: JsonObject[];
  /** `GET /api/projects/{id}/property_definitions/` items (EnterprisePropertyDefinition shape). */
  propertyDefinitions: JsonObject[];
  /** Full flags (FeatureFlag shape); deleted and archived ones included. */
  flags: JsonObject[];
  /** Cohorts (Cohort shape); the deleted one included. */
  cohorts: JsonObject[];
  /** Full persons (PersonListRecord shape, with `distinct_ids`). */
  persons: JsonObject[];
  /** Cohort id → person ids (the `id` of the entries in `persons`, as strings). */
  cohortMembers: Record<string, string[]>;
  /** ScheduledChange shape. */
  scheduledChanges: JsonObject[];
  /** EarlyAccessFeature shape (trimmed). */
  earlyAccessFeatures: JsonObject[];
  /** Experiment shape (trimmed). */
  experiments: JsonObject[];
}

const T0 = '2025-03-03T09:00:00Z';
const T1 = '2025-09-14T12:30:00Z';
const ORG = { id: ACME_HOG_ORG_ID, name: 'Acme Retail', slug: 'acme-retail' };

const ALICE_UUID = '018f3a2b-9c7d-7e11-8a3b-000000000007';
const PROJECT_UUID = '018f3a2b-9c7d-7e11-8a3b-000000004242';
const ALICE_EMAIL = 'alice.chen@acmeretail.example';
const ALICE: JsonObject = { id: 7, uuid: ALICE_UUID, distinct_id: 'alice', first_name: 'Alice', email: ALICE_EMAIL };
const BOB: JsonObject = { id: 8, uuid: '018f3a2b-9c7d-7e11-8a3b-000000000008', distinct_id: 'bob', first_name: 'Bob', email: 'bob.okafor@acmeretail.example' };

/** A PostHog PropertyFilter. `operator` absent means `exact`. */
interface Filter {
  key: string;
  type: 'person' | 'group' | 'cohort' | 'flag';
  value: Json;
  operator?: string;
  group_type_index?: number;
  negation?: boolean;
  dependency_chain?: string[];
}
const prop = (f: Filter): JsonObject => ({
  key: f.key,
  type: f.type,
  value: f.value,
  ...(f.operator !== undefined ? { operator: f.operator } : {}),
  ...(f.group_type_index !== undefined ? { group_type_index: f.group_type_index } : {}),
  ...(f.negation !== undefined ? { negation: f.negation } : {}),
  ...(f.dependency_chain !== undefined ? { dependency_chain: f.dependency_chain } : {}),
});

/** A condition set (FlagPropertyGroup). */
interface Group {
  properties: Filter[];
  rollout_percentage: number | null;
  variant?: string | null;
  aggregation_group_type_index?: number;
}
const group = (g: Group): JsonObject => ({
  properties: g.properties.map(prop),
  rollout_percentage: g.rollout_percentage,
  ...(g.variant !== undefined ? { variant: g.variant } : {}),
  ...(g.aggregation_group_type_index !== undefined ? { aggregation_group_type_index: g.aggregation_group_type_index } : {}),
});
/** Shorthand: a set with the given filters and percentage. */
const set = (properties: Filter[], rollout_percentage: number | null, extra: Omit<Group, 'properties' | 'rollout_percentage'> = {}): Group => ({ properties, rollout_percentage, ...extra });
const EVERYONE: Group[] = [set([], 100)];

interface Variant {
  key: string;
  name: string;
  rollout_percentage: number;
}

interface FlagSeed {
  id: number;
  key: string;
  /** PostHog's `name` field: the description. */
  description: string;
  tags?: string[];
  groups: Group[];
  variants?: Variant[];
  /** Variant key (or `"true"` for a boolean flag) → JSON-encoded payload string. */
  payloads?: Record<string, string>;
  aggregation_group_type_index?: number;
  holdout?: { id: number; exclusion_percentage: number };
  early_exit?: boolean;
  super_groups?: Group[];
  active?: boolean;
  deleted?: boolean;
  archived?: boolean;
  ensure_experience_continuity?: boolean;
  experiment_set?: number[];
  experiment_set_metadata?: JsonObject[];
  surveys?: JsonObject;
  features?: JsonObject[];
  evaluation_runtime?: 'all' | 'client' | 'server';
  evaluation_contexts?: string[];
  bucketing_identifier?: 'distinct_id' | 'device_id';
  is_remote_configuration?: boolean;
  has_encrypted_payloads?: boolean;
  created_by?: JsonObject;
}

const flag = (f: FlagSeed): JsonObject => {
  const filters: JsonObject = { groups: f.groups.map(group) };
  if (f.variants) filters.multivariate = { variants: f.variants.map((v) => ({ key: v.key, name: v.name, rollout_percentage: v.rollout_percentage })) };
  if (f.payloads) filters.payloads = { ...f.payloads };
  if (f.aggregation_group_type_index !== undefined) filters.aggregation_group_type_index = f.aggregation_group_type_index;
  if (f.holdout) filters.holdout = { ...f.holdout };
  if (f.early_exit !== undefined) filters.early_exit = f.early_exit;
  if (f.super_groups) filters.super_groups = f.super_groups.map(group);
  const by = f.created_by ?? ALICE;
  const active = f.active ?? true;
  return {
    id: f.id,
    name: f.description,
    key: f.key,
    filters,
    deleted: f.deleted ?? false,
    active,
    archived: f.archived ?? false,
    created_by: by,
    created_at: T0,
    updated_at: T1,
    version: 3,
    last_modified_by: by,
    ensure_experience_continuity: f.ensure_experience_continuity ?? false,
    experiment_set: f.experiment_set ?? [],
    experiment_set_metadata: f.experiment_set_metadata ?? [],
    surveys: f.surveys ?? {},
    features: f.features ?? [],
    can_edit: true,
    tags: f.tags ?? [],
    ...(f.evaluation_contexts ? { evaluation_contexts: f.evaluation_contexts } : {}),
    usage_dashboard: null,
    analytics_dashboards: [],
    has_enriched_analytics: false,
    user_access_level: 'editor',
    is_remote_configuration: f.is_remote_configuration ?? false,
    has_encrypted_payloads: f.has_encrypted_payloads ?? false,
    status: 'ACTIVE',
    evaluation_runtime: f.evaluation_runtime ?? 'all',
    bucketing_identifier: f.bucketing_identifier ?? 'distinct_id',
    last_called_at: active ? T1 : null,
    is_used_in_replay_settings: false,
    is_eligible_for_experiment: (f.variants?.length ?? 0) >= 2,
  };
};

interface CohortSeed {
  id: number;
  name: string;
  description?: string;
  is_static?: boolean;
  cohort_type: 'static' | 'person_property' | 'behavioral';
  /** `filters.properties` (a PropertyGroup); `null` for a static cohort. */
  properties: JsonObject | null;
  count: number;
  deleted?: boolean;
}
const cohort = (c: CohortSeed): JsonObject => ({
  id: c.id,
  name: c.name,
  description: c.description ?? '',
  groups: [],
  deleted: c.deleted ?? false,
  filters: c.properties ? { properties: c.properties } : null,
  query: null,
  version: 2,
  pending_version: null,
  is_calculating: false,
  created_by: ALICE,
  created_at: T0,
  last_calculation: T1,
  last_backfill_person_properties_at: null,
  errors_calculating: 0,
  last_error_message: null,
  count: c.count,
  last_import_total_count: c.is_static ? c.count : null,
  last_import_unmatched_count: c.is_static ? 0 : null,
  is_static: c.is_static ?? false,
  cohort_type: c.cohort_type,
  condition_type: null,
  realtime: null,
  experiment_set: [],
  search_match_type: null,
});

const personProp = (key: string, value: Json[], operator = 'exact'): JsonObject => ({ key, type: 'person', value, operator });

interface PersonSeed {
  id: number;
  distinct_ids: string[];
  email: string;
  properties?: JsonObject;
}
const person = (p: PersonSeed): JsonObject => ({
  id: p.id,
  name: p.email,
  distinct_ids: p.distinct_ids,
  properties: { email: p.email, ...(p.properties ?? {}) },
  created_at: T0,
  uuid: `4e5a1c00-0000-4000-8000-${String(p.id).padStart(12, '0')}`,
  last_seen_at: T1,
});

const propertyDefinition = (name: string, property_type: 'String' | 'Numeric' | 'Boolean' | 'DateTime', type: 'person' | 'group', group_type_index: number | null, n: number): JsonObject => ({
  id: `6b1d0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name,
  is_numerical: property_type === 'Numeric',
  property_type,
  type,
  group_type_index,
  tags: [],
  updated_at: T1,
  updated_by: null,
  is_seen_on_filtered_events: null,
  verified: false,
  verified_at: null,
  verified_by: null,
  hidden: false,
});

const member = (id: string, user: JsonObject, level: number): JsonObject => ({
  id,
  user: { ...user, last_name: user.first_name === 'Alice' ? 'Chen' : 'Okafor', is_email_verified: true },
  level,
  joined_at: T0,
  updated_at: T0,
  is_2fa_enabled: false,
  has_social_auth: false,
  last_login: T1,
});

/** The project at the single point in time the demo uses. Deterministic. */
export function acmeHogProject(): PostHogProjectFixture {
  const projectId = Number(ACME_HOG_PROJECT_ID);
  const project: JsonObject = {
    id: projectId,
    uuid: PROJECT_UUID,
    organization: ACME_HOG_ORG_ID,
    project_id: projectId,
    api_token: 'phc_demo-not-real',
    name: 'Acme Hog',
    completed_snippet_onboarding: true,
    has_completed_onboarding_for: { feature_flags: true },
    ingested_event: true,
    is_demo: false,
    timezone: 'UTC',
    access_control: false,
    tags: [],
    created_at: T0,
    updated_at: T1,
    product_description: 'Acme Retail storefront, the PostHog years.',
    has_group_types: true,
    group_types: [
      { group_type: 'company', group_type_index: 0, name_singular: 'Company', name_plural: 'Companies' },
      { group_type: 'workspace', group_type_index: 1, name_singular: 'Workspace', name_plural: 'Workspaces' },
    ],
  };

  const persons = [
    person({ id: 501, distinct_ids: ['u-1'], email: 'p1@design-partner.example', properties: { plan: 'enterprise', role: 'admin', country: 'DE' } }),
    // One person with two distinct ids (cohort_person_ids).
    person({ id: 502, distinct_ids: ['u-2', 'u-2-legacy'], email: 'p2@design-partner.example', properties: { plan: 'pro', country: 'US' } }),
    person({ id: 503, distinct_ids: ['u-3'], email: 'p3@design-partner.example', properties: { plan: 'enterprise', country: 'GB' } }),
    person({ id: 504, distinct_ids: ['u-4'], email: 'p4@acme.example', properties: { plan: 'pro', seats: 12 } }),
    person({ id: 505, distinct_ids: ['u-5'], email: 'p5@acme.example', properties: { plan: 'free', seats: 1 } }),
  ];

  const pricingVariants: Variant[] = [
    { key: 'control', name: 'Control', rollout_percentage: 50 },
    { key: 'plus', name: 'Plus', rollout_percentage: 25 },
    { key: 'enterprise', name: 'Enterprise', rollout_percentage: 25 },
  ];
  const abVariants: Variant[] = [
    { key: 'control', name: 'Control', rollout_percentage: 50 },
    { key: 'test', name: 'Test', rollout_percentage: 50 },
  ];

  return {
    organization: { ...ORG, logo_media_id: null, membership_level: 15, members_can_use_personal_api_keys: true, is_active: true, is_not_active_reason: null, is_pending_deletion: false },
    user: {
      id: 7,
      uuid: ALICE_UUID,
      distinct_id: 'alice',
      first_name: 'Alice',
      last_name: 'Chen',
      email: ALICE_EMAIL,
      is_email_verified: true,
      is_staff: false,
      has_password: true,
      date_joined: T0,
      team: { id: projectId, uuid: PROJECT_UUID, organization: ACME_HOG_ORG_ID, project_id: projectId, api_token: 'phc_demo-not-real', name: 'Acme Hog', timezone: 'UTC' },
      organization: { ...ORG, membership_level: 15 },
      organizations: [{ ...ORG, membership_level: 15 }],
    },
    project,
    members: [member('018f3a2b-mem0-7e11-8a3b-000000000007', ALICE, 15), member('018f3a2b-mem0-7e11-8a3b-000000000008', BOB, 8)],
    groupTypes: [
      { group_type: 'company', group_type_index: 0, name_singular: 'Company', name_plural: 'Companies', detail_dashboard: null, default_columns: null, created_at: T0 },
      { group_type: 'workspace', group_type_index: 1, name_singular: 'Workspace', name_plural: 'Workspaces', detail_dashboard: null, default_columns: null, created_at: T0 },
    ],
    propertyDefinitions: [
      propertyDefinition('email', 'String', 'person', null, 1),
      propertyDefinition('plan', 'String', 'person', null, 2),
      propertyDefinition('role', 'String', 'person', null, 3),
      propertyDefinition('seats', 'Numeric', 'person', null, 4),
      propertyDefinition('signup_date', 'DateTime', 'person', null, 5),
      propertyDefinition('app_version', 'String', 'person', null, 6),
      propertyDefinition('os', 'String', 'person', null, 7),
      propertyDefinition('beta_tester', 'Boolean', 'person', null, 8),
      propertyDefinition('country', 'String', 'person', null, 9),
      propertyDefinition('$feature_enrollment/hog-early-access', 'Boolean', 'person', null, 10),
      propertyDefinition('tier', 'String', 'group', 0, 11),
      propertyDefinition('mrr', 'Numeric', 'group', 0, 12),
    ],
    flags: [
      // The simplest case: everyone, 100%.
      flag({ id: 1001, key: 'hog-kill-switch', description: 'Turns the storefront off entirely.', tags: ['ops'], groups: EVERYONE }),
      // Ordered condition sets: a case-insensitive contains, a static cohort, then a 25% rollout (rollout_coverage).
      flag({
        id: 1002,
        key: 'hog-checkout-redesign',
        description: 'New checkout. Staff first, then the design partners, then a quarter of everyone.',
        tags: ['checkout'],
        groups: [
          set([{ key: 'email', type: 'person', value: '@acme.example', operator: 'icontains' }], 100),
          set([{ key: 'id', type: 'cohort', value: 301 }], 100),
          set([], 25),
        ],
      }),
      // Multivariate with a variant override on one set and payloads per variant.
      flag({
        id: 1003,
        key: 'hog-pricing-page',
        description: 'Which pricing page a visitor sees.',
        tags: ['pricing'],
        variants: pricingVariants,
        groups: [set([{ key: 'plan', type: 'person', value: ['enterprise'], operator: 'exact' }], 100, { variant: 'enterprise' }), set([], 100)],
        payloads: { control: '{"layout":"classic"}', plus: '{"layout":"plus"}', enterprise: '{"layout":"enterprise","salesCta":true}' },
      }),
      // Relative date (relative_date) with a 50% set, then a boolean property.
      flag({
        id: 1004,
        key: 'hog-new-onboarding',
        description: 'New onboarding for half of the recent signups, and every beta tester.',
        tags: ['growth'],
        groups: [
          set([{ key: 'signup_date', type: 'person', value: '-30d', operator: 'is_date_after' }], 50),
          set([{ key: 'beta_tester', type: 'person', value: ['true'], operator: 'exact' }], 100),
        ],
      }),
      // semver_gte and is_not, client-side only.
      flag({
        id: 1005,
        key: 'hog-ios-min-version',
        description: 'Features that need app 4.2 or newer, except iPadOS.',
        tags: ['mobile'],
        evaluation_runtime: 'client',
        groups: [set([{ key: 'app_version', type: 'person', value: '4.2.0', operator: 'semver_gte' }, { key: 'os', type: 'person', value: 'ipados', operator: 'is_not' }], 100)],
      }),
      // Group-targeted flag (aggregation_group_type_index 0 = company) with a group property and a 10% rollout by company.
      flag({
        id: 1006,
        key: 'hog-company-tier',
        description: 'Gold and platinum companies, then a tenth of all companies.',
        tags: ['b2b'],
        aggregation_group_type_index: 0,
        groups: [set([{ key: 'tier', type: 'group', group_type_index: 0, value: ['gold', 'platinum'], operator: 'exact' }], 100), set([], 10)],
      }),
      // early_exit: a context that matches the first set but misses its 40% gets false, not the second set.
      // Also carries a recurring status change (noted) and a one-off add_release_condition (scheduled in LD).
      flag({
        id: 1007,
        key: 'hog-staff-tools',
        description: 'Internal tools: 40% of staff; everyone in the UK. Stops at the first matching set.',
        tags: ['internal'],
        early_exit: true,
        groups: [
          set([{ key: 'email', type: 'person', value: '@acme.example', operator: 'ends_with' }], 40),
          set([{ key: 'country', type: 'person', value: ['GB'], operator: 'exact' }], 100),
        ],
      }),
      // Flag dependency (flag_evaluates_to on a flag *id*) plus a numeric gt.
      flag({
        id: 1008,
        key: 'hog-depends-on-checkout',
        description: 'Only where the checkout redesign is on, for accounts with more than ten seats.',
        tags: ['checkout'],
        groups: [set([{ key: '1002', type: 'flag', value: true, operator: 'flag_evaluates_to', dependency_chain: ['hog-checkout-redesign'] }, { key: 'seats', type: 'person', value: 10, operator: 'gt' }], 100)],
      }),
      // Remote configuration: one JSON payload, no targeting.
      flag({ id: 1009, key: 'hog-remote-config', description: 'Storefront list settings.', tags: ['config'], is_remote_configuration: true, groups: EVERYONE, payloads: { true: '{"maxItems":20,"theme":"dark"}' } }),
      // Early-access feature: opt-in through $feature_enrollment/<key> in super_groups; the sets serve nobody.
      flag({
        id: 1010,
        key: 'hog-early-access',
        description: 'Beta program opt-in.',
        tags: ['beta'],
        groups: [set([], 0)],
        super_groups: [set([{ key: '$feature_enrollment/hog-early-access', type: 'person', value: ['true'], operator: 'exact' }], 100)],
        features: [{ id: 7, name: 'Hog early access', stage: 'beta' }],
      }),
      // Experiment-backed multivariate flag with a holdout.
      flag({
        id: 1011,
        key: 'hog-holdout-experiment',
        description: 'An A/B test still running in PostHog, with 10% held out.',
        tags: ['experiment'],
        variants: abVariants,
        groups: EVERYONE,
        holdout: { id: 3, exclusion_percentage: 10 },
        experiment_set: [55],
        experiment_set_metadata: [{ id: 55, name: 'Holdout experiment', is_running: true }],
      }),
      // Device-id bucketing with experience continuity.
      flag({ id: 1012, key: 'hog-device-rollout', description: 'A 30% rollout bucketed by device, sticky across login.', tags: ['anon'], bucketing_identifier: 'device_id', ensure_experience_continuity: true, groups: [set([], 30)] }),
      // The backing flag of a survey (PostHog names them survey-targeting-<id>): owned by another product, skipped.
      flag({ id: 1013, key: 'survey-targeting-checkout-nps', description: 'Targeting flag for the Checkout NPS survey.', tags: [], groups: EVERYONE, surveys: { id: 'srv-1', name: 'Checkout NPS' } }),
      // Archived: listed behind the toggle, never migrated.
      flag({ id: 1014, key: 'hog-archived-promo', description: 'Spring 2025 promo banner.', tags: ['promo'], archived: true, active: false, groups: EVERYONE }),
      // Disabled: a live flag that is off (on: false in LD).
      flag({ id: 1015, key: 'hog-disabled-legacy', description: 'Legacy checkout, switched off.', tags: ['legacy'], active: false, groups: EVERYONE }),
      // Cohort `in`, numeric between, and a regex.
      flag({
        id: 1016,
        key: 'hog-eu-rollout',
        description: 'EU and UK accounts with 5 to 50 seats whose address is not a test account.',
        tags: ['eu'],
        groups: [set([
          { key: 'id', type: 'cohort', value: 303, operator: 'in' },
          { key: 'seats', type: 'person', value: [5, 50], operator: 'between' },
          { key: 'email', type: 'person', value: '^(?!.*test).*@acme\\.example$', operator: 'regex' },
        ], 100)],
      }),
      // A behavioral cohort (cohort_snapshot), a presence check, and a negated cohort.
      flag({
        id: 1017,
        key: 'hog-power-users',
        description: 'Power users with an email who are not enterprise admins.',
        tags: ['growth'],
        groups: [set([
          { key: 'id', type: 'cohort', value: 304 },
          { key: 'email', type: 'person', value: null, operator: 'is_set' },
          { key: 'id', type: 'cohort', value: 302, operator: 'not_in' },
        ], 100)],
      }),
      // Remote configuration with an encrypted payload (encrypted_payload when the key cannot read it).
      flag({ id: 1018, key: 'hog-encrypted-config', description: 'Internal API base URL.', tags: ['config'], is_remote_configuration: true, has_encrypted_payloads: true, groups: EVERYONE, payloads: { true: '{"apiBase":"https://internal.acme.example"}' } }),
      // Off today, with a pending scheduled change that turns it on (scheduled_rule).
      flag({ id: 1019, key: 'hog-scheduled-launch', description: 'Launches on 4 January 2027.', tags: ['launch'], active: false, groups: EVERYONE }),
      // A cohort that references another cohort.
      flag({ id: 1020, key: 'hog-nested-cohort', description: 'Enterprise admins in the EU.', tags: ['b2b'], groups: [set([{ key: 'id', type: 'cohort', value: 305 }], 100)] }),
      // Server-side only, with evaluation contexts.
      flag({ id: 1021, key: 'hog-server-only', description: 'Backend-only switch.', tags: ['backend'], evaluation_runtime: 'server', evaluation_contexts: ['backend'], groups: EVERYONE }),
      // not_between splits into two rules (rule_expansion).
      flag({ id: 1022, key: 'hog-not-between', description: 'Accounts outside the 5 to 50 seat band.', tags: ['growth'], groups: [set([{ key: 'seats', type: 'person', value: [5, 50], operator: 'not_between' }], 100)] }),
      // Soft-deleted: never read (hidden by the list route unless deleted=true).
      flag({ id: 1023, key: 'hog-deleted', description: 'Deleted in PostHog.', tags: [], deleted: true, groups: EVERYONE }),
      // Mixed targeting: a per-set aggregation_group_type_index on one set, person targeting on the other.
      flag({
        id: 1024,
        key: 'hog-cross-group',
        description: 'Platinum companies, and enterprise-plan people.',
        tags: ['b2b'],
        created_by: BOB,
        groups: [
          set([{ key: 'tier', type: 'group', group_type_index: 0, value: ['platinum'], operator: 'exact' }], 100, { aggregation_group_type_index: 0 }),
          set([{ key: 'plan', type: 'person', value: ['enterprise'], operator: 'exact' }], 100),
        ],
      }),
    ],
    cohorts: [
      cohort({ id: 301, name: 'Design partners', description: 'Hand-picked design partner accounts.', is_static: true, cohort_type: 'static', properties: null, count: 3 }),
      cohort({ id: 302, name: 'Enterprise admins', cohort_type: 'person_property', count: 12, properties: { type: 'AND', values: [personProp('plan', ['enterprise']), personProp('role', ['admin'])] } }),
      cohort({ id: 303, name: 'EU or UK', cohort_type: 'person_property', count: 40, properties: { type: 'OR', values: [personProp('country', ['DE', 'FR']), personProp('country', ['GB'])] } }),
      cohort({
        id: 304,
        name: 'Power users',
        description: 'Five or more pageviews in the last 30 days.',
        cohort_type: 'behavioral',
        count: 2,
        properties: { type: 'AND', values: [{ type: 'behavioral', key: '$pageview', value: 'performed_event_multiple', event_type: 'events', operator: 'gte', operator_value: 5, time_value: 30, time_interval: 'day' }] },
      }),
      cohort({ id: 305, name: 'Enterprise admins in EU', cohort_type: 'person_property', count: 3, properties: { type: 'AND', values: [{ key: 'id', type: 'cohort', value: 302 }, personProp('country', ['DE'])] } }),
      cohort({ id: 306, name: 'Retired list', is_static: true, cohort_type: 'static', properties: null, count: 0, deleted: true }),
    ],
    persons,
    cohortMembers: { '301': ['501', '502', '503'], '304': ['504', '505'] },
    scheduledChanges: [
      {
        id: 9001,
        team_id: projectId,
        record_id: '1019',
        model_name: 'FeatureFlag',
        payload: { operation: 'update_status', value: true },
        scheduled_at: '2027-01-04T09:00:00Z',
        executed_at: null,
        failure_reason: null,
        created_at: T1,
        created_by: ALICE,
        updated_at: T1,
        is_recurring: false,
        recurrence_interval: null,
        cron_expression: null,
        last_executed_at: null,
        end_date: null,
        timezone: 'UTC',
        change_request: null,
      },
      {
        id: 9002,
        team_id: projectId,
        record_id: '1007',
        model_name: 'FeatureFlag',
        payload: { operation: 'update_status', value: false },
        scheduled_at: '2027-01-05T17:00:00Z',
        executed_at: null,
        failure_reason: null,
        created_at: T1,
        created_by: ALICE,
        updated_at: T1,
        is_recurring: true,
        recurrence_rule: '0 17 * * 1-5',
        recurrence_interval: null,
        cron_expression: '0 17 * * 1-5',
        last_executed_at: null,
        end_date: null,
        timezone: 'UTC',
        change_request: null,
      },
      // One-off add_release_condition: the filter editor's output (`groups`, `payloads`, `multivariate`),
      // appended to the flag's condition sets when it fires; becomes an LD scheduled change.
      {
        id: 9003,
        team_id: projectId,
        record_id: '1007',
        model_name: 'FeatureFlag',
        payload: { operation: 'add_release_condition', value: { groups: [group(set([{ key: 'email', type: 'person', value: '@acmeretail.example', operator: 'ends_with' }], 100))], payloads: {}, multivariate: null } },
        scheduled_at: '2027-02-01T09:00:00Z',
        executed_at: null,
        failure_reason: null,
        created_at: T1,
        created_by: ALICE,
        updated_at: T1,
        is_recurring: false,
        recurrence_interval: null,
        cron_expression: null,
        last_executed_at: null,
        end_date: null,
        timezone: 'UTC',
        change_request: null,
      },
      // One-off update_variants on the multivariate pricing flag: noted, never scheduled.
      {
        id: 9004,
        team_id: projectId,
        record_id: '1003',
        model_name: 'FeatureFlag',
        payload: {
          operation: 'update_variants',
          value: {
            variants: [
              { key: 'control', name: 'Control', rollout_percentage: 34 },
              { key: 'plus', name: 'Plus', rollout_percentage: 33 },
              { key: 'enterprise', name: 'Enterprise', rollout_percentage: 33 },
            ],
            payloads: { control: '{"layout":"classic"}', plus: '{"layout":"plus"}', enterprise: '{"layout":"enterprise","salesCta":true}' },
          },
        },
        scheduled_at: '2027-03-01T09:00:00Z',
        executed_at: null,
        failure_reason: null,
        created_at: T1,
        created_by: ALICE,
        updated_at: T1,
        is_recurring: false,
        recurrence_interval: null,
        cron_expression: null,
        last_executed_at: null,
        end_date: null,
        timezone: 'UTC',
        change_request: null,
      },
    ],
    earlyAccessFeatures: [
      {
        id: '7',
        name: 'Hog early access',
        description: 'Try the new storefront before everyone else.',
        stage: 'beta',
        feature_flag: { id: 1010, key: 'hog-early-access' },
        documentation_url: 'https://acmeretail.example/docs/early-access',
        image_url: '',
        created_at: T0,
        created_by: ALICE,
        assignee: null,
        payload: {},
        user_access_level: 'editor',
      },
    ],
    experiments: [
      { id: 55, name: 'Holdout experiment', description: 'Does the test variant lift checkout?', feature_flag_key: 'hog-holdout-experiment', feature_flag: { id: 1011, key: 'hog-holdout-experiment' }, holdout_id: 3, start_date: '2026-10-01T00:00:00Z', end_date: null, archived: false, deleted: false, created_by: ALICE, created_at: '2026-09-28T10:00:00Z', updated_at: '2026-10-01T00:00:00Z', type: 'product' },
    ],
  };
}

/**
 * What `GET /flags/definitions?token=<project token>&send_cohorts` (the local-evaluation payload a
 * server SDK polls, PLAN §22.1) returns for the same project: the active, non-deleted, non-archived
 * flags, the group type mapping, and the `filters.properties` of every non-static, non-deleted cohort.
 * No static-cohort members, no owners, no scheduled changes.
 */
export function acmeHogLocalEvaluationPayload(): JsonObject {
  const p = acmeHogProject();
  const cohorts: JsonObject = {};
  for (const c of p.cohorts) {
    if (c.deleted === true || c.is_static === true) continue;
    const filters = c.filters as JsonObject | null;
    if (filters && filters.properties !== undefined) cohorts[String(c.id)] = filters.properties;
  }
  return {
    flags: p.flags.filter((f) => f.active === true && f.deleted !== true && f.archived !== true),
    group_type_mapping: Object.fromEntries(p.groupTypes.map((g) => [String(g.group_type_index), g.group_type ?? null])),
    cohorts,
  };
}

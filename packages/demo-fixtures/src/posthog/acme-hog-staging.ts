/**
 * "Acme Hog Staging": the staging *project* of the same PostHog organization as "Acme Hog"
 * (./acme-hog.ts). PostHog has no environments inside a project (PLAN §22.1), so a team that keeps
 * dev, staging and prod apart has one project per stage, populated with "copy flag to another
 * project": the same flag keys, different ids, and targeting that has drifted. The demo attaches
 * it as a second PostHog source mapped to the LD `test` environment while "Acme Hog" maps to
 * `production`, which is the consolidation case of PLAN §12 (KNOWN-EDGE-CASES §16, 19.26): one
 * LaunchDarkly flag per key, one environment's targeting per source, and a `source_collision`
 * decision where the two projects' flags cannot be one flag.
 *
 * Derived from `acmeHogProject()` so the shapes stay in step: a subset of the flags by key with ids
 * offset by 1000, the cohorts they reference (cohort ids are per project, so they keep theirs),
 * the persons, group types, property definitions and members. No scheduled changes, experiments or
 * early-access features. Deliberate differences from production:
 *
 * - `hog-kill-switch`: switched off in staging (`active: false`) while on in production.
 * - `hog-checkout-redesign`: the last condition set is at 100% in staging (25% in production).
 * - `hog-pricing-page`: the same variant keys, different weights (34/33/33, not 50/25/25) and no
 *   enterprise override set.
 * - `hog-company-tier`: half of all companies instead of a tenth.
 * - `hog-staff-tools`: a *multivariate* flag in staging (variants `basic` and `full`) while
 *   production's is boolean: the two cannot be one LaunchDarkly flag (16.2).
 * - `hog-power-users`: no `is_set` presence check on email.
 * - `hog-staging-only`: exists only here.
 */
import type { JsonObject } from '../console/builders.ts';
import { ACME_HOG_ORG_ID, acmeHogProject, type PostHogProjectFixture } from './acme-hog.ts';

export const ACME_HOG_STAGING_PROJECT_ID = '4243';
const STAGING_PROJECT_UUID = '018f3a2b-9c7d-7e11-8a3b-000000004243';
const STAGING_API_TOKEN = 'phc_demo-staging-not-real';
const STAGING_NAME = 'Acme Hog Staging';

/** Production flags copied to staging, by key, in the order they appear here. */
export const ACME_HOG_STAGING_SHARED_KEYS = ['hog-kill-switch', 'hog-checkout-redesign', 'hog-pricing-page', 'hog-company-tier', 'hog-staff-tools', 'hog-power-users'] as const;
/** Cohorts the staging flags reference (ids are per project; the same numbers as production is what "copy to project" leaves behind). */
const STAGING_COHORT_IDS = [301, 302, 304];
/** Production flag id → staging flag id. */
export const ACME_HOG_STAGING_ID_OFFSET = 1000;

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The staging project at the single point in time the demo uses. Deterministic. */
export function acmeHogStagingProject(): PostHogProjectFixture {
  const prod = acmeHogProject();
  const projectId = Number(ACME_HOG_STAGING_PROJECT_ID);
  const team: JsonObject = { id: projectId, uuid: STAGING_PROJECT_UUID, organization: ACME_HOG_ORG_ID, project_id: projectId, api_token: STAGING_API_TOKEN, name: STAGING_NAME, timezone: 'UTC' };
  const project: JsonObject = { ...clone(prod.project), ...team, product_description: 'Acme Retail storefront, staging.' };
  const user: JsonObject = { ...clone(prod.user), team };

  const byKey = new Map(prod.flags.map((f) => [f.key as string, f]));
  const take = (key: string, mutate: (f: JsonObject, filters: JsonObject) => void): JsonObject => {
    const base = byKey.get(key);
    if (!base) throw new Error(`acmeHogProject has no flag ${key}`);
    const f = clone(base);
    f.id = (f.id as number) + ACME_HOG_STAGING_ID_OFFSET;
    mutate(f, f.filters as JsonObject);
    return f;
  };
  const groups = (filters: JsonObject): JsonObject[] => filters.groups as JsonObject[];

  const flags: JsonObject[] = [
    // Off in staging, on in production.
    take('hog-kill-switch', (f) => {
      f.active = false;
      f.last_called_at = null;
    }),
    // Staff, then the design partners (static cohort 301), then everyone: the rollout finished in staging.
    take('hog-checkout-redesign', (_f, filters) => {
      groups(filters)[2]!.rollout_percentage = 100;
    }),
    // Same variant keys, even weights, and no enterprise override: everyone is in the split.
    take('hog-pricing-page', (_f, filters) => {
      const mv = filters.multivariate as JsonObject;
      mv.variants = [
        { key: 'control', name: 'Control', rollout_percentage: 34 },
        { key: 'plus', name: 'Plus', rollout_percentage: 33 },
        { key: 'enterprise', name: 'Enterprise', rollout_percentage: 33 },
      ];
      filters.groups = [{ properties: [], rollout_percentage: 100 }];
    }),
    // Gold and platinum companies, then half of all companies.
    take('hog-company-tier', (_f, filters) => {
      groups(filters)[1]!.rollout_percentage = 50;
    }),
    // Multivariate in staging (which tools tier staff get), boolean in production: not one LaunchDarkly flag.
    take('hog-staff-tools', (f, filters) => {
      f.name = 'Internal tools tier: full for staff, basic for the UK.';
      filters.multivariate = {
        variants: [
          { key: 'basic', name: 'Basic', rollout_percentage: 50 },
          { key: 'full', name: 'Full', rollout_percentage: 50 },
        ],
      };
      delete filters.early_exit;
      const [staff, uk] = groups(filters) as [JsonObject, JsonObject];
      staff.rollout_percentage = 100;
      staff.variant = 'full';
      uk.variant = 'basic';
      f.is_eligible_for_experiment = true;
    }),
    // Power users (behavioral cohort 304) who are not enterprise admins (302); no presence check.
    take('hog-power-users', (_f, filters) => {
      const set = groups(filters)[0]!;
      set.properties = (set.properties as JsonObject[]).filter((p) => p.operator !== 'is_set');
    }),
    // Exists only in staging.
    take('hog-kill-switch', (f) => {
      f.id = 2099;
      f.key = 'hog-staging-only';
      f.name = 'Harness for the staging smoke tests.';
      f.tags = ['staging'];
      f.active = true;
    }),
  ];

  const cohorts = prod.cohorts.filter((c) => STAGING_COHORT_IDS.includes(c.id as number)).map(clone);
  const cohortMembers = Object.fromEntries(Object.entries(prod.cohortMembers).filter(([id]) => STAGING_COHORT_IDS.includes(Number(id))));

  return {
    organization: clone(prod.organization),
    user,
    project,
    members: clone(prod.members),
    groupTypes: clone(prod.groupTypes),
    propertyDefinitions: clone(prod.propertyDefinitions),
    flags,
    cohorts,
    persons: clone(prod.persons),
    cohortMembers,
    scheduledChanges: [],
    earlyAccessFeatures: [],
    experiments: [],
  };
}

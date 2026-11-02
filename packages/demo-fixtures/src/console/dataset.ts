import {
  alert,
  autotune,
  dynamicConfig,
  experiment,
  gate,
  groupId,
  holdout,
  layer,
  metric,
  prompt,
  segment,
  type BuildContext,
  type IdListSeed,
  type Json,
  type JsonObject,
} from './builders.ts';
import { pseudoId } from '../ids.ts';
import type { ProjectSeed } from '../acme/seed-types.ts';

export const DATASET_SCHEMA_VERSION = 1;

/**
 * One demo StatSig project at one snapshot, as the exact `data` payloads the Console API returns.
 * The MSW mock serves these with the real envelopes (message/data/pagination).
 */
export interface ConsoleProjectDataset {
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  alias: string;
  snapshot: number;
  now: number;
  project: JsonObject;
  company: JsonObject;
  environments: JsonObject[];
  /** Includes archived gates; the mock hides them unless `includeArchived=true`. */
  gates: JsonObject[];
  dynamicConfigs: JsonObject[];
  segments: JsonObject[];
  /** id_list segment contents, as generators (20k literal IDs would bloat the JSON). */
  idLists: Record<string, IdListSeed>;
  experiments: JsonObject[];
  layers: JsonObject[];
  holdouts: JsonObject[];
  autotunes: JsonObject[];
  unitIdTypes: JsonObject[];
  tags: JsonObject[];
  targetApps: JsonObject[];
  metrics: JsonObject[];
  metricSources: JsonObject[];
  paramStores: JsonObject[];
  users: JsonObject[];
  /** TeamDto with `members` and `admins`; the list route strips them (TeamDtoWithoutMembersDto). */
  teams: JsonObject[];
  /** `/console/v1/prompts` (ExternalPromptDto). */
  prompts: JsonObject[];
  /** `/console/v1/alerts` (AlertSchemaDto). */
  alerts: JsonObject[];
  /** `/console/v1/settings/reviews`. */
  reviewSettings: JsonObject;
  /** `/console/v1/settings/project`. */
  projectSettings: JsonObject;
  /** `/console/v1/overrides` payload. */
  overrides: JsonObject;
}

export function buildConsoleDataset(seed: ProjectSeed, snapshot: number, now: number): ConsoleProjectDataset {
  const ctx: BuildContext = { project: seed.projectName, now };
  const idLists: Record<string, IdListSeed> = {};
  for (const s of seed.segments) if (s.type === 'id_list' && s.idList) idLists[s.id] = s.idList;

  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    alias: seed.alias,
    snapshot,
    now,
    project: { id: pseudoId(`project/${seed.projectName}`), name: seed.projectName },
    company: {
      companyID: pseudoId(`company/${seed.projectName}`),
      companyName: seed.companyName,
      isWarehouseNative: seed.isWarehouseNative,
      orgID: pseudoId('org/acme'),
      orgName: 'Acme Retail',
    },
    environments: seed.environments.map((e) => ({
      name: e.name,
      id: pseudoId(`${seed.projectName}/env/${e.name}`),
      isProduction: e.isProduction,
      requiresReview: e.isProduction,
      requiresReleasePipeline: false,
    })),
    gates: seed.gates.map((g) => gate(ctx, g)),
    dynamicConfigs: seed.configs.map((c) => dynamicConfig(ctx, c)),
    segments: seed.segments.map((s) => segment(ctx, s)),
    idLists,
    experiments: seed.experiments.map((e) => experiment(ctx, e)),
    layers: seed.layers.map((l) => layer(ctx, l)),
    holdouts: seed.holdouts.map((h) => holdout(ctx, h)),
    autotunes: seed.autotunes.map((a) => autotune(ctx, a)),
    unitIdTypes: seed.unitTypes.map((u) => ({ name: u.name, description: u.description })),
    tags: seed.tags.map((t) => ({ id: pseudoId(`${seed.projectName}/tag/${t.name}`), name: t.name, description: t.description, isCore: t.isCore ?? false })),
    targetApps: seed.targetApps.map((name) => ({ id: pseudoId(`${seed.projectName}/target_app/${name}`), name })),
    metrics: seed.metrics.map((m) => metric(ctx, m)),
    metricSources: seed.metricSources.map((m) => ({
      name: m.name,
      description: m.description,
      tags: [],
      sql: m.sql,
      timestampColumn: m.timestampColumn,
      timestampAsDay: false,
      idTypeMapping: m.idTypeMapping,
      sourceType: m.tableName ? 'table' : 'query',
      ...(m.tableName ? { tableName: m.tableName } : {}),
      customFieldMapping: [],
      isReadOnly: false,
      isVerified: true,
      owner: { ownerID: m.owner.id, ownerType: 'USER', ownerName: m.owner.name, ownerEmail: m.owner.email },
      team: null,
      teamID: null,
    })),
    paramStores: seed.paramStores.map((p) => ({
      id: pseudoId(`${seed.projectName}/param_store/${p.name}`),
      name: p.name,
      displayName: p.name,
      description: p.description,
      createdTime: now - 100 * 86_400_000,
      creatorID: p.owner.id,
      lastModifierID: p.owner.id,
      team: null,
      teamID: '',
      parameters: p.parameters,
    })),
    users: seed.users.map((u) => {
      const [firstName = '', lastName = ''] = u.name.split(' ');
      return { userID: u.id, email: u.email, firstName, lastName, role: u.role };
    }),
    prompts: (seed.prompts ?? []).map((p) => prompt(ctx, p)),
    alerts: (seed.alerts ?? []).map((a) => alert(ctx, a)),
    reviewSettings: {
      is_config_review_required: seed.reviews?.configReviewRequired ?? false,
      is_metric_review_required: seed.reviews?.metricReviewRequired ?? false,
      is_metric_review_required_on_verified_only: false,
      is_whn_analysis_only_review_required: false,
      is_whn_source_review_required: false,
    },
    projectSettings: { name: seed.projectName, visibility: 'OPEN', ...(seed.defaultUnitType ? { default_unit_type: seed.defaultUnitType } : {}) },
    teams: seed.teams.map((t) => ({
      name: t,
      description: `${t} team`,
      id: pseudoId(`${seed.projectName}/team/${t}`),
      members: (seed.teamMembers?.[t] ?? []).map((m) => {
        const [firstName = '', lastName = ''] = m.name.split(' ');
        const role = seed.users.find((u) => u.email === m.email)?.role ?? 'Member';
        return { userID: m.id, email: m.email, firstName, lastName, role };
      }),
      admins: (seed.teamMembers?.[t] ?? []).slice(0, 1).map((m) => {
        const [firstName = '', lastName = ''] = m.name.split(' ');
        return { userID: m.id, email: m.email, firstName, lastName, role: seed.users.find((u) => u.email === m.email)?.role ?? 'Member' };
      }),
      defaultGateMetrics: [],
      defaultExperimentPrimaryMetrics: [],
      defaultExperimentSecondaryMetrics: [],
      defaultHoldoutMetrics: [],
      changeTeamConfigs: 'team_only',
      reviewApproval: 'anyone',
      defaultTargetApplications: [],
      defaultHoldoutID: null,
    })),
    overrides: {
      gates: seed.gateOverrides.map((o) => ({
        id: o.gate,
        name: o.gate,
        passingUserIDs: o.passingUserIDs ?? [],
        failingUserIDs: o.failingUserIDs ?? [],
        passingCustomIDs: o.passingCustomIDs ?? [],
        failingCustomIDs: o.failingCustomIDs ?? [],
        environmentOverrides: (o.environmentOverrides ?? []) as unknown as Json[],
      })),
      holdouts: [],
      experiments: seed.experimentOverrides.map((o) => ({
        id: o.experiment,
        name: o.experiment,
        overrides: [],
        userIDOverrides: o.userIDOverrides.map((u) => ({
          groupID: groupId(ctx, o.experiment, u.groupName),
          ids: u.ids,
          environment: u.environment ?? null,
          unitType: u.unitType ?? null,
        })),
      })),
      autotunes: [],
      layers: [],
    },
  };
}

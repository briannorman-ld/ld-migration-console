/**
 * Lenient Zod schemas for StatSig Console API responses (API version 20240601).
 *
 * Field names come from reference/statsig/console-api-openapi-20240601.json. Unknown fields are
 * always allowed (`looseObject`) because neither prior tool was tested against real responses.
 * Only fields the adapters rely on are required; everything else is optional and nullable.
 * Failures are recorded as SchemaIssues by the client, never thrown (CLAUDE.md).
 */
import { z } from 'zod';

const str = z.string();
const optStr = z.string().nullish();
const optNum = z.number().nullish();
const optBool = z.boolean().nullish();
const strArr = z.array(z.string());

export const ConditionSchema = z.looseObject({
  type: str,
  operator: optStr,
  targetValue: z.unknown().optional(),
  field: optStr,
  customID: optStr,
});

export const VariantSchema = z.looseObject({
  id: optStr,
  name: str,
  passPercentage: z.number(),
  returnValue: z.unknown().optional(),
});

export const RuleSchema = z.looseObject({
  name: str,
  passPercentage: z.number(),
  conditions: z.array(ConditionSchema),
  environments: strArr.nullish(),
  id: optStr,
  baseID: optStr,
  returnValue: z.unknown().optional(),
  variants: z.array(VariantSchema).nullish(),
});

const Owner = z.looseObject({ ownerID: optStr, ownerType: optStr, ownerName: optStr, ownerEmail: optStr }).nullish();
/** `targetApps` is `string | string[]` in the spec. */
const TargetApps = z.union([z.string(), strArr]).nullish();

const EntityMeta = {
  id: str,
  name: optStr,
  idType: optStr,
  description: optStr,
  lastModifierID: optStr,
  lastModifiedTime: optNum,
  lastModifierEmail: optStr,
  lastModifierName: optStr,
  creatorID: optStr,
  createdTime: optNum,
  creatorName: optStr,
  creatorEmail: optStr,
  tags: strArr.nullish(),
  targetApps: TargetApps,
  holdoutIDs: strArr.nullish(),
  team: optStr,
  teamID: optStr,
  version: optNum,
  owner: Owner,
  permalink: optStr,
};

export const GateSchema = z.looseObject({
  ...EntityMeta,
  isEnabled: z.boolean(),
  rules: z.array(RuleSchema),
  status: optStr,
  type: optStr,
  typeReason: optStr,
  checksPerHour: optNum,
  archivedAt: optNum,
  isTemplate: optBool,
});

export const DynamicConfigSchema = z.looseObject({
  ...EntityMeta,
  isEnabled: z.boolean(),
  rules: z.array(RuleSchema),
  defaultValue: z.unknown().optional(),
  schema: optStr,
  status: optStr,
  type: optStr,
  typeReason: optStr,
  checksPerHour: optNum,
});

export const SegmentSchema = z.looseObject({
  ...EntityMeta,
  isEnabled: optBool,
  type: str,
  count: optNum,
  rules: z.array(RuleSchema).nullish(),
});

export const IdListSchema = z.looseObject({ name: optStr, count: optNum, ids: strArr });

export const ExperimentGroupSchema = z.looseObject({
  name: str,
  id: optStr,
  size: z.number(),
  parameterValues: z.record(z.string(), z.unknown()).nullish(),
  isControl: optBool,
});

const MetricRefSchema = z.looseObject({ name: str, type: str });

export const ExperimentSchema = z.looseObject({
  ...EntityMeta,
  status: str,
  hypothesis: optStr,
  groups: z.array(ExperimentGroupSchema),
  allocation: z.number(),
  layerID: optStr,
  targetingGateID: optStr,
  launchedGroupID: optStr,
  primaryMetrics: z.array(MetricRefSchema).nullish(),
  secondaryMetrics: z.array(MetricRefSchema).nullish(),
  inlineTargetingRules: z.array(RuleSchema).nullish(),
  salt: optStr,
  startTime: optNum,
  endTime: optNum,
});

export const LayerSchema = z.looseObject({
  ...EntityMeta,
  isImplicitLayer: optBool,
  parameters: z.array(z.looseObject({ name: str, type: optStr, defaultValue: z.unknown().optional() })).nullish(),
});

export const HoldoutSchema = z.looseObject({
  ...EntityMeta,
  isEnabled: optBool,
  passPercentage: z.number(),
  gateIDs: strArr.nullish(),
  experimentIDs: strArr.nullish(),
  layerIDs: strArr.nullish(),
  isGlobal: optBool,
  targetingGateID: optStr,
});

export const AutotuneSchema = z.looseObject({
  ...EntityMeta,
  variants: z.array(z.looseObject({ id: optStr, name: str, json: z.unknown().optional(), size: optNum })),
  successEvent: optStr,
  isStarted: optBool,
  winner: z.looseObject({ id: str, name: str }).nullish(),
});

export const MetricSchema = z.looseObject({
  id: optStr,
  name: str,
  type: str,
  description: optStr,
  tags: strArr.nullish(),
  warehouseNative: z.unknown().optional(),
  owner: Owner,
  creatorEmail: optStr,
  createdTime: optNum,
  lastModifiedTime: optNum,
  permalink: optStr,
});

export const MetricSourceSchema = z.looseObject({ name: str, description: optStr, sql: optStr });

export const ParamStoreSchema = z.looseObject({
  id: optStr,
  name: str,
  description: optStr,
  createdTime: optNum,
  parameters: z.array(z.looseObject({ name: str, ref_type: str, param_type: optStr })),
});

export const EnvironmentsSchema = z.looseObject({
  environments: z.array(z.looseObject({ name: str, id: optStr, isProduction: optBool, requiresReview: optBool })),
});

export const UnitIdTypeSchema = z.looseObject({ name: str, description: optStr });
export const TagSchema = z.looseObject({ id: optStr, name: str, description: optStr, isCore: optBool });
export const TargetAppSchema = z.looseObject({ id: optStr, name: str });
export const UserSchema = z.looseObject({ userID: optStr, email: str, firstName: optStr, lastName: optStr, role: optStr });
/** `/users/teams` lists TeamDtoWithoutMembersDto; `/users/teams/{id}` adds `members` and `admins`. */
export const TeamSchema = z.looseObject({ id: str, name: str, description: optStr, members: z.array(UserSchema).nullish(), admins: z.array(UserSchema).nullish() });

/** ExternalPromptDto (`/prompts`): the shell only; versions have no read endpoint in 20240601. */
export const PromptSchema = z.looseObject({
  id: str,
  name: optStr,
  idType: optStr,
  description: optStr,
  tags: strArr.nullish(),
  targetApps: z.union([str, strArr]).nullish(),
  holdoutIDs: strArr.nullish(),
  team: optStr,
  teamID: optStr,
  version: optNum,
  createdTime: optNum,
  lastModifiedTime: optNum,
  creatorID: optStr,
  creatorEmail: optStr,
  creatorName: optStr,
});

/** AlertSchemaDto (`/alerts`): topline alerts. `metrics` is an object keyed by metric name in the spec. */
export const AlertSchema = z.looseObject({
  id: str,
  name: str,
  alertType: optStr,
  message: optStr,
  metrics: z.unknown().optional(),
  formula: optStr,
  condition: optStr,
  alertThreshold: optNum,
  windowMs: optNum,
  team: optStr,
  owner: z.looseObject({ ownerID: optStr, ownerType: optStr, ownerName: optStr, ownerEmail: optStr }).nullish(),
  tags: strArr.nullish(),
  subscribers: z.array(z.unknown()).nullish(),
});

/** SettingsReviewsContractDto (`/settings/reviews`). */
export const ReviewSettingsSchema = z.looseObject({
  is_config_review_required: optBool,
  is_metric_review_required: optBool,
});

/** SettingsProjectContractDto (`/settings/project`). */
export const ProjectSettingsSchema = z.looseObject({ name: optStr, visibility: optStr, default_unit_type: optStr });
export const ProjectSchema = z.looseObject({ id: str, name: optStr });
export const CompanySchema = z.looseObject({ companyID: optStr, companyName: optStr, isWarehouseNative: optBool });

const GateOverride = z.looseObject({
  id: str,
  name: optStr,
  passingUserIDs: strArr.nullish(),
  failingUserIDs: strArr.nullish(),
  passingCustomIDs: strArr.nullish(),
  failingCustomIDs: strArr.nullish(),
  environmentOverrides: z
    .array(z.looseObject({ environment: optStr, unitID: optStr, passingIDs: strArr.nullish(), failingIDs: strArr.nullish() }))
    .nullish(),
});

const ExperimentOverride = z.looseObject({
  id: str,
  name: optStr,
  overrides: z.array(z.looseObject({ type: str, id: str, groupID: str, environment: optStr })).nullish(),
  userIDOverrides: z
    .array(z.looseObject({ groupID: str, ids: strArr, environment: optStr, unitType: optStr }))
    .nullish(),
});

export const OverridesSchema = z.looseObject({
  gates: z.array(GateOverride).nullish(),
  holdouts: z.array(GateOverride).nullish(),
  experiments: z.array(ExperimentOverride).nullish(),
  autotunes: z.array(ExperimentOverride).nullish(),
  layers: z.array(z.unknown()).nullish(),
});

export const PaginationSchema = z.looseObject({
  itemsPerPage: optNum,
  pageNumber: optNum,
  nextPage: optStr,
  previousPage: optStr,
  totalItems: optNum,
});

export type StatsigCondition = z.infer<typeof ConditionSchema>;
export type StatsigRule = z.infer<typeof RuleSchema>;
export type StatsigGate = z.infer<typeof GateSchema>;
export type StatsigDynamicConfig = z.infer<typeof DynamicConfigSchema>;
export type StatsigSegment = z.infer<typeof SegmentSchema>;
export type StatsigIdList = z.infer<typeof IdListSchema>;
export type StatsigExperiment = z.infer<typeof ExperimentSchema>;
export type StatsigLayer = z.infer<typeof LayerSchema>;
export type StatsigHoldout = z.infer<typeof HoldoutSchema>;
export type StatsigAutotune = z.infer<typeof AutotuneSchema>;
export type StatsigMetric = z.infer<typeof MetricSchema>;
export type StatsigMetricSource = z.infer<typeof MetricSourceSchema>;
export type StatsigParamStore = z.infer<typeof ParamStoreSchema>;
export type StatsigEnvironments = z.infer<typeof EnvironmentsSchema>;
export type StatsigUnitIdType = z.infer<typeof UnitIdTypeSchema>;
export type StatsigTag = z.infer<typeof TagSchema>;
export type StatsigTargetApp = z.infer<typeof TargetAppSchema>;
export type StatsigUser = z.infer<typeof UserSchema>;
export type StatsigTeam = z.infer<typeof TeamSchema>;
export type StatsigPrompt = z.infer<typeof PromptSchema>;
export type StatsigAlert = z.infer<typeof AlertSchema>;
export type StatsigReviewSettings = z.infer<typeof ReviewSettingsSchema>;
export type StatsigProjectSettings = z.infer<typeof ProjectSettingsSchema>;
export type StatsigProject = z.infer<typeof ProjectSchema>;
export type StatsigCompany = z.infer<typeof CompanySchema>;
export type StatsigOverrides = z.infer<typeof OverridesSchema>;

/**
 * Lenient Zod schemas for the LD REST API responses we read. Field names come from
 * reference/launchdarkly/openapi.json. Unknown fields pass through.
 */
import { z } from 'zod';

const optStr = z.string().nullish();
const optBool = z.boolean().nullish();
const optNum = z.number().nullish();

export const CallerIdentitySchema = z.looseObject({
  accountId: optStr,
  environmentId: optStr,
  projectId: optStr,
  environmentName: optStr,
  projectName: optStr,
  authKind: optStr,
  tokenKind: optStr,
  clientId: optStr,
  tokenName: optStr,
  tokenId: optStr,
  memberId: optStr,
  serviceToken: optBool,
  scopes: z.array(z.string()).nullish(),
});

/** `token` holds the last four characters on reads; we drop it anyway. */
export const TokenSchema = z
  .looseObject({
    _id: z.string(),
    name: optStr,
    role: optStr,
    customRoleIds: z.array(z.string()).nullish(),
    inlineRole: z.array(z.unknown()).nullish(),
    serviceToken: optBool,
    defaultApiVersion: optNum,
    expiry: optNum,
    token: z.unknown().optional(),
  })
  .transform(({ token: _drop, ...rest }) => rest);

const AccessEntry = z.looseObject({ action: z.string(), reason: z.unknown().optional() });
export const AccessSchema = z.looseObject({ allowed: z.array(AccessEntry).nullish(), denied: z.array(AccessEntry).nullish() });

const ApprovalSettings = z.looseObject({ required: optBool, minNumApprovals: optNum, serviceKind: optStr, requiredApprovalTags: z.array(z.string()).nullish() });

/**
 * `apiKey` (server SDK key) and `mobileKey` are secrets the app has no use for; they are
 * stripped at the schema boundary so they never enter app state, IndexedDB or logs.
 */
export const EnvironmentSchema = z
  .looseObject({
    _id: z.string(),
    key: z.string(),
    name: z.string(),
    color: optStr,
    tags: z.array(z.string()).nullish(),
    critical: optBool,
    requireComments: optBool,
    confirmChanges: optBool,
    _access: AccessSchema.nullish(),
    approvalSettings: ApprovalSettings.nullish(),
    resourceApprovalSettings: z.record(z.string(), ApprovalSettings).nullish(),
    apiKey: z.unknown().optional(),
    mobileKey: z.unknown().optional(),
  })
  .transform(({ apiKey: _a, mobileKey: _m, ...rest }) => rest);

export const EnvironmentsSchema = z.looseObject({ items: z.array(EnvironmentSchema), totalCount: optNum });

export const ProjectSchema = z.looseObject({
  _id: z.string(),
  key: z.string(),
  name: z.string(),
  tags: z.array(z.string()).nullish(),
  includeInSnippetByDefault: optBool,
  _access: AccessSchema.nullish(),
  environments: EnvironmentsSchema.nullish(),
});

export const ProjectsSchema = z.looseObject({ items: z.array(ProjectSchema), totalCount: optNum });

export const ContextKindsSchema = z.looseObject({
  items: z.array(z.looseObject({ key: z.string(), name: optStr, description: optStr, archived: optBool, createdFrom: optStr })),
});

export const FlagSummarySchema = z.looseObject({
  key: z.string(),
  name: optStr,
  kind: optStr,
  tags: z.array(z.string()).nullish(),
  archived: optBool,
  temporary: optBool,
  customProperties: z.record(z.string(), z.looseObject({ name: optStr, value: z.array(z.string()).nullish() })).nullish(),
  environments: z.record(z.string(), z.looseObject({ on: optBool, _environmentName: optStr, lastModified: optNum, version: optNum })).nullish(),
  /** Present when the listing isn't a summary (the planner's append-only guard uses it when available). */
  variations: z.array(z.looseObject({ _id: optStr, value: z.unknown(), name: optStr })).nullish(),
  _version: optNum,
});
export const FlagsSchema = z.looseObject({ items: z.array(FlagSummarySchema), totalCount: optNum });
export type LdFlagSummary = z.infer<typeof FlagSummarySchema>;

const ClauseSchema = z.looseObject({ _id: optStr, contextKind: optStr, attribute: z.string(), op: z.string(), values: z.array(z.unknown()), negate: optBool });
const RolloutSchema = z.looseObject({
  variations: z.array(z.looseObject({ variation: z.number(), weight: z.number(), _untracked: optBool })),
  contextKind: optStr,
  bucketBy: optStr,
  seed: optNum,
});
const VariationOrRolloutSchema = z.looseObject({ variation: optNum, rollout: RolloutSchema.nullish() });
const TargetSchema = z.looseObject({ values: z.array(z.string()), variation: z.number(), contextKind: optStr });

export const FlagConfigSchema = z.looseObject({
  on: z.boolean(),
  archived: optBool,
  version: optNum,
  lastModified: optNum,
  offVariation: optNum,
  fallthrough: VariationOrRolloutSchema.nullish(),
  rules: z.array(z.looseObject({ _id: optStr, description: optStr, clauses: z.array(ClauseSchema), variation: optNum, rollout: RolloutSchema.nullish(), trackEvents: optBool })).nullish(),
  targets: z.array(TargetSchema).nullish(),
  contextTargets: z.array(TargetSchema).nullish(),
  prerequisites: z.array(z.looseObject({ key: z.string(), variation: z.number() })).nullish(),
});

/** Full flag (GET /flags/{p}/{key}). Used for pre-images, so every field must survive (looseObject). */
export const FlagSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  kind: optStr,
  description: optStr,
  _version: optNum,
  temporary: optBool,
  archived: optBool,
  tags: z.array(z.string()).nullish(),
  maintainerId: optStr,
  maintainerTeamKey: optStr,
  variations: z.array(z.looseObject({ _id: z.string(), value: z.unknown(), name: optStr, description: optStr })),
  customProperties: z.record(z.string(), z.looseObject({ name: optStr, value: z.array(z.string()).nullish() })).nullish(),
  clientSideAvailability: z.looseObject({ usingEnvironmentId: optBool, usingMobileKey: optBool }).nullish(),
  defaults: z.looseObject({ onVariation: z.number(), offVariation: z.number() }).nullish(),
  environments: z.record(z.string(), FlagConfigSchema).nullish(),
});
export type LdFlag = z.infer<typeof FlagSchema>;
export type LdFlagConfig = z.infer<typeof FlagConfigSchema>;

/**
 * Flag status (GET /flag-statuses/{p}/{e}, FlagStatusRep). The items carry no `key` field: the flag
 * key is the last segment of `_links.parent.href` (`/api/v2/flags/{p}/{key}`) or `_links.self.href`.
 */
export const FlagStatusSchema = z.looseObject({
  name: z.string(),
  lastRequested: optStr,
  default: z.unknown().optional(),
  _links: z.record(z.string(), z.looseObject({ href: optStr, type: optStr })).nullish(),
});
export const FlagStatusesSchema = z.looseObject({ items: z.array(FlagStatusSchema).nullish() });
export type LdFlagStatus = z.infer<typeof FlagStatusSchema>;

/** The flag key a FlagStatusRep is about, from its links; undefined when the links are missing. */
export function flagStatusKey(s: LdFlagStatus): string | undefined {
  const href = s._links?.parent?.href ?? s._links?.self?.href;
  if (!href) return undefined;
  const last = href.split('?')[0]!.split('/').filter(Boolean).at(-1);
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export const SegmentSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  description: optStr,
  tags: z.array(z.string()).nullish(),
  version: optNum,
  deleted: optBool,
  unbounded: optBool,
  included: z.array(z.string()).nullish(),
  excluded: z.array(z.string()).nullish(),
  includedContexts: z.array(z.looseObject({ contextKind: z.string(), values: z.array(z.string()) })).nullish(),
  excludedContexts: z.array(z.looseObject({ contextKind: z.string(), values: z.array(z.string()) })).nullish(),
  rules: z.array(z.looseObject({ _id: optStr, description: optStr, clauses: z.array(ClauseSchema), weight: optNum, rolloutContextKind: optStr, bucketBy: optStr })).nullish(),
});
export const SegmentsSchema = z.looseObject({ items: z.array(SegmentSchema), totalCount: optNum });
export type LdSegment = z.infer<typeof SegmentSchema>;

/** Metric (GET /metrics/{p}/{key}); the listing returns the same shape with fewer fields (reference/launchdarkly/openapi.json MetricRep). */
export const MetricSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  kind: optStr,
  description: optStr,
  tags: z.array(z.string()).nullish(),
  eventKey: optStr,
  isNumeric: optBool,
  unit: optStr,
  selector: optStr,
  urls: z.array(z.unknown()).nullish(),
  successCriteria: optStr,
  analysisUnits: z.array(z.string()).nullish(),
  randomizationUnits: z.array(z.string()).nullish(),
  unitAggregationType: optStr,
  analysisType: optStr,
  percentileValue: optNum,
  eventDefault: z.looseObject({ disabled: optBool, value: optNum }).nullish(),
  filters: z.looseObject({ type: optStr, attribute: optStr, op: optStr, values: z.array(z.unknown()).nullish(), contextKind: optStr, negate: optBool }).nullish(),
  dataSource: z.looseObject({ key: optStr, environmentKey: optStr, _name: optStr, _integrationKey: optStr }).nullish(),
  windowStartOffset: optNum,
  windowEndOffset: optNum,
  winsorLowerPercentile: optNum,
  winsorUpperPercentile: optNum,
  winsorIncludeImputed: optBool,
  traceQuery: optStr,
  traceValueLocation: optStr,
  unitAggregationField: optStr,
  valueColumn: optStr,
  denominator: z.record(z.string(), z.unknown()).nullish(),
  maintainerId: optStr,
  _maintainer: z.looseObject({ _id: optStr, email: optStr, firstName: optStr, lastName: optStr }).nullish(),
  archived: optBool,
  archivedAt: optNum,
  isActive: optBool,
  _creationDate: optNum,
  lastModified: z.looseObject({ date: optStr }).nullish(),
  _version: optNum,
  _id: optStr,
});
export const MetricsSchema = z.looseObject({ items: z.array(MetricSchema).nullish(), totalCount: optNum });
export type LdMetric = z.infer<typeof MetricSchema>;

/** Metric group (GET /projects/{p}/metric-groups/{key}, beta): a funnel or a standard group of metrics. */
export const MetricGroupSchema = z.looseObject({
  _id: optStr,
  key: z.string(),
  name: z.string(),
  kind: optStr,
  description: optStr,
  tags: z.array(z.string()).nullish(),
  maintainer: z.looseObject({ key: optStr, kind: optStr, _member: z.looseObject({ _id: optStr, email: optStr }).nullish(), _team: z.looseObject({ key: optStr, name: optStr }).nullish() }).nullish(),
  metrics: z.array(z.looseObject({ key: z.string(), name: optStr, nameInGroup: optStr, kind: optStr })).nullish(),
  _creationDate: optNum,
  _lastModified: optNum,
  _version: optNum,
});
export const MetricGroupsSchema = z.looseObject({ items: z.array(MetricGroupSchema).nullish(), totalCount: optNum });
export type LdMetricGroup = z.infer<typeof MetricGroupSchema>;

/** A metric or metric group an iteration measures (DependentMetricOrMetricGroupRep). */
const IterationMetricSchema = z.looseObject({ key: z.string(), name: optStr, kind: optStr, isGroup: optBool, analysisUnit: optStr, isNumeric: optBool, eventKey: optStr });

/** IterationRep: the design of one iteration and how it ended. */
const IterationSchema = z.looseObject({
  _id: optStr,
  hypothesis: optStr,
  status: optStr,
  createdAt: optNum,
  startedAt: optNum,
  endedAt: optNum,
  winningTreatmentId: optStr,
  winningReason: optStr,
  canReshuffleTraffic: optBool,
  randomizationUnit: optStr,
  attributes: z.array(z.string()).nullish(),
  reallocationFrequencyMillis: optNum,
  version: optNum,
  treatments: z
    .array(z.looseObject({ _id: optStr, name: z.string(), allocationPercent: z.string(), baseline: optBool, parameters: z.array(z.looseObject({ flagKey: optStr, variationId: optStr })).nullish() }))
    .nullish(),
  flags: z.record(z.string(), z.looseObject({ targetingRule: optStr, targetingRuleDescription: optStr, flagConfigVersion: optNum, notInExperimentVariationId: optStr })).nullish(),
  metrics: z.array(IterationMetricSchema).nullish(),
  primarySingleMetric: IterationMetricSchema.nullish(),
  primaryFunnel: IterationMetricSchema.nullish(),
  /** Deprecated in LD; still the only primary field on older experiments. */
  primaryMetric: IterationMetricSchema.nullish(),
  secondaryMetrics: z.array(IterationMetricSchema).nullish(),
  layerSnapshot: z.looseObject({ key: optStr, name: optStr, reservationPercent: optNum, otherReservationPercent: optNum }).nullish(),
});

/** Experiment (GET /projects/{p}/environments/{e}/experiments/{key}). Bandits are experiments with `type: mab`; a holdout's base experiment has `type: holdout`. */
export const ExperimentSchema = z.looseObject({
  _id: optStr,
  key: z.string(),
  name: z.string(),
  description: optStr,
  environmentKey: optStr,
  type: optStr,
  tags: z.array(z.string()).nullish(),
  _maintainerId: optStr,
  _creationDate: optNum,
  methodology: optStr,
  dataSource: optStr,
  holdoutId: optStr,
  analysisConfig: z
    .looseObject({ bayesianThreshold: optStr, significanceThreshold: optStr, testDirection: optStr, multipleComparisonCorrectionMethod: optStr, multipleComparisonCorrectionScope: optStr, sequentialTestingEnabled: optBool })
    .nullish(),
  archivedDate: optNum,
  currentIteration: IterationSchema.nullish(),
  draftIteration: IterationSchema.nullish(),
  previousIterations: z.array(IterationSchema).nullish(),
});
/** LD spells this collection's count `total_count`, unlike the others. */
export const ExperimentsSchema = z.looseObject({ items: z.array(ExperimentSchema), total_count: optNum, totalCount: optNum });
export type LdExperiment = z.infer<typeof ExperimentSchema>;
export type LdIteration = z.infer<typeof IterationSchema>;

/** Holdout listing item (SimpleHoldoutRep) and detail (HoldoutDetailRep: the base experiment carries the design). */
export const HoldoutSchema = z.looseObject({
  _id: optStr,
  key: optStr,
  name: optStr,
  description: optStr,
  status: optStr,
  holdoutAmount: optStr,
  createdAt: optNum,
  updatedAt: optNum,
  baseExperiment: ExperimentSchema.nullish(),
  experiments: z.array(z.looseObject({ key: optStr, name: optStr, environment: optStr })).nullish(),
  relatedExperiments: z.array(z.looseObject({ key: z.string(), name: optStr })).nullish(),
  prerequisiteFlagKey: optStr,
});
export const HoldoutsSchema = z.looseObject({ items: z.array(HoldoutSchema).nullish(), total_count: optNum, totalCount: optNum });
export type LdHoldout = z.infer<typeof HoldoutSchema>;

/** Layer (LayerRep): project-level, with per-environment experiment reservations. */
export const LayerSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  description: optStr,
  createdAt: optNum,
  randomizationUnit: optStr,
  environments: z.record(z.string(), z.looseObject({ reservations: z.array(z.looseObject({ experimentKey: z.string(), flagKey: optStr, reservationPercent: optNum })).nullish() })).nullish(),
});
export const LayersSchema = z.looseObject({ items: z.array(LayerSchema).nullish(), totalCount: optNum });
export type LdLayer = z.infer<typeof LayerSchema>;

/** Project experimentation settings: the context kinds experiments may randomize by. */
export const ExperimentationSettingsSchema = z.looseObject({
  _projectKey: optStr,
  randomizationUnits: z.array(z.looseObject({ randomizationUnit: z.string(), default: optBool, _hidden: optBool, _displayName: optStr })).nullish(),
});
export type LdExperimentationSettings = z.infer<typeof ExperimentationSettingsSchema>;

/** Big-segment CSV import (GET /segments/{p}/{e}/{key}/imports/{id}). `status` runs preparing → … → complete | stopped. */
export const SegmentImportSchema = z.looseObject({
  id: optStr,
  segmentKey: optStr,
  mode: optStr,
  status: optStr,
  creationTime: optNum,
  files: z.array(z.looseObject({ filename: optStr, status: optStr })).nullish(),
});
export type LdSegmentImport = z.infer<typeof SegmentImportSchema>;

/** GET /segments/{p}/{e}/{key}/contexts/{contextKey} (BigSegmentTarget). */
export const SegmentMembershipSchema = z.looseObject({ userKey: optStr, included: z.boolean(), excluded: z.boolean() });

/** Approval request (flag-scoped or generic). `status` pending → completed | failed | scheduled; `reviewStatus` pending → approved | declined. */
export const ApprovalRequestSchema = z.looseObject({
  _id: z.string(),
  _version: optNum,
  creationDate: optNum,
  serviceKind: optStr,
  requestorId: optStr,
  description: optStr,
  reviewStatus: optStr,
  status: optStr,
  appliedDate: optNum,
  executionDate: optNum,
  resourceId: optStr,
  instructions: z.array(z.unknown()).nullish(),
  conflicts: z.array(z.unknown()).nullish(),
  allReviews: z.array(z.looseObject({ kind: optStr, memberId: optStr, creationDate: optNum, comment: optStr })).nullish(),
});
export type LdApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** Scheduled flag change (GET /projects/{p}/flags/{f}/environments/{e}/scheduled-changes). */
export const ScheduledChangeSchema = z.looseObject({
  _id: z.string(),
  _version: optNum,
  _creationDate: optNum,
  _maintainerId: optStr,
  _maintainerServiceTokenId: optStr,
  executionDate: optNum,
  instructions: z.array(z.unknown()).nullish(),
  conflicts: z.unknown().optional(),
});
export const ScheduledChangesSchema = z.looseObject({ items: z.array(ScheduledChangeSchema), totalCount: optNum });
export type LdScheduledChange = z.infer<typeof ScheduledChangeSchema>;

/** Any `{items: [...]}` collection, for probes where we only care that the route answers. */
export const CollectionSchema = z.looseObject({ items: z.array(z.unknown()).nullish(), totalCount: optNum });

/** Account member (GET /members). `_pendingInvite` members exist as IDs and can already be maintainers. */
export const MemberSchema = z.looseObject({
  _id: z.string(),
  email: z.string(),
  firstName: optStr,
  lastName: optStr,
  role: optStr,
  _pendingInvite: optBool,
  teams: z.array(z.looseObject({ key: z.string(), name: optStr })).nullish(),
});
export const MembersSchema = z.looseObject({ items: z.array(MemberSchema), totalCount: optNum });
export type LdMember = z.infer<typeof MemberSchema>;

/** Team (GET /teams; Enterprise). */
export const TeamSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  description: optStr,
  members: z.looseObject({ totalCount: optNum }).nullish(),
});
export const TeamsSchema = z.looseObject({ items: z.array(TeamSchema), totalCount: optNum });
export type LdTeam = z.infer<typeof TeamSchema>;

/** One AI Config variation (AIConfigVariation): the model, the messages and the tools it is wired to. */
export const AiConfigVariationSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  _id: optStr,
  description: optStr,
  comment: optStr,
  instructions: optStr,
  state: optStr,
  version: optNum,
  model: z.record(z.string(), z.unknown()).nullish(),
  modelConfigKey: optStr,
  modelConfigVersion: optNum,
  messages: z.array(z.looseObject({ role: optStr, content: optStr })).nullish(),
  tools: z.array(z.unknown()).nullish(),
  skills: z.array(z.unknown()).nullish(),
  outputFormat: z.record(z.string(), z.unknown()).nullish(),
  createdAt: optNum,
  _publishedAt: optNum,
  _archivedAt: optNum,
});
export type LdAiConfigVariation = z.infer<typeof AiConfigVariationSchema>;

/** AI Config (GET /projects/{p}/ai-configs). The description carries the migration footer, like segments. */
export const AiConfigSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  description: optStr,
  mode: optStr,
  tags: z.array(z.string()).nullish(),
  version: optNum,
  variations: z.array(AiConfigVariationSchema).nullish(),
  _maintainer: z.looseObject({ kind: optStr, member: z.looseObject({ _id: optStr, email: optStr }).nullish(), team: z.looseObject({ key: optStr, name: optStr }).nullish() }).nullish(),
  createdAt: optNum,
  updatedAt: optNum,
  evaluationMetricKey: optStr,
  evaluationMetricKeys: z.array(z.string()).nullish(),
});
export const AiConfigsSchema = z.looseObject({ items: z.array(AiConfigSchema), totalCount: optNum });
export type LdAiConfig = z.infer<typeof AiConfigSchema>;

export type LdCallerIdentity = z.infer<typeof CallerIdentitySchema>;
export type LdToken = z.infer<typeof TokenSchema>;
export type LdProject = z.infer<typeof ProjectSchema>;
export type LdEnvironment = z.infer<typeof EnvironmentSchema>;
export type LdAccess = z.infer<typeof AccessSchema>;

// ---------------------------------------------------------------------------------------------
// Everything else a source project exposes (PLAN §20.6). Lenient; credentials stripped in a
// transform so they never enter app state: a webhook's `secret`, a Relay Proxy configuration's
// `fullKey`, a trigger's `triggerURL` (the URL is the credential), a Data Export destination's
// `config` (write keys, role ARNs).
// ---------------------------------------------------------------------------------------------

const maintainerSummary = z.looseObject({ _id: optStr, email: optStr, firstName: optStr, lastName: optStr, role: optStr }).nullish();

/** Custom model configuration (ModelConfig, GET /projects/{p}/ai-configs/model-configs). */
export const ModelConfigSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  id: optStr,
  provider: optStr,
  icon: optStr,
  global: optBool,
  params: z.record(z.string(), z.unknown()).nullish(),
  customParams: z.record(z.string(), z.unknown()).nullish(),
  tags: z.array(z.string()).nullish(),
  version: optNum,
  isRestricted: optBool,
  usedInCount: optNum,
  _maintainer: z.looseObject({ kind: optStr, member: z.looseObject({ _id: optStr, email: optStr }).nullish(), team: z.looseObject({ key: optStr, name: optStr }).nullish() }).nullish(),
});
export const ModelConfigsSchema = z.looseObject({ items: z.array(ModelConfigSchema), totalCount: optNum });
export type LdModelConfig = z.infer<typeof ModelConfigSchema>;

/** Release pipeline (ReleasePipeline, beta GET /projects/{p}/release-pipelines). */
export const ReleasePipelineSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  description: optStr,
  tags: z.array(z.string()).nullish(),
  createdAt: optStr,
  _version: optNum,
  isProjectDefault: optBool,
  _isLegacy: optBool,
  phases: z
    .array(
      z.looseObject({
        id: optStr,
        name: optStr,
        audiences: z
          .array(
            z.looseObject({
              name: optStr,
              environment: z.looseObject({ key: optStr, name: optStr, color: optStr }).nullish(),
              segmentKeys: z.array(z.string()).nullish(),
              configuration: z.looseObject({ releaseStrategy: optStr, requireApproval: optBool, notifyMemberIds: z.array(z.string()).nullish(), notifyTeamKeys: z.array(z.string()).nullish(), releaseGuardianConfiguration: z.record(z.string(), z.unknown()).nullish() }).nullish(),
            }),
          )
          .nullish(),
        configuration: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .nullish(),
});
export const ReleasePipelinesSchema = z.looseObject({ items: z.array(ReleasePipelineSchema), totalCount: optNum });
export type LdReleasePipeline = z.infer<typeof ReleasePipelineSchema>;

/** Release policy (ReleasePolicy, beta GET /projects/{p}/release-policies). */
export const ReleasePolicySchema = z.looseObject({
  key: z.string(),
  name: optStr,
  _id: optStr,
  rank: optNum,
  scope: z.looseObject({ environmentKeys: z.array(z.string()).nullish(), flagTagKeys: z.array(z.string()).nullish() }).nullish(),
  releaseMethod: z.unknown().optional(),
  guardedReleaseConfig: z.record(z.string(), z.unknown()).nullish(),
  progressiveReleaseConfig: z.record(z.string(), z.unknown()).nullish(),
});
export const ReleasePoliciesSchema = z.looseObject({ items: z.array(ReleasePolicySchema).nullish(), totalCount: optNum });
export type LdReleasePolicy = z.infer<typeof ReleasePolicySchema>;

/** View (View, beta GET /projects/{p}/views). The summaries say how many resources it groups. */
export const ViewSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  description: optStr,
  id: optStr,
  tags: z.array(z.string()).nullish(),
  version: optNum,
  generateSdkKeys: optBool,
  _affectsSdkPayload: optBool,
  deleted: optBool,
  createdAt: optNum,
  updatedAt: optNum,
  maintainer: z.looseObject({ kind: optStr, member: z.looseObject({ _id: optStr, email: optStr }).nullish(), team: z.looseObject({ key: optStr, name: optStr }).nullish() }).nullish(),
  flagsSummary: z.looseObject({ count: optNum }).nullish(),
  segmentsSummary: z.looseObject({ count: optNum }).nullish(),
  metricsSummary: z.looseObject({ count: optNum }).nullish(),
  aiConfigsSummary: z.looseObject({ count: optNum }).nullish(),
});
export const ViewsSchema = z.looseObject({ items: z.array(ViewSchema), totalCount: optNum });
export type LdView = z.infer<typeof ViewSchema>;

/** Flag trigger (TriggerWorkflowRep, GET /flags/{p}/{f}/triggers/{e}). `triggerURL` is the credential and is dropped. */
export const FlagTriggerSchema = z
  .looseObject({
    _id: z.string(),
    _version: optNum,
    _creationDate: optNum,
    _maintainerId: optStr,
    _maintainer: maintainerSummary,
    enabled: optBool,
    _status: optStr,
    _integrationKey: optStr,
    instructions: z.array(z.unknown()).nullish(),
    _lastTriggeredAt: optNum,
    _triggerCount: optNum,
    triggerURL: z.unknown().optional(),
  })
  .transform(({ triggerURL: _t, ...rest }) => rest);
export const FlagTriggersSchema = z.looseObject({ items: z.array(FlagTriggerSchema).nullish() });
export type LdFlagTrigger = z.infer<typeof FlagTriggerSchema>;

/** Custom workflow (CustomWorkflowOutput, GET /projects/{p}/flags/{f}/environments/{e}/workflows). */
export const WorkflowSchema = z.looseObject({
  _id: z.string(),
  _version: optNum,
  _creationDate: optNum,
  _maintainerId: optStr,
  name: optStr,
  description: optStr,
  kind: optStr,
  templateKey: optStr,
  stages: z.array(z.looseObject({ _id: optStr, name: optStr, conditions: z.array(z.unknown()).nullish(), action: z.record(z.string(), z.unknown()).nullish(), _execution: z.looseObject({ status: optStr }).nullish() })).nullish(),
  _execution: z.looseObject({ status: optStr, stopDate: optNum }).nullish(),
});
export const WorkflowsSchema = z.looseObject({ items: z.array(WorkflowSchema).nullish(), totalCount: optNum });
export type LdWorkflow = z.infer<typeof WorkflowSchema>;

/** Flag link (FlagLinkRep, beta GET /flag-links/projects/{p}/flags/{f}). */
export const FlagLinkSchema = z.looseObject({
  _id: optStr,
  _key: optStr,
  _integrationKey: optStr,
  _deepLink: optStr,
  title: optStr,
  description: optStr,
  _createdAt: optNum,
  _member: maintainerSummary,
  _metadata: z.record(z.string(), z.unknown()).nullish(),
});
export const FlagLinksSchema = z.looseObject({ items: z.array(FlagLinkSchema).nullish() });
export type LdFlagLink = z.infer<typeof FlagLinkSchema>;

/** Data Export destination (Destination, GET /destinations). `config` holds the credentials and is dropped; the `_links.self` href names project and environment. */
export const DestinationSchema = z
  .looseObject({
    _id: z.string(),
    name: optStr,
    kind: optStr,
    version: optNum,
    on: optBool,
    createdAt: optNum,
    maintainerId: optStr,
    _links: z.looseObject({ self: z.looseObject({ href: optStr }).nullish() }).nullish(),
    config: z.unknown().optional(),
  })
  .transform(({ config: _c, ...rest }) => rest);
export const DestinationsSchema = z.looseObject({ items: z.array(DestinationSchema).nullish() });
export type LdDestination = z.infer<typeof DestinationSchema>;

/** Adaptive trigger (AdaptiveTrigger, GET /projects/{p}/environments/{e}/adaptive-triggers). */
export const AdaptiveTriggerSchema = z.looseObject({
  id: z.string(),
  name: optStr,
  resourceKind: optStr,
  resourceKey: optStr,
  enabled: optBool,
  triggerSource: z.record(z.string(), z.unknown()).nullish(),
  task: z.record(z.string(), z.unknown()).nullish(),
  createdAt: optNum,
  updatedAt: optNum,
});
export const AdaptiveTriggersSchema = z.looseObject({ items: z.array(AdaptiveTriggerSchema).nullish(), totalCount: optNum });
export type LdAdaptiveTrigger = z.infer<typeof AdaptiveTriggerSchema>;

/** Custom role (CustomRole, GET /roles). */
export const CustomRoleSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  description: optStr,
  _id: optStr,
  basePermissions: optStr,
  resourceCategory: optStr,
  policy: z.array(z.looseObject({ effect: optStr, resources: z.array(z.string()).nullish(), notResources: z.array(z.string()).nullish(), actions: z.array(z.string()).nullish(), notActions: z.array(z.string()).nullish() })).nullish(),
  assignedTo: z.looseObject({ membersCount: optNum, teamsCount: optNum }).nullish(),
});
export const CustomRolesSchema = z.looseObject({ items: z.array(CustomRoleSchema), totalCount: optNum });
export type LdCustomRole = z.infer<typeof CustomRoleSchema>;

/** Webhook (Webhook, GET /webhooks). `secret` is the signing secret and is dropped. */
export const WebhookSchema = z
  .looseObject({
    _id: z.string(),
    name: optStr,
    url: optStr,
    on: optBool,
    tags: z.array(z.string()).nullish(),
    statements: z.array(z.looseObject({ effect: optStr, resources: z.array(z.string()).nullish(), notResources: z.array(z.string()).nullish(), actions: z.array(z.string()).nullish(), notActions: z.array(z.string()).nullish() })).nullish(),
    secret: z.unknown().optional(),
  })
  .transform(({ secret: _s, ...rest }) => rest);
export const WebhooksSchema = z.looseObject({ items: z.array(WebhookSchema).nullish() });
export type LdWebhook = z.infer<typeof WebhookSchema>;

/** Relay Proxy automatic configuration (RelayAutoConfigRep, GET /account/relay-auto-configs). `fullKey` is the credential and is dropped. */
export const RelayProxyConfigSchema = z
  .looseObject({
    _id: z.string(),
    name: optStr,
    displayKey: optStr,
    creationDate: optNum,
    lastModified: optNum,
    _creator: maintainerSummary,
    policy: z.array(z.looseObject({ effect: optStr, resources: z.array(z.string()).nullish(), notResources: z.array(z.string()).nullish(), actions: z.array(z.string()).nullish(), notActions: z.array(z.string()).nullish() })).nullish(),
    fullKey: z.unknown().optional(),
  })
  .transform(({ fullKey: _k, ...rest }) => rest);
export const RelayProxyConfigsSchema = z.looseObject({ items: z.array(RelayProxyConfigSchema).nullish() });
export type LdRelayProxyConfig = z.infer<typeof RelayProxyConfigSchema>;

/** Code references repository (RepositoryRep, GET /code-refs/repositories). */
export const RepositorySchema = z.looseObject({
  name: z.string(),
  sourceLink: optStr,
  commitUrlTemplate: optStr,
  hunkUrlTemplate: optStr,
  type: optStr,
  defaultBranch: optStr,
  enabled: optBool,
  version: optNum,
  branches: z.array(z.looseObject({ name: optStr, head: optStr, updateSequenceId: optNum, syncTime: optNum })).nullish(),
});
export const RepositoriesSchema = z.looseObject({ items: z.array(RepositorySchema).nullish() });
export type LdRepository = z.infer<typeof RepositorySchema>;

/** Workflow template (WorkflowTemplateOutput, GET /templates). */
export const WorkflowTemplateSchema = z.looseObject({
  _id: z.string(),
  _key: optStr,
  name: optStr,
  description: optStr,
  _creationDate: optNum,
  _ownerId: optStr,
  _maintainerId: optStr,
  stages: z.array(z.looseObject({ name: optStr, conditions: z.array(z.unknown()).nullish(), action: z.record(z.string(), z.unknown()).nullish() })).nullish(),
});
export const WorkflowTemplatesSchema = z.looseObject({ items: z.array(WorkflowTemplateSchema).nullish() });
export type LdWorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

/** Application (ApplicationRep, beta GET /applications). */
export const ApplicationSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  description: optStr,
  kind: optStr,
  autoAdded: optBool,
  creationDate: optNum,
  _version: optNum,
  _maintainer: z.looseObject({ _id: optStr, email: optStr, firstName: optStr, lastName: optStr }).nullish(),
  flags: z.looseObject({ totalCount: optNum }).nullish(),
});
export const ApplicationsSchema = z.looseObject({ items: z.array(ApplicationSchema), totalCount: optNum });
export type LdApplication = z.infer<typeof ApplicationSchema>;

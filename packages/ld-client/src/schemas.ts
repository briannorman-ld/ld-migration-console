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

/** Metric (GET /metrics/{p}/{key}); the listing returns the same shape with fewer fields. */
export const MetricSchema = z.looseObject({
  key: z.string(),
  name: optStr,
  kind: optStr,
  description: optStr,
  tags: z.array(z.string()).nullish(),
  eventKey: optStr,
  isNumeric: optBool,
  successCriteria: optStr,
  analysisUnits: z.array(z.string()).nullish(),
  randomizationUnits: z.array(z.string()).nullish(),
  archived: optBool,
  _version: optNum,
  _id: optStr,
});
export const MetricsSchema = z.looseObject({ items: z.array(MetricSchema).nullish(), totalCount: optNum });
export type LdMetric = z.infer<typeof MetricSchema>;

const IterationSchema = z.looseObject({
  _id: optStr,
  hypothesis: optStr,
  status: optStr,
  createdAt: optNum,
  startedAt: optNum,
  endedAt: optNum,
  randomizationUnit: optStr,
  reallocationFrequencyMillis: optNum,
  treatments: z.array(z.looseObject({ _id: optStr, name: z.string(), allocationPercent: z.string(), baseline: optBool })).nullish(),
  flags: z.record(z.string(), z.looseObject({ targetingRule: optStr, flagConfigVersion: optNum })).nullish(),
});

/** Experiment (GET /projects/{p}/environments/{e}/experiments/{key}). Bandits are experiments with `type: mab`. */
export const ExperimentSchema = z.looseObject({
  _id: optStr,
  key: z.string(),
  name: z.string(),
  description: optStr,
  environmentKey: optStr,
  type: optStr,
  tags: z.array(z.string()).nullish(),
  archivedDate: optNum,
  currentIteration: IterationSchema.nullish(),
  draftIteration: IterationSchema.nullish(),
  previousIterations: z.array(IterationSchema).nullish(),
});
/** LD spells this collection's count `total_count`, unlike the others. */
export const ExperimentsSchema = z.looseObject({ items: z.array(ExperimentSchema), total_count: optNum, totalCount: optNum });
export type LdExperiment = z.infer<typeof ExperimentSchema>;
export type LdIteration = z.infer<typeof IterationSchema>;

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

/** AI Config (GET /projects/{p}/ai-configs). The description carries the migration footer, like segments. */
export const AiConfigSchema = z.looseObject({
  key: z.string(),
  name: z.string(),
  description: optStr,
  mode: optStr,
  tags: z.array(z.string()).nullish(),
  version: optNum,
  variations: z.array(z.looseObject({ key: z.string(), name: optStr, _id: optStr })).nullish(),
  _maintainer: z.looseObject({ kind: optStr, member: z.looseObject({ _id: optStr, email: optStr }).nullish(), team: z.looseObject({ key: optStr, name: optStr }).nullish() }).nullish(),
  createdAt: optNum,
  updatedAt: optNum,
});
export const AiConfigsSchema = z.looseObject({ items: z.array(AiConfigSchema), totalCount: optNum });
export type LdAiConfig = z.infer<typeof AiConfigSchema>;

export type LdCallerIdentity = z.infer<typeof CallerIdentitySchema>;
export type LdToken = z.infer<typeof TokenSchema>;
export type LdProject = z.infer<typeof ProjectSchema>;
export type LdEnvironment = z.infer<typeof EnvironmentSchema>;
export type LdAccess = z.infer<typeof AccessSchema>;

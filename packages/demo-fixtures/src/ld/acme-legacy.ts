/**
 * "Acme Legacy": a LaunchDarkly project the demo attaches as a *source* (PLAN §20). The story:
 * Acme acquired a company whose flags live in their own LD account, and wants them in the main
 * project. Shapes are LD REST API responses (reference/launchdarkly/openapi.json: FeatureFlag,
 * FeatureFlagConfig, UserSegment), served by the MSW mock in ../msw/ld-api.ts and read through
 * the real @sslm/ld-client + adapter. Each flag exercises one row of PLAN §20.3.
 */
import type { Json, JsonObject } from '../console/builders.ts';

export interface LdProjectFixture {
  project: JsonObject;
  environments: JsonObject[];
  contextKinds: JsonObject[];
  /** Full flags (GET /flags/{p}/{key} shape); archived ones included. */
  flags: JsonObject[];
  /** Segments per environment key (GET /segments/{p}/{env} shape). */
  segments: Record<string, JsonObject[]>;
  /** Experimentation (PLAN §20.5): MetricRep, MetricGroupRep, Experiment per environment, HoldoutDetailRep per environment, LayerRep. */
  metrics: JsonObject[];
  metricGroups: JsonObject[];
  experiments: Record<string, JsonObject[]>;
  holdouts: Record<string, JsonObject[]>;
  layers: JsonObject[];
  /** Account members by id (GET /members/{id} and the /members listing), for the maintainers the experimentation resources name and the People step. */
  members: Record<string, JsonObject>;
  /** Everything else (PLAN §20.6), in the shapes of reference/launchdarkly/openapi.json. */
  experimentationSettings: JsonObject;
  aiConfigs: JsonObject[];
  modelConfigs: JsonObject[];
  releasePipelines: JsonObject[];
  releasePolicies: JsonObject[];
  views: JsonObject[];
  /** Per environment key, per flag key. */
  scheduledChanges: Record<string, Record<string, JsonObject[]>>;
  flagTriggers: Record<string, Record<string, JsonObject[]>>;
  workflows: Record<string, Record<string, JsonObject[]>>;
  /** Per flag key. */
  flagLinks: Record<string, JsonObject[]>;
  /** The whole account's destinations (GET /destinations); the self link names project and environment. */
  destinations: JsonObject[];
  adaptiveTriggers: Record<string, JsonObject[]>;
  teams: JsonObject[];
  customRoles: JsonObject[];
  webhooks: JsonObject[];
  relayProxyConfigs: JsonObject[];
  repositories: JsonObject[];
  workflowTemplates: JsonObject[];
  applications: JsonObject[];
}

export const ACME_LEGACY_PROJECT_KEY = 'acme-legacy';

const T0 = Date.UTC(2025, 2, 3, 9, 0, 0);
const env = (key: string, name: string, color: string, critical: boolean): JsonObject => ({
  _id: `env-${key}`,
  key,
  name,
  color,
  critical,
  tags: [],
  requireComments: critical,
  confirmChanges: critical,
  // Production requires one approval on flag changes (ApprovalSettings); segments are exempt.
  ...(critical ? { approvalSettings: { required: true, bypassApprovalsForPendingChanges: false, minNumApprovals: 1, canReviewOwnRequest: false, canApplyDeclinedChanges: true, autoApplyApprovedChanges: false, serviceKind: 'launchdarkly', serviceConfig: {}, requiredApprovalTags: [] }, resourceApprovalSettings: { segment: { required: false, minNumApprovals: 1, serviceKind: 'launchdarkly' } } } : {}),
});
const variation = (id: string, value: Json, name?: string, description?: string): JsonObject => ({ _id: id, value, ...(name ? { name } : {}), ...(description ? { description } : {}) });
const clause = (contextKind: string, attribute: string, op: string, values: Json[], negate = false): JsonObject => ({ _id: `cl-${attribute}-${op}`, contextKind, attribute, op, values, negate });

interface EnvConfig {
  on: boolean;
  offVariation: number;
  fallthrough: JsonObject;
  rules?: JsonObject[];
  targets?: JsonObject[];
  contextTargets?: JsonObject[];
  prerequisites?: JsonObject[];
  trackEvents?: boolean;
  version?: number;
}
const config = (c: EnvConfig, envName: string): JsonObject => ({
  on: c.on,
  archived: false,
  salt: 'not-copyable',
  sel: 'x',
  lastModified: T0 + 86_400_000,
  version: c.version ?? 3,
  _environmentName: envName,
  trackEvents: c.trackEvents ?? false,
  trackEventsFallthrough: false,
  offVariation: c.offVariation,
  fallthrough: c.fallthrough,
  rules: c.rules ?? [],
  targets: c.targets ?? [],
  contextTargets: c.contextTargets ?? [],
  prerequisites: c.prerequisites ?? [],
  _summary: { variations: {}, prerequisites: (c.prerequisites ?? []).length },
});

interface FlagSeed {
  key: string;
  name: string;
  description: string;
  kind: 'boolean' | 'multivariate';
  variations: JsonObject[];
  tags: string[];
  temporary?: boolean;
  archived?: boolean;
  customProperties?: JsonObject;
  clientSideAvailability?: { usingEnvironmentId: boolean; usingMobileKey: boolean };
  maintainerId?: string;
  maintainerEmail?: string;
  experiments?: string[];
  deprecated?: boolean;
  environments: Record<string, EnvConfig>;
}
const flag = (f: FlagSeed): JsonObject => ({
  key: f.key,
  name: f.name,
  description: f.description,
  kind: f.kind,
  creationDate: T0,
  includeInSnippet: f.clientSideAvailability?.usingEnvironmentId ?? false,
  clientSideAvailability: f.clientSideAvailability ?? { usingEnvironmentId: false, usingMobileKey: false },
  temporary: f.temporary ?? true,
  tags: f.tags,
  variations: f.variations,
  defaults: { onVariation: 0, offVariation: f.variations.length - 1 },
  customProperties: f.customProperties ?? {},
  archived: f.archived ?? false,
  ...(f.archived ? { archivedDate: T0 + 2 * 86_400_000 } : {}),
  deprecated: f.deprecated ?? false,
  ...(f.maintainerId ? { maintainerId: f.maintainerId, _maintainer: { _id: f.maintainerId, email: f.maintainerEmail ?? 'someone@acme-legacy.example', firstName: 'Legacy', lastName: 'Maintainer', role: 'writer' } } : {}),
  experiments: { baselineIdx: 0, items: (f.experiments ?? []).map((key) => ({ key, name: key, environmentKey: 'production' })) },
  _version: 7,
  _links: { self: { href: `/api/v2/flags/${ACME_LEGACY_PROJECT_KEY}/${f.key}`, type: 'application/json' } },
  environments: Object.fromEntries(Object.entries(f.environments).map(([k, c]) => [k, config(c, k === 'production' ? 'Production' : 'Test')])),
});

const BOOL = [variation('v-true', true, 'On'), variation('v-false', false, 'Off')];

const segment = (s: { key: string; name: string; description?: string; tags?: string[]; included?: string[]; excluded?: string[]; includedContexts?: JsonObject[]; excludedContexts?: JsonObject[]; rules?: JsonObject[]; unbounded?: boolean; unboundedContextKind?: string; version?: number }): JsonObject => ({
  key: s.key,
  name: s.name,
  description: s.description ?? '',
  tags: s.tags ?? [],
  creationDate: T0,
  lastModifiedDate: T0 + 86_400_000,
  version: s.version ?? 2,
  deleted: false,
  generation: 1,
  unbounded: s.unbounded ?? false,
  ...(s.unbounded ? { unboundedContextKind: s.unboundedContextKind ?? 'user', _unboundedMetadata: { envId: 'env-production', version: 1, includedCount: 48_210, excludedCount: 0, lastModified: T0 } } : {}),
  included: s.included ?? [],
  excluded: s.excluded ?? [],
  includedContexts: s.includedContexts ?? [],
  excludedContexts: s.excludedContexts ?? [],
  rules: s.rules ?? [],
  _flags: [],
});

// --- Experimentation builders (reference/launchdarkly/openapi.json) ----------------------------

const MEMBERS: Record<string, JsonObject> = {
  'mem-legacy-ops': { _id: 'mem-legacy-ops', email: 'ops@acme-legacy.example', firstName: 'Legacy', lastName: 'Maintainer', role: 'writer', teams: [{ key: 'legacy-platform-ops', name: 'Platform ops' }], customRoles: ['legacy-release-manager'] },
  'mem-legacy-growth': { _id: 'mem-legacy-growth', email: 'growth@acme-legacy.example', firstName: 'Gwen', lastName: 'Growth', role: 'writer', teams: [{ key: 'legacy-growth', name: 'Growth' }] },
  // Not a maintainer of anything: listed only through GET /members (PLAN §20.6), for the People step.
  'mem-legacy-pm': { _id: 'mem-legacy-pm', email: 'pm@acme-legacy.example', firstName: 'Priya', lastName: 'Mehta', role: 'reader', teams: [{ key: 'legacy-growth', name: 'Growth' }], _pendingInvite: false },
};

interface MetricSeed {
  key: string;
  name: string;
  description?: string;
  kind: 'custom' | 'pageview' | 'click' | 'trace';
  tags?: string[];
  maintainerId?: string;
  archived?: boolean;
  extra?: JsonObject;
}
const metric = (m: MetricSeed): JsonObject => ({
  _id: `met-${m.key}`,
  _versionId: `metv-${m.key}`,
  _version: 2,
  key: m.key,
  name: m.name,
  kind: m.kind,
  description: m.description ?? '',
  tags: m.tags ?? [],
  _creationDate: T0,
  lastModified: { date: new Date(T0 + 86_400_000).toISOString() },
  ...(m.maintainerId ? { maintainerId: m.maintainerId, _maintainer: MEMBERS[m.maintainerId]! } : {}),
  dataSource: { key: 'launchdarkly', _name: 'LaunchDarkly events' },
  archived: m.archived ?? false,
  ...(m.archived ? { archivedAt: T0 + 2 * 86_400_000 } : {}),
  isActive: !m.archived,
  _links: { self: { href: `/api/v2/metrics/${ACME_LEGACY_PROJECT_KEY}/${m.key}`, type: 'application/json' } },
  ...(m.extra ?? {}),
});

interface TreatmentSeed {
  id: string;
  name: string;
  allocationPercent: string;
  baseline?: boolean;
  flagKey: string;
  variationId: string;
}
interface IterationSeed {
  id: string;
  hypothesis: string;
  status: 'not_started' | 'running' | 'stopped';
  randomizationUnit?: string;
  attributes?: string[];
  treatments: TreatmentSeed[];
  /** `[flagKey, ruleId, flagConfigVersion, notInExperimentVariationId, ruleDescription?]` */
  flags: [string, string, number, string, string?][];
  metrics: { key: string; isGroup?: boolean; kind?: string }[];
  primary: { key: string; isGroup?: boolean };
  startedAt?: number;
  endedAt?: number;
  winningTreatmentId?: string;
  winningReason?: string;
  canReshuffleTraffic?: boolean;
  reallocationFrequencyMillis?: number;
  layerSnapshot?: JsonObject;
}
const metricRep = (m: { key: string; isGroup?: boolean; kind?: string }): JsonObject => ({
  key: m.key,
  _versionId: `metv-${m.key}`,
  name: m.key,
  kind: m.kind ?? (m.isGroup ? 'funnel' : 'custom'),
  isGroup: m.isGroup ?? false,
  ...(m.isGroup ? {} : { isNumeric: false, eventKey: m.key }),
  _links: {},
});
const iteration = (it: IterationSeed): JsonObject => ({
  _id: it.id,
  hypothesis: it.hypothesis,
  status: it.status,
  createdAt: T0,
  ...(it.startedAt != null ? { startedAt: it.startedAt } : {}),
  ...(it.endedAt != null ? { endedAt: it.endedAt } : {}),
  ...(it.winningTreatmentId ? { winningTreatmentId: it.winningTreatmentId } : {}),
  ...(it.winningReason ? { winningReason: it.winningReason } : {}),
  canReshuffleTraffic: it.canReshuffleTraffic ?? true,
  randomizationUnit: it.randomizationUnit ?? 'user',
  ...(it.attributes ? { attributes: it.attributes } : {}),
  ...(it.reallocationFrequencyMillis != null ? { reallocationFrequencyMillis: it.reallocationFrequencyMillis } : {}),
  version: 1,
  treatments: it.treatments.map((t) => ({ _id: t.id, name: t.name, allocationPercent: t.allocationPercent, baseline: t.baseline ?? false, parameters: [{ flagKey: t.flagKey, variationId: t.variationId }] })),
  flags: Object.fromEntries(it.flags.map(([flagKey, ruleId, version, notIn, desc]) => [flagKey, { targetingRule: ruleId, ...(desc ? { targetingRuleDescription: desc } : {}), targetingRuleClauses: [], flagConfigVersion: version, notInExperimentVariationId: notIn, _links: {} }])),
  metrics: it.metrics.map(metricRep),
  ...(it.primary.isGroup ? { primaryFunnel: metricRep({ ...it.primary, kind: 'funnel' }) } : { primarySingleMetric: metricRep(it.primary) }),
  ...(it.layerSnapshot ? { layerSnapshot: it.layerSnapshot } : {}),
});

interface ExperimentSeed {
  key: string;
  name: string;
  description?: string;
  env: string;
  type?: 'experiment' | 'mab' | 'holdout';
  tags?: string[];
  maintainerId?: string;
  methodology?: 'bayesian' | 'frequentist';
  analysisConfig?: JsonObject;
  holdoutId?: string;
  archived?: boolean;
  currentIteration?: IterationSeed;
  draftIteration?: IterationSeed;
  previousIterations?: IterationSeed[];
}
const experiment = (x: ExperimentSeed): JsonObject => ({
  _id: `exp-${x.env}-${x.key}`,
  key: x.key,
  name: x.name,
  description: x.description ?? '',
  _maintainerId: x.maintainerId ?? 'mem-legacy-growth',
  _creationDate: T0,
  environmentKey: x.env,
  type: x.type ?? 'experiment',
  tags: x.tags ?? [],
  methodology: x.methodology ?? 'bayesian',
  dataSource: 'launchdarkly',
  ...(x.analysisConfig ? { analysisConfig: x.analysisConfig } : {}),
  ...(x.holdoutId ? { holdoutId: x.holdoutId } : {}),
  ...(x.archived ? { archivedDate: T0 + 3 * 86_400_000 } : {}),
  ...(x.currentIteration ? { currentIteration: iteration(x.currentIteration) } : {}),
  ...(x.draftIteration ? { draftIteration: iteration(x.draftIteration) } : {}),
  previousIterations: (x.previousIterations ?? []).map(iteration),
  _links: { self: { href: `/api/v2/projects/${ACME_LEGACY_PROJECT_KEY}/environments/${x.env}/experiments/${x.key}`, type: 'application/json' } },
});

/** The project at the single point in time the demo uses. Deterministic. */
export function acmeLegacyProject(): LdProjectFixture {
  const betaOrgs = { description: 'Beta organizations', clauses: [clause('organization', 'key', 'segmentMatch', ['legacy-beta-orgs'])], variation: 0, _id: 'rule-beta-orgs', trackEvents: false };
  const staff = { description: 'Acme staff', clauses: [clause('user', 'email', 'endsWith', ['@acme.example'])], variation: 0, _id: 'rule-staff', trackEvents: false };
  return {
    project: { _id: 'proj-legacy', key: ACME_LEGACY_PROJECT_KEY, name: 'Acme Legacy (acquired)', tags: ['legacy'], includeInSnippetByDefault: false },
    environments: [env('test', 'Test', '417505', false), env('production', 'Production', 'F5A623', true)],
    contextKinds: [
      { key: 'user', name: 'user', description: 'Built-in', archived: false, createdFrom: 'default', version: 1 },
      { key: 'organization', name: 'Organization', description: 'A customer organization (B2B).', archived: false, createdFrom: 'api', version: 1 },
      { key: 'device', name: 'Device', description: 'Mobile device.', archived: false, createdFrom: 'auto', version: 1 },
      { key: 'legacy-kiosk', name: 'Kiosk', description: 'Retired kiosk kind.', archived: true, createdFrom: 'api', version: 2 },
    ],
    flags: [
      // Segment reference on a custom kind, individual targets, a percentage rollout in production and
      // a custom property of its own (copy_custom_properties).
      flag({
        key: 'legacy-checkout-redesign',
        name: 'Legacy checkout redesign',
        description: 'New checkout for the acquired storefront. Rolling out by organization.',
        kind: 'boolean',
        variations: BOOL,
        tags: ['checkout', 'legacy'],
        clientSideAvailability: { usingEnvironmentId: true, usingMobileKey: true },
        customProperties: { 'jira.issue': { name: 'Jira issue', value: ['ACME-412'] } },
        environments: {
          test: { on: true, offVariation: 1, fallthrough: { variation: 1 }, rules: [betaOrgs, staff], targets: [{ variation: 0, values: ['u-qa-1', 'u-qa-2'], contextKind: 'user' }], contextTargets: [{ contextKind: 'user', variation: 0, values: [] }, { contextKind: 'organization', variation: 0, values: ['org-pilot'] }], version: 12 },
          production: { on: true, offVariation: 1, fallthrough: { rollout: { variations: [{ variation: 0, weight: 30_000 }, { variation: 1, weight: 70_000 }], contextKind: 'user' } }, rules: [betaOrgs], version: 9 },
        },
      }),
      // Multivariate strings, a prerequisite, a rollout bucketed by an attribute of a custom kind, event tracking on a rule.
      flag({
        key: 'legacy-pricing-tiers',
        name: 'Legacy pricing tiers',
        description: 'Which pricing page an organization sees.',
        kind: 'multivariate',
        variations: [variation('v-standard', 'standard', 'Standard'), variation('v-plus', 'plus', 'Plus'), variation('v-enterprise', 'enterprise', 'Enterprise', 'Sales-assisted')],
        tags: ['pricing'],
        temporary: false,
        environments: {
          test: { on: true, offVariation: 0, fallthrough: { rollout: { variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }], contextKind: 'organization', bucketBy: 'plan' } }, rules: [{ _id: 'rule-ent', description: 'Enterprise plan', clauses: [clause('organization', 'plan', 'in', ['enterprise'])], variation: 2, trackEvents: false }], prerequisites: [{ key: 'legacy-checkout-redesign', variation: 0 }] },
          production: { on: true, offVariation: 0, fallthrough: { rollout: { variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }], contextKind: 'organization', bucketBy: 'plan' } }, rules: [{ _id: 'rule-ent', description: 'Enterprise plan', clauses: [clause('organization', 'plan', 'in', ['enterprise'])], variation: 2, trackEvents: true }], prerequisites: [{ key: 'legacy-checkout-redesign', variation: 0 }] },
        },
      }),
      // The simplest case: exact copy, plus a maintainer that cannot follow.
      flag({
        key: 'legacy-kill-switch',
        name: 'Legacy kill switch',
        description: 'Turns the acquired storefront off entirely.',
        kind: 'boolean',
        variations: BOOL,
        tags: ['ops'],
        temporary: false,
        maintainerId: 'mem-legacy-ops',
        maintainerEmail: 'ops@acme-legacy.example',
        environments: {
          test: { on: true, offVariation: 1, fallthrough: { variation: 0 } },
          production: { on: true, offVariation: 1, fallthrough: { variation: 0 } },
        },
      }),
      // Archived: skipped.
      flag({ key: 'legacy-archived-promo', name: 'Legacy archived promo', description: 'Spring 2025 promo banner.', kind: 'boolean', variations: BOOL, tags: ['promo'], archived: true, environments: { test: { on: false, offVariation: 1, fallthrough: { variation: 0 } }, production: { on: false, offVariation: 1, fallthrough: { variation: 0 } } } }),
      // semVer and negated clauses on the device kind.
      flag({
        key: 'legacy-ios-min-version',
        name: 'Legacy iOS minimum version',
        description: 'Features that need app 4.2 or newer, except iPadOS.',
        kind: 'boolean',
        variations: BOOL,
        tags: ['mobile'],
        clientSideAvailability: { usingEnvironmentId: false, usingMobileKey: true },
        environments: {
          test: { on: true, offVariation: 1, fallthrough: { variation: 1 }, rules: [{ _id: 'rule-ios', description: 'App 4.2+ not on iPadOS', clauses: [clause('device', 'appVersion', 'semVerGreaterThan', ['4.2.0']), clause('device', 'os', 'in', ['ipados'], true)], variation: 0, trackEvents: false }] },
          production: { on: false, offVariation: 1, fallthrough: { variation: 1 }, rules: [{ _id: 'rule-ios', description: 'App 4.2+ not on iPadOS', clauses: [clause('device', 'appVersion', 'semVerGreaterThan', ['4.2.0']), clause('device', 'os', 'in', ['ipados'], true)], variation: 0, trackEvents: false }] },
        },
      }),
      // A big segment (membership unreadable) in production; the segment does not exist in test at all.
      flag({
        key: 'legacy-fraud-shield',
        name: 'Legacy fraud shield',
        description: 'Blocks checkout for users on the fraud blocklist.',
        kind: 'boolean',
        variations: [variation('v-allow', true, 'Allow'), variation('v-block', false, 'Block')],
        tags: ['risk'],
        temporary: false,
        environments: {
          test: { on: true, offVariation: 0, fallthrough: { variation: 0 }, rules: [{ _id: 'rule-blocklist', description: 'Blocklisted users', clauses: [clause('user', 'key', 'segmentMatch', ['legacy-fraud-blocklist'])], variation: 1, trackEvents: false }] },
          production: { on: true, offVariation: 0, fallthrough: { variation: 0 }, rules: [{ _id: 'rule-blocklist', description: 'Blocklisted users', clauses: [clause('user', 'key', 'segmentMatch', ['legacy-fraud-blocklist'])], variation: 1, trackEvents: false }] },
        },
      }),
      // JSON variations, and provenance from an *earlier* migration into this project (never copied onward).
      flag({
        key: 'legacy-theme',
        name: 'Legacy theme',
        description: 'Storefront theme. Migrated into this project from StatSig in 2025.',
        kind: 'multivariate',
        variations: [variation('v-light', { theme: 'light', contrast: 1 }, 'Light'), variation('v-dark', { theme: 'dark', contrast: 1.2 }, 'Dark')],
        tags: ['ui', 'migrated-from-statsig', 'migration-src-storefront'],
        customProperties: { 'migration.kind': { name: 'Migrated from', value: ['statsig'] }, 'migration.id': { name: 'StatSig ID', value: ['storefront_theme'] }, 'migration.source': { name: 'StatSig source', value: ['storefront'] } },
        environments: {
          test: { on: true, offVariation: 0, fallthrough: { variation: 0 }, rules: [{ _id: 'rule-dark', description: 'Dark mode opt-in', clauses: [clause('user', 'prefersDark', 'in', [true])], variation: 1, trackEvents: false }] },
          production: { on: true, offVariation: 0, fallthrough: { variation: 0 }, rules: [{ _id: 'rule-dark', description: 'Dark mode opt-in', clauses: [clause('user', 'prefersDark', 'in', [true])], variation: 1, trackEvents: false }] },
        },
      }),
      // An experiment runs on this flag (not migrated, PLAN §11) and it is deprecated.
      flag({
        key: 'legacy-cta-copy',
        name: 'Legacy CTA copy',
        description: 'Checkout button wording. An experiment is still running on it.',
        kind: 'multivariate',
        variations: [variation('v-buy', 'Buy now', 'Buy now'), variation('v-checkout', 'Checkout', 'Checkout')],
        tags: ['experiment'],
        experiments: ['legacy-cta-copy-test'],
        deprecated: true,
        environments: {
          test: { on: true, offVariation: 0, fallthrough: { variation: 0 } },
          production: { on: true, offVariation: 0, fallthrough: { rollout: { variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }], contextKind: 'user', seed: 8_675_309, experimentAllocation: { defaultVariation: 0, canReshuffle: false, type: 'experiment' } } }, trackEvents: true },
        },
      }),
      // A prerequisite on a flag that no longer exists in the source (missing_reference).
      flag({
        key: 'legacy-receipt-emails',
        name: 'Legacy receipt emails',
        description: 'Depends on a gate that was deleted in the source project.',
        kind: 'boolean',
        variations: BOOL,
        tags: ['email'],
        environments: {
          test: { on: true, offVariation: 1, fallthrough: { variation: 0 }, prerequisites: [{ key: 'legacy-retired-gate', variation: 0 }] },
          production: { on: true, offVariation: 1, fallthrough: { variation: 0 }, prerequisites: [{ key: 'legacy-retired-gate', variation: 0 }] },
        },
      }),
    ],
    segments: {
      test: [
        segment({ key: 'legacy-beta-orgs', name: 'Beta organizations', description: 'Design partners and pilot customers.', tags: ['beta'], includedContexts: [{ contextKind: 'organization', values: ['org-pilot', 'org-northwind'] }], rules: [{ _id: 'srule-dp', description: 'Design partners', clauses: [clause('organization', 'tier', 'in', ['design-partner'])] }] }),
        segment({ key: 'legacy-internal-users', name: 'Internal users', description: 'Staff and half of the contractors.', included: ['u-1', 'u-2', 'u-3'], excluded: ['u-contractor-9'], rules: [{ _id: 'srule-half', description: 'Half of acme.example', clauses: [clause('user', 'email', 'endsWith', ['@acme.example'])], weight: 50_000, rolloutContextKind: 'user' }] }),
      ],
      production: [
        segment({ key: 'legacy-beta-orgs', name: 'Beta organizations', description: 'Design partners and pilot customers.', tags: ['beta'], includedContexts: [{ contextKind: 'organization', values: ['org-pilot'] }], rules: [{ _id: 'srule-dp', description: 'Design partners', clauses: [clause('organization', 'tier', 'in', ['design-partner'])] }], version: 5 }),
        segment({ key: 'legacy-internal-users', name: 'Internal users', description: 'Staff and half of the contractors.', included: ['u-1', 'u-2'], excluded: ['u-contractor-9'], rules: [{ _id: 'srule-half', description: 'Half of acme.example', clauses: [clause('user', 'email', 'endsWith', ['@acme.example'])], weight: 50_000, rolloutContextKind: 'user' }] }),
        segment({ key: 'legacy-fraud-blocklist', name: 'Fraud blocklist', description: 'Synced nightly from the risk warehouse (big segment).', tags: ['risk'], unbounded: true, unboundedContextKind: 'user' }),
      ],
    },
    // Experimentation (PLAN §20.5; edge cases 18.10, 18.13–18.18). Every metric kind, a funnel, one
    // experiment per lifecycle state, a holdout and a layer.
    metrics: [
      // Conversion (binary) custom metric with a maintainer who exists in the target account.
      metric({ key: 'legacy-checkout-completed', name: 'Checkout completed', description: 'A user completed checkout.', kind: 'custom', tags: ['checkout'], maintainerId: 'mem-legacy-ops', extra: { eventKey: 'checkout_completed', isNumeric: false, successCriteria: 'HigherThanBaseline', analysisUnits: ['user', 'organization'], unitAggregationType: 'average', analysisType: 'mean' } }),
      // Numeric custom metric with a unit, percentile analysis, winsorization and an event default.
      metric({ key: 'legacy-order-value', name: 'Order value', description: 'Order total in USD.', kind: 'custom', tags: ['checkout', 'revenue'], maintainerId: 'mem-legacy-growth', extra: { eventKey: 'order_placed', isNumeric: true, unit: 'USD', successCriteria: 'HigherThanBaseline', analysisUnits: ['user'], unitAggregationType: 'sum', analysisType: 'percentile', percentileValue: 90, eventDefault: { disabled: false, value: 0 }, winsorLowerPercentile: 1, winsorUpperPercentile: 99, winsorIncludeImputed: false, filters: { type: 'eventProperty', attribute: 'currency', op: 'in', values: ['USD'], negate: false } } }),
      // Page view and click metrics (URL matchers, a selector).
      metric({ key: 'legacy-pricing-pageview', name: 'Pricing page viewed', kind: 'pageview', tags: ['pricing'], extra: { urls: [{ kind: 'substring', substring: '/pricing' }], isNumeric: false, successCriteria: 'HigherThanBaseline', analysisUnits: ['user'] } }),
      metric({ key: 'legacy-cta-click', name: 'CTA clicked', kind: 'click', tags: ['checkout'], extra: { selector: '#checkout-cta', urls: [{ kind: 'exact', url: 'https://shop.acme-legacy.example/cart' }], isNumeric: false, successCriteria: 'HigherThanBaseline', analysisUnits: ['user'] } }),
      // Warehouse-native metric on a data source of the source project (metric_data_source).
      metric({ key: 'legacy-wh-revenue', name: 'Revenue (warehouse)', description: 'Daily revenue from the Snowflake orders table.', kind: 'custom', tags: ['revenue', 'warehouse'], maintainerId: 'mem-legacy-growth', extra: { isNumeric: true, successCriteria: 'HigherThanBaseline', analysisUnits: ['user'], unitAggregationType: 'sum', analysisType: 'mean', dataSource: { key: 'legacy-snowflake', environmentKey: 'production', _name: 'Legacy Snowflake', _integrationKey: 'snowflake' }, valueColumn: 'revenue_usd' } }),
      // Ratio metric: a denominator event.
      metric({ key: 'legacy-cart-conversion', name: 'Cart conversion rate', kind: 'custom', tags: ['checkout'], extra: { eventKey: 'checkout_completed', isNumeric: false, successCriteria: 'HigherThanBaseline', analysisUnits: ['user'], unitAggregationType: 'count_distinct', denominator: { eventName: 'cart_viewed', isNumeric: false, unitAggregationType: 'count_distinct' } } }),
      // Archived: listed, never migrated.
      metric({ key: 'legacy-old-signup', name: 'Old signup event', kind: 'custom', tags: ['growth'], archived: true, extra: { eventKey: 'signup_v1', isNumeric: false, successCriteria: 'HigherThanBaseline', analysisUnits: ['user'] } }),
    ],
    metricGroups: [
      {
        _id: 'mg-legacy-checkout-funnel',
        key: 'legacy-checkout-funnel',
        name: 'Checkout funnel',
        kind: 'funnel',
        description: 'Cart → CTA → order.',
        tags: ['checkout'],
        maintainer: { key: 'mem-legacy-growth', kind: 'member', _member: MEMBERS['mem-legacy-growth']! },
        metrics: [
          { key: 'legacy-cta-click', name: 'CTA clicked', nameInGroup: 'Clicked CTA', kind: 'click', _links: {} },
          { key: 'legacy-checkout-completed', name: 'Checkout completed', nameInGroup: 'Completed checkout', kind: 'custom', _links: {} },
        ],
        _creationDate: T0,
        _lastModified: T0 + 86_400_000,
        _version: 1,
        _links: {},
      },
    ],
    experiments: {
      test: [
        // Not started: a draft iteration on a rule (not the default rule) of a flag that exists in test.
        experiment({
          key: 'legacy-theme-test',
          name: 'Dark theme uplift',
          description: 'Does the dark theme keep people in checkout longer?',
          env: 'test',
          tags: ['ui'],
          maintainerId: 'mem-legacy-ops',
          methodology: 'frequentist',
          analysisConfig: { significanceThreshold: '0.05', testDirection: 'two-sided', multipleComparisonCorrectionMethod: 'bonferroni', multipleComparisonCorrectionScope: 'variations', sequentialTestingEnabled: true },
          draftIteration: {
            id: 'it-theme-draft',
            hypothesis: 'Dark mode users complete checkout more often.',
            status: 'not_started',
            treatments: [
              { id: 'v-light', name: 'Light', allocationPercent: '50', baseline: true, flagKey: 'legacy-theme', variationId: 'v-light' },
              { id: 'v-dark', name: 'Dark', allocationPercent: '50', flagKey: 'legacy-theme', variationId: 'v-dark' },
            ],
            flags: [['legacy-theme', 'rule-dark', 3, 'v-light', 'Dark mode opt-in']],
            metrics: [{ key: 'legacy-checkout-completed' }, { key: 'legacy-order-value' }],
            primary: { key: 'legacy-checkout-completed' },
          },
        }),
      ],
      production: [
        // Running on the default rule of legacy-cta-copy, in a layer and a holdout, with a funnel as primary metric.
        experiment({
          key: 'legacy-cta-copy-test',
          name: 'Checkout CTA wording',
          description: '“Buy now” vs “Checkout” on the cart page.',
          env: 'production',
          tags: ['checkout', 'experiment'],
          holdoutId: 'hold-legacy-q3',
          analysisConfig: { bayesianThreshold: '0.95' },
          currentIteration: {
            id: 'it-cta-1',
            hypothesis: '“Checkout” is clearer and converts better than “Buy now”.',
            status: 'running',
            startedAt: T0 + 86_400_000,
            treatments: [
              { id: 'v-buy', name: 'Buy now', allocationPercent: '50', baseline: true, flagKey: 'legacy-cta-copy', variationId: 'v-buy' },
              { id: 'v-checkout', name: 'Checkout', allocationPercent: '50', flagKey: 'legacy-cta-copy', variationId: 'v-checkout' },
            ],
            flags: [['legacy-cta-copy', 'fallthrough', 3, 'v-buy']],
            metrics: [{ key: 'legacy-checkout-funnel', isGroup: true }, { key: 'legacy-order-value' }, { key: 'legacy-cta-click' }],
            primary: { key: 'legacy-checkout-funnel', isGroup: true },
          },
        }),
        // Stopped with a winner, after an earlier iteration: the design can be recreated, the results cannot.
        experiment({
          key: 'legacy-checkout-redesign-test',
          name: 'Checkout redesign',
          description: 'The new checkout against the old one.',
          env: 'production',
          tags: ['checkout'],
          maintainerId: 'mem-legacy-ops',
          currentIteration: {
            id: 'it-redesign-2',
            hypothesis: 'The redesign lifts completed checkouts by 3%.',
            status: 'stopped',
            startedAt: T0 + 5 * 86_400_000,
            endedAt: T0 + 20 * 86_400_000,
            winningTreatmentId: 'v-true',
            winningReason: 'Checkout completed +4.1%, credible.',
            randomizationUnit: 'organization',
            attributes: ['plan'],
            treatments: [
              { id: 'v-false', name: 'Old checkout', allocationPercent: '70', baseline: true, flagKey: 'legacy-checkout-redesign', variationId: 'v-false' },
              { id: 'v-true', name: 'Redesign', allocationPercent: '30', flagKey: 'legacy-checkout-redesign', variationId: 'v-true' },
            ],
            flags: [['legacy-checkout-redesign', 'fallthrough', 9, 'v-false']],
            metrics: [{ key: 'legacy-checkout-completed' }, { key: 'legacy-wh-revenue' }],
            primary: { key: 'legacy-checkout-completed' },
          },
          previousIterations: [
            {
              id: 'it-redesign-1',
              hypothesis: 'The redesign lifts completed checkouts.',
              status: 'stopped',
              startedAt: T0 + 86_400_000,
              endedAt: T0 + 4 * 86_400_000,
              winningReason: 'Inconclusive; restarted with a bigger allocation.',
              randomizationUnit: 'organization',
              treatments: [
                { id: 'v-false', name: 'Old checkout', allocationPercent: '90', baseline: true, flagKey: 'legacy-checkout-redesign', variationId: 'v-false' },
                { id: 'v-true', name: 'Redesign', allocationPercent: '10', flagKey: 'legacy-checkout-redesign', variationId: 'v-true' },
              ],
              flags: [['legacy-checkout-redesign', 'fallthrough', 7, 'v-false']],
              metrics: [{ key: 'legacy-checkout-completed' }],
              primary: { key: 'legacy-checkout-completed' },
            },
          ],
        }),
        // A multi-armed bandit on pricing tiers.
        experiment({
          key: 'legacy-pricing-bandit',
          name: 'Pricing page bandit',
          env: 'production',
          type: 'mab',
          tags: ['pricing'],
          currentIteration: {
            id: 'it-pricing-mab',
            hypothesis: 'Let the bandit find the pricing page that sells.',
            status: 'running',
            startedAt: T0 + 2 * 86_400_000,
            randomizationUnit: 'organization',
            reallocationFrequencyMillis: 3_600_000,
            treatments: [
              { id: 'v-standard', name: 'Standard', allocationPercent: '34', baseline: true, flagKey: 'legacy-pricing-tiers', variationId: 'v-standard' },
              { id: 'v-plus', name: 'Plus', allocationPercent: '33', flagKey: 'legacy-pricing-tiers', variationId: 'v-plus' },
              { id: 'v-enterprise', name: 'Enterprise', allocationPercent: '33', flagKey: 'legacy-pricing-tiers', variationId: 'v-enterprise' },
            ],
            flags: [['legacy-pricing-tiers', 'fallthrough', 3, 'v-standard']],
            metrics: [{ key: 'legacy-pricing-pageview' }],
            primary: { key: 'legacy-pricing-pageview' },
          },
        }),
        // Archived: listed, never migrated.
        experiment({
          key: 'legacy-old-banner-test',
          name: 'Old banner test',
          env: 'production',
          archived: true,
          currentIteration: {
            id: 'it-banner',
            hypothesis: 'A banner helps.',
            status: 'stopped',
            treatments: [{ id: 'v-true', name: 'On', allocationPercent: '100', baseline: true, flagKey: 'legacy-kill-switch', variationId: 'v-true' }],
            flags: [['legacy-kill-switch', 'fallthrough', 3, 'v-true']],
            metrics: [{ key: 'legacy-checkout-completed' }],
            primary: { key: 'legacy-checkout-completed' },
          },
        }),
        // A holdout's base experiment is listed among the experiments too; it travels with the holdout.
        experiment({
          key: 'legacy-q3-holdout',
          name: 'Q3 holdout',
          env: 'production',
          type: 'holdout',
          currentIteration: {
            id: 'it-holdout-q3',
            hypothesis: 'Holdout',
            status: 'running',
            treatments: [],
            flags: [],
            metrics: [{ key: 'legacy-checkout-completed' }, { key: 'legacy-order-value' }],
            primary: { key: 'legacy-checkout-completed' },
          },
        }),
      ],
    },
    holdouts: {
      test: [],
      production: [
        {
          _id: 'hold-legacy-q3',
          key: 'legacy-q3-holdout',
          name: 'Q3 holdout',
          description: 'Keeps 10% of users out of every Q3 experiment to measure their combined effect.',
          status: 'running',
          holdoutAmount: '10',
          createdAt: T0,
          updatedAt: T0 + 86_400_000,
          isDirty: false,
          baseExperiment: experiment({
            key: 'legacy-q3-holdout',
            name: 'Q3 holdout',
            env: 'production',
            type: 'holdout',
            maintainerId: 'mem-legacy-growth',
            currentIteration: {
              id: 'it-holdout-q3',
              hypothesis: 'Holdout',
              status: 'running',
              treatments: [],
              flags: [],
              metrics: [{ key: 'legacy-checkout-completed' }, { key: 'legacy-order-value' }],
              primary: { key: 'legacy-checkout-completed' },
            },
          }),
          relatedExperiments: [{ key: 'legacy-cta-copy-test', name: 'Checkout CTA wording' }],
          experiments: [{ key: 'legacy-cta-copy-test', name: 'Checkout CTA wording', environment: 'production' }],
        },
      ],
    },
    layers: [
      {
        key: 'legacy-checkout-layer',
        name: 'Checkout layer',
        description: 'Mutually exclusive checkout experiments.',
        createdAt: T0,
        randomizationUnit: 'user',
        environments: {
          production: { reservations: [{ experimentKey: 'legacy-cta-copy-test', flagKey: 'legacy-cta-copy', reservationPercent: 40 }] },
          test: { reservations: [] },
        },
      },
    ],
    members: MEMBERS,
    // --- Everything else (PLAN §20.6) ---------------------------------------------------------------
    experimentationSettings: { _projectId: 'proj-legacy', _projectKey: ACME_LEGACY_PROJECT_KEY, randomizationUnits: [{ randomizationUnit: 'user', default: true, _hidden: false, _displayName: 'User' }, { randomizationUnit: 'organization', default: false, _hidden: false, _displayName: 'Organization' }], _creationDate: T0 },
    aiConfigs: [
      {
        key: 'legacy-support-assistant',
        name: 'Support assistant',
        description: 'System prompt and model for the in-app support assistant.',
        mode: 'completion',
        tags: ['support'],
        version: 4,
        _maintainer: { kind: 'member', member: { _id: 'mem-legacy-growth', email: 'growth@acme-legacy.example' } },
        evaluationMetricKey: 'legacy-checkout-completed',
        createdAt: T0,
        updatedAt: T0 + 86_400_000,
        variations: [
          { _id: 'aiv-1', key: 'concise', name: 'Concise', state: 'published', version: 2, modelConfigKey: 'gpt-4o-mini', model: { name: 'gpt-4o-mini', parameters: { temperature: 0.2 } }, messages: [{ role: 'system', content: 'You are a concise support assistant for Acme Legacy.' }], createdAt: T0 },
          { _id: 'aiv-2', key: 'friendly-claude', name: 'Friendly (Claude)', state: 'published', version: 1, modelConfigKey: 'legacy-claude-haiku', model: { name: 'claude-haiku', parameters: { temperature: 0.7 } }, messages: [{ role: 'system', content: 'You are a warm, friendly support assistant.' }], tools: [{ key: 'lookup-order' }], createdAt: T0 },
        ],
      },
    ],
    modelConfigs: [
      { key: 'legacy-claude-haiku', name: 'Claude Haiku (legacy account)', id: 'mc-1', provider: 'anthropic', global: false, params: { temperature: 0.7, maxTokens: 1024 }, customParams: { region: 'us-east-1' }, tags: ['support'], version: 1, isRestricted: false, usedInCount: 1, _maintainer: { kind: 'member', member: { _id: 'mem-legacy-growth', email: 'growth@acme-legacy.example' } } },
    ],
    releasePipelines: [
      {
        key: 'legacy-standard-release',
        name: 'Standard release',
        description: 'Test first, then production with an approval.',
        tags: [],
        createdAt: new Date(T0).toISOString(),
        _version: 2,
        isProjectDefault: true,
        phases: [
          { id: 'ph-test', name: 'Test', audiences: [{ name: 'Test', environment: { key: 'test', name: 'Test', color: '417505' }, configuration: { releaseStrategy: 'immediate-rollout', requireApproval: false, notifyMemberIds: [], notifyTeamKeys: [] } }] },
          { id: 'ph-prod', name: 'Production', audiences: [{ name: 'Production', environment: { key: 'production', name: 'Production', color: 'F5A623' }, configuration: { releaseStrategy: 'immediate-rollout', requireApproval: true, notifyMemberIds: ['mem-legacy-ops'], notifyTeamKeys: ['legacy-platform-ops'] } }] },
        ],
      },
    ],
    releasePolicies: [
      { _id: 'rp-1', key: 'legacy-guarded-checkout', name: 'Guarded checkout releases', rank: 1, scope: { environmentKeys: ['production'], flagTagKeys: ['checkout'] }, releaseMethod: 'guarded-release', guardedReleaseConfig: { monitoringWindowMilliseconds: 3_600_000, rollbackOnRegression: true, randomizationUnit: 'user', rolloutWeight: 10_000 } },
    ],
    views: [
      { id: 'view-1', key: 'legacy-checkout', name: 'Checkout', description: 'Everything the checkout squad owns.', tags: ['checkout'], version: 3, generateSdkKeys: false, _affectsSdkPayload: false, deleted: false, createdAt: T0, updatedAt: T0 + 86_400_000, maintainer: { kind: 'team', team: { key: 'legacy-growth', name: 'Growth' } }, flagsSummary: { count: 3 }, segmentsSummary: { count: 1 }, metricsSummary: { count: 2 }, aiConfigsSummary: { count: 0 } },
    ],
    scheduledChanges: {
      production: {
        // A plain flip the console can carry as an LD scheduled change (dated well ahead so the demo offers to schedule it).
        'legacy-theme': [{ _id: 'sc-theme-on', _version: 1, _creationDate: T0, _maintainerId: 'mem-legacy-growth', executionDate: Date.UTC(2027, 5, 1, 9, 0, 0), instructions: [{ kind: 'turnFlagOn' }], conflicts: {} }],
        // A fallthrough change the console does not translate: noted on the flag, listed in the inventory.
        'legacy-kill-switch': [{ _id: 'sc-kill-fallthrough', _version: 1, _creationDate: T0, _maintainerId: 'mem-legacy-ops', executionDate: Date.UTC(2027, 0, 15, 9, 0, 0), instructions: [{ kind: 'updateFallthroughVariationOrRollout', variationId: 'v-false' }], conflicts: {} }],
      },
      test: {
        // An added rule: variation id resolved against the flag's variations.
        'legacy-pricing-tiers': [{ _id: 'sc-pricing-rule', _version: 1, _creationDate: T0, _maintainerId: 'mem-legacy-growth', executionDate: Date.UTC(2027, 2, 1, 9, 0, 0), instructions: [{ kind: 'addRule', description: 'Plus for design partners', variationId: 'v-plus', clauses: [{ contextKind: 'organization', attribute: 'tier', op: 'in', values: ['design-partner'], negate: false }] }], conflicts: {} }],
      },
    },
    flagTriggers: {
      production: {
        'legacy-kill-switch': [{ _id: 'trig-kill', _version: 1, _creationDate: T0, _maintainerId: 'mem-legacy-ops', _maintainer: MEMBERS['mem-legacy-ops']!, enabled: true, _status: 'active', _integrationKey: 'datadog', instructions: [{ kind: 'turnFlagOff' }], _triggerCount: 2, _lastTriggeredAt: T0 + 86_400_000, triggerURL: 'https://app.launchdarkly.com/webhook/triggers/SECRET-PATH-DO-NOT-STORE' }],
      },
      test: {},
    },
    workflows: {
      production: {
        'legacy-checkout-redesign': [
          {
            _id: 'wf-checkout',
            _version: 1,
            _creationDate: T0,
            _maintainerId: 'mem-legacy-growth',
            name: 'Checkout gradual rollout',
            description: 'Approval, then 10% → 50% → 100% a day apart.',
            kind: 'custom',
            templateKey: 'legacy-progressive',
            stages: [
              { _id: 'st-1', name: 'Approve', conditions: [{ kind: 'ld-approval', notifyMemberIds: ['mem-legacy-ops'] }], action: { instructions: [{ kind: 'turnFlagOn' }] }, _execution: { status: 'completed' } },
              { _id: 'st-2', name: '10%', conditions: [{ kind: 'schedule', waitDuration: 1, waitDurationUnit: 'calendarDay' }], action: { instructions: [{ kind: 'updateFallthroughVariationOrRollout', rolloutWeights: { 'v-true': 10_000, 'v-false': 90_000 } }] }, _execution: { status: 'active' } },
              { _id: 'st-3', name: '100%', conditions: [{ kind: 'schedule', waitDuration: 1, waitDurationUnit: 'calendarDay' }], action: { instructions: [{ kind: 'updateFallthroughVariationOrRollout', variationId: 'v-true' }] }, _execution: { status: 'pending' } },
            ],
            _execution: { status: 'active' },
          },
        ],
      },
      test: {},
    },
    flagLinks: {
      'legacy-checkout-redesign': [{ _id: 'fl-1', _key: 'jira-ACME-412', _integrationKey: 'jira', _deepLink: 'https://acme-legacy.atlassian.net/browse/ACME-412', title: 'ACME-412: New checkout', description: 'Tracking issue.', _createdAt: T0, _member: MEMBERS['mem-legacy-growth']! }],
    },
    destinations: [
      { _id: 'dest-prod-segment', name: 'Segment (production)', kind: 'segment', version: 1, on: true, createdAt: T0, maintainerId: 'mem-legacy-ops', config: { writeKey: 'SEGMENT-WRITE-KEY-DO-NOT-STORE' }, _links: { self: { href: `/api/v2/destinations/${ACME_LEGACY_PROJECT_KEY}/production/dest-prod-segment`, type: 'application/json' } } },
      // Another project's destination in the same account: the adapter leaves it out.
      { _id: 'dest-other', name: 'Kinesis (other project)', kind: 'kinesis', version: 1, on: false, createdAt: T0, config: { roleArn: 'arn:aws:iam::123:role/x' }, _links: { self: { href: '/api/v2/destinations/other-project/production/dest-other', type: 'application/json' } } },
    ],
    adaptiveTriggers: {
      production: [{ id: 'at-fraud', name: 'Roll back fraud shield on error spike', resourceKind: 'flag', resourceKey: 'legacy-fraud-shield', enabled: true, triggerSource: { kind: 'observability-alert', alertId: 'alert-9' }, task: { kind: 'flag-off' }, createdAt: T0, updatedAt: T0 }],
      test: [],
    },
    teams: [
      { key: 'legacy-growth', name: 'Growth', description: 'Experimentation and pricing.', _creationDate: T0, _lastModified: T0, _version: 3, _idpSynced: false, members: { totalCount: 2 }, projects: { totalCount: 1, items: [{ key: ACME_LEGACY_PROJECT_KEY, name: 'Acme Legacy (acquired)' }] }, roles: { totalCount: 0, items: [] } },
      { key: 'legacy-platform-ops', name: 'Platform ops', description: 'Kill switches and releases.', _creationDate: T0, _lastModified: T0, _version: 1, _idpSynced: true, members: { totalCount: 1 }, projects: { totalCount: 1, items: [{ key: ACME_LEGACY_PROJECT_KEY, name: 'Acme Legacy (acquired)' }] }, roles: { totalCount: 1, items: [{ key: 'legacy-release-manager', name: 'Release manager' }] } },
    ],
    customRoles: [
      { _id: 'role-1', key: 'legacy-release-manager', name: 'Release manager', description: 'May flip production flags of the legacy project, nothing else.', basePermissions: 'reader', resourceCategory: 'project', policy: [{ effect: 'allow', resources: [`proj/${ACME_LEGACY_PROJECT_KEY}:env/production:flag/*`], actions: ['updateOn', 'updateFallthrough'] }], assignedTo: { membersCount: 1, teamsCount: 1 } },
    ],
    webhooks: [
      { _id: 'wh-slack', name: 'Slack #legacy-flags', url: 'https://hooks.example/legacy-flags', on: true, tags: ['legacy'], statements: [{ effect: 'allow', resources: [`proj/${ACME_LEGACY_PROJECT_KEY}:env/production:flag/*`], actions: ['*'] }], secret: 'WEBHOOK-SIGNING-SECRET-DO-NOT-STORE' },
    ],
    relayProxyConfigs: [{ _id: 'relay-1', name: 'Legacy relay', policy: [{ effect: 'allow', resources: [`proj/${ACME_LEGACY_PROJECT_KEY}:env/*`], actions: ['*'] }], fullKey: 'rel-FULL-KEY-DO-NOT-STORE', displayKey: 'a1b2', creationDate: T0, lastModified: T0, _creator: MEMBERS['mem-legacy-ops']! }],
    repositories: [{ name: 'acme-legacy/storefront', sourceLink: 'https://github.com/acme-legacy/storefront', commitUrlTemplate: 'https://github.com/acme-legacy/storefront/commit/${sha}', hunkUrlTemplate: 'https://github.com/acme-legacy/storefront/blob/${sha}/${filePath}#L${lineNumber}', type: 'github', defaultBranch: 'main', enabled: true, version: 12, branches: [{ name: 'main', head: 'abc123', updateSequenceId: 12, syncTime: T0 + 86_400_000 }] }],
    workflowTemplates: [{ _id: 'tpl-1', _key: 'legacy-progressive', name: 'Progressive rollout', description: 'Approval, then 10% → 100%.', _creationDate: T0, _ownerId: 'mem-legacy-growth', _maintainerId: 'mem-legacy-growth', stages: [{ name: 'Approve', conditions: [{ kind: 'ld-approval' }], action: { instructions: [{ kind: 'turnFlagOn' }] } }, { name: '10%', conditions: [{ kind: 'schedule', waitDuration: 1, waitDurationUnit: 'calendarDay' }], action: { instructions: [] } }, { name: '100%', conditions: [], action: { instructions: [] } }] }],
    applications: [{ key: 'legacy-ios', name: 'Legacy iOS app', description: 'Reported by the iOS SDK.', kind: 'mobile', autoAdded: true, creationDate: T0, _version: 1, _maintainer: MEMBERS['mem-legacy-ops']!, flags: { totalCount: 2 } }],
  };
}

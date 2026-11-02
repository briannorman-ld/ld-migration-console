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
}

export const ACME_LEGACY_PROJECT_KEY = 'acme-legacy';

const T0 = Date.UTC(2025, 2, 3, 9, 0, 0);
const env = (key: string, name: string, color: string, critical: boolean): JsonObject => ({ _id: `env-${key}`, key, name, color, critical, tags: [], requireComments: critical, confirmChanges: critical });
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
  };
}

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { acmeHogLocalEvaluationPayload, acmeHogProject, ACME_HOG_PROJECT_ID, createPostHogApiHandlers } from '@sslm/demo-fixtures';
import type { NeutralFlag } from '@sslm/canonical';
import { normalizePostHogSnapshot, parsePostHogPayload, PostHogClient, PostHogPayloadError, PostHogReadAuthError, readPostHogProject, semverRange, translateFilter, typeValues, type TranslateContext } from '../src/index.ts';

const ORIGIN = 'https://demo-posthog.test';
const KEY = 'phx_test-key';
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const SOURCE = { sourceId: 'src-hog', sourceKind: 'posthog' as const, alias: 'hog' };

function client(key = KEY) {
  const requests: string[] = [];
  server.use(...createPostHogApiHandlers({ baseUrl: ORIGIN, getProject: acmeHogProject, key: KEY, onRequest: (r) => requests.push(`${r.status} ${r.path}`) }));
  return { client: new PostHogClient({ region: { origin: ORIGIN }, key, transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 2 } } }), requests };
}

const flagOf = (flags: NeutralFlag[], key: string) => flags.find((f) => f.key === key)!;

describe('PostHog source adapter (PLAN §22.2)', () => {
  it('lists the projects a key can read, across organizations', async () => {
    const { client: c } = client();
    expect(await c.listReadableProjects()).toEqual([{ id: ACME_HOG_PROJECT_ID, name: 'Acme Hog', organizationId: acmeHogProject().organization.id, organizationName: 'Acme Retail' }]);
  });

  it('reads flags (archived included, deleted never), cohorts, group types, property definitions and cohort members with only GETs', async () => {
    const { client: c, requests } = client();
    const progress: string[] = [];
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID, { onProgress: (p) => progress.push(p.endpoint) });
    expect(raw.flags.map((f) => f.key)).toContain('hog-archived-promo');
    expect(raw.flags.map((f) => f.key)).not.toContain('hog-deleted');
    expect(raw.cohorts.map((x) => x.id)).toEqual([301, 302, 303, 304, 305]);
    expect(raw.groupTypes.map((g) => g.group_type)).toEqual(['company', 'workspace']);
    expect(raw.propertyDefinitions.filter((d) => d.type === 'group')).toHaveLength(2);
    // Static cohort 301 and behavioral cohort 304 are referenced by flags: their members were read, with distinct ids.
    expect(raw.cohortMembers['301']!.flatMap((p) => p.distinct_ids)).toEqual(['u-1', 'u-2', 'u-2-legacy', 'u-3']);
    expect(raw.cohortMembers['304']).toHaveLength(2);
    expect(raw.membersUnreadable).toEqual({});
    expect(raw.scheduledChanges.map((s) => s.record_id)).toEqual(['1019', '1007']);
    expect(raw.skipped).toEqual([]);
    expect(requests.every((r) => r.startsWith('200 '))).toBe(true);
    expect(progress.at(-1)).toBe('done');
  });

  it('a wrong key is an auth error on the project read', async () => {
    const { client: c } = client('phx_wrong');
    await expect(readPostHogProject(c, ACME_HOG_PROJECT_ID)).rejects.toBeInstanceOf(PostHogReadAuthError);
  });

  it('normalizes into the neutral block with one environment named after the project', async () => {
    const { client: c } = client();
    const snap = normalizePostHogSnapshot(await readPostHogProject(c, ACME_HOG_PROJECT_ID), { source: SOURCE, takenAt: '2026-11-12T00:00:00.000Z' });
    expect(snap.source).toEqual(SOURCE);
    expect(snap.gates).toEqual([]);
    expect(snap.environments).toEqual([{ name: 'Acme Hog', id: '4242', isProduction: false, inferred: true }]);
    expect(snap.neutral!.contextKinds.map((k) => k.key)).toEqual(['user', 'company', 'workspace']);
    expect(snap.unitTypes.map((u) => u.name)).toEqual(['company', 'workspace']);
    expect(snap.neutral!.attributes!.find((a) => a.name === 'seats')).toEqual({ name: 'seats', contextKind: 'user', type: 'number' });
    expect(snap.neutral!.attributes!.find((a) => a.name === 'tier')).toEqual({ name: 'tier', contextKind: 'company', type: 'string' });
    expect(snap.users.map((u) => u.email)).toEqual(['alice.chen@acmeretail.example', 'bob.okafor@acmeretail.example']);
    const flags = snap.neutral!.flags;

    // Key is the name, `name` is the description; creator → maintainer.
    const kill = flagOf(flags, 'hog-kill-switch');
    expect(kill.name).toBe('hog-kill-switch');
    expect(kill.description).toBe('Turns the storefront off entirely.');
    expect(kill.maintainer).toEqual({ id: '7', email: 'alice.chen@acmeretail.example' });
    expect(kill.flagKind).toBe('boolean');
    expect(kill.variations.map((v) => v.value)).toEqual([true, false]);
    // An "everyone" set is a rule with no clauses (the mapper makes it the default rule).
    expect(kill.environments[0]!.rules).toEqual([{ id: 'set-0', description: 'Condition set 1', clauses: [], variation: 0 }]);
    expect(kill.environments[0]!.on).toBe(true);
    expect(flagOf(flags, 'hog-disabled-legacy').environments[0]!.on).toBe(false);
    expect(flagOf(flags, 'hog-archived-promo').archived).toBe(true);

    // Condition sets: case-insensitive contains, a cohort → segmentMatch on the cohort's key, a last 25% set → coverage.
    const checkout = flagOf(flags, 'hog-checkout-redesign').environments[0]!;
    expect(checkout.rules[0]!.clauses).toEqual([{ contextKind: 'user', attribute: 'email', op: 'contains', values: ['@acme.example'], negate: false, caseInsensitive: true }]);
    expect(checkout.rules[1]!.clauses).toEqual([{ contextKind: 'user', attribute: 'key', op: 'segmentMatch', values: ['design-partners'], negate: false }]);
    expect(checkout.rules[2]).toMatchObject({ clauses: [], variation: 0, coverage: 0.25 });
    expect(flagOf(flags, 'hog-checkout-redesign').caveats).toEqual([{ kind: 'unsalted_rollout' }]);

    // Multivariate: variants + payloads + the synthetic "Not served" variation; a variant override and a variant split.
    const pricing = flagOf(flags, 'hog-pricing-page');
    expect(pricing.flagKind).toBe('multivariate');
    expect(pricing.variations).toEqual([
      { value: 'control', name: 'Control', payload: { layout: 'classic' } },
      { value: 'plus', name: 'Plus', payload: { layout: 'plus' } },
      { value: 'enterprise', name: 'Enterprise', payload: { layout: 'enterprise', salesCta: true } },
      { value: '', name: 'Not served', synthetic: 'no_match' },
    ]);
    expect(pricing.environments[0]!.offVariation).toBe(3);
    expect(pricing.environments[0]!.rules[0]).toMatchObject({ variation: 2, clauses: [{ attribute: 'plan', op: 'in', values: ['enterprise'], caseInsensitive: true }] });
    expect(pricing.environments[0]!.rules[1]!.rollout).toEqual({ contextKind: 'user', variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 25_000 }, { variation: 2, weight: 25_000 }] });

    // Early exit: a 40% set becomes a lossless two-way rollout.
    const staff = flagOf(flags, 'hog-staff-tools').environments[0]!;
    expect(staff.rules[0]!.rollout).toEqual({ contextKind: 'user', variations: [{ variation: 0, weight: 40_000 }, { variation: 1, weight: 60_000 }] });
    expect(staff.rules[0]!.coverage).toBeUndefined();

    // Group targeting: the company kind buckets the rollout; mixed targeting sets the rule's kind.
    const tier = flagOf(flags, 'hog-company-tier').environments[0]!;
    expect(tier.rules[0]!.clauses[0]).toMatchObject({ contextKind: 'company', attribute: 'tier', op: 'in', values: ['gold', 'platinum'] });
    expect(tier.rules[1]).toMatchObject({ clauses: [], coverage: 0.1, rollout: { contextKind: 'company', variations: [{ variation: 0, weight: 100_000 }] } });

    // Operators.
    const ios = flagOf(flags, 'hog-ios-min-version').environments[0]!.rules[0]!;
    expect(ios.clauses).toEqual([
      { contextKind: 'user', attribute: 'app_version', op: 'semVerLessThan', values: ['4.2.0'], negate: true },
      { contextKind: 'user', attribute: 'os', op: 'in', values: ['ipados'], negate: true, caseInsensitive: true },
    ]);
    expect(flagOf(flags, 'hog-ios-min-version').clientSideAvailability).toEqual({ usingEnvironmentId: true, usingMobileKey: true });
    expect(flagOf(flags, 'hog-server-only').clientSideAvailability).toEqual({ usingEnvironmentId: false, usingMobileKey: false });
    const onboarding = flagOf(flags, 'hog-new-onboarding').environments[0]!;
    expect(onboarding.rules[0]).toMatchObject({ coverage: 0.5, clauses: [{ attribute: 'signup_date', op: 'after', values: ['-30d'] }] });
    // `['true']` on a Boolean property is typed as a boolean, not a case-insensitive string.
    expect(onboarding.rules[1]!.clauses).toEqual([{ contextKind: 'user', attribute: 'beta_tester', op: 'in', values: [true], negate: false }]);
    const eu = flagOf(flags, 'hog-eu-rollout').environments[0]!.rules[0]!;
    expect(eu.clauses.map((c) => c.op)).toEqual(['segmentMatch', 'greaterThanOrEqual', 'lessThanOrEqual', 'matches']);
    const notBetween = flagOf(flags, 'hog-not-between').environments[0]!.rules;
    expect(notBetween.map((r) => [r.description, r.clauses[0]!.op, r.clauses[0]!.values[0]])).toEqual([
      ['Condition set 1 (a)', 'lessThan', 5],
      ['Condition set 1 (b)', 'greaterThan', 50],
    ]);
    const power = flagOf(flags, 'hog-power-users').environments[0]!.rules[0]!;
    expect(power.clauses.map((c) => [c.op, c.negate])).toEqual([
      ['segmentMatch', false],
      ['isSet', false],
      ['segmentMatch', true],
    ]);

    // Flag dependency by id → a rule-level prerequisite on the parent's key and `true` variation.
    const dep = flagOf(flags, 'hog-depends-on-checkout').environments[0]!.rules[0]!;
    expect(dep.prerequisites).toEqual([{ key: 'hog-checkout-redesign', variation: 0 }]);
    expect(dep.clauses).toEqual([{ contextKind: 'user', attribute: 'seats', op: 'greaterThan', values: [10], negate: false }]);

    // Remote config, early access, holdout + experiment, device bucketing, scheduled change, encrypted payload, survey.
    const remote = flagOf(flags, 'hog-remote-config');
    expect(remote.variations[0]).toEqual({ value: { maxItems: 20, theme: 'dark' }, name: 'Remote config' });
    expect(remote.environments[0]!.fallthrough).toEqual({ variation: 0 });
    expect(remote.caveats).toEqual([{ kind: 'remote_config' }]);
    const early = flagOf(flags, 'hog-early-access');
    // The 0% "everyone" set matches nobody and is dropped (exact).
    expect(early.environments[0]!.rules.map((r) => r.id)).toEqual(['enrollment-in', 'enrollment-out']);
    expect(early.caveats).toEqual([{ kind: 'early_access_enrollment', detail: { attribute: '$feature_enrollment/hog-early-access', stage: 'beta' } }]);
    const holdout = flagOf(flags, 'hog-holdout-experiment');
    expect(holdout.environments[0]!.rules[0]!.experiment).toEqual({ key: 'Holdout experiment' });
    expect(holdout.caveats).toContainEqual({ kind: 'holdout', detail: { id: '3', percentage: 10 } });
    expect(flagOf(flags, 'hog-device-rollout').caveats!.map((c) => c.kind).sort()).toEqual(['device_bucketing', 'experience_continuity', 'unsalted_rollout']);
    expect(flagOf(flags, 'hog-scheduled-launch').caveats).toEqual([{ kind: 'scheduled_changes', detail: { changes: [{ at: '2027-01-04T09:00:00Z', operation: 'update_status', recurring: false }] } }]);
    expect(flagOf(flags, 'hog-encrypted-config').caveats).toContainEqual({ kind: 'encrypted_payload', detail: { readable: true } });
    expect(flagOf(flags, 'survey-targeting-checkout-nps').purpose).toBe('survey');
    expect(flagOf(flags, 'hog-server-only').customProperties['posthog.evaluationContexts']).toEqual({ name: 'PostHog evaluation contexts', value: ['backend'] });

    // Cohorts → segments: static list with every distinct id, property rules (OR → two rules), frozen behavioral members, nested cohort.
    const segs = snap.neutral!.segments;
    const partners = segs.find((s) => s.key === 'design-partners')!;
    expect(partners.environments[0]!.included).toEqual([{ contextKind: 'user', values: ['u-1', 'u-2', 'u-2-legacy', 'u-3'] }]);
    expect(partners.caveats).toEqual([{ kind: 'multi_id_members', detail: { persons: 3, ids: 4 } }]);
    const euUk = segs.find((s) => s.key === 'eu-or-uk')!;
    expect(euUk.environments[0]!.rules.map((r) => r.clauses[0]!.values)).toEqual([['DE', 'FR'], ['GB']]);
    const powerUsers = segs.find((s) => s.key === 'power-users')!;
    expect(powerUsers.environments[0]!.included[0]!.values).toEqual(['u-4', 'u-5']);
    expect(powerUsers.caveats).toEqual([{ kind: 'frozen_membership', detail: { cohortType: 'behavioral', count: 2 } }]);
    const nested = segs.find((s) => s.key === 'enterprise-admins-in-eu')!;
    expect(nested.environments[0]!.rules[0]!.clauses.map((c) => c.op)).toEqual(['segmentMatch', 'in']);
  });

  it('parses an uploaded local-evaluation payload: same flags, inlined cohorts, static cohorts without members', () => {
    const snap = parsePostHogPayload(acmeHogLocalEvaluationPayload(), { source: { ...SOURCE, sourceKind: 'posthog_payload' }, takenAt: '2026-11-12T00:00:00.000Z', projectName: 'Acme Hog' });
    const flags = snap.neutral!.flags;
    expect(flags.map((f) => f.key)).not.toContain('hog-archived-promo');
    expect(flagOf(flags, 'hog-pricing-page').environments[0]!.rules[1]!.rollout!.variations).toHaveLength(3);
    expect(snap.neutral!.contextKinds.map((k) => k.key)).toEqual(['user', 'company', 'workspace']);
    const partners = snap.neutral!.segments.find((s) => s.key === 'cohort-301')!;
    expect(partners.environments[0]!.unbounded).toEqual({ contextKind: 'user' });
    expect(partners.caveats?.[0]?.kind).toBe('membership_unreadable');
    expect(snap.neutral!.segments.find((s) => s.key === 'cohort-302')!.environments[0]!.rules[0]!.clauses).toHaveLength(2);
    expect(snap.completeness.missing).toContain('tags');
    expect(flagOf(flags, 'hog-checkout-redesign').environments[0]!.rules[1]!.clauses[0]!.values).toEqual(['cohort-301']);
  });

  it('rejects a client /flags response and a file without flags', () => {
    expect(() => parsePostHogPayload({ featureFlags: { a: true } }, { source: SOURCE })).toThrow(PostHogPayloadError);
    expect(() => parsePostHogPayload({ hello: 1 }, { source: SOURCE })).toThrow(/no “flags” list/);
    expect(() => parsePostHogPayload([1, 2], { source: SOURCE })).toThrow(PostHogPayloadError);
  });
});

describe('PostHog filter translation', () => {
  const ctx: TranslateContext = { groupKinds: new Map([[0, 'company']]), cohortKeys: new Map([['7', 'vips']]), flagsById: new Map([['99', { key: 'parent', variations: [{ value: 'a' }, { value: 'b' }, { value: '', synthetic: 'no_match' }] }]]), attributeTypes: new Map([['user:age', 'number']]), warn: () => undefined };
  const one = (f: Parameters<typeof translateFilter>[0]) => {
    const out = translateFilter(f, ctx);
    if (out.kind !== 'clauses') throw new Error(`expected clauses, got ${out.kind}`);
    return out.clauses;
  };

  it('types equality values from the property schema and keeps case-insensitivity for text', () => {
    expect(one({ key: 'age', value: ['30', '40'], operator: 'exact' })).toEqual([{ contextKind: 'user', attribute: 'age', op: 'in', values: [30, 40], negate: false }]);
    expect(one({ key: 'plan', value: 'Pro', operator: 'is_not' })).toEqual([{ contextKind: 'user', attribute: 'plan', op: 'in', values: ['Pro'], negate: true, caseInsensitive: true }]);
    expect(one({ key: 'flag', value: ['True'] })).toEqual([{ contextKind: 'user', attribute: 'flag', op: 'in', values: [true], negate: false }]);
    expect(one({ key: 'code', value: ['123'] })).toEqual([{ contextKind: 'user', attribute: 'code', op: 'in', values: ['123'], negate: false }]);
    expect(typeValues([], 'unknown')).toEqual({ values: [], caseInsensitive: false });
  });

  it('maps cohorts, group properties, flags and presence checks', () => {
    expect(one({ key: 'id', type: 'cohort', value: 7, operator: 'not_in' })).toEqual([{ contextKind: 'user', attribute: 'key', op: 'segmentMatch', values: ['vips'], negate: true }]);
    expect(one({ key: 'id', type: 'cohort', value: 8 })).toEqual([{ contextKind: 'user', attribute: 'key', op: 'segmentMatch', values: ['cohort-8'], negate: false }]);
    expect(one({ key: '$group_key', type: 'group', group_type_index: 0, value: ['acme'] })).toEqual([{ contextKind: 'company', attribute: 'key', op: 'in', values: ['acme'], negate: false, caseInsensitive: true }]);
    expect(translateFilter({ key: '99', type: 'flag', value: 'b', operator: 'flag_evaluates_to' }, ctx)).toEqual({ kind: 'prerequisite', prerequisite: { key: 'parent', variation: 1 } });
    expect(translateFilter({ key: '99', type: 'flag', value: false, operator: 'flag_evaluates_to' }, ctx)).toEqual({ kind: 'prerequisite', prerequisite: { key: 'parent', variation: 2 } });
    expect(one({ key: 'email', value: null, operator: 'is_not_set' })).toEqual([{ contextKind: 'user', attribute: 'email', op: 'isNotSet', values: [], negate: false }]);
  });

  it('semver ranges follow the SDK', () => {
    expect(semverRange('semver_tilde', '~1.2.3')).toEqual({ lower: '1.2.3', upper: '1.3.0' });
    expect(semverRange('semver_tilde', '1')).toEqual({ lower: '1.0.0', upper: '2.0.0' });
    expect(semverRange('semver_caret', '^0.2.3')).toEqual({ lower: '0.2.3', upper: '0.3.0' });
    expect(semverRange('semver_caret', '^0.0.3')).toEqual({ lower: '0.0.3', upper: '0.0.4' });
    expect(semverRange('semver_caret', '1.2.3')).toEqual({ lower: '1.2.3', upper: '2.0.0' });
    expect(semverRange('semver_wildcard', '1.2.x')).toEqual({ lower: '1.2.0', upper: '1.3.0' });
    expect(semverRange('semver_wildcard', '*')).toBe('any');
    expect(semverRange('semver_tilde', 'abc')).toBeUndefined();
    expect(one({ key: 'v', value: '~1.2', operator: 'semver_tilde' })).toEqual([
      { contextKind: 'user', attribute: 'v', op: 'semVerLessThan', values: ['1.2.0'], negate: true },
      { contextKind: 'user', attribute: 'v', op: 'semVerLessThan', values: ['1.3.0'], negate: false },
    ]);
  });

  it('leaves what LaunchDarkly cannot express for the mapper', () => {
    expect(one({ key: 'd', value: '2026-01-01', operator: 'is_date_exact' })).toEqual([{ contextKind: 'user', attribute: 'd', op: 'posthog:is_date_exact', values: ['2026-01-01'], negate: false }]);
    expect(one({ key: 'n', value: 'abc', operator: 'gt' })[0]).toMatchObject({ op: 'posthog:gt against a non-numeric value "abc"' });
    expect(one({ key: 'x', value: [], operator: 'exact' })[0]).toMatchObject({ op: expect.stringContaining('posthog:exact') });
    expect(one({ key: 'created_at', type: 'person_metadata', value: '2026' })[0]).toMatchObject({ op: 'posthog:a person_metadata property' });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { acmeHogLocalEvaluationPayload, acmeHogProject, ACME_HOG_PROJECT_ID, createPostHogApiHandlers, type PostHogProjectFixture } from '@sslm/demo-fixtures';
import type { NeutralFlag } from '@sslm/canonical';
import { DEFAULT_MAX_MEMBERS_PER_COHORT, normalizePostHogSnapshot, parsePostHogPayload, PostHogClient, PostHogPayloadError, PostHogReadAuthError, readPostHogProject, semverRange, translateFilter, typeValues, type TranslateContext } from '../src/index.ts';

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
    expect(raw.scheduledChanges.map((s) => s.record_id)).toEqual(['1019', '1007', '1007', '1003']);
    expect(raw.skipped).toEqual([]);
    expect(requests.every((r) => r.startsWith('200 '))).toBe(true);
    // Members come from one filtered `/persons/?cohort=` page per cohort (3 and 2 members fit one
    // page). The actor list `/cohorts/{id}/persons/` is no longer read first: it is only the
    // fallback when the filter is ignored, and no single `/persons/{id}/` read happens either.
    expect(requests.filter((r) => r === `200 /api/projects/${ACME_HOG_PROJECT_ID}/persons/`)).toHaveLength(2);
    expect(requests.filter((r) => /\/cohorts\/\d+\/persons\/$/.test(r) || /\/persons\/[^/?]+\/$/.test(r))).toEqual([]);
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
    expect(early.caveats).toEqual([{ kind: 'early_access_enrollment', detail: { attribute: '$feature_enrollment/hog-early-access', stage: 'beta', name: 'Hog early access', description: 'Try the new storefront before everyone else.', documentationUrl: 'https://acmeretail.example/docs/early-access' } }]);
    const holdout = flagOf(flags, 'hog-holdout-experiment');
    expect(holdout.environments[0]!.rules[0]!.experiment).toEqual({ key: 'Holdout experiment' });
    expect(holdout.caveats).toContainEqual({ kind: 'holdout', detail: { id: '3', percentage: 10 } });
    expect(flagOf(flags, 'hog-device-rollout').caveats!.map((c) => c.kind).sort()).toEqual(['device_bucketing', 'experience_continuity', 'unsalted_rollout']);
    expect(flagOf(flags, 'hog-scheduled-launch').caveats).toEqual([{ kind: 'scheduled_changes', detail: { changes: [{ at: '2027-01-04T09:00:00Z', operation: 'update_status', recurring: false, on: true }] } }]);
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

describe('cohort membership at scale', () => {
  const BIG = 399;
  const PERSONS = `/api/projects/${ACME_HOG_PROJECT_ID}/persons/`;
  const ACTORS = `/api/projects/${ACME_HOG_PROJECT_ID}/cohorts/${BIG}/persons/`;
  const uuidOf = (id: number) => `4e5a1c00-0000-4000-8000-${String(id).padStart(12, '0')}`;
  type Row = Record<string, unknown>;

  /**
   * Acme Hog plus a synthetic static cohort 399 of `n` persons (ids 10000…; every third one has
   * two distinct ids), referenced by a new flag `hog-big-list`, so readPostHogProject reads it
   * beside cohorts 301 and 304.
   */
  function bigFixture(n: number, cohort: Row = {}): PostHogProjectFixture {
    const p = structuredClone(acmeHogProject());
    const persons = Array.from({ length: n }, (_, i) => {
      const id = 10_000 + i;
      return { id, uuid: uuidOf(id), name: `big-${i}@acme.example`, distinct_ids: i % 3 === 0 ? [`big-${i}`, `big-${i}-legacy`] : [`big-${i}`], properties: { email: `big-${i}@acme.example` }, created_at: '2026-01-01T00:00:00Z' };
    });
    p.persons.push(...persons);
    const template = p.cohorts.find((c) => c.id === 301)!;
    p.cohorts.push({ ...template, id: BIG, name: 'Big static list', description: `${n} imported accounts.`, count: n, last_import_total_count: n, ...cohort });
    p.cohortMembers[String(BIG)] = persons.map((x) => String(x.id));
    const flag = p.flags.find((f) => f.key === 'hog-checkout-redesign')! as Row;
    p.flags.push({ ...flag, id: 1399, key: 'hog-big-list', name: 'Targets the big list.', filters: { ...(flag.filters as Row), groups: [{ properties: [{ key: 'id', type: 'cohort', value: BIG, operator: 'in' }], rollout_percentage: 100, variant: null }] } } as (typeof p.flags)[number]);
    return p;
  }

  /** Serve `fixture` and record every request URL (path + query) the client sends. */
  function serve(fixture: PostHogProjectFixture, onUrl?: (url: string) => void) {
    const urls: string[] = [];
    server.use(...createPostHogApiHandlers({ baseUrl: ORIGIN, getProject: () => fixture, key: KEY }));
    const recording: typeof fetch = (input, init) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      urls.push(u.pathname + u.search);
      onUrl?.(u.pathname + u.search);
      return fetch(input, init);
    };
    const c = new PostHogClient({ region: { origin: ORIGIN }, key: KEY, transport: { fetch: recording, budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 2 } } });
    return { c, urls };
  }

  /** PostHog's envelope over `items`, honouring `limit`/`offset` (and a server-side page clamp). */
  const envelope = (items: unknown[], url: URL, maxPage = 1000, withCount = true) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), maxPage);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const at = (o: number) => {
      const u = new URL(url);
      u.searchParams.set('offset', String(o));
      return u.toString();
    };
    return { ...(withCount ? { count: items.length } : {}), next: offset + limit < items.length ? at(offset + limit) : null, previous: null, results: items.slice(offset, offset + limit) };
  };
  /** A persons list that ignores `?cohort=` (every person of the project, paged). */
  const ignoringFilter = (fixture: PostHogProjectFixture, maxPage = 1000) => http.get(`${ORIGIN}${PERSONS}`, ({ request }) => HttpResponse.json(envelope(fixture.persons, new URL(request.url), maxPage)));
  /** `GET /persons/{id}/` accepting the uuid too, as PostHog does (the fixture route takes the numeric id only). */
  const personByIdOrUuid = (fixture: PostHogProjectFixture) =>
    http.get(`${ORIGIN}${PERSONS}:id/`, ({ params }) => {
      const hit = fixture.persons.find((x) => String(x.id) === params.id || x.uuid === params.id);
      return hit ? HttpResponse.json(hit) : HttpResponse.json({ detail: 'Not found.' }, { status: 404 });
    });

  /** Requests about cohort 399: its filtered pages, its actor list and single reads of its persons (ids 10000+). */
  const memberUrls = (urls: string[]) => urls.filter((u) => u.includes(`cohort=${BIG}`) || u.startsWith(ACTORS) || u.startsWith(`${PERSONS}4e5a1c00-0000-4000-8000-00000001`));
  const distinctIds = (members: { distinct_ids?: string[] | null }[]) => members.flatMap((m) => m.distinct_ids ?? []);

  it('(a) reads 2,500 members through the filtered persons list alone, in pages of 1,000', async () => {
    const { c, urls } = serve(bigFixture(2500));
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID);
    const members = raw.cohortMembers[String(BIG)]!;
    expect(members).toHaveLength(2500);
    expect(new Set(members.map((m) => m.id)).size).toBe(2500);
    const ids = distinctIds(members);
    expect(ids).toHaveLength(2500 + 834); // every third person carries a second id
    expect(ids).toEqual(expect.arrayContaining(['big-0', 'big-0-legacy', 'big-1', 'big-2499', 'big-2499-legacy']));
    expect(raw.membersUnreadable).toEqual({});
    // Three page requests for the cohort and nothing else: no actor list, no single person read.
    expect(memberUrls(urls)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`, `${PERSONS}?cohort=${BIG}&limit=1000&offset=1000`, `${PERSONS}?cohort=${BIG}&limit=1000&offset=2000`]);
    // The whole read: project, flags, cohorts, group types, 3 property-definition lists, scheduled
    // changes, early access, experiments, members = 11; cohorts 301 and 304 one page each; 399 three.
    expect(urls).toHaveLength(16);
    // The small cohorts still come out right beside it.
    expect(distinctIds(raw.cohortMembers['301']!)).toEqual(['u-1', 'u-2', 'u-2-legacy', 'u-3']);
  });

  it('(a) a server that clamps the page size below the 1,000 asked for is paged to the end, not cut off after one page', async () => {
    // PostHog Cloud's real ceiling for `limit` is unverified (P0 spike): if it hands back 100 per page
    // regardless, a short first page must not be read as "no more members".
    const fixture = bigFixture(2500);
    const { c, urls } = serve(fixture);
    server.use(
      http.get(`${ORIGIN}${PERSONS}`, ({ request }) => {
        const url = new URL(request.url);
        const cohort = url.searchParams.get('cohort');
        const items = cohort === null ? fixture.persons : fixture.persons.filter((x) => fixture.cohortMembers[cohort]!.includes(String(x.id)));
        return HttpResponse.json(envelope(items, url, 100));
      }),
    );
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID);
    const members = raw.cohortMembers[String(BIG)]!;
    expect(members).toHaveLength(2500);
    expect(new Set(members.map((m) => m.id)).size).toBe(2500);
    expect(raw.membersUnreadable).toEqual({});
    const pages = memberUrls(urls).filter((u) => u.startsWith(`${PERSONS}?cohort=${BIG}`));
    expect(pages).toHaveLength(25);
    expect(pages[0]).toBe(`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`);
    expect(pages[24]).toBe(`${PERSONS}?cohort=${BIG}&limit=1000&offset=2400`);
    // Still no actor list and no single person read: the filter was honoured, only the page was small.
    expect(memberUrls(urls).some((u) => u.startsWith(ACTORS) || /\/persons\/\d+\/$/.test(u))).toBe(false);
  });
  it('(b) a cohort whose own count exceeds the cap is refused before any member request', async () => {
    const { c, urls } = serve(bigFixture(10, { count: DEFAULT_MAX_MEMBERS_PER_COHORT + 1 }));
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID);
    expect(raw.cohortMembers[String(BIG)]).toBeUndefined();
    expect(raw.membersUnreadable[String(BIG)]).toBe('100,001 members; more than the console reads from the API (100,000). Export the cohort as CSV in PostHog and import it into the LaunchDarkly segment.');
    expect(memberUrls(urls)).toEqual([]);
    // Not an error: the other cohorts were read and nothing was skipped.
    expect(raw.skipped).toEqual([]);
    expect(raw.cohortMembers['304']).toHaveLength(2);
  });

  it('(b) the paged read stops at the cap, from the envelope count or from the pages themselves', async () => {
    // Count unknown on the cohort (PostHog has not calculated it): the first page's envelope says 2,500.
    const first = serve(bigFixture(2500, { count: null }));
    const raw = await readPostHogProject(first.c, ACME_HOG_PROJECT_ID, { maxMembersPerCohort: 1500 });
    expect(raw.membersUnreadable[String(BIG)]).toMatch(/^2,500 members; more than the console reads from the API \(1,500\)\. Export the cohort as CSV/);
    expect(memberUrls(first.urls)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`]);
    server.resetHandlers();

    // No envelope count either: the second page carries the read past the cap and the read stops there.
    const fixture = bigFixture(2500, { count: null });
    const second = serve(fixture);
    server.use(http.get(`${ORIGIN}${PERSONS}`, ({ request }) => {
      const url = new URL(request.url);
      const members = fixture.persons.filter((x) => fixture.cohortMembers[url.searchParams.get('cohort')!]?.includes(String(x.id)));
      return HttpResponse.json(envelope(members, url, 1000, false));
    }));
    const raw2 = await readPostHogProject(second.c, ACME_HOG_PROJECT_ID, { maxMembersPerCohort: 1500 });
    expect(raw2.membersUnreadable[String(BIG)]).toMatch(/^2,000 members; more than the console reads from the API \(1,500\)/);
    expect(memberUrls(second.urls)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`, `${PERSONS}?cohort=${BIG}&limit=1000&offset=1000`]);
  });

  it('(c) a server that ignores the cohort filter falls back to the actor list and yields exactly the members', async () => {
    const fixture = bigFixture(40);
    const { c, urls } = serve(fixture);
    server.use(ignoringFilter(fixture));
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID);
    const members = raw.cohortMembers[String(BIG)]!;
    expect(members.map((m) => m.id).sort()).toEqual(fixture.cohortMembers[String(BIG)]!.sort());
    expect(distinctIds(members)).toHaveLength(40 + 14);
    expect(raw.membersUnreadable).toEqual({});
    // The 45-person page disagreed with the cohort's count of 40, so paging stopped after one page;
    // the actor list named the 40 members, all of which were already on that page: no single read.
    expect(memberUrls(urls)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`, `${ACTORS}?limit=100&offset=0`]);
    // The small cohorts took the same route and are still exact.
    expect(distinctIds(raw.cohortMembers['301']!)).toEqual(['u-1', 'u-2', 'u-2-legacy', 'u-3']);
    expect(raw.cohortMembers['304']!.map((m) => m.id)).toEqual(['504', '505']);
  });

  it('(c) members the ignored-filter page did not carry are read one by one, up to a cap', async () => {
    const fixture = bigFixture(40);
    const { c, urls } = serve(fixture);
    // The server also clamps pages to 10, so the one page holds persons 501–505 and big-0…big-4.
    server.use(ignoringFilter(fixture, 10), personByIdOrUuid(fixture));
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID);
    const members = raw.cohortMembers[String(BIG)]!;
    expect(members.map((m) => m.id).sort()).toEqual(fixture.cohortMembers[String(BIG)]!.sort());
    expect(distinctIds(members)).toEqual(expect.arrayContaining(['big-4', 'big-5', 'big-39-legacy']));
    const singles = urls.filter((u) => u.startsWith(`${PERSONS}4e5a1c00-0000-4000-8000-00000001`));
    expect(singles).toHaveLength(35);
    expect(singles[0]).toBe(`${PERSONS}${uuidOf(10_005)}/`);
    expect(memberUrls(urls).slice(0, 2)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`, `${ACTORS}?limit=100&offset=0`]);
    server.resetHandlers();

    // Above the single-read cap the membership is unreadable, with the CSV instruction, and no single read is made.
    const capped = serve(fixture);
    server.use(ignoringFilter(fixture, 10), personByIdOrUuid(fixture));
    const raw2 = await readPostHogProject(capped.c, ACME_HOG_PROJECT_ID, { maxSinglePersonReads: 20 });
    expect(raw2.cohortMembers[String(BIG)]).toBeUndefined();
    expect(raw2.membersUnreadable[String(BIG)]).toBe('40 members, 35 of them readable only one by one because the persons list ignored the cohort filter; more than the console reads that way (20). Export the cohort as CSV in PostHog and import it into the LaunchDarkly segment.');
    expect(capped.urls.filter((u) => u.startsWith(`${PERSONS}4e5a1c00-0000-4000-8000-00000001`))).toEqual([]);
  });

  it('(d) an empty filtered list for a cohort with members falls back to the actor list', async () => {
    const fixture = bigFixture(3);
    const { c, urls } = serve(fixture);
    server.use(http.get(`${ORIGIN}${PERSONS}`, () => HttpResponse.json({ count: 0, next: null, previous: null, results: [] })), personByIdOrUuid(fixture));
    const raw = await readPostHogProject(c, ACME_HOG_PROJECT_ID);
    expect(distinctIds(raw.cohortMembers[String(BIG)]!)).toEqual(['big-0', 'big-0-legacy', 'big-1', 'big-2']);
    expect(memberUrls(urls)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`, `${ACTORS}?limit=100&offset=0`, `${PERSONS}${uuidOf(10_000)}/`, `${PERSONS}${uuidOf(10_001)}/`, `${PERSONS}${uuidOf(10_002)}/`]);
    expect(raw.membersUnreadable).toEqual({});
  });

  it('(e) progress reports each page of the big cohort, and says when the count is being recalculated', async () => {
    const { c } = serve(bigFixture(2500));
    const progress: string[] = [];
    await readPostHogProject(c, ACME_HOG_PROJECT_ID, { onProgress: (p) => progress.push(p.endpoint) });
    const pages = progress.filter((e) => e.startsWith(`${PERSONS}?cohort=${BIG}`));
    expect(pages).toEqual([`${PERSONS}?cohort=${BIG}`, `${PERSONS}?cohort=${BIG} (1,000/2,500)`, `${PERSONS}?cohort=${BIG} (2,000/2,500)`, `${PERSONS}?cohort=${BIG} (2,500/2,500)`]);
    server.resetHandlers();

    // While PostHog recalculates, the cohort's count is not trusted: the read probes the project's
    // person count once to tell a filtered list from an unfiltered one, and the progress says so.
    const calc = serve(bigFixture(1200, { is_calculating: true, count: 7 }));
    const progress2: string[] = [];
    const raw = await readPostHogProject(calc.c, ACME_HOG_PROJECT_ID, { onProgress: (p) => progress2.push(p.endpoint) });
    expect(raw.cohortMembers[String(BIG)]).toHaveLength(1200);
    expect(progress2).toContain(`${PERSONS}?cohort=${BIG} (1,200/1,200) (recalculating)`);
    expect(memberUrls(calc.urls)).toEqual([`${PERSONS}?cohort=${BIG}&limit=1000&offset=0`, `${PERSONS}?cohort=${BIG}&limit=1000&offset=1000`]);
    expect(calc.urls.filter((u) => u === `${PERSONS}?limit=1&offset=0`)).toHaveLength(1);
  });

  it('(f) an abort during the paged read rejects instead of returning partial members', async () => {
    const ctrl = new AbortController();
    const { c, urls } = serve(bigFixture(2500), (url) => {
      if (url === `${PERSONS}?cohort=${BIG}&limit=1000&offset=1000`) ctrl.abort();
    });
    await expect(readPostHogProject(c, ACME_HOG_PROJECT_ID, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(urls.filter((u) => u.includes('offset=2000'))).toEqual([]);
    expect(urls.at(-1)).toBe(`${PERSONS}?cohort=${BIG}&limit=1000&offset=1000`);
  });
});

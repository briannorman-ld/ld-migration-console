import { describe, expect, it } from 'vitest';
import { acmeHogProject, ACME_HOG_PROJECT_ID } from '@sslm/demo-fixtures';
import type { NeutralCaveat, NeutralFlag } from '@sslm/canonical';
import {
  normalizePostHogSnapshot,
  parsePostHogPayload,
  PhCohortSchema,
  PhEarlyAccessFeatureSchema,
  PhExperimentSchema,
  PhFeatureFlagSchema,
  PhGroupTypeSchema,
  PhMemberSchema,
  PhPersonSchema,
  PhProjectSchema,
  PhPropertyDefinitionSchema,
  PhScheduledChangeSchema,
  type RawPostHogSnapshot,
} from '../src/index.ts';

/**
 * Normalizer-level tests (PLAN §22.2) for what the mapper reads off the neutral model: scheduled
 * changes typed from their payloads, the early-access feature definition, and clause typing without
 * property definitions. The raw snapshot is built from the demo fixture through the same lenient
 * schemas the client applies, so no network mock is needed.
 */
const SOURCE = { sourceId: 'src-hog', sourceKind: 'posthog' as const, alias: 'hog' };
const TAKEN = '2026-11-12T00:00:00.000Z';

function rawFixture(over: Partial<RawPostHogSnapshot> = {}): RawPostHogSnapshot {
  const p = acmeHogProject();
  const person = (id: string) => PhPersonSchema.parse(p.persons.find((x) => String(x.id) === id));
  return {
    kind: 'posthog',
    fetchedAt: TAKEN,
    projectId: ACME_HOG_PROJECT_ID,
    project: PhProjectSchema.parse(p.project),
    flags: p.flags.filter((f) => f.deleted !== true).map((f) => PhFeatureFlagSchema.parse(f)),
    cohorts: p.cohorts.filter((c) => c.deleted !== true).map((c) => PhCohortSchema.parse(c)),
    cohortMembers: Object.fromEntries(Object.entries(p.cohortMembers).map(([cid, ids]) => [cid, ids.map(person)])),
    membersUnreadable: {},
    groupTypes: p.groupTypes.map((g) => PhGroupTypeSchema.parse(g)),
    propertyDefinitions: p.propertyDefinitions.map((d) => PhPropertyDefinitionSchema.parse(d)),
    scheduledChanges: p.scheduledChanges.map((s) => PhScheduledChangeSchema.parse(s)),
    earlyAccessFeatures: p.earlyAccessFeatures.map((e) => PhEarlyAccessFeatureSchema.parse(e)),
    experiments: p.experiments.map((e) => PhExperimentSchema.parse(e)),
    members: p.members.map((m) => PhMemberSchema.parse(m)),
    schemaIssues: [],
    skipped: [],
    ...over,
  };
}

const normalize = (raw: RawPostHogSnapshot) => normalizePostHogSnapshot(raw, { source: SOURCE, takenAt: TAKEN });
const flagOf = (flags: NeutralFlag[], key: string) => flags.find((f) => f.key === key)!;
const scheduled = (f: NeutralFlag) => (f.caveats ?? []).find((c): c is Extract<NeutralCaveat, { kind: 'scheduled_changes' }> => c.kind === 'scheduled_changes')!.detail.changes;

/** A pending ScheduledChange row for `recordId`, as the API returns it. */
const change = (id: number, recordId: number, payload: unknown, at: string, extra: Record<string, unknown> = {}) =>
  PhScheduledChangeSchema.parse({ id, team_id: 4242, record_id: String(recordId), model_name: 'FeatureFlag', payload, scheduled_at: at, executed_at: null, failure_reason: null, is_recurring: false, ...extra });

describe('PostHog normalizer: scheduled changes (19.24)', () => {
  it('types the fixture’s pending changes from their payloads: a status flip, a cron’d flip, an added condition set and a variant change', () => {
    const flags = normalize(rawFixture()).neutral!.flags;
    expect(scheduled(flagOf(flags, 'hog-scheduled-launch'))).toEqual([{ at: '2027-01-04T09:00:00Z', operation: 'update_status', recurring: false, on: true }]);
    expect(scheduled(flagOf(flags, 'hog-staff-tools'))).toEqual([
      { at: '2027-01-05T17:00:00Z', operation: 'update_status', recurring: true, on: false },
      {
        at: '2027-02-01T09:00:00Z',
        operation: 'add_release_condition',
        recurring: false,
        // The same translation as the flag's own sets: the clause carries PostHog's case-insensitivity, the set at 100% serves `true`.
        rules: [{ id: 'scheduled-9003-set-0', description: 'Scheduled condition set 1 (2027-02-01T09:00:00Z)', clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@acmeretail.example'], negate: false, caseInsensitive: true }], variation: 0 }],
      },
    ]);
    expect(scheduled(flagOf(flags, 'hog-pricing-page'))).toEqual([
      {
        at: '2027-03-01T09:00:00Z',
        operation: 'update_variants',
        recurring: false,
        variants: [
          { key: 'control', weight: 34_000 },
          { key: 'plus', weight: 33_000 },
          { key: 'enterprise', weight: 33_000 },
        ],
      },
    ]);
    // A flag with nothing pending has no caveat.
    expect(flagOf(flags, 'hog-kill-switch').caveats).toBeUndefined();
  });

  it('an added set keeps its rollout: coverage on a plain flag, a two-way rollout under early exit, and distinct ids as a key clause (not lifted to targets)', () => {
    const groups = (sets: unknown[]) => ({ groups: sets, payloads: {}, multivariate: null });
    const raw = rawFixture({
      scheduledChanges: [
        // hog-kill-switch (1001): no early exit → a 25% set is a covered rule.
        change(9101, 1001, { operation: 'add_release_condition', value: groups([{ properties: [{ key: 'country', type: 'person', value: ['GB'], operator: 'exact' }], rollout_percentage: 25 }]) }, '2027-04-01T00:00:00Z'),
        // hog-staff-tools (1007): early exit → the uncovered 75% get `false` as a plain rollout.
        change(9102, 1007, { operation: 'add_release_condition', value: groups([{ properties: [{ key: 'country', type: 'person', value: ['GB'], operator: 'exact' }], rollout_percentage: 25 }]) }, '2027-04-01T00:00:00Z'),
        // A bare condition set (not wrapped in `groups`) on distinct ids: accepted, and a rule (never lifted to targets), since a
        // scheduled change appends sets. PostHog compares distinct ids lower-cased like any `exact`, so the clause says so.
        change(9103, 1001, { operation: 'add_release_condition', value: { properties: [{ key: 'distinct_id', type: 'person', value: ['u-9'], operator: 'exact' }], rollout_percentage: 100 } }, '2027-05-01T00:00:00Z'),
        // A 0% set appends nothing: the change is carried without rules (noted by the mapper).
        change(9104, 1001, { operation: 'add_release_condition', value: groups([{ properties: [], rollout_percentage: 0 }]) }, '2027-06-01T00:00:00Z'),
      ],
    });
    const snap = normalize(raw);
    const flags = snap.neutral!.flags;
    const kill = scheduled(flagOf(flags, 'hog-kill-switch'));
    expect(kill[0]!.rules).toEqual([{ id: 'scheduled-9101-set-0', description: 'Scheduled condition set 1 (2027-04-01T00:00:00Z)', clauses: [{ contextKind: 'user', attribute: 'country', op: 'in', values: ['GB'], negate: false, caseInsensitive: true }], variation: 0, coverage: 0.25 }]);
    expect(kill[1]!.rules).toEqual([{ id: 'scheduled-9103-set-0', description: 'Scheduled condition set 1 (2027-05-01T00:00:00Z)', clauses: [{ contextKind: 'user', attribute: 'key', op: 'in', values: ['u-9'], negate: false, caseInsensitive: true }], variation: 0 }]);
    expect(kill[2]).toEqual({ at: '2027-06-01T00:00:00Z', operation: 'add_release_condition', recurring: false });
    // The flag's own targeting is untouched by pending changes.
    expect(flagOf(flags, 'hog-kill-switch').environments[0]!.rules).toEqual([{ id: 'set-0', description: 'Condition set 1', clauses: [], variation: 0 }]);
    expect(flagOf(flags, 'hog-kill-switch').environments[0]!.targets).toEqual([]);
    const staff = scheduled(flagOf(flags, 'hog-staff-tools'));
    expect(staff.at(-1)!.rules![0]).toMatchObject({ rollout: { contextKind: 'user', variations: [{ variation: 0, weight: 25_000 }, { variation: 1, weight: 75_000 }] } });
    expect(staff.at(-1)!.rules![0]!.coverage).toBeUndefined();
    expect(snap.warnings.filter((w) => (w.path ?? "").includes('scheduled_changes'))).toEqual([]);
  });

  it('payloads it cannot read keep only the time and operation, with a warning; recurrence is read from any of the schedule fields', () => {
    const raw = rawFixture({
      scheduledChanges: [
        change(9201, 1001, { operation: 'update_status', value: 'maybe' }, '2027-04-01T00:00:00Z'),
        change(9202, 1001, { operation: 'add_release_condition', value: 'oops' }, '2027-04-02T00:00:00Z'),
        change(9203, 1001, { operation: 'update_variants', value: { variants: 'none' } }, '2027-04-03T00:00:00Z'),
        change(9204, 1001, { operation: 'archive', value: null }, '2027-04-04T00:00:00Z'),
        change(9205, 1001, { operation: 'update_status', value: 'false' }, '2027-04-05T00:00:00Z', { recurrence_interval: 'weekly' }),
        change(9206, 1001, { operation: 'update_status', value: true }, '2027-04-06T00:00:00Z', { cron_expression: '0 9 * * 1' }),
      ],
    });
    const snap = normalize(raw);
    expect(scheduled(flagOf(snap.neutral!.flags, 'hog-kill-switch'))).toEqual([
      { at: '2027-04-01T00:00:00Z', operation: 'update_status', recurring: false },
      { at: '2027-04-02T00:00:00Z', operation: 'add_release_condition', recurring: false },
      { at: '2027-04-03T00:00:00Z', operation: 'update_variants', recurring: false },
      { at: '2027-04-04T00:00:00Z', operation: 'archive', recurring: false },
      { at: '2027-04-05T00:00:00Z', operation: 'update_status', recurring: true, on: false },
      { at: '2027-04-06T00:00:00Z', operation: 'update_status', recurring: true, on: true },
    ]);
    const warned = snap.warnings.filter((w) => w.code === 'schema_mismatch' && (w.path ?? "").startsWith('feature_flags/hog-kill-switch/scheduled_changes/'));
    expect(warned.map((w) => (w.path ?? "").split('/').at(-1))).toEqual(['9201', '9202', '9203']);
    expect(warned[0]!.message).toBe('update_status payload value "maybe" is not a boolean; the change is noted, not carried.');
  });
});

describe('PostHog normalizer: early access feature definitions (19.19)', () => {
  it('the caveat carries the feature’s name, description, stage and documentation URL', () => {
    const flags = normalize(rawFixture()).neutral!.flags;
    expect(flagOf(flags, 'hog-early-access').caveats).toEqual([
      {
        kind: 'early_access_enrollment',
        detail: { attribute: '$feature_enrollment/hog-early-access', stage: 'beta', name: 'Hog early access', description: 'Try the new storefront before everyone else.', documentationUrl: 'https://acmeretail.example/docs/early-access' },
      },
    ]);
  });

  it('falls back to the flag’s own `features` list when the early-access route was not read, and omits empty fields', () => {
    const flags = normalize(rawFixture({ earlyAccessFeatures: [] })).neutral!.flags;
    expect(flagOf(flags, 'hog-early-access').caveats).toEqual([{ kind: 'early_access_enrollment', detail: { attribute: '$feature_enrollment/hog-early-access', stage: 'beta', name: 'Hog early access' } }]);
    const p = acmeHogProject();
    const blank = PhEarlyAccessFeatureSchema.parse({ ...p.earlyAccessFeatures[0], description: '', documentation_url: '', stage: null });
    const noFeatures = rawFixture({ earlyAccessFeatures: [blank], flags: rawFixture().flags.map((f) => (f.key === 'hog-early-access' ? { ...f, features: [] } : f)) });
    expect(flagOf(normalize(noFeatures).neutral!.flags, 'hog-early-access').caveats).toEqual([{ kind: 'early_access_enrollment', detail: { attribute: '$feature_enrollment/hog-early-access', name: 'Hog early access' } }]);
  });
});

describe('PostHog normalizer: clause typing without property definitions (19.27)', () => {
  it('a payload upload types numeric-operator values as numbers even when given as strings; equality values stay strings unless they are booleans or JSON numbers', () => {
    const payload = {
      flags: [
        {
          id: 1,
          team_id: 1,
          key: 'seats-band',
          name: '',
          active: true,
          deleted: false,
          filters: {
            groups: [
              {
                properties: [
                  { key: 'seats', type: 'person', operator: 'gt', value: '10' },
                  { key: 'seats', type: 'person', operator: 'between', value: ['5', '50'] },
                  { key: 'score', type: 'person', operator: 'lte', value: ['7.5'] },
                  { key: 'code', type: 'person', operator: 'exact', value: ['123'] },
                  { key: 'tier', type: 'person', operator: 'exact', value: [3] },
                  { key: 'beta', type: 'person', operator: 'exact', value: ['True'] },
                ],
                rollout_percentage: 100,
              },
            ],
          },
        },
      ],
      group_type_mapping: {},
    };
    const snap = parsePostHogPayload(payload, { source: { ...SOURCE, sourceKind: 'posthog_payload' }, takenAt: TAKEN, projectName: 'Upload' });
    expect(snap.neutral!.attributes).toEqual([]);
    const clauses = snap.neutral!.flags[0]!.environments[0]!.rules[0]!.clauses;
    expect(clauses.map((c) => [c.attribute, c.op, c.values, c.caseInsensitive ?? false])).toEqual([
      ['seats', 'greaterThan', [10], false],
      ['seats', 'greaterThanOrEqual', [5], false],
      ['seats', 'lessThanOrEqual', [50], false],
      ['score', 'lessThanOrEqual', [7.5], false],
      // PostHog compares `exact` as lower-cased strings: whether the app sends 123 or "123" is unknowable without a definition.
      ['code', 'in', ['123'], false],
      ['tier', 'in', [3], false],
      ['beta', 'in', [true], false],
    ]);
  });
});

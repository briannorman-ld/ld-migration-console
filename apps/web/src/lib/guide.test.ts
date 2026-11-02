import { describe, expect, it } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import { classify, computeGuide, currentStep, describeTally, STEP_ORDER, type GuideInput, type Tally } from './guide.ts';

const blocking = { severity: 'blocking' } as DecisionPoint;
const choice = { severity: 'choice' } as DecisionPoint;

describe('guide: where an item stands', () => {
  it('skipped and blocked win over what LD holds; otherwise LD decides', () => {
    expect(classify({ skipped: 'archived', unresolved: [blocking] }, { status: 'in_sync' })).toBe('skipped');
    expect(classify({ unresolved: [blocking] }, { status: 'in_sync' })).toBe('blocked');
    expect(classify({ unresolved: [choice] }, { status: 'in_sync' })).toBe('in_sync');
    expect(classify({ unresolved: [] }, { status: 'changed' })).toBe('changed');
    expect(classify({ unresolved: [] }, { status: 'absent' })).toBe('not_migrated');
  });

  it('describes a tally for the step line', () => {
    const t: Tally = { kind: 'gate', total: 12, inSync: 3, changed: 2, notMigrated: 5, blocked: 2, skipped: 0, toMigrate: [], ldUnknown: false };
    expect(describeTally(t, 'gate')).toBe('3 of 12 in sync · 2 changed since · 5 not migrated · 2 wait for decisions');
    expect(describeTally({ ...t, total: 0 }, 'gate')).toBe('No gates in this environment.');
    expect(describeTally({ ...t, ldUnknown: true }, 'gate')).toMatch(/^reading LaunchDarkly…/);
  });
});

describe('guide: the current step', () => {
  it('is the first step not done, in dependency order, and cut over once all are', () => {
    const none = Object.fromEntries(STEP_ORDER.map((k) => [k, false])) as Record<(typeof STEP_ORDER)[number], boolean>;
    expect(currentStep(none)).toBe('connect');
    expect(currentStep({ ...none, connect: true })).toBe('environment');
    expect(currentStep({ ...none, connect: true, environment: true })).toBe('contexts');
    expect(currentStep({ ...none, connect: true, environment: true, contexts: true })).toBe('segments');
    expect(currentStep({ ...none, connect: true, environment: true, contexts: true, segments: true })).toBe('flags');
    expect(currentStep({ ...none, connect: true, environment: true, contexts: true, segments: true, flags: true })).toBe('experiments');
    expect(currentStep({ ...none, connect: true, environment: true, contexts: true, segments: true, flags: true, experiments: true })).toBe('cutover');
  });

  it('reports LaunchDarkly as connecting (not "not connected") while the saved token reconnects', () => {
    const base: GuideInput = { sources: [], snapshots: [], m: null, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    const m = (ld: Partial<NonNullable<GuideInput['m']>['ld']>) => ({ ...base, m: { ld: { status: 'connecting', ...ld }, connected: false, capabilities: {} } as unknown as NonNullable<GuideInput['m']> });
    expect(computeGuide(m({})).connecting).toBe(true);
    expect(computeGuide(m({ status: 'connected', projectKey: 'p1', probing: 'Starting' })).connecting).toBe(true);
    expect(computeGuide(m({ status: 'disconnected' })).connecting).toBe(false);
    expect(computeGuide(m({ status: 'error', error: 'nope' })).connecting).toBe(false);
    expect(computeGuide(base).connecting).toBe(false);
  });

  it('a fresh workspace starts at Connect with nothing tallied', () => {
    const input: GuideInput = { sources: [], snapshots: [], m: null, env: '', decisions: [], monitoring: { attention: 0, rows: 0, loaded: false }, interruptedRuns: 0 };
    const g = computeGuide(input);
    expect(g.current).toBe('connect');
    expect(g.connected).toBe(false);
    expect(g.envs).toEqual([]);
    expect(g.segments.total + g.gates.total + g.configs.total + g.autotunes.total).toBe(0);
    expect(Object.values(g.done).every((d) => !d)).toBe(true);
  });
});

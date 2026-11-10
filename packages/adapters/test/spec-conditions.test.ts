import { describe, expect, it } from 'vitest';
import type { SnapshotWarning } from '@sslm/canonical';
import { normalizeDcsCondition } from '../src/index.ts';

const ctx = () => {
  const warnings: SnapshotWarning[] = [];
  return { warnings, ctx: { warn: (w: SnapshotWarning) => void warnings.push(w), path: 'gates[0]' } };
};

describe('normalizeDcsCondition: fields and types named like Object.prototype members (security review M4)', () => {
  it('a user_field named constructor is a custom field, not Object.prototype.constructor', () => {
    const { ctx: c } = ctx();
    const out = normalizeDcsCondition({ type: 'user_field', field: 'constructor', operator: 'any', targetValue: ['a'] }, c);
    expect(out).toMatchObject({ type: 'custom_field', field: 'constructor', operator: 'any' });
    expect(typeof out.type).toBe('string');
  });

  it('a ua_based field named toString is unknown, with a warning, and a __proto__ type is unknown too', () => {
    const { warnings, ctx: c } = ctx();
    const ua = normalizeDcsCondition({ type: 'ua_based', field: 'toString', operator: 'eq', targetValue: 'x' }, c);
    expect(ua).toMatchObject({ type: 'unknown', field: 'toString', derivedFrom: 'user_agent' });
    const proto = normalizeDcsCondition({ type: '__proto__', operator: 'eq', targetValue: 'x' }, c);
    expect(proto).toMatchObject({ type: 'unknown' });
    expect(warnings.map((w) => w.code)).toEqual(['unknown_condition', 'unknown_condition']);
  });

  it('every value in the result survives structured clone (the worker posts the snapshot)', () => {
    const { ctx: c } = ctx();
    for (const type of ['constructor', 'hasOwnProperty', 'valueOf']) {
      const out = normalizeDcsCondition({ type, field: type, operator: 'eq', targetValue: 1 }, c);
      expect(() => structuredClone(out)).not.toThrow();
    }
  });
});

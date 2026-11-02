import { describe, expect, it } from 'vitest';
import type { Gate } from '@sslm/canonical';
import { describeUsage, isQuiet, suggestedReason } from './usage.ts';

const base = (over: Partial<Pick<Gate, 'usage' | 'completeness' | 'archived' | 'source'>> = {}) => ({
  source: { sourceId: 's', sourceKind: 'console_api' as const },
  completeness: { missing: [] },
  archived: false,
  ...over,
});

describe('describeUsage (PLAN §14 StatSig side)', () => {
  it('counts exposures compactly for a busy gate', () => {
    const s = describeUsage(base({ usage: { exposuresPastDay: 1_152_000, exposuresPast7Days: 8_064_000 } }));
    expect(s.level).toBe('active');
    expect(s.label).toBe('8.1M in 7 d');
    expect(s.detail).toContain('8,064,000 exposure events');
    expect(isQuiet(s)).toBe(false);
  });

  it('is "unused" only when exposures and production checks both say nothing happened', () => {
    expect(describeUsage(base({ usage: { exposuresPastDay: 0, exposuresPast7Days: 0, productionChecksPast7Days: false } })).level).toBe('unused');
    const checked = describeUsage(base({ usage: { exposuresPastDay: 0, exposuresPast7Days: 0, productionChecksPast7Days: true } }));
    expect(checked.level).toBe('no_exposures');
    expect(checked.detail).toMatch(/exposure logging may be off/);
    const unknownChecks = describeUsage(base({ usage: { exposuresPastDay: 0, exposuresPast7Days: 0 } }));
    expect(unknownChecks.level).toBe('no_exposures');
    expect([checked, unknownChecks].every(isQuiet)).toBe(true);
  });

  it('says what is not known: spec sources, unsynced items, archived items, an unreadable route', () => {
    expect(describeUsage(base({ source: { sourceId: 's', sourceKind: 'config_spec' } })).level).toBe('needs_key');
    expect(describeUsage(base({ completeness: { missing: ['checks'] } })).level).toBe('needs_key');
    expect(describeUsage(base()).detail).toMatch(/sync the source again/);
    expect(describeUsage(base({ archived: true })).detail).toMatch(/Archived/);
    expect(describeUsage(base({ usage: { exposuresPastDay: null, exposuresPast7Days: null } })).detail).toMatch(/could not read/);
  });

  it('suggests a reason for a "Don\'t migrate" mark only when every item agrees', () => {
    const unused = describeUsage(base({ usage: { exposuresPastDay: 0, exposuresPast7Days: 0, productionChecksPast7Days: false } }));
    const quiet = describeUsage(base({ usage: { exposuresPastDay: 0, exposuresPast7Days: 0 } }));
    const busy = describeUsage(base({ usage: { exposuresPastDay: 1, exposuresPast7Days: 9 } }));
    expect(suggestedReason([unused, unused])).toBe('No checks in StatSig in the past 7 days');
    expect(suggestedReason([unused, quiet])).toBe('No exposures in StatSig in the past 7 days');
    expect(suggestedReason([unused, busy])).toBeUndefined();
    expect(suggestedReason([])).toBeUndefined();
  });
});

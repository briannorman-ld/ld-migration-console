import { describe, expect, it } from 'vitest';
import { describeLdScope, LD_DEFAULT_RESOURCES, LD_NOT_READ, LD_RESOURCE_INFO, LD_RESOURCE_KINDS, ldReadScope } from '../src/index.ts';

describe('LD resource registry (PLAN §20.6)', () => {
  it('covers every kind once, each with a coverage row id in the ld_source area', () => {
    expect(new Set(LD_RESOURCE_KINDS).size).toBe(LD_RESOURCE_KINDS.length);
    for (const k of LD_RESOURCE_KINDS) {
      const info = LD_RESOURCE_INFO[k];
      expect(info.kind).toBe(k);
      expect(info.coverageId.startsWith('ld_source.')).toBe(true);
      expect(info.description.length).toBeGreaterThan(20);
    }
  });

  it('defaults to everything but the per-flag reads, which have no project-wide listing', () => {
    const off = LD_RESOURCE_KINDS.filter((k) => !LD_DEFAULT_RESOURCES.includes(k));
    expect(off.sort()).toEqual(['flag_links', 'flag_triggers', 'scheduled_changes', 'workflows']);
    for (const k of off) expect(['per_flag', 'per_flag_environment']).toContain(LD_RESOURCE_INFO[k].requests);
    // The kinds that migrate today are all on by default.
    for (const k of LD_RESOURCE_KINDS) if (LD_RESOURCE_INFO[k].handling === 'migrates') expect(LD_DEFAULT_RESOURCES).toContain(k);
  });

  it('resolves a stored scope: unknown kinds dropped, kinds without their prerequisite dropped, undefined is the default', () => {
    expect(ldReadScope(undefined)).toEqual(LD_DEFAULT_RESOURCES);
    expect(ldReadScope(['segments', 'bogus', 'flags'])).toEqual(['flags', 'segments']);
    // Scheduled changes need the flag list: alone they cannot be read.
    expect(ldReadScope(['scheduled_changes'])).toEqual([]);
    expect(ldReadScope(['scheduled_changes', 'flags'])).toEqual(['flags', 'scheduled_changes']);
    expect(ldReadScope([])).toEqual([]);
  });

  it('describes a scope in registry order', () => {
    expect(describeLdScope(['members', 'flags'])).toBe('Flags, Members');
    expect(describeLdScope(undefined).startsWith('Flags, Segments, Metrics')).toBe(true);
  });

  it('says why each never-read kind is never read', () => {
    expect(LD_NOT_READ.length).toBeGreaterThan(3);
    for (const n of LD_NOT_READ) expect(n.reason.length).toBeGreaterThan(10);
  });
});

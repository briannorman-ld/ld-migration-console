import { describe, expect, it } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import { renderHook } from '@testing-library/react';
import { resolutionsFor, useStable, useStableIdLists } from './useMigration.ts';

const base = { severity: 'choice', explanation: '', sourceFragment: {}, fingerprint: 'fp' } as const;
const kind: DecisionPoint = {
  ...base,
  id: 'unit_type_kind:web/unit_type/planKey:kind',
  type: 'unit_type_kind',
  subject: { sourceId: 'web', kind: 'unit_type', uid: 'web/unit_type/planKey', id: 'planKey' },
  title: 'Context kind for unit type planKey',
  options: [{ key: 'create:plan-key', label: '', explanation: '', resultingFidelity: 'full' }],
};
const other: DecisionPoint = {
  ...base,
  id: 'gate_reference:web/gate/g:rule:1',
  type: 'gate_reference',
  subject: { sourceId: 'web', kind: 'gate', uid: 'web/gate/g', id: 'g' },
  title: 'Gate reference',
  options: [{ key: 'drop_condition', label: '', explanation: '', resultingFidelity: 'partial' }],
};

describe('resolutionsFor', () => {
  it('saves a typed context kind key or attribute for a unit_type_kind decision, not only listed options', () => {
    const at = '2026-11-02T10:00:00Z';
    expect(resolutionsFor([kind], 'create:plan', at)).toEqual([{ id: kind.id, type: 'unit_type_kind', optionKey: 'create:plan', scope: 'resource', fingerprint: 'fp', decidedAt: at }]);
    expect(resolutionsFor([kind], 'attribute:planKey', at)).toHaveLength(1);
    expect(resolutionsFor([kind], 'create:not a key', at)).toEqual([]);
    expect(resolutionsFor([kind], 'create:plan-key', at)).toHaveLength(1);
  });

  it('leaves out decisions that do not take the answer', () => {
    const rs = resolutionsFor([kind, other], 'create:plan', '2026-11-02T10:00:00Z');
    expect(rs.map((r) => r.id)).toEqual([kind.id]);
    expect(resolutionsFor([other], 'drop_condition', '2026-11-02T10:00:00Z')).toHaveLength(1);
    expect(resolutionsFor([other], 'create:plan', '2026-11-02T10:00:00Z')).toEqual([]);
  });
});

describe('stable mapping inputs', () => {
  it('useStable keeps the previous object while the content is the same, so the mapping memo keeps hitting', () => {
    const { result, rerender } = renderHook(({ v }) => useStable(v), { initialProps: { v: { a: 1, kinds: ['user'] } as { a: number; kinds: string[] } } });
    const first = result.current;
    rerender({ v: { a: 1, kinds: ['user'] } });
    expect(result.current).toBe(first);
    rerender({ v: { a: 1, kinds: ['user', 'org'] } });
    expect(result.current).not.toBe(first);
    expect(result.current.kinds).toEqual(['user', 'org']);
  });

  it('useStableIdLists keeps each list’s array while its record is unchanged, and the whole object while no list changed', () => {
    const rec = (uid: string, fetchedAt: string, ids: string[]) => ({ uid, workspaceId: 'w', sourceId: 's', fetchedAt, ids });
    const { result, rerender } = renderHook(({ recs }) => useStableIdLists(recs), { initialProps: { recs: [rec('a', 't1', ['1', '2'])] as ReturnType<typeof rec>[] | undefined } });
    const first = result.current!;
    // A live query re-reads the records: new arrays, same content.
    rerender({ recs: [rec('a', 't1', ['1', '2'])] });
    expect(result.current).toBe(first);
    // A second list arrives: a new object, but list a keeps its array (the memo entries that used only a stay valid).
    rerender({ recs: [rec('a', 't1', ['1', '2']), rec('b', 't2', ['9'])] });
    expect(result.current).not.toBe(first);
    expect(result.current!.a).toBe(first.a);
    const second = result.current!;
    // List a re-fetched: its array changes, b's stays.
    rerender({ recs: [rec('a', 't3', ['1', '2', '3']), rec('b', 't2', ['9'])] });
    expect(result.current!.a).not.toBe(second.a);
    expect(result.current!.b).toBe(second.b);
    rerender({ recs: undefined });
    expect(result.current).toBeUndefined();
  });
});

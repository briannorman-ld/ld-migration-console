import { describe, expect, it } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import { resolutionsFor } from './useMigration.ts';

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

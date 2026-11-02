import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import { DecisionCard } from './DecisionCard.tsx';

const decision: DecisionPoint = {
  id: 'unit_type_kind:web/unit_type/planKey:kind',
  type: 'unit_type_kind',
  severity: 'choice',
  subject: { sourceId: 'web', kind: 'unit_type', uid: 'web/unit_type/planKey', id: 'planKey' },
  title: 'Context kind for unit type planKey',
  explanation: 'StatSig buckets and targets by planKey.',
  sourceFragment: { unitType: 'planKey' },
  options: [
    { key: 'create:plan-key', label: 'Create context kind “plan-key”', explanation: '', resultingFidelity: 'full' },
    { key: 'existing:user', label: 'Use the existing kind “user”', explanation: '', resultingFidelity: 'full' },
  ],
  recommended: 'create:plan-key',
  fingerprint: 'fp',
};

describe('DecisionCard: unit_type_kind custom key', () => {
  afterEach(cleanup);

  it('lets the user name a context kind that does not exist yet, validating the key', () => {
    const onChoose = vi.fn();
    render(<DecisionCard decision={decision} onChoose={onChoose} />);
    const input = screen.getByLabelText('Context kind key for planKey');
    const choose = () => screen.getByTestId('custom-kind-option').querySelector('button')!;
    expect(choose().disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'plan key' } });
    expect(screen.getByText('Not a valid context kind key.')).toBeTruthy();
    expect(choose().disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'plan-key' } });
    expect(screen.getByText('That one is already an option above.')).toBeTruthy();
    expect(choose().disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'plan' } });
    expect(choose().disabled).toBe(false);
    fireEvent.click(choose());
    expect(onChoose).toHaveBeenCalledWith('create:plan');
  });

  it('shows a typed key as the answer in force, and as the previous answer when stale', () => {
    render(<DecisionCard decision={decision} current={{ optionKey: 'create:plan', via: 'resource' }} stale={{ id: decision.id, type: 'unit_type_kind', optionKey: 'create:tier', scope: 'resource', decidedAt: '2026-11-01T00:00:00Z' }} onChoose={vi.fn()} />);
    const input = screen.getByLabelText('Context kind key for planKey') as HTMLInputElement;
    expect(input.value).toBe('plan');
    expect(screen.getByTestId('custom-kind-option').querySelector('button')!.textContent).toBe('Chosen');
    expect(screen.getByText('Create context kind “tier”')).toBeTruthy();
  });
});

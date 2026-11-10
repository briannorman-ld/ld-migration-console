import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LdSession } from '../lib/ld.ts';
import type { ResetPlan } from '../lib/reset.ts';

const plan: ResetPlan = {
  projectKey: 'shop',
  projectName: 'Shop',
  plannedAt: '2026-11-02T10:00:00Z',
  environments: [
    { key: 'production', name: 'Production', action: 'keep', reason: 'not created by this console' },
    { key: 'staging', name: 'Staging', action: 'delete', reason: 'created by this console' },
  ],
  flags: [{ key: 'checkout-v2', name: 'Checkout v2' }, { key: 'dark-mode' }],
  segments: [{ env: 'production', key: 'beta', name: 'Beta users' }],
  metrics: [],
  experiments: [{ env: 'production', key: 'price-test', name: 'Price test', running: true }],
  contextKinds: [{ key: 'org', name: 'Organization' }],
  unreadable: ['metrics: 403 Forbidden'],
  kept: { flags: 3, segments: 0, metrics: 0, experiments: 0, contextKinds: 0 },
};

const planLdReset = vi.fn<(workspaceId: string, ld: LdSession, signal?: AbortSignal) => Promise<ResetPlan>>(async () => plan);
const resetLdReport = { deleted: { flags: 2, segments: 1, metrics: 0, environments: 1 }, archived: { experiments: 1, contextKinds: 1 }, failures: [] };
const resetLdProject = vi.fn<(workspaceId: string, ld: LdSession, plan: ResetPlan) => Promise<typeof resetLdReport>>(async () => resetLdReport);
vi.mock('../lib/reset.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reset.ts')>()),
  planLdReset: (...a: Parameters<typeof planLdReset>) => planLdReset(...a),
  resetLdProject: (...a: Parameters<typeof resetLdProject>) => resetLdProject(...a),
}));

const { ProjectResetModal } = await import('./ProjectResetModal.tsx');

const ld: LdSession = { status: 'connected', instance: 'us', projectKey: 'shop' };

describe('ProjectResetModal', () => {
  afterEach(() => {
    cleanup();
    planLdReset.mockClear();
    resetLdProject.mockClear();
  });

  async function open() {
    const onClose = vi.fn();
    render(<ProjectResetModal workspaceId="w1" ld={ld} onClose={onClose} />);
    await act(async () => {});
    return onClose;
  }

  it('reads the project first and shows every key it will touch, and what it keeps', async () => {
    await open();
    expect(planLdReset).toHaveBeenCalledTimes(1);
    expect(resetLdProject).not.toHaveBeenCalled();
    const target = screen.getByTestId('reset-target');
    expect(target.textContent).toContain('Shop');
    expect(target.textContent).toContain('shop');
    expect(target.textContent).toContain('LaunchDarkly (commercial, US)');
    for (const key of ['checkout-v2', 'dark-mode', 'production/beta', 'production/price-test', 'org', 'staging']) expect(screen.getByText(key)).toBeTruthy();
    expect(screen.getByText('delete 2')).toBeTruthy(); // flags
    expect(screen.getAllByText('delete 1')).toHaveLength(2); // segments, environments
    expect(screen.getAllByText('archive 1')).toHaveLength(2); // experiments, context kinds
    expect(screen.getByText('none')).toBeTruthy(); // metrics
    expect(screen.getByText('running: stopped first')).toBeTruthy();
    expect(screen.getByText('Kept').parentElement?.textContent).toContain('production');
    expect(screen.getByText('metrics: 403 Forbidden')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'I’ve reviewed this; continue' })).toBeTruthy();
  });

  it('offers no way forward when the project is already empty', async () => {
    planLdReset.mockResolvedValueOnce({ ...plan, flags: [], segments: [], experiments: [], contextKinds: [], environments: [plan.environments[0]!] });
    await open();
    expect(screen.getByText(/Nothing to do/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I’ve reviewed this; continue' })).toBeNull();
  });

  it('requires the exact project key as the second confirmation, then runs the previewed plan', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'I’ve reviewed this; continue' }));
    expect(screen.getByText(/Will delete/).textContent).toContain('2 flags');

    const type = (v: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: v } });
    type('YES');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Which project, exactly?')).toBeTruthy();

    type('Shop'); // wrong case: the key is case-sensitive
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    type('shop');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    type('engage project reset');
    expect(resetLdProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Engage project reset' }));
    await act(async () => {});
    expect(resetLdProject).toHaveBeenCalledTimes(1);
    expect(resetLdProject.mock.calls[0]![2]).toBe(plan);
    expect(screen.getByText(/Project “shop” reset/)).toBeTruthy();
  });

  it('shows the failure and runs nothing when the project cannot be read', async () => {
    planLdReset.mockRejectedValueOnce(new Error('403 Forbidden'));
    await open();
    expect(screen.getByText('403 Forbidden')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'I’ve reviewed this; continue' })).toBeNull();
    expect(resetLdProject).not.toHaveBeenCalled();
  });
});

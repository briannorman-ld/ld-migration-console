import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainMapping } from '@sslm/coverage';
import { MappingExplainer } from './MappingExplainer.tsx';

describe('MappingExplainer', () => {
  afterEach(cleanup);

  it('keeps the headline mapping visible and the caveats behind a toggle', () => {
    render(<MappingExplainer resource="gate" />);
    const x = explainMapping('gate');
    expect(screen.getByText(x.headline.statsig)).toBeTruthy();
    expect(screen.getByText(x.headline.ld)).toBeTruthy();
    expect(screen.getByText('Migrates with decisions')).toBeTruthy();
    const count = x.caveats.reduce((n, c) => n + c.rows.length, 0);
    expect(screen.queryByText('Operators')).toBeNull();
    fireEvent.click(screen.getByText(`Show ${count} caveats`));
    expect(screen.getByText('Feature gates: what does not map cleanly')).toBeTruthy();
    expect(screen.getByText('Rule conditions')).toBeTruthy();
    expect(screen.getByText('Operators')).toBeTruthy();
    expect(screen.getByText(/^Maps cleanly:/)).toBeTruthy();
    // Every caveat row is there with its status, and a clean row is only in the summary line.
    for (const e of x.caveats.flatMap((c) => c.rows)) expect(screen.getAllByText(e.statsig).length).toBeGreaterThan(0);
    expect(screen.getAllByText('No LaunchDarkly equivalent').length).toBeGreaterThan(0);
    expect(screen.getByText(`Hide ${count} caveats`)).toBeTruthy();
  });

  it('links each caveat to its row on the What migrates page', () => {
    const onOpenCoverage = vi.fn();
    render(<MappingExplainer resource="segment" onOpenCoverage={onOpenCoverage} />);
    fireEvent.click(screen.getByText(/Show \d+ caveats/));
    const big = screen.getByText('ID list segment above 15,000 IDs').closest('li')!;
    fireEvent.click(within(big).getByRole('button', { name: 'more' }));
    expect(onOpenCoverage).toHaveBeenCalledWith('segments.id_list_big');
    fireEvent.click(screen.getByRole('button', { name: 'Full row on What migrates' }));
    expect(onOpenCoverage).toHaveBeenCalledWith('segments.rule_based');
  });

  it('describes a LaunchDarkly-source resource in LaunchDarkly words', () => {
    render(<MappingExplainer resource="ld_flag" />);
    expect(screen.getByText('Flag with the same key and settings')).toBeTruthy();
    expect(screen.getByText('Migrates')).toBeTruthy();
    fireEvent.click(screen.getByText(/Show \d+ caveats/));
    expect(screen.getByText('Prerequisites (Enterprise)')).toBeTruthy();
  });
});

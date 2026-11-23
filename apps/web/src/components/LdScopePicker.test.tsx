import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LD_DEFAULT_RESOURCES, LD_RESOURCE_KINDS, type LdResourceKind } from '@sslm/canonical';
import { LdScopePicker, withoutOrphans, withRequirements } from './LdScopePicker.tsx';

function Harness({ initial = LD_DEFAULT_RESOURCES, onChange }: { initial?: LdResourceKind[]; onChange?: (s: Set<LdResourceKind>) => void }) {
  const [value, setValue] = useState(() => new Set(initial));
  return (
    <LdScopePicker
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      counts={{ flags: 12, environments: 2 }}
    />
  );
}

const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('LdScopePicker (PLAN §20.6)', () => {
  afterEach(cleanup);

  it('offers every LD resource kind, ticks the default and prices the per-flag reads', () => {
    render(<Harness />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(LD_RESOURCE_KINDS.length);
    expect(box(/^Flags/).checked).toBe(true);
    expect(box(/^Members/).checked).toBe(true);
    expect(box(/^Scheduled changes/).checked).toBe(false);
    // 12 flags × 2 environments.
    expect(screen.getAllByText('24 requests (one per flag per environment)')).toHaveLength(3);
    expect(screen.getByText('12 requests (one per flag)')).toBeTruthy();
    expect(screen.getByText('Never read, and why')).toBeTruthy();
  });

  it('keeps the per-flag kinds tied to flags: unticking flags drops them, ticking one brings flags back', () => {
    let last: Set<LdResourceKind> | undefined;
    render(<Harness initial={['flags', 'scheduled_changes']} onChange={(s) => (last = s)} />);
    fireEvent.click(box(/^Flags/));
    expect([...last!]).toEqual([]);
    expect(box(/^Scheduled changes/).disabled).toBe(true);
    expect(screen.getAllByText('needs flags')).toHaveLength(4);
    fireEvent.click(box(/^Flags/));
    fireEvent.click(box(/^Scheduled changes/));
    expect([...last!].sort()).toEqual(['flags', 'scheduled_changes']);
  });

  it('has quick picks for everything, the default and flags with segments', () => {
    let last: Set<LdResourceKind> | undefined;
    render(<Harness onChange={(s) => (last = s)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Everything' }));
    expect(last!.size).toBe(LD_RESOURCE_KINDS.length);
    fireEvent.click(screen.getByRole('button', { name: 'Flags and segments only' }));
    expect([...last!].sort()).toEqual(['flags', 'segments']);
    fireEvent.click(screen.getByRole('button', { name: /^Default/ }));
    expect([...last!]).toEqual(LD_DEFAULT_RESOURCES);
  });

  it('exposes the set helpers', () => {
    expect([...withRequirements(new Set<LdResourceKind>(['flag_links']))].sort()).toEqual(['flag_links', 'flags']);
    expect([...withoutOrphans(new Set<LdResourceKind>(['flag_links', 'segments']))]).toEqual(['segments']);
  });
});

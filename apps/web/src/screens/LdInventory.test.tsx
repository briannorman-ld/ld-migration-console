import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, LD_DEFAULT_RESOURCES, LD_RESOURCE_KINDS, type CanonicalSnapshot, type NeutralInventoryItem } from '@sslm/canonical';
import type { SourceRecord } from '@sslm/store';
import { INVENTORY_KINDS, LdInventory, snapshotReadScope } from './LdInventory.tsx';

const SRC = { sourceId: 's-legacy', sourceKind: 'launchdarkly' as const, alias: 'legacy' };
const source: SourceRecord = { id: 's-legacy', workspaceId: 'w', alias: 'legacy', label: 'Acme Legacy (LaunchDarkly)', kind: 'launchdarkly', ld: { instance: 'us', projectKey: 'acme-legacy' }, createdAt: '2026-11-23T10:00:00Z' };

const item = (resourceKind: string, key: string, over: Partial<NeutralInventoryItem> = {}): NeutralInventoryItem => ({
  kind: 'inventory',
  uid: `s-legacy/${resourceKind}/${key}`,
  resourceKind,
  key,
  name: key,
  description: '',
  tags: [],
  archived: false,
  facts: [],
  raw: { key },
  ...over,
});

function snapshot(over: Partial<NonNullable<CanonicalSnapshot['neutral']>> = {}): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-23T00:00:00Z');
  s.environments = [
    { name: 'test', isProduction: false, inferred: false },
    { name: 'production', isProduction: true, inferred: false },
  ];
  s.users = [{ id: 'm-1', email: 'growth@acme-legacy.example', name: 'Gwen Growth' }];
  s.neutral = {
    flags: [],
    segments: [],
    contextKinds: [],
    readScope: [...LD_DEFAULT_RESOURCES],
    inventory: [
      item('ai_configs', 'support-assistant', { name: 'Support assistant', facts: [{ label: 'Mode', value: 'completion' }, { label: 'Variations', value: 'Concise, Friendly' }], maintainer: { id: 'm-1', email: 'growth@acme-legacy.example' }, raw: { key: 'support-assistant', secretless: true } }),
      item('webhooks', 'wh-1', { name: 'Slack #flags', facts: [{ label: 'URL', value: 'https://hooks.example/x' }, { label: 'On', value: 'yes' }, { label: 'Statements', value: 'allow * on proj/*' }, { label: 'Signing secret', value: 'not read' }] }),
      item('approval_settings', 'production', { name: 'Approvals in Production', env: 'production', facts: [{ label: 'Required', value: 'yes' }] }),
    ],
    ...over,
  };
  return s;
}

describe('LdInventory (PLAN §20.6)', () => {
  afterEach(cleanup);

  it('shows one chip per kind with its count, "—" for a kind the scope did not read, and opens on the first kind with items', () => {
    render(<LdInventory sources={[source]} snapshots={{ 's-legacy': snapshot() }} />);
    expect(screen.getByRole('tab', { name: /AI Configs/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /^Webhooks/ }).textContent).toContain('1');
    // Scheduled changes are not in the default scope: not read, not zero.
    const sc = screen.getByRole('tab', { name: /Scheduled changes/ });
    expect(sc.textContent).toContain('—');
    expect(sc.getAttribute('title')).toMatch(/not read/);
    // Every inventory kind is offered, in registry order.
    expect(screen.getAllByRole('tab')).toHaveLength(INVENTORY_KINDS.length);
    // The first kind with items is open: AI Configs come before webhooks in the registry.
    expect(screen.getByRole('tab', { name: /AI Configs/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('support-assistant')).toBeTruthy();
    expect(screen.getByText('Gwen Growth')).toBeTruthy();
    // The coverage verdict of the kind is shown with a link to the matrix.
    expect(screen.getByText('Planned')).toBeTruthy();
  });

  it('switches kinds, filters, and opens a detail with every fact and the raw representation', () => {
    render(<LdInventory sources={[source]} snapshots={{ 's-legacy': snapshot() }} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Webhooks/ }));
    expect(screen.getByText('wh-1')).toBeTruthy();
    // Three facts inline, the rest counted.
    expect(screen.getByText('+1')).toBeTruthy();
    fireEvent.click(screen.getByText('wh-1'));
    expect(screen.getByText('Signing secret')).toBeTruthy();
    expect(screen.getByText('As LaunchDarkly returned it (credentials removed)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter other resources'), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText('No webhooks match.')).toBeTruthy();
  });

  it('shows where an item lives and says when a kind was not read, offering to widen the scope', () => {
    render(<LdInventory sources={[source]} snapshots={{ 's-legacy': snapshot() }} onChangeScope={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Approval settings/ }));
    // The key cell and the environment badge both say where it lives.
    expect(screen.getAllByText('production')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: /Scheduled changes/ }));
    expect(screen.getByText(/were not read/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Widen the read scope' }));
    expect(screen.getByRole('button', { name: /Save and refresh/ })).toBeTruthy();
  });

  it('saves a widened scope on the source and refreshes it', async () => {
    const onChangeScope = vi.fn();
    render(<LdInventory sources={[source]} snapshots={{ 's-legacy': snapshot() }} onChangeScope={onChangeScope} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read scope…' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Scheduled changes/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save and refresh/ }));
    await waitFor(() => expect(onChangeScope).toHaveBeenCalledTimes(1));
    const [s, resources] = onChangeScope.mock.calls[0]!;
    expect(s.id).toBe('s-legacy');
    // The picker keeps registry order.
    expect(resources).toEqual(LD_RESOURCE_KINDS.filter((k) => k === 'scheduled_changes' || LD_DEFAULT_RESOURCES.includes(k)));
  });

  it('treats a snapshot from before the read scope as the old scope (flags, segments, experimentation)', () => {
    const old = snapshot({ readScope: undefined, inventory: undefined });
    delete old.neutral!.readScope;
    delete old.neutral!.inventory;
    expect(snapshotReadScope(old)).toEqual(['flags', 'segments', 'metrics', 'metric_groups', 'experiments', 'holdouts', 'layers']);
    render(<LdInventory sources={[source]} snapshots={{ 's-legacy': old }} />);
    expect(screen.getByRole('tab', { name: /AI Configs/ }).textContent).toContain('—');
    expect(screen.getByText(/Not read: widen the read scope/)).toBeTruthy();
  });

  it('says so when no LaunchDarkly source is attached', () => {
    render(<LdInventory sources={[]} snapshots={{}} />);
    expect(screen.getByText(/No LaunchDarkly source is attached/)).toBeTruthy();
  });
});


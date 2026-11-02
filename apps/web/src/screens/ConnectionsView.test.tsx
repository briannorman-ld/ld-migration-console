import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalSnapshot } from '@sslm/canonical';
import type { SourceRecord, WorkspaceRecord } from '@sslm/store';
import type { LdSession } from '../lib/ld.ts';
import { ConnectionsView } from './ConnectionsView.tsx';

const workspace: WorkspaceRecord = { id: 'w1', name: 'Contoso migration', createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T10:00:00Z', isDemo: false };
const source: SourceRecord = { id: 's1', workspaceId: 'w1', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-10-22T10:01:00Z' };

function setup(over: Partial<Parameters<typeof ConnectionsView>[0]> = {}) {
  const handlers = { onAddSource: vi.fn(), onRemoveSource: vi.fn(), onOpenLd: vi.fn(), onOpenGates: vi.fn() };
  const ld: LdSession = { status: 'disconnected' };
  render(<ConnectionsView workspace={workspace} sources={[]} snapshots={{}} ld={ld} {...handlers} {...over} />);
  return handlers;
}

describe('ConnectionsView', () => {
  afterEach(cleanup);

  it('gives a new workspace a place to connect a source and a place to connect LaunchDarkly', () => {
    const h = setup();
    expect(screen.getAllByText('Not connected')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Connect a source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect LaunchDarkly' }));
    expect(h.onAddSource).toHaveBeenCalledTimes(1);
    expect(h.onOpenLd).toHaveBeenCalledTimes(1);
    // Nothing to browse yet, so no way forward until a source has synced.
    expect(screen.queryByRole('button', { name: /Open gates/ })).toBeNull();
  });

  it('shows each side’s status once connected and offers to continue', () => {
    const snapshot = { takenAt: '2026-10-22T10:05:00Z' } as CanonicalSnapshot;
    const h = setup({
      sources: [source],
      snapshots: { s1: snapshot },
      ld: { status: 'connected', instance: 'us', projectKey: 'statsig-migration' },
    });
    expect(screen.getByText('acme-web')).toBeTruthy();
    expect(screen.getByText('1 source')).toBeTruthy();
    expect(screen.getByText(/Connected to LaunchDarkly \(commercial, US\)/)).toBeTruthy();
    expect(screen.getByText('statsig-migration')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add another source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage connection' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open gates/ }));
    expect(h.onOpenGates).toHaveBeenCalledTimes(1);
  });

  it('flags a source that has not synced and a connection without a project', () => {
    setup({ sources: [source], ld: { status: 'connected', instance: 'eu' } });
    expect(screen.getByText(/1 source · waiting for the first sync/)).toBeTruthy();
    expect(screen.getByText('not synced yet')).toBeTruthy();
    expect(screen.getByText(/Connected to LaunchDarkly EU · choose a project/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose a project' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open gates/ })).toBeNull();
  });

  it('surfaces a failed LaunchDarkly connection', () => {
    setup({ ld: { status: 'error', error: 'Could not reach LaunchDarkly: 401' } });
    expect(screen.getByText('Connection failed')).toBeTruthy();
    expect(screen.getByText('Could not reach LaunchDarkly: 401')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect LaunchDarkly' })).toBeTruthy();
  });
});

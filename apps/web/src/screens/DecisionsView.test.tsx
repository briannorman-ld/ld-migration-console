import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionPoint } from '@sslm/mapper';
import type { DecisionInstance } from '../lib/migration.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { DecisionsView } from './DecisionsView.tsx';

const decision: DecisionPoint = {
  id: 'case_insensitive_match:s-web/gate/g1:rule:r1:cond:0',
  type: 'case_insensitive_match',
  severity: 'choice',
  subject: { kind: 'gate', uid: 's-web/gate/g1', id: 'g1', sourceId: 's-web' },
  title: 'Case-insensitive match',
  explanation: 'StatSig matches ignoring case.',
  sourceFragment: { operator: 'any' },
  fingerprint: 'fp1',
  options: [
    { key: 'exact', label: 'Exact match', explanation: 'Match the value as written.', resultingFidelity: 'partial' },
    { key: 'lower', label: 'Lowercase both sides', explanation: 'Compare lowercased values.', resultingFidelity: 'full' },
  ],
  recommended: 'exact',
};
const open: DecisionInstance = { decision, entityId: 'g1', envs: ['test'] };

function context(bulk?: MigrationContext['bulk']): MigrationContext {
  return {
    ld: { status: 'disconnected' },
    connected: false,
    ldEnvs: [],
    profile: { version: 1, sources: {}, attributes: {}, policies: {}, maintainers: {}, teams: {} },
    resolutions: new Map(),
    resolutionList: [],
    capabilities: {},
    directory: { members: [], teams: [], membersReadable: false, teamsReadable: false },
    idLists: {},
    coverage: {},
    now: '2026-11-17T00:00:00Z',
    exclusions: new Map(),
    ...(bulk ? { bulk } : {}),
    resolve: vi.fn(),
    saveResolutions: vi.fn(() => Promise.resolve()),
    setPolicy: vi.fn(),
  } as unknown as MigrationContext;
}

describe('DecisionsView bulk answers', () => {
  afterEach(cleanup);

  it('applies the recommended answers from the header button', () => {
    const m = context();
    render(<DecisionsView snapshots={[]} decisions={[open]} m={m} workspaceName="Acme" env="test" />);
    const button = screen.getByRole('button', { name: 'Use recommended for 1 choice' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByTestId('bulk-progress')).toBeNull();
    button.click();
    expect(m.saveResolutions).toHaveBeenCalledWith([expect.objectContaining({ id: decision.id, optionKey: 'exact', scope: 'resource' })]);
  });

  it('shows the save progress and holds the bulk buttons while a save is in flight', () => {
    const m = context({ phase: 'saving', done: 1500, total: 4000 });
    render(<DecisionsView snapshots={[]} decisions={[open]} m={m} workspaceName="Acme" env="test" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('38');
    expect(screen.getByText('Saving answers… 1,500 of 4,000')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Use recommended for 1 choice' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Use recommended (1)' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says when the save has landed', () => {
    const m = context({ phase: 'saved', done: 4000, total: 4000 });
    render(<DecisionsView snapshots={[]} decisions={[open]} m={m} workspaceName="Acme" env="test" />);
    expect(screen.getByText('Saved 4,000 answers.')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});

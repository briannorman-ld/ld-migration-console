import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptySnapshot, type CanonicalSnapshot, type Gate, type Segment } from '@sslm/canonical';
import type { MappingProfile } from '@sslm/mapper';
import type { ExclusionRecord, SourceRecord } from '@sslm/store';
import type { MigrationContext } from '../lib/useMigration.ts';
import { segmentStatus, SegmentsSideBySide, UNUSED_REASON } from './SegmentsSideBySide.tsx';

const SRC = { sourceId: 's-web', sourceKind: 'console_api' as const, alias: 'web' };
const source: SourceRecord = { id: 's-web', workspaceId: 'w', alias: 'web', label: 'acme-web', kind: 'console_api', createdAt: '2026-11-02T10:00:00Z' };
const base = { source: SRC, completeness: { missing: [] }, tags: [], targetApps: [], archived: false };

const segment = (id: string, over: Partial<Segment> = {}): Segment => ({ kind: 'segment', uid: `s-web/segment/${id}`, id, name: id, ...base, segmentType: 'rule_based', enabled: true, idType: 'userID', rules: [], ...over }) as Segment;
const usesSegment = (id: string, segmentId: string, over: Partial<Gate> = {}): Gate =>
  ({ kind: 'gate', uid: `s-web/gate/${id}`, id, name: id, ...base, enabled: true, idType: 'userID', holdoutIds: [], overrides: [], rules: [{ id: 'r1', name: 'In segment', passPercentage: 100, conditions: [{ type: 'passes_segment', operator: null, targetValue: segmentId, raw: {} }], environments: null, idType: 'userID' }], ...over }) as Gate;

function snapshot(): CanonicalSnapshot {
  const s = emptySnapshot(SRC, '2026-11-02T00:00:00Z');
  s.environments = [{ name: 'production', isProduction: true, inferred: false }];
  s.segments = [segment('beta_testers'), segment('old_partners'), segment('retired', {}), segment('vip', { segmentType: 'id_list', idList: { count: 25 } })];
  s.gates = [usesSegment('checkout', 'beta_testers'), usesSegment('vip_banner', 'vip'), usesSegment('legacy_gate', 'retired', { archived: true })];
  return s;
}

function Harness({ m, onMigrate }: { m: MigrationContext; onMigrate: (uids: string[], envs: string[]) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <>
      <output data-testid="selection">{[...selected].sort().join(',')}</output>
      <SegmentsSideBySide sources={[source]} snapshots={{ 's-web': snapshot() }} env="production" m={m} onMigrate={onMigrate} onOpenMapping={vi.fn()} selected={selected} setSelected={setSelected} />
    </>
  );
}

function setup(exclusions: ExclusionRecord[] = []) {
  const profile: MappingProfile = { version: 1, attributes: {}, policies: {}, sources: { 's-web': { envMapping: { production: 'production' }, unitTypeKinds: {} } } };
  const exclude = vi.fn(() => Promise.resolve());
  const onMigrate = vi.fn();
  const m = {
    profile,
    resolutions: new Map(),
    resolutionList: [],
    idLists: {},
    coverage: {},
    now: '2026-11-02T12:00:00Z',
    connected: false,
    ldEnvs: [],
    ld: { status: 'disconnected' },
    capabilities: { prerequisites: 'unknown', contextKinds: 'unknown', existingContextKinds: ['user'] },
    directory: { members: [], teams: [], membersReadable: false, teamsReadable: false },
    exclusions: new Map(exclusions.map((e) => [e.uid, e])),
    exclude,
    include: vi.fn(() => Promise.resolve()),
    resolve: vi.fn(() => Promise.resolve()),
    setPolicy: vi.fn(() => Promise.resolve()),
  } as unknown as MigrationContext;
  render(<Harness m={m} onMigrate={onMigrate} />);
  return { exclude, onMigrate };
}

const rowOf = (id: string) => screen.getByText(id).closest('tr')!;

describe('Segments explorer: who uses each segment, and leaving the unused behind', () => {
  afterEach(cleanup);

  it('says which gates, configs and segments use each segment, and filters to the unused ones', () => {
    setup();
    expect(within(rowOf('beta_testers')).getByText('used by 1 gate')).toBeTruthy();
    expect(within(rowOf('vip')).getByText('used by 1 gate')).toBeTruthy();
    expect(within(rowOf('old_partners')).getByText('not used')).toBeTruthy();
    expect(within(rowOf('retired')).getByText('not used (1 archived user)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'unused' } });
    expect(screen.queryByText('beta_testers')).toBeNull();
    expect(screen.getByText('old_partners')).toBeTruthy();
    expect(screen.getByText('retired')).toBeTruthy();
    expect(screen.getByText(/2 segments are not referenced by any gate/)).toBeTruthy();
  });

  it('ticks segments into the shared selection and plans only those; "Don\'t migrate these" carries the unused reason', async () => {
    const { exclude, onMigrate } = setup();
    fireEvent.click(screen.getByLabelText('Select old_partners'));
    fireEvent.click(screen.getByLabelText('Select retired'));
    expect(screen.getByTestId('selection').textContent).toBe('s-web/segment/old_partners,s-web/segment/retired');
    expect(screen.getByText('2 segments selected')).toBeTruthy();
    fireEvent.click(screen.getByText("Don't migrate these"));
    await Promise.resolve();
    expect(exclude).toHaveBeenCalledWith(['s-web/segment/old_partners', 's-web/segment/retired'], UNUSED_REASON);
    expect(onMigrate).not.toHaveBeenCalled();
  });

  it('a set-aside segment stays listed but cannot be ticked, and "Select all" skips it', () => {
    setup([{ workspaceId: 'w', uid: 's-web/segment/old_partners', reason: UNUSED_REASON, markedAt: '2026-11-02T11:00:00Z' }]);
    expect(within(rowOf('old_partners')).getByText('set aside')).toBeTruthy();
    expect((screen.getByLabelText('Select old_partners') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByTestId('selection').textContent).toBe('s-web/segment/beta_testers,s-web/segment/retired,s-web/segment/vip');
  });

  it('reads where a segment stands in an LD environment from its list and provenance footer', () => {
    const r = { segmentKey: 'beta_testers', statsigFingerprint: 'fp1', decisionSetHash: 'd1' };
    const ours = { key: 'beta_testers', tags: ['migrated-from-statsig', 'migration-src-web'], description: 'Beta [ld-migration: from=statsig; src=web; id=beta_testers; fp=fp1; d=d1; at=2026-11-02T00:00:00.000Z]' };
    expect(segmentStatus(undefined, r, 'web')).toBe('unknown');
    expect(segmentStatus([], r, 'web')).toBe('not_in_ld');
    expect(segmentStatus([{ key: 'beta_testers', tags: ['theirs'] }], r, 'web')).toBe('foreign');
    expect(segmentStatus([ours], r, 'web')).toBe('in_sync');
    expect(segmentStatus([ours], { ...r, statsigFingerprint: 'fp2' }, 'web')).toBe('statsig_changed');
    expect(segmentStatus([ours], { ...r, decisionSetHash: 'd2' }, 'web')).toBe('decisions_changed');
  });
});

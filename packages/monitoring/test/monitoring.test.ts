import { describe, expect, it } from 'vitest';
import { alertsSince, csvCell, funnel, ldChange, ldVersionsAtSync, lifecycleOf, monitorRows, pruneSamples, shouldSample, statsigZeroSince, statusCsv, statusMarkdown, type LdFlagInfo, type MonitorSample, type MonitoredItem } from '../src/index.ts';

const NOW = '2026-10-23T12:00:00.000Z';
const SYNCED = '2026-10-15T09:00:00.000Z';

function item(over: Partial<MonitoredItem> = {}): MonitoredItem {
  return {
    kind: 'gate',
    uid: 'src-web/gate/new_checkout_flow',
    id: 'new_checkout_flow',
    name: 'new_checkout_flow',
    sourceId: 'src-web',
    sourceAlias: 'web',
    flagKey: 'new_checkout_flow',
    ldEnv: 'test',
    statsigEnv: 'staging',
    archived: false,
    statsigFingerprint: 'fp1',
    decisionSetHash: 'dh1',
    fidelity: 'partial',
    openDecisions: 0,
    checksPerHour: 1200,
    ...over,
  };
}

function flag(over: Partial<LdFlagInfo> & { sync?: string[]; env?: LdFlagInfo['environments'] } = {}): LdFlagInfo {
  const { sync = ['fp1', '3', SYNCED, 'dh1'], env, ...rest } = over;
  return {
    key: 'new_checkout_flow',
    tags: ['migrated-from-statsig', 'migration-src-web'],
    customProperties: {
      'migration.id': { value: ['new_checkout_flow'] },
      'migration.source': { value: ['web'] },
      'migration.type': { value: ['gate'] },
      'migration.sync.test': { value: sync },
    },
    environments: env ?? { test: { on: true, version: 7, lastModified: Date.parse(SYNCED) + 500 } },
    ...rest,
  };
}

const flags = (...fs: LdFlagInfo[]) => new Map(fs.map((f) => [f.key, f]));

describe('ldChange', () => {
  it('ignores modifications inside the grace window after the sync (our own provenance write)', () => {
    expect(ldChange({ lastModified: Date.parse(SYNCED) + 30_000 }, SYNCED).changed).toBe(false);
  });
  it('flags a later modification with evidence', () => {
    const r = ldChange({ lastModified: Date.parse(SYNCED) + 3600_000 }, SYNCED);
    expect(r.changed).toBe(true);
    expect(r.evidence).toContain('after the sync at');
  });
  it('falls back to the journaled version when the modification time is unknown', () => {
    expect(ldChange({ version: 9 }, undefined, 7).changed).toBe(true);
    expect(ldChange({ version: 7 }, undefined, 7).changed).toBe(false);
    expect(ldChange({ version: 9 }, undefined).changed).toBe(false);
  });
  it('lets the modification time overrule a bumped version (the provenance write bumps versions too)', () => {
    expect(ldChange({ version: 9, lastModified: Date.parse(SYNCED) + 1000 }, SYNCED, 7).changed).toBe(false);
  });
});

describe('monitorRows', () => {
  it('reports in_sync from provenance alone', () => {
    const [row] = monitorRows({ items: [item()], ldFlags: flags(flag()), statuses: {}, settings: [], samples: [], now: NOW });
    expect(row?.status).toBe('in_sync');
    expect(row?.syncedAt).toBe(SYNCED);
    expect(row?.traffic).toBe('unknown');
    expect(row?.lifecycle).toBe('migrated');
  });

  it('keeps the planner statuses for items that are not monitored', () => {
    const rows = monitorRows({ items: [item(), item({ id: 'other', uid: 'src-web/gate/other', flagKey: 'other' })], ldFlags: flags(flag({ sync: [] })), statuses: {}, settings: [], samples: [], now: NOW });
    expect(rows.map((r) => [r.id, r.status, r.lifecycle])).toEqual([
      ['new_checkout_flow', 'not_migrated', 'not_migrated'],
      ['other', 'not_in_ld', 'not_migrated'],
    ]);
  });

  it('distinguishes StatSig changed, LaunchDarkly changed and conflict', () => {
    const later = Date.parse(SYNCED) + 86400_000;
    const ss = monitorRows({ items: [item({ statsigFingerprint: 'fp2' })], ldFlags: flags(flag()), statuses: {}, settings: [], samples: [], now: NOW })[0]!;
    const ld = monitorRows({ items: [item()], ldFlags: flags(flag({ env: { test: { lastModified: later } } })), statuses: {}, settings: [], samples: [], now: NOW })[0]!;
    const both = monitorRows({ items: [item({ decisionSetHash: 'dh2' })], ldFlags: flags(flag({ env: { test: { lastModified: later } } })), statuses: {}, settings: [], samples: [], now: NOW })[0]!;
    expect([ss.status, ss.statsigChanged, ss.ldChanged]).toEqual(['statsig_changed', true, false]);
    expect([ld.status, ld.statsigChanged, ld.ldChanged]).toEqual(['ld_changed', false, true]);
    expect(ld.ldChangeEvidence).toMatch(/^modified /);
    expect(both.status).toBe('conflict');
  });

  it('uses the journaled LaunchDarkly version when the summary has no modification time', () => {
    const row = monitorRows({ items: [item()], ldFlags: flags(flag({ env: { test: { version: 9 } } })), statuses: {}, settings: [], samples: [], ldVersionsAtSync: { 'new_checkout_flow|test': 7 }, now: NOW })[0]!;
    expect(row.status).toBe('ld_changed');
    expect(row.ldChangeEvidence).toBe('version 9, was 7 at sync');
  });

  it('marks an entity archived in StatSig after migration, even when its fingerprint moved', () => {
    const row = monitorRows({ items: [item({ archived: true, statsigFingerprint: 'fp9' })], ldFlags: flags(flag()), statuses: {}, settings: [], samples: [], now: NOW })[0]!;
    expect(row.status).toBe('archived_in_statsig');
  });

  it('silences StatSig changes once LaunchDarkly is authoritative, and says so in the lifecycle', () => {
    const row = monitorRows({ items: [item({ statsigFingerprint: 'fp2' })], ldFlags: flags(flag()), statuses: { test: { new_checkout_flow: { name: 'active' } } }, settings: [{ flagKey: 'new_checkout_flow', ldEnv: 'test', ldAuthoritative: true, setAt: NOW }], samples: [], now: NOW })[0]!;
    expect(row.status).toBe('ld_authoritative');
    expect(row.statsigChanged).toBe(true);
    expect(row.lifecycle).toBe('ld_authoritative');
  });

  it('reads LaunchDarkly traffic from flag statuses and moves the lifecycle to dual-running', () => {
    const row = monitorRows({ items: [item()], ldFlags: flags(flag()), statuses: { test: { new_checkout_flow: { name: 'active', lastRequested: '2026-10-23T11:59:00Z' } } }, settings: [], samples: [], now: NOW })[0]!;
    expect(row.traffic).toBe('active');
    expect(row.lastRequested).toBe('2026-10-23T11:59:00Z');
    expect(row.lifecycle).toBe('dual_running');
    expect(row.ldOn).toBe(true);
  });

  it('calls an item cut over after seven days of LaunchDarkly traffic and zero StatSig checks', () => {
    const samples: MonitorSample[] = [
      { flagKey: 'new_checkout_flow', ldEnv: 'test', at: '2026-10-10T00:00:00Z', ldStatus: 'active', statsigChecksPerHour: 40 },
      { flagKey: 'new_checkout_flow', ldEnv: 'test', at: '2026-10-15T12:00:00Z', ldStatus: 'active', statsigChecksPerHour: 0 },
      { flagKey: 'new_checkout_flow', ldEnv: 'test', at: '2026-10-23T11:00:00Z', ldStatus: 'active', statsigChecksPerHour: 0 },
    ];
    const row = monitorRows({ items: [item({ checksPerHour: 0 })], ldFlags: flags(flag()), statuses: { test: { new_checkout_flow: { name: 'active' } } }, settings: [], samples, now: NOW })[0]!;
    expect(row.lifecycle).toBe('cut_over');
    expect(row.statsigZeroSince).toBe('2026-10-15T12:00:00Z');
    // Six days is not enough.
    expect(lifecycleOf('in_sync', 'active', false, '2026-10-18T00:00:00Z', NOW)).toBe('dual_running');
  });

  it('lists LaunchDarkly flags with our provenance whose StatSig entity is gone', () => {
    const gone = flag({ key: 'retired_gate', customProperties: { 'migration.id': { value: ['retired_gate'] }, 'migration.source': { value: ['web'] }, 'migration.sync.test': { value: ['fp', '1', SYNCED, 'dh'] }, 'migration.sync.production': { value: [] } } });
    const foreign: LdFlagInfo = { key: 'hand_made', tags: [], customProperties: {} };
    const rows = monitorRows({ items: [item()], ldFlags: flags(flag(), gone, foreign), statuses: {}, settings: [], samples: [], now: NOW });
    expect(rows.map((r) => `${r.id}@${r.ldEnv}:${r.status}`)).toEqual(['new_checkout_flow@test:in_sync', 'retired_gate@test:missing_in_statsig']);
  });

  it('builds the per-environment funnel', () => {
    const rows = monitorRows({
      items: [item(), item({ ldEnv: 'production', statsigEnv: 'production' })],
      ldFlags: flags(flag({ customProperties: { ...flag().customProperties, 'migration.sync.production': { value: ['fp1', '3', SYNCED, 'dh1'] } }, env: { test: { lastModified: 1 }, production: { lastModified: 1 } } })),
      statuses: { production: { new_checkout_flow: { name: 'launched' } } },
      settings: [],
      samples: [],
      now: NOW,
    });
    expect(funnel(rows)).toEqual([
      { ldEnv: 'production', counts: { not_migrated: 0, migrated: 0, dual_running: 1, cut_over: 0, ld_authoritative: 0 }, total: 1 },
      { ldEnv: 'test', counts: { not_migrated: 0, migrated: 1, dual_running: 0, cut_over: 0, ld_authoritative: 0 }, total: 1 },
    ]);
  });
});

describe('alertsSince', () => {
  it('fires once per drift, and again only after a new sync', () => {
    const drifted = monitorRows({ items: [item({ statsigFingerprint: 'fp2' })], ldFlags: flags(flag()), statuses: {}, settings: [], samples: [], now: NOW });
    const first = alertsSince([], drifted);
    expect(first.alerts.map((a) => a.kind)).toEqual(['drift']);
    expect(first.alerts[0]?.message).toContain('StatSig changed');
    expect(alertsSince(first.keys, drifted).alerts).toEqual([]);
    const resynced = monitorRows({ items: [item({ statsigFingerprint: 'fp3' })], ldFlags: flags(flag({ sync: ['fp2', '4', NOW, 'dh1'] })), statuses: {}, settings: [], samples: [], now: NOW });
    expect(alertsSince(first.keys, resynced).alerts).toHaveLength(1);
    const inSync = monitorRows({ items: [item()], ldFlags: flags(flag()), statuses: {}, settings: [], samples: [], now: NOW });
    expect(alertsSince(first.keys, inSync)).toEqual({ alerts: [], keys: [] });
  });
});

describe('samples', () => {
  const base = { flagKey: 'f', ldEnv: 'test', ldStatus: 'active', statsigChecksPerHour: 10 };
  it('keeps a reading when something changed or the last one is old', () => {
    expect(shouldSample(undefined, base, NOW)).toBe(true);
    const prev: MonitorSample = { ...base, at: '2026-10-23T11:00:00Z' };
    expect(shouldSample(prev, base, NOW)).toBe(false);
    expect(shouldSample(prev, { ...base, ldStatus: 'launched' }, NOW)).toBe(true);
    expect(shouldSample(prev, { ...base, statsigChecksPerHour: 0 }, NOW)).toBe(true);
    expect(shouldSample(prev, { ...base, statsigChecksPerHour: null }, NOW)).toBe(true);
    expect(shouldSample({ ...prev, at: '2026-10-23T05:00:00Z' }, base, NOW)).toBe(true);
  });
  it('finds the start of the zero streak and prunes old samples', () => {
    const samples: MonitorSample[] = [
      { ...base, at: '2026-07-01T00:00:00Z', statsigChecksPerHour: 0 },
      { ...base, at: '2026-10-20T00:00:00Z', statsigChecksPerHour: 3 },
      { ...base, at: '2026-10-21T00:00:00Z', statsigChecksPerHour: 0 },
      { ...base, at: '2026-10-22T00:00:00Z', statsigChecksPerHour: 0 },
    ];
    expect(statsigZeroSince(samples)).toBe('2026-10-21T00:00:00Z');
    expect(statsigZeroSince([{ ...base, at: NOW, statsigChecksPerHour: null }])).toBeUndefined();
    expect(pruneSamples(samples, NOW).map((s) => s.at)).toEqual(samples.slice(1).map((s) => s.at));
  });
});

describe('ldVersionsAtSync', () => {
  it('takes the newest completed sync per flag environment, skipping undone and failed steps', () => {
    const runs = [
      { steps: [{ status: 'undone', ldVersion: 12, step: { op: 'update_flag_env', key: 'a', ldEnv: 'test' } }] },
      { steps: [{ status: 'done', ldVersion: 9, step: { op: 'update_flag_env', key: 'a', ldEnv: 'test' } }, { status: 'done', step: { op: 'upsert_flag_shell', key: 'a' } }] },
      { steps: [{ status: 'done', ldVersion: 4, step: { op: 'update_flag_env', key: 'a', ldEnv: 'test' } }, { status: 'failed', ldVersion: 2, step: { op: 'update_flag_env', key: 'b', ldEnv: 'test' } }] },
    ];
    expect(ldVersionsAtSync(runs)).toEqual({ 'a|test': 9 });
  });
});

describe('csvCell', () => {
  it('quotes, doubles quotes, and defuses a leading formula trigger (CSV injection)', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("https://evil.example","x")')).toBe(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(csvCell("+cmd|' /C calc'!A0")).toBe(`"'+cmd|' /C calc'!A0"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tlead')).toBe(`"'\tlead"`);
    // Numbers, negative ones included, are left as numbers.
    expect(csvCell(-3)).toBe('"-3"');
    expect(csvCell('-2.5')).toBe('"-2.5"');
    expect(csvCell(undefined)).toBe('""');
  });
});

describe('reports', () => {
  it('renders CSV and markdown with the funnel, drift and inventory', () => {
    const rows = monitorRows({ items: [item({ statsigFingerprint: 'fp2' }), item({ id: 'b', uid: 'src-web/gate/b', flagKey: 'b' })], ldFlags: flags(flag()), statuses: { test: { new_checkout_flow: { name: 'active', lastRequested: '2026-10-23T11:00:00Z' } } }, settings: [], samples: [], now: NOW });
    const csv = statusCsv(rows);
    expect(csv.split('\n')[0]).toBe('kind,statsig_id,source,statsig_env,ld_flag,ld_env,fidelity,open_decisions,status,synced_at,ld_on,ld_traffic,ld_last_requested,statsig_checks_per_hour,lifecycle,ld_change_evidence');
    expect(csv).toContain('"gate","b","web","staging","b","test","partial","0","not_in_ld"');
    expect(csv).toContain('"statsig_changed","2026-10-15T09:00:00.000Z","on","active","2026-10-23T11:00:00Z","1200","dual_running"');
    const md = statusMarkdown('Acme', rows, { now: NOW, lastCheckedAt: NOW, ldProject: 'statsig-migration' });
    expect(md).toContain('# Migration status: Acme');
    expect(md).toContain('| test | 1 | 0 | 1 | 0 | 0 | 2 |');
    expect(md).toContain('| gate new_checkout_flow (web) | test | StatSig changed |');
    expect(md).toContain('Nothing to retire.');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { describeUids, kindOfUid, loadSelection, saveSelection, toSelection } from './selection.ts';

describe('migration selection', () => {
  beforeEach(() => sessionStorage.clear());

  it('reads the kind from the uid and builds one plan request from every kind at once', () => {
    expect(kindOfUid('src-web/gate/checkout')).toBe('gate');
    expect(kindOfUid('src-legacy/flag/new-nav')).toBe('flag');
    // StatSig param stores have no plan of their own; LD-source experiments do (PLAN §20.5).
    expect(kindOfUid('src-web/param_store/x')).toBeUndefined();
    expect(kindOfUid('src-legacy/experiment/x')).toBe('experiment');
    const uids = ['src-web/gate/a', 'src-web/gate/b', 'src-web/config/c', 'src-web/autotune/d', 'src-legacy/flag/e', 'src-web/segment/f', 'src-web/prompt/p', 'src-web/param_store/x', 'src-legacy/experiment/x', 'src-legacy/metric/m'];
    expect(toSelection(uids)).toEqual({ gates: ['src-web/gate/a', 'src-web/gate/b'], configs: ['src-web/config/c'], autotunes: ['src-web/autotune/d'], flags: ['src-legacy/flag/e'], segments: ['src-web/segment/f'], prompts: ['src-web/prompt/p'], metrics: ['src-legacy/metric/m'], metricGroups: [], experiments: ['src-legacy/experiment/x'], holdouts: [], layers: [] });
    expect(describeUids(uids)).toBe('1 segment, 2 gates, 1 dynamic config, 1 flag, 1 autotune, 1 AI Config, 1 metric and 1 experiment');
    expect(describeUids(['src-web/gate/a'])).toBe('1 gate');
    expect(describeUids([])).toBe('nothing');
  });

  it('survives a reload for the tab, per workspace, and drops what is not a selectable uid', () => {
    saveSelection('w1', new Set(['src-web/gate/a', 'src-web/config/c']));
    saveSelection('w2', new Set(['src-web/gate/z']));
    expect([...loadSelection('w1')]).toEqual(['src-web/gate/a', 'src-web/config/c']);
    expect([...loadSelection('w2')]).toEqual(['src-web/gate/z']);
    sessionStorage.setItem('ld-migration:selection:w3', JSON.stringify(['src-web/gate/ok', 'src-web/param_store/no', 42]));
    expect([...loadSelection('w3')]).toEqual(['src-web/gate/ok']);
    saveSelection('w1', new Set());
    expect(sessionStorage.getItem('ld-migration:selection:w1')).toBeNull();
    sessionStorage.setItem('ld-migration:selection:w4', '{not json');
    expect(loadSelection('w4').size).toBe(0);
  });
});

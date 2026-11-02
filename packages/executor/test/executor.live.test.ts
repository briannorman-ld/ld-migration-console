/**
 * Live WRITE checks against the demo LD project (`statsig-migration`, env `test`). Opt-in:
 * `LIVE=1 LIVE_WRITE=1 pnpm test:live`. Every key is prefixed `zz-live-<run>-` and everything
 * created is undone (deleted) at the end, so the demo project is left as it was.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { buildAcmeDataset, createStatsigConsoleHandlers, DEMO_STATSIG_API_KEY } from '@sslm/demo-fixtures';
import { crawlConsoleProject, normalizeConsoleSnapshot } from '@sslm/adapters';
import { StatsigConsoleClient } from '@sslm/statsig-client';
import { LdClient, type LdInstanceId } from '@sslm/ld-client';
import { planMigration, recommendedResolutions, type PlanStep } from '@sslm/planner';
import type { Resolution } from '@sslm/mapper';
import { Executor, newRun, type RunRecord } from '../src/index.ts';

function loadEnvLocal(): Record<string, string> {
  const path = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadEnvLocal(), ...process.env };
const token = env.LD_API_TOKEN ?? '';
const enabled = process.env.LIVE === '1' && process.env.LIVE_WRITE === '1' && token.length > 0;
const PROJECT = 'statsig-migration';
const NOW = new Date().toISOString();
const PREFIX = `zz-live-${Date.now().toString(36)}-`;

/** Rename every LD key in a plan, including references inside clauses and prerequisites. */
function prefixed(steps: PlanStep[]): PlanStep[] {
  const json = JSON.stringify(steps);
  const keys = new Set(steps.filter((s) => s.op !== 'ensure_context_kind').map((s) => s.key));
  return (JSON.parse(json) as PlanStep[]).map((s) => {
    if (s.op === 'ensure_context_kind') return s;
    const ren = (k: string) => (keys.has(k) ? PREFIX + k : k);
    const out = { ...s, key: ren(s.key), id: s.id.replace(s.key, ren(s.key)), deps: s.deps.map((d) => d.replace(/([^:]+)$/, (k) => ren(k))) } as PlanStep;
    if (out.op === 'upsert_flag_shell' || out.op === 'upsert_segment') out.desired.key = ren(out.desired.key);
    if (out.op === 'update_flag_env') {
      out.desired.rules.forEach((r) => r.clauses.forEach((c) => c.op === 'segmentMatch' && (c.values = c.values.map((v) => ren(String(v))))));
      out.desired.prerequisites = out.desired.prerequisites.map((p) => ({ ...p, key: ren(p.key) }));
    }
    return out;
  });
}

describe.skipIf(!enabled)('executor against real LaunchDarkly (writes, then undoes)', () => {
  const server = setupServer();
  const stats = { requests: 0, throttled: [] as string[] };
  const client = new LdClient({
    instance: (env.LD_INSTANCE || 'us') as LdInstanceId,
    token,
    transport: { onEvent: (e) => (e.type === 'request' ? stats.requests++ : e.type === 'throttled' ? stats.throttled.push(`${e.url.replace(/.*api\/v2/, '')} @${stats.requests}`) : undefined) },
  });
  const runs: RunRecord[] = [];
  const journal = { save: async (r: RunRecord) => void runs.push(structuredClone(r)) };
  let steps: PlanStep[];

  beforeAll(async () => {
    server.listen({ onUnhandledFrame: 'bypass' });
    const baseUrl = 'https://demo-statsig.test/web/console/v1';
    server.use(...createStatsigConsoleHandlers({ baseUrl, getDataset: () => buildAcmeDataset('web', 1), apiKey: DEMO_STATSIG_API_KEY }));
    const sc = new StatsigConsoleClient({ baseUrl, apiKey: DEMO_STATSIG_API_KEY, transport: { budgets: [], retry: { baseDelayMs: 1, maxDelayMs: 5 } } });
    const snap = normalizeConsoleSnapshot(await crawlConsoleProject(sc, []), { source: { sourceId: 'src-web', sourceKind: 'console_api', alias: 'web' }, takenAt: NOW });
    server.close();
    const ids = ['new_checkout_flow', 'checkout_express_pay', 'vip_early_access', 'search_v2'];
    const base = {
      gates: ids.map((id) => snap.gates.find((g) => g.id === id)!.uid),
      ldEnvs: ['test'],
      snapshots: [snap],
      profile: { version: 1 as const, sources: { 'src-web': { envMapping: { staging: 'test' }, unitTypeKinds: {} } }, attributes: {}, policies: {} },
      capabilities: { prerequisites: 'unknown' as const, contextKinds: 'unknown' as const, existingContextKinds: ['user'] },
      ld: { flags: new Map(), segments: {}, contextKinds: ['user'], criticalEnvs: [] },
      now: NOW,
    };
    let resolutions = new Map<string, Resolution>();
    for (let i = 0; i < 4; i++) {
      const plan = planMigration({ ...base, resolutions });
      for (const r of recommendedResolutions(plan.decisions, NOW)) resolutions.set(r.id, r);
      for (const d of plan.decisions.filter((d) => d.severity === 'acknowledge')) resolutions.set(d.id, { id: d.id, type: d.type, optionKey: d.recommended!, scope: 'resource', fingerprint: d.fingerprint, decidedAt: NOW });
      resolutions = new Map(resolutions);
    }
    const plan = planMigration({ ...base, resolutions });
    expect(plan.ready).toBe(true);
    steps = prefixed(plan.steps);
  });

  afterAll(async () => {
    console.log(`LaunchDarkly requests: ${stats.requests}; throttled: ${stats.throttled.length}`, stats.throttled.slice(0, 20));
    // Belt and braces: remove anything with our prefix that survived a failed test.
    for (const f of await client.listFlags(PROJECT)) if (f.key.startsWith(PREFIX)) await client.deleteFlag(PROJECT, f.key).catch(() => undefined);
    for (const sg of await client.listSegments(PROJECT, 'test')) if (sg.key.startsWith(PREFIX)) await client.deleteSegment(PROJECT, 'test', sg.key).catch(() => undefined);
  });

  it('renames every key it writes', () => {
    for (const s of steps) if (s.op !== 'ensure_context_kind') expect([s.key, 'desired' in s && 'key' in s.desired ? s.desired.key : s.key].every((k) => k.startsWith(PREFIX))).toBe(true);
  });

  it('dry-runs, migrates, re-syncs idempotently and undoes', async () => {
    const ex = new Executor({ client, projectKey: PROJECT, journal, actor: 'live-test' });
    const dry = await ex.run(newRun({ id: `dry-${PREFIX}`, workspaceId: 'live', projectKey: PROJECT, label: 'dry', dryRun: true, steps, now: new Date() }));
    expect(dry.steps.map((s) => [s.id, s.status, s.error ?? ''])).toEqual(dry.steps.map((s) => [s.id, 'done', '']));
    expect(await client.getFlag(PROJECT, `${PREFIX}new_checkout_flow`)).toBeNull();

    const run = await ex.run(newRun({ id: `run-${PREFIX}`, workspaceId: 'live', projectKey: PROJECT, label: 'live', dryRun: false, steps, now: new Date() }));
    expect(run.steps.map((s) => [s.id, s.status, s.error ?? ''])).toEqual(run.steps.map((s) => [s.id, 'done', '']));

    const ncf = (await client.getFlag(PROJECT, `${PREFIX}new_checkout_flow`))!;
    const e = ncf.environments!.test!;
    expect(e.on).toBe(true);
    expect(e.rules).toHaveLength(2);
    expect(e.fallthrough?.rollout?.variations.map((v) => v.weight)).toEqual([20000, 80000]);
    expect(ncf.tags).toEqual(expect.arrayContaining(['migrated-from-statsig', 'migration-src-web']));
    expect(ncf.customProperties?.['migration.sync.test']?.value?.length).toBe(4);
    expect(ncf.environments!.production!.on).toBe(false);

    const express = (await client.getFlag(PROJECT, `${PREFIX}checkout_express_pay`))!;
    expect(express.environments!.test!.prerequisites).toEqual([{ key: `${PREFIX}new_checkout_flow`, variation: 0 }]);
    const seg = (await client.getSegment(PROJECT, 'test', `${PREFIX}vip_customers`))!;
    expect(seg.included).toHaveLength(25);
    expect(seg.description).toMatch(/\[ld-migration: from=statsig; src=web; id=vip_customers;/);

    const again = await ex.run(newRun({ id: `again-${PREFIX}`, workspaceId: 'live', projectKey: PROJECT, label: 'again', dryRun: false, steps, now: new Date() }));
    expect(again.steps.filter((s) => s.status !== 'done').map((s) => [s.id, s.error])).toEqual([]);
    expect(again.steps.find((s) => s.step.op === 'upsert_flag_shell')!.message).toMatch(/already up to date/);

    // Undo the re-sync first (restores pre-images), then the first run (deletes what it created).
    const undoneAgain = await ex.undo(again);
    expect(undoneAgain.steps.filter((s) => s.error).map((s) => [s.id, s.error])).toEqual([]);
    expect(undoneAgain.status).toBe('undone');
    expect((await client.getFlag(PROJECT, `${PREFIX}new_checkout_flow`))!.environments!.test!.rules).toHaveLength(2);
    const undone = await ex.undo(run);
    expect(undone.steps.filter((s) => s.error)).toEqual([]);
    expect(undone.status).toBe('undone');
    expect(await client.getFlag(PROJECT, `${PREFIX}new_checkout_flow`)).toBeNull();
    expect(await client.getSegment(PROJECT, 'test', `${PREFIX}vip_customers`)).toBeNull();
  }, 600_000);

  it('adopts an existing flag and restores it exactly on undo', async () => {
    const key = `${PREFIX}adopted`;
    await client.createFlag(PROJECT, { key, name: 'Pre-existing', variations: [{ value: true }, { value: false }], tags: ['team-x'] });
    const pre = (await client.getFlag(PROJECT, key))!;
    const [t, f] = [pre.variations[0]!._id, pre.variations[1]!._id];
    await client.patchFlagSemantic(PROJECT, key, {
      environmentKey: 'test',
      instructions: [
        { kind: 'turnFlagOn' },
        { kind: 'addRule', variationId: t, clauses: [{ contextKind: 'user', attribute: 'email', op: 'endsWith', values: ['@x.com'], negate: false }] },
        { kind: 'addTargets', contextKind: 'user', variationId: f, values: ['u1'] },
      ],
    });
    const before = (await client.getFlag(PROJECT, key))!;
    const shell = steps.find((s): s is Extract<PlanStep, { op: 'upsert_flag_shell' }> => s.op === 'upsert_flag_shell' && s.key.endsWith('search_v2'))!;
    const envStep = steps.find((s): s is Extract<PlanStep, { op: 'update_flag_env' }> => s.op === 'update_flag_env' && s.key.endsWith('search_v2'))!;
    const adopt: PlanStep[] = [
      { ...shell, id: `shell:${key}`, key, exists: true, adopt: true, desired: { ...shell.desired, key } },
      { ...envStep, id: `env:test:${key}`, key, deps: [`shell:${key}`] },
    ];
    const ex = new Executor({ client, projectKey: PROJECT, journal, actor: 'live-test' });
    const run = await ex.run(newRun({ id: `adopt-${PREFIX}`, workspaceId: 'live', projectKey: PROJECT, label: 'adopt', dryRun: false, steps: adopt, now: new Date() }));
    expect(run.steps.map((s) => [s.status, s.error ?? ''])).toEqual([['done', ''], ['done', '']]);
    expect((await client.getFlag(PROJECT, key))!.environments!.test!.rules![0]!.clauses[0]!.attribute).toBe('plan');

    await ex.undo(run);
    const after = (await client.getFlag(PROJECT, key))!;
    const strip = (fl: typeof before) => {
      const e = fl.environments!.test!;
      return { name: fl.name, tags: fl.tags, cp: fl.customProperties, on: e.on, ft: e.fallthrough, off: e.offVariation, targets: e.targets, rules: e.rules?.map((r) => ({ v: r.variation, c: r.clauses.map(({ _id, ...c }) => c) })) };
    };
    expect(strip(after)).toEqual(strip(before));
    await client.deleteFlag(PROJECT, key);
  }, 300_000);
});

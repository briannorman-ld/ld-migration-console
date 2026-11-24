import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { experimentKitMarkdown, experimentMigrationKit } from '@sslm/canonical';
import { crawlConsoleProject, normalizeConsoleSnapshot } from '../src/index.ts';
import { mockProject, server, testClient } from './msw-server.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * The experiment migration kit on the Acme Retail demo, read through the Console API adapter: the
 * case the Layers page demos, two experiments of `checkout_layer` ticked at once.
 */
describe('experiment migration kit on the Acme web project', () => {
  async function snapshot() {
    mockProject('web');
    const { client, issues } = testClient('web');
    const raw = await crawlConsoleProject(client, issues);
    return normalizeConsoleSnapshot(raw, { source: { sourceId: 'src-web', sourceKind: 'console_api', alias: 'web' }, takenAt: '2026-10-01T00:00:00.000Z' });
  }

  it('two experiments of the checkout layer share one layer, one defaults flag and one metric', async () => {
    const kit = experimentMigrationKit(await snapshot(), ['checkout_cta_copy', 'checkout_trust_badges']);
    expect(kit.excluded).toEqual([]);
    expect(kit.selected.map((s) => [s.id, s.fate, s.flag.state])).toEqual([
      ['checkout_cta_copy', 'wait', 'blocked_running'],
      ['checkout_trust_badges', 'draft', 'in_snapshot'],
    ]);
    expect(kit.items.map((i) => `${i.kind}/${i.id}:${i.state}`)).toEqual([
      'layer/checkout_layer:in_snapshot',
      'flag/checkout_cta_copy:blocked_running',
      'flag/checkout_layer_defaults:in_snapshot',
      'flag/checkout_trust_badges:in_snapshot',
      'metric/checkout_conversion:in_snapshot',
      'holdout/global_holdout:in_snapshot',
    ]);
    expect(kit.items.find((i) => i.kind === 'layer')!.neededBy).toEqual(['checkout_cta_copy', 'checkout_trust_badges']);
    // checkout_trust_badges has no metrics in the demo: the kit says so rather than inventing one.
    expect(kit.notes).toEqual(['checkout_trust_badges names no metrics; a LaunchDarkly experiment needs at least one before it can start.']);
    const doc = experimentKitMarkdown(kit, { source: 'web' });
    expect(doc).toContain('## Layers (1)');
    expect(doc).toContain('| `checkout_conversion` | `checkout_conversion` | ratio metric | to create | `checkout_cta_copy` |');
  });

  it('resolves a running experiment’s targeting gate to a segment and lists its metrics', async () => {
    const kit = experimentMigrationKit(await snapshot(), ['search_ranking_v3']);
    expect(kit.items.map((i) => `${i.kind}/${i.id}:${i.state}`)).toEqual([
      'flag/search_ranking_v3:blocked_running',
      'segment/checkout_targeting_gate:in_snapshot',
      'metric/purchase_count:in_snapshot',
      'metric/revenue:in_snapshot',
      'holdout/global_holdout:in_snapshot',
    ]);
  });

  it('never lists an archived experiment', async () => {
    const kit = experimentMigrationKit(await snapshot(), ['old_banner_test', 'pricing_old_tiers']);
    expect(kit.items).toEqual([]);
    expect(kit.excluded.map((x) => x.id)).toEqual(['old_banner_test', 'pricing_old_tiers']);
  });
});

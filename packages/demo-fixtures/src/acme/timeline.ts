import { PEOPLE as P } from './people.ts';
import type { ProjectSeed } from './seed-types.ts';

export const SNAPSHOT_COUNT = 2;

/**
 * Scripted StatSig changes between demo snapshots ("Advance StatSig timeline", PLAN §19.3).
 * Snapshot 1 is the seed as written; snapshot n applies steps 2..n in order.
 */
export function applyTimeline(seed: ProjectSeed, snapshot: number): ProjectSeed {
  const s = structuredClone(seed);
  if (snapshot >= 2) step2(s);
  return s;
}

function step2(s: ProjectSeed): void {
  const gate = (id: string) => s.gates.find((g) => g.id === id);
  const config = (id: string) => s.configs.find((c) => c.id === id);
  const bump = (o: { version?: number; modifiedDaysAgo?: number } | undefined, base: number) => {
    if (!o) return;
    o.version = (o.version ?? base) + 1;
    o.modifiedDaysAgo = 1;
  };
  if (s.alias === 'web') {
    // Rollout widened: StatSig changed after migration → drift.
    const ncf = gate('new_checkout_flow');
    const pub = ncf?.rules.find((r) => r.name === 'Public 20%');
    if (pub) {
      pub.name = 'Public 50%';
      pub.passPercentage = 50;
    }
    bump(ncf, 3);
    if (ncf) ncf.checksPerHour = 12_000; // traffic shifting to LaunchDarkly
    // A config gains a new value → variation_change_affects_migrated_env.
    const ship = config('shipping_thresholds');
    ship?.rules.push({ name: 'Australia', conditions: [{ type: 'country', operator: 'any', targetValue: ['AU'] }], returnValue: { free_shipping_min: 90, currency: 'AUD' } });
    bump(ship, 5);
    // A gate's targeting grows.
    const dm = gate('dark_mode');
    const modern = dm?.rules[0]?.conditions[0];
    if (modern && Array.isArray(modern.targetValue)) modern.targetValue = [...(modern.targetValue as string[]), 'Safari'];
    bump(dm, 3);
    // A migrated gate is archived in StatSig → the LD flag should be retired, not synced.
    const lbb = gate('legacy_browser_banner');
    if (lbb) Object.assign(lbb, { status: 'Archived', isEnabled: false, archivedDaysAgo: 2, archiveReason: 'Safari 15 is below our support floor now' });
    // A gate is switched off → drift in the on/off state only.
    const bot = gate('bot_detection_challenge');
    if (bot) Object.assign(bot, { isEnabled: false, status: 'Disabled' });
    bump(bot, 3);
    // A new gate appears → "new in StatSig, not yet in LD".
    s.gates.push({
      id: 'checkout_gift_wrap',
      description: 'Gift-wrap option at checkout (added in snapshot 2).',
      owner: P.bob,
      tags: ['checkout'],
      createdDaysAgo: 3,
      modifiedDaysAgo: 1,
      version: 1,
      rules: [{ name: 'Staff', conditions: [{ type: 'email', operator: 'str_contains_any', targetValue: ['@acmeretail.example'] }] }],
    });
    // An experiment concludes.
    const exp = s.experiments.find((e) => e.id === 'search_ranking_v3');
    if (exp) {
      exp.status = 'decision_made';
      exp.launchedGroup = 'Model v3';
      exp.endedDaysAgo = 1;
      exp.decisionReason = 'Model v3 won on add-to-cart (+4.2%).';
    }
  }
  if (s.alias === 'mobile') {
    const exp = s.experiments.find((e) => e.id === 'onboarding_carousel');
    if (exp) exp.startedDaysAgo = (exp.startedDaysAgo ?? 12) + 7;
  }
}

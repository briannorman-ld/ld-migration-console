import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { mapAutotune, mapConfig, mapGate, mapNeutralExperiment, mapNeutralFlag, mapNeutralHoldout, mapNeutralLayer, mapNeutralMetric, mapNeutralMetricGroup, mapNeutralSegment, mapPrompt, mapSegment } from '../src/index.ts';
import { acmeSnapshot, CAPS, DIRECTORY, hogSnapshot, legacySnapshot, NOW, profileFor, server } from './fixtures.ts';

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

/**
 * Golden files (CLAUDE.md): canonical demo input + default profile + no resolutions → the desired
 * LD state and the decisions it raises, per environment. Review diffs in test/golden/ carefully:
 * a change there is a change in what lands in customers' LD projects.
 */
const MAPPING = { development: null, staging: 'test', production: 'production', qa: null };

function golden(snap: CanonicalSnapshot, statsig: string, ld: string) {
  const profile = profileFor(snap, MAPPING);
  // DIRECTORY: every Acme owner but Jordan Former is an LD member, so maintainers resolve except theirs (maintainer_unknown).
  const args = { canonical: { snapshot: snap }, profile, resolutions: new Map(), capabilities: CAPS, env: { statsig, ld }, now: NOW, directory: DIRECTORY };
  const gates = snap.gates.map((g) => {
    const r = mapGate({ ...args, entity: g });
    return {
      gate: g.id,
      flagKey: r.flagKey,
      name: r.shell.name,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      fidelity: r.fidelity.overall,
      notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}${n.location ? ` [${n.location}]` : ''}`),
      decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
      dependencies: r.dependencies.map((d) => `${d.kind}:${d.key}`),
      env: r.skipped ? undefined : r.env,
    };
  });
  const configs = snap.configs.map((c) => {
    const r = mapConfig({ ...args, entity: c });
    return {
      config: c.id,
      flagKey: r.flagKey,
      name: r.shell.name,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      fidelity: r.fidelity.overall,
      notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}${n.location ? ` [${n.location}]` : ''}`),
      decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
      dependencies: r.dependencies.map((d) => `${d.kind}:${d.key}`),
      variations: r.shell.variations,
      env: r.skipped ? undefined : r.env,
    };
  });
  const segments = snap.segments.map((s) => {
    const r = mapSegment({ ...args, entity: s });
    return {
      segment: s.id,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      fidelity: r.fidelity.overall,
      decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id})`),
      rules: r.desired?.rules,
      included: r.desired?.included.length,
      includedContexts: r.desired?.includedContexts.map((c) => `${c.contextKind}: ${c.values.length}`),
    };
  });
  const autotunes = snap.autotunes.map((a) => {
    const r = mapAutotune({ ...args, entity: a });
    return {
      autotune: a.id,
      state: r.state,
      flagKey: r.flagKey,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      fidelity: r.fidelity.overall,
      notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}`),
      decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
      dependencies: r.dependencies.map((d) => `${d.kind}:${d.key}`),
      variations: r.skipped ? undefined : r.shell.variations.map((v) => v.name),
      env: r.skipped ? undefined : r.env,
      metric: r.metric ? `${r.metric.key} (${r.metric.eventKey})` : null,
      bandit: r.bandit ? { treatments: r.bandit.treatments.map((t) => `${t.name}${t.baseline ? ' (baseline)' : ''} ${t.allocationPercent}%`), metricKey: r.bandit.metricKey, randomizationUnit: r.bandit.randomizationUnit } : null,
    };
  });
  // Project-level: the same for every environment, so only the production goldens carry them meaningfully.
  const prompts = (snap.prompts ?? []).map((p) => {
    const r = mapPrompt({ ...args, entity: p });
    return {
      prompt: p.id,
      key: r.key,
      ...(r.skipped ? { skipped: r.skipped } : {}),
      fidelity: r.fidelity.overall,
      notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}${n.location ? ` [${n.location}]` : ''}`),
      decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
      desired: r.desired,
    };
  });
  return { gates, configs, segments, autotunes, prompts };
}

/** Arrays of more than 20 strings become their first and last three plus a count, so a big list reads as a shape, not a dump. */
function compactLists<T>(v: T): T {
  if (Array.isArray(v)) {
    if (v.length > 20 && v.every((x) => typeof x === 'string')) return [...v.slice(0, 3), `… ${v.length - 6} more …`, ...v.slice(-3)] as unknown as T;
    return v.map(compactLists) as unknown as T;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, compactLists(x)])) as T;
  return v;
}

describe('mapper golden files', () => {
  it.each([
    ['web', 'staging', 'test'],
    ['web', 'production', 'production'],
    // acme-mobile: version operators, javascript / experiment_group conditions, deviceID lists.
    ['mobile', 'production', 'production'],
  ] as const)('acme-%s %s → LaunchDarkly %s', async (alias, statsig, ld) => {
    const snap = await acmeSnapshot(alias);
    await expect(JSON.stringify(golden(snap, statsig, ld), null, 2) + '\n').toMatchFileSnapshot(`golden/acme-${alias}.${statsig}.json`);
  });

  /**
   * The LD *source* project (PLAN §20): neutral flags and segments → desired LD state. Near-identity,
   * so a diff here usually means a copied field went missing or a new difference became a decision.
   */
  it.each([
    ['test', 'test'],
    ['production', 'production'],
  ] as const)('acme-legacy (LaunchDarkly source) %s → LaunchDarkly %s', async (source, ld) => {
    const snap = await legacySnapshot();
    const profile = profileFor(snap, { test: 'test', production: 'production' });
    const args = { canonical: { snapshot: snap }, profile, resolutions: new Map(), capabilities: { ...CAPS, existingContextKinds: ['user', 'organization'] }, env: { statsig: source, ld }, now: NOW, directory: DIRECTORY };
    const flags = snap.neutral!.flags.map((f) => {
      const r = mapNeutralFlag({ ...args, entity: f });
      return {
        flag: f.key,
        flagKind: r.flagKind,
        ...(r.skipped ? { skipped: r.skipped } : {}),
        fidelity: r.fidelity.overall,
        notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}${n.location ? ` [${n.location}]` : ''}`),
        decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
        dependencies: r.dependencies.map((d) => `${d.kind}:${d.key}`),
        shell: r.skipped ? undefined : { tags: r.shell.tags, variations: r.shell.variations, customProperties: Object.keys(r.shell.customProperties).sort(), clientSideAvailability: r.shell.clientSideAvailability, temporary: r.shell.temporary },
        env: r.skipped ? undefined : r.env,
      };
    });
    const segments = snap.neutral!.segments.map((g) => {
      const r = mapNeutralSegment({ ...args, entity: g });
      return {
        segment: g.key,
        ...(r.skipped ? { skipped: r.skipped } : {}),
        fidelity: r.fidelity.overall,
        decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id})`),
        desired: r.desired,
      };
    });
    // Experimentation (PLAN §20.5): project-level metrics, metric groups and layers once; experiments and holdouts per environment.
    const summarize = (r: { skipped?: string; fidelity: { overall: string; notes: { fidelity: string; message: string; location?: string }[] }; unresolved: { severity: string; type: string; subject: { location?: string; id: string }; recommended?: string }[]; dependencies: { kind: string; key: string }[]; desired: unknown }) => ({
      ...(r.skipped ? { skipped: r.skipped } : {}),
      fidelity: r.fidelity.overall,
      notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}${n.location ? ` [${n.location}]` : ''}`),
      decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
      dependencies: r.dependencies.map((d) => `${d.kind}:${d.key}`),
      desired: r.desired,
    });
    const projectArgs = { ...args, env: { statsig: '', ld: '' } };
    const metrics = (snap.neutral!.metrics ?? []).map((m) => ({ metric: m.key, ...summarize(mapNeutralMetric({ ...projectArgs, entity: m })) }));
    const metricGroups = (snap.neutral!.metricGroups ?? []).map((g) => ({ metricGroup: g.key, ...summarize(mapNeutralMetricGroup({ ...projectArgs, entity: g })) }));
    const layers = (snap.neutral!.layers ?? []).map((l) => ({ layer: l.key, ...summarize(mapNeutralLayer({ ...projectArgs, entity: l })) }));
    const experiments = (snap.neutral!.experiments ?? []).map((x) => ({ experiment: x.key, ...summarize(mapNeutralExperiment({ ...args, entity: x })) }));
    const holdouts = (snap.neutral!.holdouts ?? []).map((h) => ({ holdout: h.key, ...summarize(mapNeutralHoldout({ ...args, entity: h })) }));
    await expect(JSON.stringify({ flags, segments, metrics, metricGroups, layers, experiments, holdouts }, null, 2) + '\n').toMatchFileSnapshot(`golden/acme-legacy.${source}.json`);
  });

  /**
   * The PostHog *source* project (PLAN §22): one environment, every construct of §22.3. A diff here
   * is a change in what a PostHog customer's flags become.
   */
  it('acme-hog (PostHog source) → LaunchDarkly production', async () => {
    const snap = await hogSnapshot();
    const profile = profileFor(snap, { 'Acme Hog': 'production' });
    const args = { canonical: { snapshot: snap }, profile, resolutions: new Map(), capabilities: { ...CAPS, existingContextKinds: ['user'] }, env: { statsig: 'Acme Hog', ld: 'production' }, now: NOW, directory: DIRECTORY };
    const flags = snap.neutral!.flags.map((f) => {
      const r = mapNeutralFlag({ ...args, entity: f });
      return {
        flag: f.key,
        flagKind: r.flagKind,
        ...(r.skipped ? { skipped: r.skipped } : {}),
        fidelity: r.fidelity.overall,
        notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}${n.location ? ` [${n.location}]` : ''}`),
        decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id}) → ${d.recommended ?? 'no default'}`),
        dependencies: r.dependencies.map((d) => `${d.kind}:${d.key}`),
        shell: r.skipped ? undefined : { name: r.shell.name, description: r.shell.description, tags: r.shell.tags, variations: r.shell.variations, customProperties: Object.keys(r.shell.customProperties).sort(), clientSideAvailability: r.shell.clientSideAvailability },
        env: r.skipped ? undefined : r.env,
      };
    });
    const segments = snap.neutral!.segments.map((g) => {
      const r = mapNeutralSegment({ ...args, entity: g });
      return {
        segment: g.key,
        ...(r.skipped ? { skipped: r.skipped } : {}),
        fidelity: r.fidelity.overall,
        notes: r.fidelity.notes.map((n) => `${n.fidelity}: ${n.message}`),
        decisions: r.unresolved.map((d) => `${d.severity} ${d.type} (${d.subject.location ?? d.subject.id})`),
        // The newsletter cohort's 15,500 ids would be most of the file: long key lists are summarised.
        desired: compactLists(r.desired),
      };
    });
    await expect(JSON.stringify({ flags, segments }, null, 2) + '\n').toMatchFileSnapshot('golden/acme-hog.production.json');
  });
});

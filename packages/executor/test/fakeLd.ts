import { LdWriteError, type LdAiConfig, type LdExperiment, type LdFlag, type LdMetric } from '@sslm/ld-client';
import type { LdWriter } from '../src/index.ts';

/** Minimal in-memory LD, shared by the executor tests: enough state for the executor's control flow, not LD's semantics. */
export function fakeLd(over: Partial<Record<keyof LdWriter, (...a: never[]) => unknown>> = {}) {
  const flags = new Map<string, LdFlag>();
  const metrics = new Map<string, LdMetric>();
  const experiments = new Map<string, LdExperiment & { iteration?: unknown }>();
  const aiConfigs = new Map<string, LdAiConfig>();
  const units: string[] = ['user'];
  const calls: string[] = [];
  const approvals = new Map<string, { status: string; reviewStatus: string; executionDate?: number }>();
  const scheduled = new Map<string, { executionDate: number; instructions: unknown[] }>();
  const imports: { key: string; env: string; keys: string[]; mode: string }[] = [];
  let nextId = 1;
  const flag = (key: string, body: Record<string, unknown> = {}): LdFlag => ({
    key,
    name: key,
    tags: (body.tags as string[]) ?? [],
    customProperties: (body.customProperties as LdFlag['customProperties']) ?? {},
    // The variations the create asked for (a multivariate flag keeps its values, null and "" included), else a boolean flag.
    variations: Array.isArray(body.variations) && body.variations.length ? (body.variations as { value: unknown; name?: string }[]).map((v, i) => ({ _id: v.value === true ? `${key}-t` : v.value === false ? `${key}-f` : `${key}-${i}`, value: v.value, ...(v.name ? { name: v.name } : {}) })) : [
      { _id: `${key}-t`, value: true },
      { _id: `${key}-f`, value: false },
    ],
    environments: { test: { on: false, offVariation: 1, fallthrough: { variation: 1 }, rules: [], targets: [] } },
  });
  const base: LdWriter = {
    getFlag: async (_p, key) => (calls.push(`get ${key}`), flags.get(key) ?? null),
    createFlag: async (_p, body) => {
      calls.push(`create ${body.key}`);
      if (flags.has(body.key as string)) throw new LdWriteError(409, '/flags', { message: 'Duplicate flag key' });
      const f = flag(body.key as string, body);
      flags.set(f.key, f);
      return f;
    },
    patchFlagSemantic: async (_p, key, patch) => (calls.push(`semantic ${key} ${patch.environmentKey ?? ''}`), flags.get(key)!),
    patchFlagJson: async (_p, key, ops) => (calls.push(`json ${key} ${ops.map((o) => o.path).join(',')}`), flags.get(key)!),
    deleteFlag: async (_p, key) => void (calls.push(`delete ${key}`), flags.delete(key)),
    getSegment: async () => null,
    createSegment: async (_p, _e, b) => ({ key: b.key, name: b.name, tags: b.tags }),
    patchSegmentJson: async (_p, _e, key) => ({ key, name: key }),
    patchSegmentSemantic: async (_p, _e, key, patch) => (calls.push(`semantic segment ${key} ${patch.instructions.map((i) => `${i.kind}:${Array.isArray(i.values) ? i.values.length : ''}`).join(',')}`), { key, name: key }),
    deleteSegment: async () => undefined,
    putContextKind: async () => undefined,
    listContextKinds: async () => ({ items: [] }),
    getAiConfig: async (_p, key) => (calls.push(`get ai ${key}`), aiConfigs.get(key) ?? null),
    createAiConfig: async (_p, body) => {
      calls.push(`create ai ${body.key}`);
      if (aiConfigs.has(body.key)) throw new LdWriteError(409, '/ai-configs', { message: 'Duplicate key' });
      const a = { key: body.key, name: body.name, description: body.description ?? '', tags: body.tags ?? [], ...(body.maintainerId ? { _maintainer: { kind: 'member', member: { _id: body.maintainerId } } } : {}) };
      aiConfigs.set(a.key, a);
      return a;
    },
    patchAiConfig: async (_p, key, body) => (calls.push(`patch ai ${key} ${Object.keys(body).join(',')}`), { ...aiConfigs.get(key)!, ...body }),
    deleteAiConfig: async (_p, key) => void (calls.push(`delete ai ${key}`), aiConfigs.delete(key)),
    getMetric: async (_p, key) => (calls.push(`get metric ${key}`), metrics.get(key) ?? null),
    createMetric: async (_p, body) => {
      calls.push(`create metric ${body.key}`);
      if (metrics.has(body.key as string)) throw new LdWriteError(409, '/metrics', { message: 'Duplicate key' });
      const m = { key: body.key as string, name: body.name as string, kind: 'custom', eventKey: body.eventKey as string, tags: (body.tags as string[]) ?? [] };
      metrics.set(m.key, m);
      return m;
    },
    patchMetricJson: async (_p, key, ops) => (calls.push(`json metric ${key} ${ops.map((o) => o.path).join(',')}`), metrics.get(key)!),
    deleteMetric: async (_p, key) => void (calls.push(`delete metric ${key}`), metrics.delete(key)),
    getExperiment: async (_p, env, key) => (calls.push(`get experiment ${env}/${key}`), experiments.get(`${env}/${key}`) ?? null),
    createExperiment: async (_p, env, body) => {
      calls.push(`create experiment ${env}/${body.key}`);
      if (experiments.has(`${env}/${body.key}`)) throw new LdWriteError(409, '/experiments', { message: 'Duplicate key' });
      const e = { key: body.key as string, name: body.name as string, type: body.type as string, tags: (body.tags as string[]) ?? [], draftIteration: { status: 'not_started', hypothesis: '' }, iteration: body.iteration };
      experiments.set(`${env}/${e.key}`, e);
      return e;
    },
    createIteration: async (_p, env, key, body) => (calls.push(`iteration ${env}/${key}`), { ...experiments.get(`${env}/${key}`)!, iteration: body }),
    patchExperimentSemantic: async (_p, env, key, patch) => (calls.push(`semantic experiment ${env}/${key} ${patch.instructions.map((i) => i.kind).join(',')}`), experiments.get(`${env}/${key}`)!),
    getExperimentationSettings: async () => (calls.push('get settings'), { randomizationUnits: units.map((u) => ({ randomizationUnit: u })) }),
    putExperimentationSettings: async (_p, body) => {
      calls.push(`put settings ${body.randomizationUnits.map((u) => u.randomizationUnit).join(',')}`);
      units.splice(0, units.length, ...body.randomizationUnits.map((u) => u.randomizationUnit));
      return { randomizationUnits: body.randomizationUnits };
    },
    createSegmentImport: async (_p, env, key, keys, opts) => void (calls.push(`import ${env}/${key} ${keys.length} ${opts.mode}`), imports.push({ key, env, keys, mode: opts.mode })),
    getSegmentMembership: async (_p, env, key, contextKey) => ({ included: imports.some((i) => i.env === env && i.key === key && i.keys.includes(contextKey)), excluded: false }),
    createFlagApprovalRequest: async (_p, key, env, body) => {
      const id = `ar-${nextId++}`;
      calls.push(`approval ${env}/${key} ${body.executionDate ? 'scheduled' : 'now'} ${body.instructions.map((i) => i.kind).join(',')}`);
      approvals.set(id, { status: 'pending', reviewStatus: 'pending', ...(body.executionDate ? { executionDate: body.executionDate } : {}) });
      return { _id: id, status: 'pending', reviewStatus: 'pending' };
    },
    getFlagApprovalRequest: async (_p, _k, _e, id) => (calls.push(`get approval ${id}`), approvals.has(id) ? { _id: id, ...approvals.get(id)! } : null),
    deleteFlagApprovalRequest: async (_p, _k, _e, id) => void (calls.push(`delete approval ${id}`), approvals.delete(id)),
    createApprovalRequest: async (body) => {
      const id = `ar-${nextId++}`;
      calls.push(`approval ${body.resourceId} ${body.instructions.map((i) => i.kind).join(',')}`);
      approvals.set(id, { status: 'pending', reviewStatus: 'pending' });
      return { _id: id, status: 'pending', reviewStatus: 'pending' };
    },
    getApprovalRequest: async (id) => (calls.push(`get approval ${id}`), approvals.has(id) ? { _id: id, ...approvals.get(id)! } : null),
    deleteApprovalRequest: async (id) => void (calls.push(`delete approval ${id}`), approvals.delete(id)),
    listScheduledChanges: async () => [...scheduled.entries()].map(([id, v]) => ({ _id: id, ...v })),
    createScheduledChange: async (_p, key, env, body) => {
      const id = `sc-${nextId++}`;
      calls.push(`schedule ${env}/${key} ${new Date(body.executionDate).toISOString()}`);
      scheduled.set(id, { executionDate: body.executionDate, instructions: body.instructions });
      return { _id: id, executionDate: body.executionDate, instructions: body.instructions };
    },
    deleteScheduledChange: async (_p, _k, _e, id) => {
      calls.push(`unschedule ${id}`);
      if (!scheduled.delete(id)) throw new LdWriteError(404, '/scheduled-changes', null);
    },
  };
  return { client: { ...base, ...over } as LdWriter, flags, metrics, experiments, aiConfigs, units, calls, flag, approvals, scheduled, imports };
}

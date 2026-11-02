import { describe, expect, it } from 'vitest';
import { buildAcmeRetailFile } from '../src/files.ts';
import { paginated, single } from '../src/console/envelopes.ts';
import { expandIdList } from '../src/console/builders.ts';
import { StatsigOpenApiValidator } from './openapi-validator.ts';

const file = buildAcmeRetailFile();
const validator = new StatsigOpenApiValidator();
const list = (path: string, items: unknown[]) => paginated(items, { path, page: 1, limit: 100 });

/** Every payload the mock serves, with the OpenAPI path it must conform to. */
function cases() {
  const out: [string, string, unknown][] = [];
  for (const [alias, snaps] of Object.entries(file.projects)) {
    for (const d of snaps) {
      const tag = `${alias}#${d.snapshot}`;
      out.push(
        [tag, '/console/v1/project', single(d.project)],
        [tag, '/console/v1/company', single(d.company)],
        [tag, '/console/v1/environments', single({ environments: d.environments })],
        [tag, '/console/v1/gates', list('/console/v1/gates', d.gates)],
        [tag, '/console/v1/dynamic_configs', list('/console/v1/dynamic_configs', d.dynamicConfigs)],
        [tag, '/console/v1/segments', list('/console/v1/segments', d.segments)],
        [tag, '/console/v1/experiments', list('/console/v1/experiments', d.experiments)],
        [tag, '/console/v1/layers', list('/console/v1/layers', d.layers)],
        [tag, '/console/v1/holdouts', list('/console/v1/holdouts', d.holdouts)],
        [tag, '/console/v1/autotunes', list('/console/v1/autotunes', d.autotunes)],
        [tag, '/console/v1/unit_id_types', list('/console/v1/unit_id_types', d.unitIdTypes)],
        [tag, '/console/v1/tags', list('/console/v1/tags', d.tags)],
        [tag, '/console/v1/target_app', list('/console/v1/target_app', d.targetApps)],
        [tag, '/console/v1/metrics/list', list('/console/v1/metrics/list', d.metrics)],
        [tag, '/console/v1/metrics/metric_source/list', list('/console/v1/metrics/metric_source/list', d.metricSources)],
        [tag, '/console/v1/param_stores', list('/console/v1/param_stores', d.paramStores)],
        [tag, '/console/v1/users', list('/console/v1/users', d.users)],
        [tag, '/console/v1/users/teams', list('/console/v1/users/teams', d.teams.map(({ members: _m, admins: _a, ...t }) => t))],
        [tag, '/console/v1/prompts', list('/console/v1/prompts', d.prompts)],
        [tag, '/console/v1/alerts', list('/console/v1/alerts', d.alerts)],
        [tag, '/console/v1/settings/reviews', single(d.reviewSettings)],
        [tag, '/console/v1/settings/project', single(d.projectSettings)],
        [tag, '/console/v1/overrides', single(d.overrides)],
      );
      for (const t of d.teams) out.push([tag, '/console/v1/users/teams/{id}', single(t)]);
      for (const p of d.prompts) out.push([tag, '/console/v1/prompts/{id}', single(p)]);
      for (const g of d.gates) out.push([tag, '/console/v1/gates/{id}', single(g)]);
      for (const c of d.dynamicConfigs) out.push([tag, '/console/v1/dynamic_configs/{id}', single(c)]);
      for (const [id, seed] of Object.entries(d.idLists)) {
        const ids = expandIdList(seed).slice(0, 100);
        // The spec's allOf requires `data` to be both an array (pagination envelope) and an object
        // (the ID list), which nothing can satisfy; validate the ID-list object on its own.
        out.push([tag, '#idlist', { name: id, count: seed.count, ids }]);
      }
    }
  }
  return out;
}

describe('demo dataset matches the real StatSig Console API OpenAPI shapes', () => {
  it.each(cases())('%s %s', (_tag, path, body) => {
    if (path === '#idlist') {
      expect(validator.validateComponent('/console/v1/segments/{id}/id_list', 1, body)).toEqual([]);
      return;
    }
    expect(validator.validate(path, body)).toEqual([]);
  });

  it('the id_list response schema in the published spec is self-contradictory', () => {
    const body = { message: 'ok', data: { name: 'x', count: 1, ids: ['a'] }, pagination: { itemsPerPage: 100, pageNumber: 1, nextPage: null, previousPage: null } };
    expect(validator.validate('/console/v1/segments/{id}/id_list', body)).toContain('/data must be array');
  });

  it('catches a wrong shape (validator sanity check)', () => {
    const g = structuredClone(file.projects.web[0]!.gates[0]!) as Record<string, unknown>;
    delete g.permalink;
    g.status = 'Shipped';
    const errors = validator.validate('/console/v1/gates/{id}', single(g));
    expect(errors.join('\n')).toMatch(/permalink/);
    expect(errors.join('\n')).toMatch(/allowed|enum/i);
  });
});

/**
 * Seeds a real PostHog Cloud project of OUR OWN with the "Acme Hog" demo fixture (PLAN §22.5), so
 * the P0 spike can run against known data and the fixture's assumed shapes can be diffed against
 * real responses. A developer tool, not part of the console: the console never writes to a source.
 *
 *   pnpm seed:posthog                       # production fixture ("Acme Hog")
 *   pnpm seed:posthog -- --project=staging  # "Acme Hog Staging"
 *   pnpm seed:posthog -- --dry-run          # print the writes, send nothing
 *   pnpm seed:posthog -- --skip-events      # cohorts, flags and the rest; no capture events
 *   pnpm seed:posthog -- --only=flags,scheduled_changes
 *
 * Reads from .env.local (never committed; the key is never printed):
 *   POSTHOG_SEED_KEY           personal API key (phx_…) with write scopes: feature_flag:write,
 *                              cohort:write, scheduled_change:write, early_access_feature:write,
 *                              experiment:write, survey:write, plus project:read, person:read
 *   POSTHOG_SEED_PROJECT_ID    the project (team) id to seed
 *   POSTHOG_SEED_HOST          https://us.posthog.com (default) or https://eu.posthog.com
 *   POSTHOG_SEED_CAPTURE_HOST  defaults to the ingestion host of POSTHOG_SEED_HOST (us.i / eu.i)
 *   POSTHOG_SEED_ALLOW_PROJECT the project id, to seed a project whose name lacks "Acme Hog"
 *
 * Idempotent: cohorts, early-access features, experiments and surveys are matched by name, flags
 * by key, scheduled changes by (flag, operation, time); matches are updated, not duplicated. The
 * fixture id → real id map is written to .posthog-seed.<project id>.json (gitignored).
 *
 * What a real project cannot take from the fixture, and what to check in the P0 spike:
 * - Persons and their properties come from capture events ($identify with $set, $create_alias
 *   for a second distinct id); property definitions and their types are inferred by PostHog.
 * - Group types come from $groupidentify events; group analytics is a paid add-on on PostHog
 *   Cloud, so without it the group-targeted flags are created with no group type behind them.
 * - Static cohorts are created with a CSV of distinct ids (one per line, no header), the way the
 *   UI does; whether PostHog matches ids that were ingested seconds ago is a spike item, and the
 *   script waits for the last seeded person to be queryable first.
 * - The behavioral cohort needs its $pageview events ingested and the cohort recalculated;
 *   the analytical cohort is a HogQL query PostHog computes on its own schedule.
 * - The survey creates its own `survey-targeting-<id>` flag, so the fixture's flag 1013 is not
 *   posted; the early-access feature adds `super_groups` to its flag, so flag 1010 is posted
 *   without them.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACME_HOG_NEWSLETTER_COHORT_ID, acmeHogProject, acmeHogStagingProject, type JsonObject, type PostHogProjectFixture } from '../src/index.ts';

type Json = JsonObject[string];

// ---------------------------------------------------------------------------------------------
// Arguments and environment
// ---------------------------------------------------------------------------------------------

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (!m) throw new Error(`Unknown argument ${a}`);
  args.set(m[1]!, m[2] ?? 'true');
}
const DRY = args.get('dry-run') === 'true';
const SKIP_EVENTS = args.get('skip-events') === 'true';
const ONLY = new Set((args.get('only') ?? 'events,cohorts,flags,scheduled_changes,early_access,experiments,surveys').split(','));
const WHICH = args.get('project') ?? 'production';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
function loadEnvLocal(): Record<string, string> {
  const path = join(root, '.env.local');
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = { ...loadEnvLocal(), ...process.env };
const KEY = env.POSTHOG_SEED_KEY ?? '';
const PROJECT_ID = env.POSTHOG_SEED_PROJECT_ID ?? '';
const HOST = (env.POSTHOG_SEED_HOST ?? 'https://us.posthog.com').replace(/\/+$/, '');
const CAPTURE_HOST = (env.POSTHOG_SEED_CAPTURE_HOST ?? HOST.replace('://us.posthog.com', '://us.i.posthog.com').replace('://eu.posthog.com', '://eu.i.posthog.com')).replace(/\/+$/, '');
if (!KEY || !PROJECT_ID) {
  console.error('POSTHOG_SEED_KEY and POSTHOG_SEED_PROJECT_ID are required (in .env.local or the environment).');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// HTTP: paced to PostHog's documented 480 requests/minute, 429s retried with Retry-After
// ---------------------------------------------------------------------------------------------

let lastRequestAt = 0;
const MIN_GAP_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = JsonObject>(method: string, path: string, body?: unknown, opts: { form?: FormData; okStatuses?: number[] } = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${HOST}${path}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const headers: Record<string, string> = { authorization: `Bearer ${KEY}` };
    let payload: BodyInit | undefined;
    if (opts.form) payload = opts.form;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0');
      const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt);
      console.warn(`  ${res.status} on ${method} ${path}; retrying in ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      continue;
    }
    if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 600)}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  throw new Error(`${method} ${path}: gave up after repeated 429/5xx`);
}

interface Page<T> {
  next: string | null;
  results: T[];
}
async function listAll<T = JsonObject>(path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = `${path}${path.includes('?') ? '&' : '?'}limit=100`;
  while (next) {
    const page: Page<T> = await api<Page<T>>('GET', next);
    out.push(...page.results);
    next = page.next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The fixture, and the id map we build while writing it
// ---------------------------------------------------------------------------------------------

const fixture: PostHogProjectFixture = WHICH === 'staging' ? acmeHogStagingProject() : acmeHogProject();
const fixtureName = String(fixture.project.name);
const P = `/api/projects/${PROJECT_ID}`;
const mapPath = join(root, `.posthog-seed.${PROJECT_ID}.json`);
interface IdMap {
  cohorts: Record<string, number>;
  flags: Record<string, number>;
  scheduledChanges: Record<string, number>;
  earlyAccess: Record<string, string>;
  experiments: Record<string, number>;
  holdouts: Record<string, number>;
  surveys: Record<string, string>;
}
const ids: IdMap = existsSync(mapPath) ? (JSON.parse(readFileSync(mapPath, 'utf8')) as IdMap) : { cohorts: {}, flags: {}, scheduledChanges: {}, earlyAccess: {}, experiments: {}, holdouts: {}, surveys: {} };
const saveIds = () => writeFileSync(mapPath, JSON.stringify(ids, null, 2) + '\n');

const summary: string[] = [];
const note = (s: string) => {
  console.log(s);
  summary.push(s);
};
const obj = (v: Json | undefined): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);

/** Fixture cohort ids and flag ids inside a `filters` document → the real ones. */
function remapFilters(filters: JsonObject): JsonObject {
  const remapProps = (props: Json[]): Json[] =>
    props.map((p) => {
      const f = obj(p);
      if (f.type === 'cohort') {
        const real = ids.cohorts[String(f.value)];
        if (real === undefined) throw new Error(`cohort ${String(f.value)} has not been created yet`);
        return { ...f, value: real };
      }
      if (f.type === 'flag') {
        const real = ids.flags[String(f.key)];
        if (real === undefined) throw new Error(`flag ${String(f.key)} has not been created yet`);
        const { dependency_chain: _dropped, ...rest } = f;
        return { ...rest, key: String(real) };
      }
      return f;
    });
  const remapGroups = (groups: Json[]): Json[] => groups.map((g) => ({ ...obj(g), properties: remapProps(arr(obj(g).properties)) }));
  const out: JsonObject = { ...filters, groups: remapGroups(arr(filters.groups)) };
  if (filters.super_groups !== undefined) out.super_groups = remapGroups(arr(filters.super_groups));
  return out;
}

/** Fixture cohort ids inside a cohort's property tree → the real ones. */
function remapPropertyGroup(group: JsonObject): JsonObject {
  return {
    ...group,
    values: arr(group.values).map((v) => {
      const o = obj(v);
      if (Array.isArray(o.values)) return remapPropertyGroup(o);
      if (o.type === 'cohort') {
        const real = ids.cohorts[String(o.value)];
        if (real === undefined) throw new Error(`cohort ${String(o.value)} has not been created yet`);
        return { ...o, value: real };
      }
      return o;
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

async function checkProject(): Promise<{ name: string; token: string }> {
  const project = await api(`GET`, `${P}/`);
  const name = String(project.name ?? '');
  const token = String(project.api_token ?? '');
  if (!name.includes('Acme Hog') && env.POSTHOG_SEED_ALLOW_PROJECT !== PROJECT_ID) {
    throw new Error(`Project ${PROJECT_ID} is named “${name}”, not an Acme Hog project. Seeding writes dozens of flags and 15,500 persons; set POSTHOG_SEED_ALLOW_PROJECT=${PROJECT_ID} if that is what you want.`);
  }
  note(`Project ${PROJECT_ID} “${name}” on ${HOST}; seeding the “${fixtureName}” fixture${DRY ? ' (dry run)' : ''}.`);
  return { name, token };
}

/** Persons, aliases, groups and the behavioral cohort's pageviews, through the capture batch endpoint. */
async function seedEvents(token: string): Promise<void> {
  const now = new Date().toISOString();
  const events: JsonObject[] = [];
  for (const p of fixture.persons) {
    const distinctIds = arr(p.distinct_ids).map(String);
    const first = distinctIds[0]!;
    events.push({ event: '$identify', distinct_id: first, timestamp: now, properties: { $set: { ...obj(p.properties) } } });
    for (const alias of distinctIds.slice(1)) events.push({ event: '$create_alias', distinct_id: first, timestamp: now, properties: { alias } });
  }
  // Companies and workspaces the group-targeted flags talk about.
  const groups: { type: string; key: string; set: JsonObject }[] = [
    { type: 'company', key: 'acme-corp', set: { tier: 'platinum', mrr: 12_000 } },
    { type: 'company', key: 'globex', set: { tier: 'gold', mrr: 4_000 } },
    { type: 'company', key: 'initech', set: { tier: 'silver', mrr: 900 } },
    { type: 'workspace', key: 'ws-acme-hq', set: { seats_purchased: 25 } },
    { type: 'workspace', key: 'ws-globex', set: { seats_purchased: 8 } },
  ];
  for (const g of groups) events.push({ event: '$groupidentify', distinct_id: 'seed-bot', timestamp: now, properties: { $group_type: g.type, $group_key: g.key, $group_set: g.set } });
  // Cohort 304 "Power users": five or more pageviews in 30 days, for its two fixture members.
  for (const id of fixture.cohortMembers['304'] ?? []) {
    const person = fixture.persons.find((x) => String(x.id) === id);
    const distinctId = person ? String(arr(person.distinct_ids)[0]) : undefined;
    if (!distinctId) continue;
    for (let i = 0; i < 6; i++) events.push({ event: '$pageview', distinct_id: distinctId, timestamp: new Date(Date.now() - i * 86_400_000).toISOString(), properties: { $current_url: 'https://acmeretail.example/' } });
  }
  note(`Events: ${events.length} ($identify ${fixture.persons.length}, aliases, ${groups.length} $groupidentify, pageviews).`);
  if (DRY) return;
  const BATCH = 500;
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    const res = await fetch(`${CAPTURE_HOST}/batch/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: token, batch }) });
    if (!res.ok) throw new Error(`capture batch ${i / BATCH + 1} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.stdout.write(`  sent ${Math.min(i + BATCH, events.length)}/${events.length}\r`);
  }
  console.log('');
  // Ingestion is asynchronous: wait until the last newsletter subscriber is queryable before the static cohorts reference them.
  const last = fixture.persons.at(-1);
  const probe = last ? String(arr(last.distinct_ids)[0]) : undefined;
  if (!probe) return;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const page = await api<Page<JsonObject>>('GET', `${P}/persons/?distinct_id=${encodeURIComponent(probe)}`);
    if (page.results.length) {
      note(`Persons ingested (“${probe}” is queryable).`);
      return;
    }
    process.stdout.write('  waiting for ingestion…\r');
    await sleep(10_000);
  }
  console.warn(`  “${probe}” is still not queryable after 10 minutes; static cohorts may come out with unmatched ids. Re-run with --only=cohorts later.`);
}

async function seedCohorts(): Promise<void> {
  const existing = await listAll(`${P}/cohorts/`);
  const byName = new Map(existing.filter((c) => c.deleted !== true).map((c) => [String(c.name), c]));
  // Nested cohorts after the ones they reference.
  const pending = fixture.cohorts.filter((c) => c.deleted !== true);
  const done = new Set<string>();
  const refs = (c: JsonObject): string[] => {
    const out: string[] = [];
    const walk = (v: Json | undefined) => {
      if (Array.isArray(v)) return v.forEach(walk);
      const o = obj(v);
      if (o.type === 'cohort') out.push(String(o.value));
      for (const x of Object.values(o)) if (x && typeof x === 'object') walk(x);
    };
    walk(obj(c.filters).properties);
    return out;
  };
  while (done.size < pending.length) {
    const ready = pending.filter((c) => !done.has(String(c.id)) && refs(c).every((r) => ids.cohorts[r] !== undefined));
    if (!ready.length) throw new Error('cohort references form a cycle');
    for (const c of ready) {
      const fixtureId = String(c.id);
      const name = String(c.name);
      const members = fixture.cohortMembers[fixtureId] ?? [];
      const isStatic = c.is_static === true;
      const current = byName.get(name);
      if (current) {
        ids.cohorts[fixtureId] = Number(current.id);
        note(`Cohort “${name}” exists as ${current.id}; kept.`);
        done.add(fixtureId);
        continue;
      }
      if (isStatic) {
        const distinctIds = members.flatMap((pid) => arr(fixture.persons.find((x) => String(x.id) === pid)?.distinct_ids).map(String));
        note(`Cohort “${name}”: static, ${distinctIds.length} distinct ids by CSV.`);
        if (!DRY) {
          const form = new FormData();
          form.set('name', name);
          form.set('description', String(c.description ?? ''));
          form.set('is_static', 'true');
          form.set('csv', new Blob([distinctIds.join('\n') + '\n'], { type: 'text/csv' }), `${fixtureId}.csv`);
          const created = await api('POST', `${P}/cohorts/`, undefined, { form });
          ids.cohorts[fixtureId] = Number(created.id);
        }
      } else {
        const body: JsonObject = { name, description: String(c.description ?? ''), is_static: false };
        const filters = obj(c.filters);
        if (filters.properties) body.filters = { ...filters, properties: remapPropertyGroup(obj(filters.properties)) };
        if (c.query) body.query = c.query;
        note(`Cohort “${name}”: ${String(c.cohort_type)}${filters.filterTestAccounts ? ', test accounts filtered' : ''}.`);
        if (!DRY) {
          const created = await api('POST', `${P}/cohorts/`, body);
          ids.cohorts[fixtureId] = Number(created.id);
        }
      }
      if (DRY) ids.cohorts[fixtureId] = -Number(fixtureId);
      done.add(fixtureId);
      saveIds();
    }
  }
}

/** The flag's writable fields, with ids remapped. */
function flagBody(f: JsonObject): JsonObject {
  const filters = remapFilters(obj(f.filters));
  // The early-access feature (seedEarlyAccess) adds super_groups itself.
  if (arr(f.features).length) delete filters.super_groups;
  const body: JsonObject = {
    key: f.key!,
    name: f.name ?? '',
    filters,
    active: f.active ?? true,
    tags: arr(f.tags),
    ensure_experience_continuity: f.ensure_experience_continuity ?? false,
    is_remote_configuration: f.is_remote_configuration ?? false,
    has_encrypted_payloads: f.has_encrypted_payloads ?? false,
    evaluation_runtime: f.evaluation_runtime ?? 'all',
    bucketing_identifier: f.bucketing_identifier ?? 'distinct_id',
    creation_context: f.creation_context ?? 'feature_flags',
  };
  if (Array.isArray(f.evaluation_contexts)) body.evaluation_contexts = f.evaluation_contexts;
  return body;
}

async function seedFlags(): Promise<void> {
  const existing = await listAll(`${P}/feature_flags/?deleted=false`);
  const byKey = new Map(existing.map((f) => [String(f.key), f]));
  // Parents before dependants; the survey's flag is created by the survey.
  const wanted = fixture.flags.filter((f) => !arr(f.surveys).length && !Object.keys(obj(f.surveys)).length);
  const parentIds = (f: JsonObject): string[] => arr(obj(f.filters).groups).flatMap((g) => arr(obj(g).properties).filter((p) => obj(p).type === 'flag').map((p) => String(obj(p).key)));
  const done = new Set<string>();
  while (done.size < wanted.length) {
    const ready = wanted.filter((f) => !done.has(String(f.id)) && parentIds(f).every((pid) => ids.flags[pid] !== undefined));
    if (!ready.length) throw new Error('flag dependencies form a cycle or reference a flag outside the fixture');
    for (const f of ready) {
      const fixtureId = String(f.id);
      const key = String(f.key);
      const body = flagBody(f);
      const current = byKey.get(key);
      const flagsOf = (x: JsonObject) => [x.archived === true ? 'archived' : '', x.deleted === true ? 'deleted' : '', x.active === false ? 'off' : ''].filter(Boolean).join(', ');
      note(`Flag “${key}”: ${current ? `update ${current.id}` : 'create'}${flagsOf(f) ? ` (${flagsOf(f)})` : ''}.`);
      if (DRY) {
        ids.flags[fixtureId] = current ? Number(current.id) : -Number(fixtureId);
        done.add(fixtureId);
        continue;
      }
      let real: number;
      if (current) {
        real = Number(current.id);
        await api('PATCH', `${P}/feature_flags/${real}/`, { ...body, archived: false, deleted: false });
      } else {
        const created = await api('POST', `${P}/feature_flags/`, body);
        real = Number(created.id);
      }
      ids.flags[fixtureId] = real;
      // Archived and soft-deleted flags are created live first, then flipped, as a user would have done.
      if (f.archived === true) await api('PATCH', `${P}/feature_flags/${real}/`, { archived: true });
      if (f.deleted === true && !ids.flags[`deleted:${fixtureId}`]) {
        // A dependant may still need this id (hog-orphan-dependency): delete after the dependants exist.
        ids.flags[`deleted:${fixtureId}`] = real;
      }
      done.add(fixtureId);
      saveIds();
    }
  }
  if (DRY) return;
  for (const [k, real] of Object.entries(ids.flags)) {
    if (!k.startsWith('deleted:')) continue;
    await api('PATCH', `${P}/feature_flags/${real}/`, { deleted: true });
    note(`Flag ${real} soft-deleted (fixture ${k.slice('deleted:'.length)}).`);
  }
}

async function seedScheduledChanges(): Promise<void> {
  const existing = await listAll(`${P}/scheduled_changes/?model_name=FeatureFlag`);
  for (const s of fixture.scheduledChanges) {
    const real = ids.flags[String(s.record_id)];
    if (real === undefined) {
      note(`Scheduled change ${s.id}: its flag ${String(s.record_id)} was not seeded; skipped.`);
      continue;
    }
    const payload = obj(s.payload);
    const operation = String(payload.operation);
    const same = existing.find((e) => String(e.record_id) === String(real) && obj(e.payload).operation === operation && e.scheduled_at === s.scheduled_at && !e.executed_at);
    if (same) {
      ids.scheduledChanges[String(s.id)] = Number(same.id);
      note(`Scheduled change “${operation}” on flag ${real} at ${String(s.scheduled_at)} exists as ${same.id}; kept.`);
      continue;
    }
    const value = operation === 'add_release_condition' ? remapFilters(obj(payload.value)) : payload.value;
    const body: JsonObject = { record_id: String(real), model_name: 'FeatureFlag', payload: { operation, value: value ?? null }, scheduled_at: s.scheduled_at ?? null, is_recurring: s.is_recurring ?? false };
    if (s.cron_expression) body.cron_expression = s.cron_expression;
    if (s.end_date) body.end_date = s.end_date;
    note(`Scheduled change “${operation}” on flag ${real} at ${String(s.scheduled_at)}${s.is_recurring ? ` (recurring ${String(s.cron_expression)})` : ''}.`);
    if (DRY) continue;
    try {
      const created = await api('POST', `${P}/scheduled_changes/`, body);
      ids.scheduledChanges[String(s.id)] = Number(created.id);
      saveIds();
    } catch (e) {
      // Recurring schedules are gated behind a plan on PostHog Cloud; record and go on.
      note(`  not created: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

async function seedEarlyAccess(): Promise<void> {
  const existing = await listAll(`${P}/early_access_feature/`);
  for (const ea of fixture.earlyAccessFeatures) {
    const name = String(ea.name);
    const flagFixtureId = String(obj(ea.feature_flag).id);
    const real = ids.flags[flagFixtureId];
    const current = existing.find((e) => e.name === name);
    if (current) {
      ids.earlyAccess[String(ea.id)] = String(current.id);
      note(`Early-access feature “${name}” exists as ${current.id}; kept.`);
      continue;
    }
    note(`Early-access feature “${name}” (${String(ea.stage)}) on flag ${real ?? '?'}.`);
    if (DRY || real === undefined) continue;
    const created = await api('POST', `${P}/early_access_feature/`, { name, description: ea.description ?? '', stage: ea.stage ?? 'beta', documentation_url: ea.documentation_url ?? '', feature_flag_id: real });
    ids.earlyAccess[String(ea.id)] = String(created.id);
    saveIds();
  }
}

async function seedExperiments(): Promise<void> {
  const existing = await listAll(`${P}/experiments/`);
  for (const x of fixture.experiments) {
    const name = String(x.name);
    const current = existing.find((e) => e.name === name && e.deleted !== true);
    if (current) {
      ids.experiments[String(x.id)] = Number(current.id);
      note(`Experiment “${name}” exists as ${current.id}; kept.`);
      continue;
    }
    const flag = fixture.flags.find((f) => f.key === x.feature_flag_key);
    const holdout = flag ? obj(obj(flag.filters).holdout) : {};
    let holdoutId: number | undefined;
    if (holdout.id !== undefined) {
      const holdoutName = `Acme Hog holdout ${String(holdout.id)}`;
      const holdouts = await listAll(`${P}/experiment_holdouts/`).catch(() => [] as JsonObject[]);
      const h = holdouts.find((e) => e.name === holdoutName);
      note(`Holdout “${holdoutName}” (${String(holdout.exclusion_percentage)}%): ${h ? `exists as ${h.id}` : 'create'}.`);
      if (h) holdoutId = Number(h.id);
      else if (!DRY) {
        try {
          const created = await api('POST', `${P}/experiment_holdouts/`, { name: holdoutName, filters: [{ properties: [], rollout_percentage: holdout.exclusion_percentage ?? 10, variant: 'holdout' }] });
          holdoutId = Number(created.id);
          ids.holdouts[String(holdout.id)] = holdoutId;
        } catch (e) {
          note(`  holdout not created: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }
    const variants = arr(obj(obj(flag?.filters).multivariate).variants);
    note(`Experiment “${name}” on flag “${String(x.feature_flag_key)}”${holdoutId !== undefined ? ` with holdout ${holdoutId}` : ''}.`);
    if (DRY) continue;
    try {
      const created = await api('POST', `${P}/experiments/`, {
        name,
        description: x.description ?? '',
        feature_flag_key: x.feature_flag_key,
        ...(holdoutId !== undefined ? { holdout_id: holdoutId } : {}),
        parameters: { feature_flag_variants: variants },
        start_date: x.start_date ?? new Date().toISOString(),
        type: x.type ?? 'product',
      });
      ids.experiments[String(x.id)] = Number(created.id);
      saveIds();
    } catch (e) {
      note(`  not created: ${(e as Error).message.slice(0, 300)}`);
    }
  }
}

async function seedSurveys(): Promise<void> {
  const backing = fixture.flags.filter((f) => arr(f.surveys).length || Object.keys(obj(f.surveys)).length);
  if (!backing.length) return;
  const existing = await listAll(`${P}/surveys/`);
  for (const f of backing) {
    const survey = Array.isArray(f.surveys) ? obj(f.surveys[0]) : obj(f.surveys);
    const name = String(survey.name ?? f.key);
    const current = existing.find((e) => e.name === name && e.archived !== true);
    if (current) {
      ids.surveys[String(survey.id ?? f.id)] = String(current.id);
      note(`Survey “${name}” exists as ${current.id} (targeting flag ${String(obj(current.targeting_flag).key ?? '?')}); kept.`);
      continue;
    }
    note(`Survey “${name}”: PostHog creates its survey-targeting-<id> flag.`);
    if (DRY) continue;
    try {
      const created = await api('POST', `${P}/surveys/`, {
        name,
        description: String(f.name ?? ''),
        type: 'popover',
        questions: [{ type: 'rating', question: 'How likely are you to recommend our checkout?', scale: 10, display: 'number', lowerBoundLabel: 'Unlikely', upperBoundLabel: 'Very likely' }],
        targeting_flag_filters: remapFilters(obj(f.filters)),
      });
      ids.surveys[String(survey.id ?? f.id)] = String(created.id);
      saveIds();
    } catch (e) {
      note(`  not created: ${(e as Error).message.slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { token } = await checkProject();
  if (ONLY.has('events') && !SKIP_EVENTS) await seedEvents(token);
  if (ONLY.has('cohorts')) await seedCohorts();
  if (ONLY.has('flags')) await seedFlags();
  if (ONLY.has('scheduled_changes')) await seedScheduledChanges();
  if (ONLY.has('early_access')) await seedEarlyAccess();
  if (ONLY.has('experiments')) await seedExperiments();
  if (ONLY.has('surveys')) await seedSurveys();
  if (!DRY) saveIds();
  console.log('');
  console.log(`Done. ${DRY ? 'Nothing was sent.' : `Id map in ${mapPath}.`}`);
  console.log(`Next: connect the console to project ${PROJECT_ID} with a read-only key and compare the snapshot with the fixture (PLAN §22.6, P0 spike).`);
  console.log(`Group-targeted flags (${fixture.flags.filter((f) => obj(f.filters).aggregation_group_type_index !== undefined).length}) need group analytics on the PostHog plan; check ${P}/groups_types/ returns both group types.`);
  console.log(`Newsletter cohort (fixture ${ACME_HOG_NEWSLETTER_COHORT_ID}) → ${ids.cohorts[String(ACME_HOG_NEWSLETTER_COHORT_ID)] ?? 'not created'}; check its count once PostHog has matched the CSV.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

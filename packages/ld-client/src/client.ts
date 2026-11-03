import { HttpError, Transport, UnreachableError, type TransportOptions } from '@sslm/http';
import type { z } from 'zod';
import { LD_API_VERSION, LD_INSTANCES, type LdInstance, type LdInstanceId } from './instances.ts';
import {
  AiConfigSchema,
  AiConfigsSchema,
  ApprovalRequestSchema,
  CallerIdentitySchema,
  MemberSchema,
  MembersSchema,
  TeamSchema,
  TeamsSchema,
  type LdAiConfig,
  type LdMember,
  type LdTeam,
  ContextKindsSchema,
  EnvironmentSchema,
  EnvironmentsSchema,
  ExperimentSchema,
  ExperimentsSchema,
  ExperimentationSettingsSchema,
  FlagSchema,
  FlagStatusesSchema,
  flagStatusKey,
  MetricSchema,
  MetricsSchema,
  FlagsSchema,
  ProjectSchema,
  SegmentSchema,
  SegmentsSchema,
  ProjectsSchema,
  ScheduledChangeSchema,
  ScheduledChangesSchema,
  SegmentImportSchema,
  SegmentMembershipSchema,
  TokenSchema,
  type LdApprovalRequest,
  type LdCallerIdentity,
  type LdEnvironment,
  type LdExperiment,
  type LdExperimentationSettings,
  type LdFlag,
  type LdMetric,
  type LdFlagSummary,
  type LdProject,
  type LdScheduledChange,
  type LdSegment,
  type LdSegmentImport,
  type LdToken,
} from './schemas.ts';

export interface LdSchemaIssue {
  path: string;
  issues: { path: string; message: string }[];
}

export interface LdClientOptions {
  instance: LdInstanceId | LdInstance;
  /** LD access token. Held in memory by this instance only; never logged or persisted. */
  token: string;
  transport?: Transport | TransportOptions;
  onSchemaIssue?: (i: LdSchemaIssue) => void;
}

export class LdAuthError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(status === 401 ? 'LaunchDarkly rejected the token (401).' : `LaunchDarkly denied access to ${path} (${status}).`);
    this.name = 'LdAuthError';
  }
}

export interface ProbeResult {
  path: string;
  status: number | 'unreachable';
  ok: boolean;
  body?: unknown;
}

/** A failed LD write. `status` 405 on a flag or segment PATCH means the environment requires approvals (PLAN §5.1). */
export class LdWriteError extends Error {
  constructor(
    readonly status: number | 'unreachable',
    readonly path: string,
    readonly body: unknown,
  ) {
    super(ldErrorMessage(status, path, body));
    this.name = 'LdWriteError';
  }
}

function ldErrorMessage(status: number | 'unreachable', path: string, body: unknown): string {
  const msg = body && typeof body === 'object' && 'message' in body ? String((body as { message: unknown }).message) : undefined;
  if (status === 'unreachable') return `LaunchDarkly unreachable for ${path}.`;
  if (status === 405) return `${path} requires an approval (405): the environment's approval settings forbid direct writes.`;
  return `LaunchDarkly ${status} for ${path}${msg ? `: ${msg}` : ''}`;
}

export type JsonPatchOp = { op: 'replace' | 'add' | 'remove' | 'test'; path: string; value?: unknown };

export interface SemanticPatch {
  environmentKey?: string;
  comment?: string;
  instructions: ({ kind: string } & Record<string, unknown>)[];
}

/**
 * LaunchDarkly REST client. Reads are lenient-validated; writes (PLAN §5.1) are only called by the
 * executor, after the user confirms a plan. Every write method returns the parsed response body.
 */
export class LdClient {
  readonly instance: LdInstance;
  readonly transport: Transport;
  readonly #token: string;
  private readonly onSchemaIssue: (i: LdSchemaIssue) => void;

  constructor(opts: LdClientOptions) {
    this.instance = typeof opts.instance === 'string' ? LD_INSTANCES[opts.instance] : opts.instance;
    this.#token = opts.token;
    // LD's 429s are readable (CORS headers on errors), but X-Ratelimit-* / Retry-After are not
    // exposed to JS (PLAN §3.1), so the AIMD limiter adapts to 429s.
    // Writes to one flag in quick succession hit LD's per-resource limits, so back off longer than
    // the transport default before giving up (the run can still be resumed after that).
    // A request that fails without a status is therefore a timeout or a dropped connection, never
    // a hidden 429: a read is retried a couple of times (the transport never repeats a POST or
    // PATCH that may have landed), and the executor pauses the run when a write meets one.
    this.transport =
      opts.transport instanceof Transport
        ? opts.transport
        : new Transport({ ...opts.transport, retry: { retryOpaqueFailures: true, maxOpaqueAttempts: 3, maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 30_000, ...opts.transport?.retry } });
    this.onSchemaIssue = opts.onSchemaIssue ?? (() => undefined);
  }

  callerIdentity(signal?: AbortSignal): Promise<LdCallerIdentity> {
    return this.get('/caller-identity', CallerIdentitySchema, { signal });
  }

  getToken(id: string, signal?: AbortSignal): Promise<LdToken> {
    return this.get(`/tokens/${encodeURIComponent(id)}`, TokenSchema, { signal });
  }

  /** All projects (paged by offset). */
  async listProjects(signal?: AbortSignal): Promise<LdProject[]> {
    const out: LdProject[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = await this.get('/projects', ProjectsSchema, { query: { limit: '100', offset: String(offset) }, signal });
      out.push(...page.items);
      if (page.items.length < 100 || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  getProject(projectKey: string, signal?: AbortSignal): Promise<LdProject> {
    return this.get(`/projects/${encodeURIComponent(projectKey)}`, ProjectSchema, { signal });
  }

  async listEnvironments(projectKey: string, signal?: AbortSignal): Promise<LdEnvironment[]> {
    const out: LdEnvironment[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const page = await this.get(`/projects/${encodeURIComponent(projectKey)}/environments`, EnvironmentsSchema, { query: { limit: '100', offset: String(offset) }, signal });
      out.push(...page.items);
      if (page.items.length < 100 || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  getEnvironment(projectKey: string, envKey: string, signal?: AbortSignal): Promise<LdEnvironment> {
    return this.get(`/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}`, EnvironmentSchema, { signal });
  }

  /** Flag summaries (key, tags, on/off for `envKey`), paged. Read-only. */
  async listFlags(projectKey: string, opts: { envKey?: string; signal?: AbortSignal; includeArchived?: boolean; onPage?: (read: number, total?: number) => void } = {}): Promise<LdFlagSummary[]> {
    const out = await this.listFlagPages(projectKey, opts);
    if (!opts.includeArchived) return out;
    // Archived flags are left out of the default listing and `filter=state:` takes one value, so a
    // source read (PLAN §20.2) lists them in a second pass and merges by key.
    const have = new Set(out.map((f) => f.key));
    for (const f of await this.listFlagPages(projectKey, { ...opts, filter: 'state:archived' })) if (!have.has(f.key)) out.push(f);
    return out;
  }

  private async listFlagPages(projectKey: string, opts: { envKey?: string; signal?: AbortSignal; filter?: string; onPage?: (read: number, total?: number) => void }): Promise<LdFlagSummary[]> {
    const out: LdFlagSummary[] = [];
    for (let offset = 0; offset < 100_000; offset += 100) {
      const query: Record<string, string> = { limit: '100', offset: String(offset), summary: 'true' };
      if (opts.envKey) query.env = opts.envKey;
      if (opts.filter) query.filter = opts.filter;
      const page = await this.get(`/flags/${encodeURIComponent(projectKey)}`, FlagsSchema, { query, signal: opts.signal });
      out.push(...page.items);
      opts.onPage?.(out.length, page.totalCount ?? undefined);
      if (page.items.length < 100 || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  /** Full flag with every environment's configuration (pre-images, variation IDs). `null` if absent. */
  async getFlag(projectKey: string, key: string, signal?: AbortSignal): Promise<LdFlag | null> {
    try {
      return await this.get(`/flags/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, FlagSchema, { signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Flag statuses in one environment (GET /flag-statuses/{p}/{e}): `new`, `inactive`, `active` or
   * `launched` plus `lastRequested`, keyed by flag key (PLAN §14 cutover). Read-only; one request
   * per environment. Items whose links name no flag are dropped and reported as a schema issue.
   */
  async listFlagStatuses(projectKey: string, envKey: string, signal?: AbortSignal): Promise<Record<string, { name: string; lastRequested?: string }>> {
    const path = `/flag-statuses/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}`;
    const page = await this.get(path, FlagStatusesSchema, { signal });
    const out: Record<string, { name: string; lastRequested?: string }> = {};
    let unkeyed = 0;
    for (const item of page.items ?? []) {
      const key = flagStatusKey(item);
      if (!key) {
        unkeyed++;
        continue;
      }
      out[key] = { name: item.name, ...(item.lastRequested ? { lastRequested: item.lastRequested } : {}) };
    }
    if (unkeyed) this.onSchemaIssue({ path, issues: [{ path: 'items[]._links', message: `${unkeyed} flag status item(s) without a parent/self link; dropped` }] });
    return out;
  }

  async listSegments(projectKey: string, envKey: string, signal?: AbortSignal): Promise<LdSegment[]> {
    const out: LdSegment[] = [];
    for (let offset = 0; offset < 100_000; offset += 50) {
      const page = await this.get(`/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}`, SegmentsSchema, { query: { limit: '50', offset: String(offset) }, signal });
      out.push(...page.items);
      if (page.items.length < 50 || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  async getSegment(projectKey: string, envKey: string, key: string, signal?: AbortSignal): Promise<LdSegment | null> {
    try {
      return await this.get(`/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}`, SegmentSchema, { signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  // --- Experimentation reads ---------------------------------------------------------------------

  /** Every metric in the project (key, kind, event key, tags). 403 on plans without Experimentation. */
  async listMetrics(projectKey: string, signal?: AbortSignal): Promise<LdMetric[]> {
    const out: LdMetric[] = [];
    for (let offset = 0; offset < 100_000; offset += 50) {
      const page = await this.get(`/metrics/${encodeURIComponent(projectKey)}`, MetricsSchema, { query: { limit: '50', offset: String(offset) }, signal });
      const items = page.items ?? [];
      out.push(...items);
      if (items.length < 50 || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  async getMetric(projectKey: string, key: string, signal?: AbortSignal): Promise<LdMetric | null> {
    try {
      return await this.get(`/metrics/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, MetricSchema, { signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** Experiments (including bandits) in one environment, active and archived. */
  async listExperiments(projectKey: string, envKey: string, signal?: AbortSignal): Promise<LdExperiment[]> {
    const out: LdExperiment[] = [];
    for (let offset = 0; offset < 100_000; offset += 50) {
      const page = await this.get(`/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}/experiments`, ExperimentsSchema, {
        query: { limit: '50', offset: String(offset), lifecycleState: 'active,archived' },
        signal,
      });
      out.push(...page.items);
      const total = page.total_count ?? page.totalCount;
      if (page.items.length < 50 || (total != null && out.length >= total)) break;
    }
    return out;
  }

  async getExperiment(projectKey: string, envKey: string, key: string, signal?: AbortSignal): Promise<LdExperiment | null> {
    try {
      return await this.get(`/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}/experiments/${encodeURIComponent(key)}`, ExperimentSchema, { signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  getExperimentationSettings(projectKey: string, signal?: AbortSignal): Promise<LdExperimentationSettings> {
    return this.get(`/projects/${encodeURIComponent(projectKey)}/experimentation-settings`, ExperimentationSettingsSchema, { signal });
  }

  // --- Writes ---------------------------------------------------------------------------------

  /** POST /projects/{p}/environments (reference/launchdarkly/openapi.json EnvironmentPost: name, key, color required). */
  // Every write takes an optional AbortSignal so a migration run or a project reset can be
  // cancelled mid-flight; the transport never retries once the signal has fired.

  createEnvironment(projectKey: string, body: { key: string; name: string; color: string; critical?: boolean; tags?: string[] }, signal?: AbortSignal): Promise<LdEnvironment> {
    return this.write('POST', `/projects/${encodeURIComponent(projectKey)}/environments`, body, EnvironmentSchema, { signal });
  }

  async deleteEnvironment(projectKey: string, envKey: string, signal?: AbortSignal): Promise<void> {
    await this.write('DELETE', `/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}`, undefined, null, { signal });
  }

  /** PATCH /projects/{p}/environments/{e} (JSON patch). Approval settings: only `required`, `minNumApprovals`, `canReviewOwnRequest`, `canApplyDeclinedChanges` and `requiredApprovalTags` are editable. */
  patchEnvironmentJson(projectKey: string, envKey: string, patch: JsonPatchOp[], signal?: AbortSignal): Promise<LdEnvironment> {
    return this.write('PATCH', `/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}`, patch, EnvironmentSchema, { signal });
  }

  // --- Members and teams (owner → maintainer, PLAN §8.3 `maintainer_unknown`) ---------------------

  /** GET /members, every page. Reader on `member/*` is enough to list; Admin to invite. */
  async listMembers(signal?: AbortSignal): Promise<LdMember[]> {
    const out: LdMember[] = [];
    for (let offset = 0; offset < 50_000; offset += MEMBER_PAGE) {
      const page = await this.get('/members', MembersSchema, { query: { limit: String(MEMBER_PAGE), offset: String(offset) }, signal });
      out.push(...page.items);
      if (page.items.length < MEMBER_PAGE || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  /** POST /members (NewMemberForm[]): invites by email; LD sends each an invitation. Needs Admin or `createMember`. */
  invite(members: { email: string; role: 'reader' | 'writer' | 'admin' | 'no_access'; firstName?: string; lastName?: string; teamKeys?: string[] }[], signal?: AbortSignal): Promise<LdMember[]> {
    return this.write('POST', '/members', members, MembersSchema, { signal }).then((r) => r.items);
  }

  /** GET /teams, every page (Enterprise). */
  async listTeams(signal?: AbortSignal): Promise<LdTeam[]> {
    const out: LdTeam[] = [];
    for (let offset = 0; offset < 10_000; offset += MEMBER_PAGE) {
      const page = await this.get('/teams', TeamsSchema, { query: { limit: String(MEMBER_PAGE), offset: String(offset) }, signal });
      out.push(...page.items);
      if (page.items.length < MEMBER_PAGE || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  /** POST /teams (teamPostInput: key and name required; memberIDs are member `_id`s). */
  createTeam(body: { key: string; name: string; description?: string; memberIDs?: string[] }, signal?: AbortSignal): Promise<LdTeam> {
    return this.write('POST', '/teams', body, TeamSchema, { signal });
  }

  /** PATCH /teams/{key} with semantic-patch instructions (`addMembers` takes member IDs). */
  patchTeamSemantic(teamKey: string, patch: SemanticPatch, signal?: AbortSignal): Promise<LdTeam> {
    return this.write('PATCH', `/teams/${encodeURIComponent(teamKey)}`, patch, TeamSchema, { contentType: 'application/json; domain-model=launchdarkly.semanticpatch', signal });
  }

  // --- AI Configs (StatSig prompts, PLAN §6) ----------------------------------------------------------

  async listAiConfigs(projectKey: string, signal?: AbortSignal): Promise<LdAiConfig[]> {
    const out: LdAiConfig[] = [];
    for (let offset = 0; offset < 10_000; offset += MEMBER_PAGE) {
      const page = await this.get(`/projects/${encodeURIComponent(projectKey)}/ai-configs`, AiConfigsSchema, { query: { limit: String(MEMBER_PAGE), offset: String(offset) }, signal });
      out.push(...page.items);
      if (page.items.length < MEMBER_PAGE || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  getAiConfig(projectKey: string, key: string, signal?: AbortSignal): Promise<LdAiConfig | null> {
    return this.optional(`/projects/${encodeURIComponent(projectKey)}/ai-configs/${encodeURIComponent(key)}`, AiConfigSchema, signal);
  }

  /** POST /projects/{p}/ai-configs (AIConfigPost: key and name required). */
  createAiConfig(projectKey: string, body: { key: string; name: string; description?: string; tags?: string[]; mode?: string; maintainerId?: string; maintainerTeamKey?: string }, signal?: AbortSignal): Promise<LdAiConfig> {
    return this.write('POST', `/projects/${encodeURIComponent(projectKey)}/ai-configs`, body, AiConfigSchema, { signal });
  }

  /** PATCH /projects/{p}/ai-configs/{key}: a plain object of fields to replace (AIConfigPatch), not a JSON patch. */
  patchAiConfig(projectKey: string, key: string, body: { name?: string; description?: string; tags?: string[]; maintainerId?: string; maintainerTeamKey?: string }, signal?: AbortSignal): Promise<LdAiConfig> {
    return this.write('PATCH', `/projects/${encodeURIComponent(projectKey)}/ai-configs/${encodeURIComponent(key)}`, body, AiConfigSchema, { signal });
  }

  async deleteAiConfig(projectKey: string, key: string, signal?: AbortSignal): Promise<void> {
    await this.write('DELETE', `/projects/${encodeURIComponent(projectKey)}/ai-configs/${encodeURIComponent(key)}`, undefined, null, { signal });
  }

  createMetric(projectKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<LdMetric> {
    return this.write('POST', `/metrics/${encodeURIComponent(projectKey)}`, body, MetricSchema, { signal });
  }

  patchMetricJson(projectKey: string, key: string, patch: JsonPatchOp[], opts: { comment?: string; signal?: AbortSignal } = {}): Promise<LdMetric> {
    return this.write('PATCH', `/metrics/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, { patch, ...(opts.comment ? { comment: opts.comment } : {}) }, MetricSchema, { signal: opts.signal });
  }

  async deleteMetric(projectKey: string, key: string, signal?: AbortSignal): Promise<void> {
    await this.write('DELETE', `/metrics/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, undefined, null, { signal });
  }

  /** POST an experiment with its first iteration as a draft (`type: mab` for a bandit). */
  createExperiment(projectKey: string, envKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<LdExperiment> {
    return this.write('POST', `/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}/experiments`, body, ExperimentSchema, { signal });
  }

  /** Replaces the experiment's draft iteration. */
  createIteration(projectKey: string, envKey: string, key: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<LdExperiment> {
    return this.write('POST', `/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}/experiments/${encodeURIComponent(key)}/iterations`, body, ExperimentSchema, { signal });
  }

  /** Experiments only take semantic patches (`archiveExperiment`, `updateExperimentFields`, …). */
  patchExperimentSemantic(projectKey: string, envKey: string, key: string, patch: SemanticPatch, signal?: AbortSignal): Promise<LdExperiment> {
    return this.write('PATCH', `/projects/${encodeURIComponent(projectKey)}/environments/${encodeURIComponent(envKey)}/experiments/${encodeURIComponent(key)}`, patch, ExperimentSchema, {
      contentType: 'application/json; domain-model=launchdarkly.semanticpatch',
      signal,
    });
  }

  /** PUT replaces the whole list of randomization units. */
  putExperimentationSettings(projectKey: string, body: { randomizationUnits: { randomizationUnit: string; default?: boolean }[] }, signal?: AbortSignal): Promise<LdExperimentationSettings> {
    return this.write('PUT', `/projects/${encodeURIComponent(projectKey)}/experimentation-settings`, body, ExperimentationSettingsSchema, { signal });
  }

  createFlag(projectKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<LdFlag> {
    return this.write('POST', `/flags/${encodeURIComponent(projectKey)}`, body, FlagSchema, { signal });
  }

  /** One atomic semantic patch (PLAN §5.1). `dryRun` validates without saving. */
  patchFlagSemantic(projectKey: string, key: string, patch: SemanticPatch, opts: { dryRun?: boolean; signal?: AbortSignal } = {}): Promise<LdFlag> {
    return this.write('PATCH', `/flags/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, patch, FlagSchema, {
      contentType: 'application/json; domain-model=launchdarkly.semanticpatch',
      ...(opts.dryRun ? { query: { dryRun: 'true' } } : {}),
      signal: opts.signal,
    });
  }

  patchFlagJson(projectKey: string, key: string, patch: JsonPatchOp[], opts: { comment?: string; dryRun?: boolean; signal?: AbortSignal } = {}): Promise<LdFlag> {
    return this.write('PATCH', `/flags/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, { patch, ...(opts.comment ? { comment: opts.comment } : {}) }, FlagSchema, { ...(opts.dryRun ? { query: { dryRun: 'true' } } : {}), signal: opts.signal });
  }

  async deleteFlag(projectKey: string, key: string, signal?: AbortSignal): Promise<void> {
    await this.write('DELETE', `/flags/${encodeURIComponent(projectKey)}/${encodeURIComponent(key)}`, undefined, null, { signal });
  }

  /** `unbounded: true` with `unboundedContextKind` creates a big segment (Enterprise), whose members come from imports. */
  createSegment(projectKey: string, envKey: string, body: { key: string; name: string; description?: string; tags?: string[]; unbounded?: boolean; unboundedContextKind?: string }, signal?: AbortSignal): Promise<LdSegment> {
    return this.write('POST', `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}`, body, SegmentSchema, { signal });
  }

  /**
   * Start a big-segment CSV import (POST /segments/{p}/{e}/{key}/imports, multipart `file` + `mode`;
   * reference/launchdarkly/openapi.json createBigSegmentImport). `keys` become one key per line.
   * LD answers 204 with the import's URL in `Location`, which the browser can't read without an
   * exposed header; the import is then found by listing (`getSegmentImport` with the id when known).
   */
  async createSegmentImport(projectKey: string, envKey: string, key: string, keys: string[], opts: { mode: 'merge' | 'replace'; waitOnApprovals?: boolean }): Promise<void> {
    const form = new FormData();
    form.append('file', new Blob([keys.join('\n') + '\n'], { type: 'text/csv' }), `${key}.csv`);
    form.append('mode', opts.mode);
    if (opts.waitOnApprovals !== undefined) form.append('waitOnApprovals', String(opts.waitOnApprovals));
    await this.write('POST', `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}/imports`, form, null);
  }

  /** GET /segments/{p}/{e}/{key}/contexts/{contextKey}: whether one key is an included member (how an import is verified from a browser). */
  getSegmentMembership(projectKey: string, envKey: string, key: string, contextKey: string, signal?: AbortSignal): Promise<{ included: boolean; excluded: boolean } | null> {
    return this.optional(`/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}/contexts/${encodeURIComponent(contextKey)}`, SegmentMembershipSchema, signal);
  }

  getSegmentImport(projectKey: string, envKey: string, key: string, importId: string, signal?: AbortSignal): Promise<LdSegmentImport> {
    return this.get(`/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}/imports/${encodeURIComponent(importId)}`, SegmentImportSchema, { signal });
  }

  /** Semantic patch on a segment (needed for approval requests, which only take instructions). */
  patchSegmentSemantic(projectKey: string, envKey: string, key: string, patch: SemanticPatch): Promise<LdSegment> {
    return this.write('PATCH', `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}`, { ...patch, environmentKey: envKey }, SegmentSchema, {
      contentType: 'application/json; domain-model=launchdarkly.semanticpatch',
    });
  }

  // --- Approvals and scheduled changes (PLAN §5.1) -------------------------------------------------

  /** POST /projects/{p}/flags/{f}/environments/{e}/approval-requests (createFlagConfigApprovalRequestRequest). */
  createFlagApprovalRequest(
    projectKey: string,
    flagKey: string,
    envKey: string,
    body: { description: string; instructions: SemanticPatch['instructions']; comment?: string; executionDate?: number; notifyMemberIds?: string[]; notifyTeamKeys?: string[] },
  ): Promise<LdApprovalRequest> {
    return this.write('POST', `/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}/environments/${encodeURIComponent(envKey)}/approval-requests`, body, ApprovalRequestSchema);
  }

  getFlagApprovalRequest(projectKey: string, flagKey: string, envKey: string, id: string, signal?: AbortSignal): Promise<LdApprovalRequest | null> {
    return this.optional(`/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}/environments/${encodeURIComponent(envKey)}/approval-requests/${encodeURIComponent(id)}`, ApprovalRequestSchema, signal);
  }

  async deleteFlagApprovalRequest(projectKey: string, flagKey: string, envKey: string, id: string): Promise<void> {
    await this.write('DELETE', `/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}/environments/${encodeURIComponent(envKey)}/approval-requests/${encodeURIComponent(id)}`, undefined, null);
  }

  /** POST /approval-requests: any resource, e.g. `resourceId: "proj/p:env/e:segment/s"` with segment instructions. */
  createApprovalRequest(body: { resourceId: string; description: string; instructions: SemanticPatch['instructions']; comment?: string; notifyMemberIds?: string[]; notifyTeamKeys?: string[] }): Promise<LdApprovalRequest> {
    return this.write('POST', '/approval-requests', body, ApprovalRequestSchema);
  }

  getApprovalRequest(id: string, signal?: AbortSignal): Promise<LdApprovalRequest | null> {
    return this.optional(`/approval-requests/${encodeURIComponent(id)}`, ApprovalRequestSchema, signal);
  }

  async deleteApprovalRequest(id: string): Promise<void> {
    await this.write('DELETE', `/approval-requests/${encodeURIComponent(id)}`, undefined, null);
  }

  async listScheduledChanges(projectKey: string, flagKey: string, envKey: string, signal?: AbortSignal): Promise<LdScheduledChange[]> {
    const page = await this.get(`/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}/environments/${encodeURIComponent(envKey)}/scheduled-changes`, ScheduledChangesSchema, { signal });
    return page.items;
  }

  /**
   * POST scheduled changes (PostFlagScheduledChangesInput). `ignoreConflicts` lets several full-state
   * changes on one flag coexist: ours each replace the whole targeting, so conflicts between them are intended.
   */
  createScheduledChange(projectKey: string, flagKey: string, envKey: string, body: { executionDate: number; instructions: SemanticPatch['instructions']; comment?: string }, opts: { ignoreConflicts?: boolean } = {}): Promise<LdScheduledChange> {
    return this.write('POST', `/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}/environments/${encodeURIComponent(envKey)}/scheduled-changes`, body, ScheduledChangeSchema, opts.ignoreConflicts ? { query: { ignoreConflicts: 'true' } } : {});
  }

  async deleteScheduledChange(projectKey: string, flagKey: string, envKey: string, id: string): Promise<void> {
    await this.write('DELETE', `/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}/environments/${encodeURIComponent(envKey)}/scheduled-changes/${encodeURIComponent(id)}`, undefined, null);
  }

  /** GET that returns `null` on 404. */
  private async optional<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<z.output<S> | null> {
    try {
      return await this.get(path, schema, { signal });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  patchSegmentJson(projectKey: string, envKey: string, key: string, patch: JsonPatchOp[], opts: { comment?: string; dryRun?: boolean; signal?: AbortSignal } = {}): Promise<LdSegment> {
    return this.write('PATCH', `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}`, { patch, ...(opts.comment ? { comment: opts.comment } : {}) }, SegmentSchema, { ...(opts.dryRun ? { query: { dryRun: 'true' } } : {}), signal: opts.signal });
  }

  async deleteSegment(projectKey: string, envKey: string, key: string, signal?: AbortSignal): Promise<void> {
    await this.write('DELETE', `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}/${encodeURIComponent(key)}`, undefined, null, { signal });
  }

  /** PUT is an upsert; `archived: true` is how a context kind is "removed". */
  async putContextKind(projectKey: string, key: string, body: { name: string; description?: string; archived?: boolean }, signal?: AbortSignal): Promise<void> {
    await this.write('PUT', `/projects/${encodeURIComponent(projectKey)}/context-kinds/${encodeURIComponent(key)}`, body, null, { signal });
  }

  private async write<S extends z.ZodType>(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    schema: S | null,
    opts: { contentType?: string; query?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<z.output<S>> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
    let res;
    try {
      res = await this.transport.request({
        method,
        url: `${this.instance.origin}/api/v2${path}${qs}`,
        headers: { Authorization: this.#token, 'LD-API-Version': LD_API_VERSION, ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}) },
        body,
        signal: opts.signal,
      });
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401) throw new LdAuthError(401, path);
        throw new LdWriteError(e.status, path, stripSdkKeys(e.body));
      }
      if (e instanceof UnreachableError) throw new LdWriteError('unreachable', path, null);
      throw e;
    }
    const out = stripSdkKeys(res.body);
    if (!schema) return out as z.output<S>;
    const parsed = schema.safeParse(out);
    if (parsed.success) return parsed.data;
    this.onSchemaIssue({ path, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return out as z.output<S>;
  }

  listContextKinds(projectKey: string, signal?: AbortSignal) {
    return this.get(`/projects/${encodeURIComponent(projectKey)}/context-kinds`, ContextKindsSchema, { signal });
  }

  /**
   * GET a route and report its status without throwing (capability probing, PLAN §5.2).
   * Beta routes must be probed with the beta header: without it they 403 regardless of plan.
   */
  async probe(path: string, opts: { beta?: boolean; query?: Record<string, string>; signal?: AbortSignal } = {}): Promise<ProbeResult> {
    try {
      const res = await this.request(path, opts);
      return { path, status: res.status, ok: true, body: stripSdkKeys(res.body) };
    } catch (e) {
      if (e instanceof HttpError) return { path, status: e.status, ok: false, body: stripSdkKeys(e.body) };
      if (e instanceof UnreachableError) return { path, status: 'unreachable', ok: false };
      throw e;
    }
  }

  async get<S extends z.ZodType>(path: string, schema: S, opts: { beta?: boolean; query?: Record<string, string>; signal?: AbortSignal } = {}): Promise<z.output<S>> {
    let res;
    try {
      res = await this.request(path, opts);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) throw new LdAuthError(e.status, path);
      throw e;
    }
    const body = stripSdkKeys(res.body);
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    this.onSchemaIssue({ path, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return body as z.output<S>;
  }

  private request(path: string, opts: { beta?: boolean; query?: Record<string, string>; signal?: AbortSignal }) {
    const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
    return this.transport.request({
      method: 'GET',
      url: `${this.instance.origin}/api/v2${path}${qs}`,
      headers: { Authorization: this.#token, 'LD-API-Version': opts.beta ? 'beta' : LD_API_VERSION },
      signal: opts.signal,
    });
  }
}

/** Page size for the account-level lists (members, teams, AI Configs); LD caps `limit` at 50 on some of them. */
const MEMBER_PAGE = 50;

const SDK_KEY_FIELDS = new Set(['apiKey', 'mobileKey']);

/**
 * Remove environment SDK keys anywhere in a response, before validation, so they can't leak via
 * the lenient "return the raw body" path either.
 */
export function stripSdkKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSdkKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SDK_KEY_FIELDS.has(k)) out[k] = stripSdkKeys(x);
    return out;
  }
  return v;
}

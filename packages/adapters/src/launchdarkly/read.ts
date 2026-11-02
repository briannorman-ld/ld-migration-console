/**
 * LaunchDarkly source adapter, read side (PLAN §20.2): everything the console needs from a
 * source LD project, read with the lenient schemas of @sslm/ld-client and never written to.
 * One request per flag (GET /flags/{p}/{key} carries every environment's targeting), one per
 * environment for segments. Experiments and metrics are not read (PLAN §11, §20.4).
 */
import type { LdClient, LdEnvironment, LdFlag, LdFlagSummary, LdProject, LdSchemaIssue, LdSegment } from '@sslm/ld-client';
import { HttpError } from '@sslm/http';

/** The reads the adapter makes; `LdClient` satisfies it, and tests can pass a fake. */
export type LdSourceReader = Pick<LdClient, 'getProject' | 'listEnvironments' | 'listContextKinds' | 'listFlags' | 'getFlag' | 'listSegments'>;

export interface RawLdSnapshot {
  kind: 'launchdarkly';
  fetchedAt: string;
  projectKey: string;
  project: LdProject;
  environments: LdEnvironment[];
  contextKinds: { key: string; name?: string | null; archived?: boolean | null }[];
  /** Full flags, archived ones included (the listing hides them unless asked). */
  flags: LdFlag[];
  /** Segments per environment key. */
  segments: Record<string, LdSegment[]>;
  schemaIssues: LdSchemaIssue[];
  /** Reads that failed without failing the whole read (a 403 on one route, a segment page). */
  skipped: { endpoint: string; reason: string }[];
}

export interface LdReadProgress {
  done: number;
  total: number;
  endpoint: string;
}

export interface LdReadOptions {
  signal?: AbortSignal;
  onProgress?: (p: LdReadProgress) => void;
  /** Flags fetched at a time. LD's per-route limits are generous for reads; 4 keeps the UI responsive. */
  concurrency?: number;
}

export class LdReadAuthError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
    this.name = 'LdReadAuthError';
  }
}

/** Read one LD project. A 401/403 on the project itself is an auth error; later 403s are skipped routes. */
export async function readLdProject(client: LdSourceReader, projectKey: string, opts: LdReadOptions = {}): Promise<RawLdSnapshot> {
  const skipped: RawLdSnapshot['skipped'] = [];
  let done = 0;
  let total = 4;
  const progress = (endpoint: string) => opts.onProgress?.({ done, total, endpoint });

  progress(`/projects/${projectKey}`);
  let project: LdProject;
  try {
    project = await client.getProject(projectKey, opts.signal);
  } catch (e) {
    throw new LdReadAuthError(`Could not read LaunchDarkly project “${projectKey}”: ${(e as Error).message}`, e);
  }
  done++;

  progress(`/projects/${projectKey}/environments`);
  const environments = await client.listEnvironments(projectKey, opts.signal);
  done++;

  progress(`/projects/${projectKey}/context-kinds`);
  let contextKinds: RawLdSnapshot['contextKinds'] = [];
  try {
    contextKinds = (await client.listContextKinds(projectKey, opts.signal)).items.map((k) => ({ key: k.key, name: k.name, archived: k.archived }));
  } catch (e) {
    skipped.push({ endpoint: `/projects/${projectKey}/context-kinds`, reason: reason(e) });
  }
  done++;

  progress(`/flags/${projectKey}`);
  const summaries: LdFlagSummary[] = await client.listFlags(projectKey, { signal: opts.signal, includeArchived: true });
  done++;
  total += summaries.length + environments.length;

  const flags: LdFlag[] = [];
  const queue = [...summaries];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, queue.length || 1)) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const endpoint = `/flags/${projectKey}/${s.key}`;
      progress(endpoint);
      try {
        const f = await client.getFlag(projectKey, s.key, opts.signal);
        if (f) flags.push(f);
        else skipped.push({ endpoint, reason: 'listed but not found (deleted while reading?)' });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        skipped.push({ endpoint, reason: reason(e) });
      }
      done++;
    }
  });
  await Promise.all(workers);
  // The listing order is LD's; keep snapshots deterministic.
  flags.sort((a, b) => a.key.localeCompare(b.key));

  const segments: Record<string, LdSegment[]> = {};
  for (const env of environments) {
    const endpoint = `/segments/${projectKey}/${env.key}`;
    progress(endpoint);
    try {
      segments[env.key] = (await client.listSegments(projectKey, env.key, opts.signal)).sort((a, b) => a.key.localeCompare(b.key));
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      segments[env.key] = [];
      skipped.push({ endpoint, reason: reason(e) });
    }
    done++;
  }
  progress('done');

  return { kind: 'launchdarkly', fetchedAt: new Date().toISOString(), projectKey, project, environments, contextKinds, flags, segments, schemaIssues: [], skipped };
}

function reason(e: unknown): string {
  if (e instanceof HttpError) return `HTTP ${e.status}`;
  return (e as Error).message;
}

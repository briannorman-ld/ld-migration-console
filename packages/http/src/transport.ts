import { realClock, type Clock } from './clock.ts';
import { AimdLimiter, RateBudget, type AimdOptions, type RateWindow } from './limiter.ts';

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * HTTP statuses that are retried with backoff (429 always also shrinks the AIMD window).
   * Only idempotent requests (GET, PUT, DELETE) retry on these: a POST or PATCH that timed out or
   * drew a 5xx may already have been applied, so those retry on 429 only (the server refused the
   * request without processing it), and a PATCH or PUT also on a 409 concurrent-edit conflict.
   */
  retryStatuses: number[];
  /**
   * Whether a fetch that throws (no readable status) is retried. In the browser, StatSig error
   * responses carry no CORS header (PLAN §3.1), so a 401 or 429 surfaces as a TypeError. We treat
   * it as possibly rate-limited: shrink the window and back off.
   */
  retryOpaqueFailures: boolean;
  /**
   * Attempts (including the first) for a request that keeps failing opaquely, when
   * `retryOpaqueFailures` is on. Defaults to `maxAttempts`. A host whose errors are readable
   * (LaunchDarkly) fails opaquely only on a timeout or a dropped connection, and each timed-out
   * attempt already costs `timeoutMs`, so it gives up sooner than on a 429.
   */
  maxOpaqueAttempts?: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  retryStatuses: [429, 500, 502, 503, 504],
  retryOpaqueFailures: true,
};

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON-encoded, except a `FormData` body, which is sent as multipart (the browser sets the boundary). */
  body?: unknown;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  ok: boolean;
  body: unknown;
  /** Elapsed wall time for the successful attempt, ms. */
  elapsedMs: number;
  attempts: number;
}

/**
 * Events for UI progress and diagnostics. They deliberately carry no headers or bodies: tokens
 * must never reach a log (CLAUDE.md). URLs are included; our URLs never contain secrets.
 */
export type TransportEvent =
  | { type: 'request'; method: string; url: string; attempt: number }
  | { type: 'response'; method: string; url: string; status: number; elapsedMs: number }
  | { type: 'retry'; method: string; url: string; attempt: number; delayMs: number; reason: string }
  | { type: 'throttled'; url: string; newLimit: number }
  /** The request is held back by our own rate budget (not by the server) for about `waitMs`. */
  | { type: 'paced'; url: string; waitMs: number }
  | { type: 'gave-up'; method: string; url: string; attempts: number; reason: string };

/** Longest wait a Retry-After / X-Ratelimit-Reset header may ask for before we fall back to backoff. */
const MAX_HINTED_DELAY_MS = 60_000;

/**
 * `Retry-After` (seconds or an HTTP date) or LaunchDarkly's `X-Ratelimit-Reset` (epoch ms), when
 * the response exposes either. Undefined when absent or unparseable.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.round(secs * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return at - now;
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const at = Number(reset);
    if (Number.isFinite(at) && at > 0) return at - now;
  }
  return undefined;
}

export interface TransportOptions {
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  limiter?: AimdLimiter | Partial<AimdOptions>;
  budgets?: RateWindow[];
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  onEvent?: (e: TransportEvent) => void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${redactUrl(url)}`);
    this.name = 'HttpError';
  }
}

/** The request failed without a readable status (CORS-blocked error, DNS, offline, timeout). */
export class UnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly attempts: number,
    readonly lastCause: string,
  ) {
    super(`Unreachable after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${redactUrl(url)} (${lastCause})`);
    this.name = 'UnreachableError';
  }
}

export class Transport {
  readonly limiter: AimdLimiter;
  readonly budget: RateBudget | null;
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly retry: RetryPolicy;
  private readonly timeoutMs: number;
  private readonly onEvent: (e: TransportEvent) => void;
  /** Observed throughput for duration estimates (PLAN §5.1). */
  readonly stats = { requests: 0, throttles: 0, opaqueFailures: 0, totalElapsedMs: 0 };

  constructor(opts: TransportOptions = {}) {
    // Bind so `this` is the global object; a bare `fetch` reference fails in some browsers.
    const f = opts.fetch ?? globalThis.fetch;
    this.fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => f(input, init)) as typeof fetch;
    this.clock = opts.clock ?? realClock;
    this.random = opts.random ?? Math.random;
    this.limiter = opts.limiter instanceof AimdLimiter ? opts.limiter : new AimdLimiter(opts.limiter);
    this.budget = opts.budgets?.length ? new RateBudget(opts.budgets, this.clock) : null;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.onEvent = opts.onEvent ?? (() => undefined);
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let lastCause = 'unknown';
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      // A cancelled caller gets its abort reason back at once: no attempt, no retry, no backoff.
      if (req.signal?.aborted) throw abortReason(req.signal);
      if (this.budget) {
        const waitMs = this.budget.peekWait();
        if (waitMs > 0) this.onEvent({ type: 'paced', url: req.url, waitMs });
        await this.budget.take(req.signal);
      }
      const release = await this.limiter.acquire();
      const started = this.clock.now();
      let outcome: Outcome;
      try {
        this.onEvent({ type: 'request', method: req.method, url: req.url, attempt });
        outcome = await this.once(req);
      } finally {
        release();
      }
      const elapsedMs = this.clock.now() - started;

      const idempotent = req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE';
      if (outcome.kind === 'response') {
        const { status, body } = outcome;
        this.stats.requests++;
        this.stats.totalElapsedMs += elapsedMs;
        this.onEvent({ type: 'response', method: req.method, url: req.url, status, elapsedMs });
        if (status >= 200 && status < 300) {
          this.limiter.onSuccess();
          return { status, ok: true, body, elapsedMs, attempts: attempt };
        }
        if (status === 429) {
          this.stats.throttles++;
          this.limiter.onThrottle();
          this.onEvent({ type: 'throttled', url: req.url, newLimit: this.limiter.limit });
        }
        const retryable =
          status === 429 ||
          (idempotent && this.retry.retryStatuses.includes(status)) ||
          (status === 409 && (req.method === 'PATCH' || req.method === 'PUT'));
        if (!retryable || attempt === this.retry.maxAttempts) {
          if (attempt > 1 && retryable) {
            this.onEvent({ type: 'gave-up', method: req.method, url: req.url, attempts: attempt, reason: `HTTP ${status}` });
          }
          throw new HttpError(status, body, req.url);
        }
        lastCause = `HTTP ${status}`;
      } else {
        if (outcome.aborted) throw outcome.error;
        this.stats.opaqueFailures++;
        lastCause = outcome.reason;
        if (!this.retry.retryOpaqueFailures || !idempotent) throw new UnreachableError(req.url, attempt, lastCause);
        // No status to read: assume we may have been throttled.
        this.limiter.onThrottle();
        this.onEvent({ type: 'throttled', url: req.url, newLimit: this.limiter.limit });
        if (attempt >= Math.min(this.retry.maxAttempts, this.retry.maxOpaqueAttempts ?? this.retry.maxAttempts)) {
          this.onEvent({ type: 'gave-up', method: req.method, url: req.url, attempts: attempt, reason: lastCause });
          throw new UnreachableError(req.url, attempt, lastCause);
        }
      }

      // Prefer the server's own hint when the browser is allowed to see it (LD exposes no
      // CORS headers today, so this is usually the computed backoff).
      const hinted = outcome.kind === 'response' ? outcome.retryAfterMs : undefined;
      const delayMs = hinted !== undefined ? Math.min(Math.max(hinted, 0), MAX_HINTED_DELAY_MS) : this.backoff(attempt);
      this.onEvent({ type: 'retry', method: req.method, url: req.url, attempt, delayMs, reason: lastCause });
      await this.clock.sleep(delayMs, req.signal);
    }
    this.onEvent({ type: 'gave-up', method: req.method, url: req.url, attempts: this.retry.maxAttempts, reason: lastCause });
    throw new UnreachableError(req.url, this.retry.maxAttempts, lastCause);
  }

  /** Average observed latency per request, for duration estimates. */
  get avgLatencyMs(): number {
    return this.stats.requests ? this.stats.totalElapsedMs / this.stats.requests : 0;
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number): number {
    const cap = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(cap / 2 + (this.random() * cap) / 2);
  }

  private async once(req: TransportRequest): Promise<Outcome> {
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(abortReason(req.signal!));
    if (req.signal?.aborted) onOuterAbort();
    else req.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
      let body: string | FormData | undefined;
      if (typeof FormData !== 'undefined' && req.body instanceof FormData) {
        // Multipart (LD big-segment CSV import): fetch derives Content-Type with the boundary.
        body = req.body;
        delete headers['Content-Type'];
      } else if (req.body !== undefined) {
        body = JSON.stringify(req.body);
        headers['Content-Type'] ??= 'application/json';
      }
      // `no-store`: a listing re-read after a write must come from the API, never from the browser's HTTP cache.
      const res = await this.fetchFn(req.url, { method: req.method, headers, body, signal: ctrl.signal, cache: 'no-store' });
      const text = await res.text();
      let parsed: unknown = text;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      } else {
        parsed = null;
      }
      return { kind: 'response', status: res.status, body: parsed, retryAfterMs: retryAfterMs(res.headers) };
    } catch (error) {
      if (req.signal?.aborted) return { kind: 'failure', aborted: true, error, reason: 'aborted' };
      const reason =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'timeout'
          : ctrl.signal.aborted
            ? 'timeout'
            : error instanceof TypeError
              ? 'network error (no readable status; possibly CORS-blocked 401/429)'
              : String((error as Error)?.message ?? error);
      return { kind: 'failure', aborted: false, error, reason };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

type Outcome =
  | { kind: 'response'; status: number; body: unknown; retryAfterMs?: number | undefined }
  | { kind: 'failure'; aborted: boolean; error: unknown; reason: string };

/** The signal's reason, or a standard AbortError when it was aborted without one. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** True when `e` is the error an aborted request, sleep or budget wait rejects with. */
export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError';
}

/** Strip query strings from URLs in messages; defensive, as none of ours carry secrets. */
export function redactUrl(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i) + '?…';
}

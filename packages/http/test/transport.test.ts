import { describe, expect, it } from 'vitest';
import { AimdLimiter, HttpError, ManualClock, RateBudget, retryAfterMs, Transport, UnreachableError, type TransportEvent } from '../src/index.ts';

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Instant sleeps so retry tests don't wait; records requested delays. */
function instantClock() {
  const delays: number[] = [];
  let t = 0;
  return {
    delays,
    clock: { now: () => t, sleep: async (ms: number) => { delays.push(ms); t += ms; } },
  };
}

describe('AimdLimiter', () => {
  it('halves on throttle and grows back additively', () => {
    const l = new AimdLimiter({ initial: 4, min: 1, max: 6, successesPerIncrease: 2 });
    l.onThrottle();
    expect(l.limit).toBe(2);
    l.onThrottle();
    l.onThrottle();
    expect(l.limit).toBe(1);
    l.onSuccess();
    l.onSuccess();
    expect(l.limit).toBe(2);
    for (let i = 0; i < 20; i++) l.onSuccess();
    expect(l.limit).toBe(6);
  });

  it('never runs more than `limit` concurrently', async () => {
    const l = new AimdLimiter({ initial: 2, min: 1, max: 2, successesPerIncrease: 100 });
    let active = 0;
    let peak = 0;
    const task = async () => {
      const release = await l.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
  });
});

describe('RateBudget', () => {
  it('delays requests that would exceed a window', async () => {
    const clock = new ManualClock(0);
    const budget = new RateBudget([{ limit: 3, windowMs: 1000 }], clock);
    const started: number[] = [];
    const all = Promise.all(Array.from({ length: 5 }, () => budget.take().then(() => started.push(clock.now()))));
    await clock.runAll();
    await all;
    expect(started.slice(0, 3)).toEqual([0, 0, 0]);
    expect(started[3]).toBeGreaterThanOrEqual(1000);
    expect(started[4]).toBeGreaterThanOrEqual(1000);
  });
});

describe('Transport', () => {
  it('retries 429 with jittered exponential backoff and shrinks concurrency', async () => {
    const { clock, delays } = instantClock();
    const statuses = [429, 429, 200];
    const events: TransportEvent[] = [];
    const t = new Transport({
      clock,
      random: () => 1,
      limiter: { initial: 4 },
      retry: { baseDelayMs: 100 },
      fetch: async () => jsonResponse(statuses.shift()!, { ok: true }),
      onEvent: (e) => events.push(e),
    });
    const res = await t.request({ method: 'GET', url: 'https://x.test/a' });
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(t.limiter.limit).toBe(1);
    expect(events.filter((e) => e.type === 'throttled')).toHaveLength(2);
  });

  it('does not retry non-retryable 4xx', async () => {
    let calls = 0;
    const t = new Transport({ clock: instantClock().clock, fetch: async () => (calls++, jsonResponse(404, { message: 'nope' })) });
    await expect(t.request({ method: 'GET', url: 'https://x.test/a' })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('treats opaque failures (CORS-blocked errors) as possible throttling, then gives up', async () => {
    const { clock, delays } = instantClock();
    let calls = 0;
    const t = new Transport({
      clock,
      retry: { maxAttempts: 4, baseDelayMs: 10 },
      fetch: async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      },
    });
    const err = await t.request({ method: 'GET', url: 'https://x.test/a?k=v' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnreachableError);
    expect(err.message).not.toContain('k=v');
    expect(calls).toBe(4);
    expect(delays).toHaveLength(3);
    expect(t.stats.opaqueFailures).toBe(4);
  });

  it('maxOpaqueAttempts gives up on opaque failures sooner than on readable ones, and says so in the singular', async () => {
    const { clock } = instantClock();
    let calls = 0;
    const events: TransportEvent[] = [];
    const t = new Transport({
      clock,
      retry: { maxAttempts: 8, maxOpaqueAttempts: 3, baseDelayMs: 1 },
      onEvent: (e) => events.push(e),
      fetch: async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      },
    });
    const err = await t.request({ method: 'GET', url: 'https://x.test/a' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnreachableError);
    expect(err.message).toBe('Unreachable after 3 attempts: https://x.test/a (network error (no readable status; possibly CORS-blocked 401/429))');
    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === 'gave-up')).toHaveLength(1);
    // Readable statuses still get the full count.
    let calls2 = 0;
    const t2 = new Transport({ clock, retry: { maxAttempts: 4, maxOpaqueAttempts: 2, baseDelayMs: 1 }, fetch: async () => (calls2++, jsonResponse(503)) });
    await expect(t2.request({ method: 'GET', url: 'https://x.test/a' })).rejects.toBeInstanceOf(HttpError);
    expect(calls2).toBe(4);
    const t3 = new Transport({ clock, retry: { maxOpaqueAttempts: 1 }, fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(t3.request({ method: 'GET', url: 'https://x.test/a' })).rejects.toThrow(/^Unreachable after 1 attempt:/);
  });

  it('never puts headers in events', async () => {
    const events: TransportEvent[] = [];
    const t = new Transport({ clock: instantClock().clock, fetch: async () => jsonResponse(200), onEvent: (e) => events.push(e) });
    await t.request({ method: 'GET', url: 'https://x.test/a', headers: { Authorization: 'secret-token' } });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('parses empty and non-JSON bodies leniently', async () => {
    const t = new Transport({ clock: instantClock().clock, fetch: async () => new Response(null, { status: 204 }) });
    expect((await t.request({ method: 'GET', url: 'https://x.test/a' })).body).toBeNull();
    const t2 = new Transport({ clock: instantClock().clock, fetch: async () => new Response('hello', { status: 200 }) });
    expect((await t2.request({ method: 'GET', url: 'https://x.test/a' })).body).toBe('hello');
  });
});

describe('Transport multipart bodies', () => {
  it('sends a FormData body as is, letting fetch set the multipart boundary', async () => {
    const seen: RequestInit[] = [];
    const t = new Transport({ fetch: async (_u, init) => (seen.push(init!), new Response(null, { status: 204 })), clock: instantClock().clock });
    const form = new FormData();
    form.append('mode', 'replace');
    form.append('file', new Blob(['a\nb\n'], { type: 'text/csv' }), 'ids.csv');
    const res = await t.request({ method: 'POST', url: 'https://ld.test/api/v2/segments/p/e/k/imports', headers: { Authorization: 'tok', 'Content-Type': 'application/json' }, body: form });
    expect(res.status).toBe(204);
    expect(seen[0]!.body).toBe(form);
    expect((seen[0]!.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((seen[0]!.headers as Record<string, string>).Authorization).toBe('tok');
  });
});

describe('Transport retry policy by method', () => {
  it('does not retry a POST on 5xx or a timeout: it may already have been applied', async () => {
    let calls = 0;
    const t = new Transport({ clock: instantClock().clock, fetch: async () => (calls++, jsonResponse(502)) });
    await expect(t.request({ method: 'POST', url: 'https://x.test/a', body: {} })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
    let calls2 = 0;
    const t2 = new Transport({
      clock: instantClock().clock,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
      fetch: async () => {
        calls2++;
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(t2.request({ method: 'POST', url: 'https://x.test/a', body: {} })).rejects.toBeInstanceOf(UnreachableError);
    expect(calls2).toBe(1);
  });

  it('retries a POST on 429 (refused, not processed) and a PATCH on 409 (concurrent edit)', async () => {
    const posts = [429, 201];
    const t = new Transport({ clock: instantClock().clock, retry: { baseDelayMs: 1 }, fetch: async () => jsonResponse(posts.shift()!) });
    expect((await t.request({ method: 'POST', url: 'https://x.test/a', body: {} })).attempts).toBe(2);
    const patches = [409, 200];
    const t2 = new Transport({ clock: instantClock().clock, retry: { baseDelayMs: 1 }, fetch: async () => jsonResponse(patches.shift()!) });
    expect((await t2.request({ method: 'PATCH', url: 'https://x.test/a', body: {} })).attempts).toBe(2);
    // A GET still retries 5xx as before.
    const gets = [503, 200];
    const t3 = new Transport({ clock: instantClock().clock, retry: { baseDelayMs: 1 }, fetch: async () => jsonResponse(gets.shift()!) });
    expect((await t3.request({ method: 'GET', url: 'https://x.test/a' })).attempts).toBe(2);
  });

  it('waits as long as Retry-After or X-Ratelimit-Reset asks, when the response exposes them', async () => {
    const { clock, delays } = instantClock();
    const responses = [
      new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
      new Response('{}', { status: 429, headers: { 'X-Ratelimit-Reset': String(Date.now() + 2500) } }),
      jsonResponse(200),
    ];
    const t = new Transport({ clock, retry: { baseDelayMs: 100 }, fetch: async () => responses.shift()! });
    await t.request({ method: 'GET', url: 'https://x.test/a' });
    expect(delays[0]).toBe(7000);
    expect(delays[1]).toBeGreaterThan(2000);
    expect(delays[1]).toBeLessThanOrEqual(2500);
    // Absurd hints are capped; an absent hint falls back to backoff.
    expect(retryAfterMs(new Headers({ 'Retry-After': 'garbage' }))).toBeUndefined();
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});

describe('rate budget pacing events', () => {
  it('rejects at once with the abort reason when the signal is already aborted: no attempt, no retry', async () => {
    const { clock, delays } = instantClock();
    let fetches = 0;
    const events: TransportEvent[] = [];
    const t = new Transport({ clock, fetch: async () => (fetches++, jsonResponse(500)), onEvent: (e) => events.push(e) });
    const ctrl = new AbortController();
    const reason = new DOMException('Cancelled by the user.', 'AbortError');
    ctrl.abort(reason);
    await expect(t.request({ method: 'POST', url: 'https://x.test/a', body: {}, signal: ctrl.signal })).rejects.toBe(reason);
    expect(fetches).toBe(0);
    expect(delays).toEqual([]);
    expect(events).toEqual([]);
  });

  it('an abort during the retry backoff ends the request instead of retrying', async () => {
    const ctrl = new AbortController();
    let fetches = 0;
    const events: TransportEvent[] = [];
    // Real clock, tiny delays: the first 429 schedules a backoff, and the cancel lands inside it.
    const t = new Transport({ retry: { baseDelayMs: 200, maxDelayMs: 200 }, random: () => 1, fetch: async () => (fetches++, jsonResponse(429)), onEvent: (e) => events.push(e) });
    const req = t.request({ method: 'GET', url: 'https://x.test/a', signal: ctrl.signal });
    setTimeout(() => ctrl.abort(new DOMException('Cancelled by the user.', 'AbortError')), 10);
    await expect(req).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetches).toBe(1);
    expect(events.filter((e) => e.type === 'request')).toHaveLength(1);
  });

  it('an abort while fetch is pending surfaces as the abort reason, never as an unreachable error', async () => {
    const ctrl = new AbortController();
    // What a real fetch does: never resolves, rejects with the reason as soon as the signal aborts.
    const t = new Transport({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    const req = t.request({ method: 'DELETE', url: 'https://x.test/a', signal: ctrl.signal });
    ctrl.abort(new DOMException('Cancelled by the user.', 'AbortError'));
    await expect(req).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports when our own budget holds a request back, before waiting', async () => {
    const { clock, delays } = instantClock();
    const events: TransportEvent[] = [];
    const t = new Transport({ clock, budgets: [{ limit: 2, windowMs: 1000 }], fetch: async () => jsonResponse(200), onEvent: (e) => events.push(e) });
    for (let i = 0; i < 3; i++) await t.request({ method: 'GET', url: 'https://x.test/console/v1/gates' });
    const paced = events.filter((e) => e.type === 'paced');
    expect(paced).toHaveLength(1); // only the third request had to wait
    expect(paced[0]).toMatchObject({ type: 'paced', url: 'https://x.test/console/v1/gates' });
    expect((paced[0] as { waitMs: number }).waitMs).toBeGreaterThan(0);
    expect(delays.length).toBeGreaterThan(0); // and it did wait
    // Order: paced is announced before the request goes out.
    const idx = events.findIndex((e) => e.type === 'paced');
    expect(events[idx + 1]?.type).toBe('request');
  });
});

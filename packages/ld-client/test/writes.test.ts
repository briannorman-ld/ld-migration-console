import { describe, expect, it } from 'vitest';
import { LdClient } from '../src/index.ts';

const TOKEN = 'api-00000000-test-token-never-logged';

/** A client over a recording fetch; `respond` decides each response. */
function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { method: string; url: string; signal: AbortSignal | null | undefined }[] = [];
  const c = new LdClient({
    instance: 'us',
    token: TOKEN,
    transport: {
      retry: { baseDelayMs: 1, maxDelayMs: 2 },
      fetch: async (input, init) => {
        calls.push({ method: init?.method ?? 'GET', url: String(input), signal: init?.signal });
        return respond(String(input), init ?? {});
      },
    },
  });
  return { c, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** What a real fetch does: never resolves, rejects with the reason as soon as the signal aborts. */
const pendingUntilAborted = (signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('LdClient writes and AbortSignal', () => {
  it('every write forwards its signal to the transport: an aborted one rejects before anything reaches LaunchDarkly, with no retry', async () => {
    const { c, calls } = client(() => ok({}));
    const ctrl = new AbortController();
    const reason = new DOMException('Cancelled by the user.', 'AbortError');
    ctrl.abort(reason);
    const s = ctrl.signal;
    const writes: (() => Promise<unknown>)[] = [
      () => c.createFlag('p', { key: 'f' }, s),
      () => c.patchFlagSemantic('p', 'f', { instructions: [] }, { signal: s }),
      () => c.patchFlagJson('p', 'f', [], { signal: s }),
      () => c.deleteFlag('p', 'f', s),
      () => c.createSegment('p', 'e', { key: 's', name: 's' }, s),
      () => c.patchSegmentJson('p', 'e', 's', [], { signal: s }),
      () => c.deleteSegment('p', 'e', 's', s),
      () => c.putContextKind('p', 'k', { name: 'k' }, s),
      () => c.createMetric('p', { key: 'm' }, s),
      () => c.patchMetricJson('p', 'm', [], { signal: s }),
      () => c.deleteMetric('p', 'm', s),
      () => c.createExperiment('p', 'e', { key: 'x' }, s),
      () => c.createIteration('p', 'e', 'x', {}, s),
      () => c.patchExperimentSemantic('p', 'e', 'x', { instructions: [] }, s),
      () => c.putExperimentationSettings('p', { randomizationUnits: [] }, s),
      () => c.createEnvironment('p', { key: 'e2', name: 'e2', color: 'fff' }, s),
      () => c.deleteEnvironment('p', 'e2', s),
    ];
    for (const w of writes) await expect(w()).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  it('an abort mid-request is not reported as a LaunchDarkly write error (the executor treats it as a cancel)', async () => {
    const ctrl = new AbortController();
    const { c } = client((_url, init) => pendingUntilAborted(init.signal!));
    const req = c.createFlag('p', { key: 'f' }, ctrl.signal);
    ctrl.abort(new DOMException('Cancelled by the user.', 'AbortError'));
    const err: unknown = await req.catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });
});

import { describe, expect, it } from 'vitest';
import { LdClient } from '../src/index.ts';

const TOKEN = 'api-00000000-test-token-never-logged';
const flag = (i: number) => ({ key: `f${i}`, name: `f${i}`, kind: 'boolean', variations: [], tags: [] });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('LdClient.listFlags', () => {
  it('reads the first page, then the rest at once, in order, reporting progress', async () => {
    const total = 350;
    const offsets: number[] = [];
    let waiting: (() => void)[] = [];
    const c = new LdClient({
      instance: 'us',
      token: TOKEN,
      transport: {
        limiter: { initial: 6, max: 6 },
        fetch: async (input) => {
          const u = new URL(String(input));
          const offset = Number(u.searchParams.get('offset'));
          offsets.push(offset);
          expect(u.searchParams.get('limit')).toBe('100');
          const items = Array.from({ length: Math.min(100, total - offset) }, (_, i) => flag(offset + i));
          if (offset === 0) return json({ items, totalCount: total });
          // Pages after the first resolve only once all three were requested: a sequential walk would hang here.
          await new Promise<void>((r) => {
            waiting.push(r);
            if (waiting.length === 3) {
              waiting.forEach((w) => w());
              waiting = [];
            }
          });
          return json({ items, totalCount: total });
        },
      },
    });
    const progress: [number, number | undefined][] = [];
    const out = await c.listFlags('p', { onPage: (read, t) => progress.push([read, t]) });
    expect(out.map((f) => f.key)).toEqual(Array.from({ length: total }, (_, i) => `f${i}`));
    expect(offsets).toEqual([0, 100, 200, 300]);
    expect(progress[0]).toEqual([100, 350]);
    expect(progress.at(-1)).toEqual([350, 350]);
  }, 2_000);

  it('without a total count, walks page by page until a short one', async () => {
    const offsets: number[] = [];
    const c = new LdClient({
      instance: 'us',
      token: TOKEN,
      transport: {
        fetch: async (input) => {
          const offset = Number(new URL(String(input)).searchParams.get('offset'));
          offsets.push(offset);
          return json({ items: Array.from({ length: offset < 200 ? 100 : 7 }, (_, i) => flag(offset + i)) });
        },
      },
    });
    const out = await c.listFlags('p');
    expect(out).toHaveLength(207);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it('a project that fits one page makes one request', async () => {
    let calls = 0;
    const c = new LdClient({ instance: 'us', token: TOKEN, transport: { fetch: async () => (calls++, json({ items: [flag(1)], totalCount: 1 })) } });
    expect(await c.listFlags('p')).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

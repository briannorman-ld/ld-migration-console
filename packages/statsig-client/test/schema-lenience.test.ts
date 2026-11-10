import { describe, expect, it } from 'vitest';
import { GateSchema, StatsigConsoleClient, StatsigSchemaError, type SchemaIssue } from '../src/index.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const gate = (id: string) => ({ id, name: id, isEnabled: true, idType: 'userID', rules: [], status: 'In Progress', tags: [] });

function client(bodies: Record<string, unknown>, issues: SchemaIssue[]) {
  return new StatsigConsoleClient({
    baseUrl: 'https://statsig.test/console/v1',
    apiKey: 'console-test-key-never-logged',
    transport: { fetch: async (input) => json(bodies[new URL(String(input)).pathname.replace('/console/v1', '')] ?? { message: 'not found' }) },
    onSchemaIssue: (i) => issues.push(i),
  });
}

describe('schema lenience (SECURITY-REVIEW M5)', () => {
  it('keeps a list item with odd fields (logged), drops one that is not an object, keeps the rest', async () => {
    const issues: SchemaIssue[] = [];
    const c = client({ '/gates': { data: [gate('a'), 'not an object', { name: 'no id' }, gate('c')], pagination: { nextPage: null } } }, issues);
    const gates = await c.list('/gates', GateSchema);
    expect(gates.map((g) => g.id)).toEqual(['a', undefined, 'c']);
    expect(issues.map((i) => i.index)).toEqual([1, 2]);
  });

  it('hands back a single object with odd fields (logged) but throws a typed error for a body that is not an object', async () => {
    const issues: SchemaIssue[] = [];
    const c = client({ '/gates/x': { data: { name: 'no id' } }, '/gates/y': { data: 'just a string' } }, issues);
    expect(await c.get('/gates/x', GateSchema)).toEqual({ name: 'no id' });
    await expect(c.get('/gates/y', GateSchema)).rejects.toBeInstanceOf(StatsigSchemaError);
    await expect(c.get('/gates/y', GateSchema)).rejects.toThrow(/unexpected shape for \/gates\/y/);
    expect(issues.length).toBe(3);
  });
});

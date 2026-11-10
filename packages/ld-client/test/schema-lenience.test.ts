import { describe, expect, it } from 'vitest';
import { LdClient, LdSchemaError, type LdSchemaIssue } from '../src/index.ts';

const TOKEN = 'api-00000000-test-token-never-logged';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function client(bodies: Record<string, unknown>, issues: LdSchemaIssue[]) {
  return new LdClient({
    instance: 'us',
    token: TOKEN,
    transport: { fetch: async (input) => json(bodies[new URL(String(input)).pathname.replace('/api/v2', '')] ?? { message: 'not found' }) },
    onSchemaIssue: (i) => issues.push(i),
  });
}

describe('schema lenience (SECURITY-REVIEW M5)', () => {
  it('keeps list items with odd fields (logged) and drops items that are not objects', async () => {
    const issues: LdSchemaIssue[] = [];
    const c = client({ '/projects/p/context-kinds': { items: [{ key: 'user', name: 'User' }, 'garbage', { name: 'no key' }] } }, issues);
    const out = await c.listContextKinds('p');
    expect(out.items).toEqual([{ key: 'user', name: 'User' }, { name: 'no key' }]);
    expect(issues.length).toBe(2);
    expect(issues[1]!.issues[0]!.message).toMatch(/1 item\(s\) that were not objects dropped/);
  });

  it('hands back a single object with odd fields (logged) but throws a typed error for a body that is not an object', async () => {
    const issues: LdSchemaIssue[] = [];
    const c = client({ '/projects/p/environments/production': { key: 'production', color: 42 }, '/projects/p/environments/staging': 'nope' }, issues);
    expect(await c.getEnvironment('p', 'production')).toMatchObject({ key: 'production' });
    await expect(c.getEnvironment('p', 'staging')).rejects.toBeInstanceOf(LdSchemaError);
    expect(issues.length).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { buildCsp, CONNECT_HOSTS } from '../csp.ts';
import vercel from '../vercel.json';

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `))?.split(' ').slice(1) ?? [];

describe('Content-Security-Policy', () => {
  it('limits connect-src to self + the StatSig and LaunchDarkly API hosts in production', () => {
    const csp = buildCsp('production');
    expect(directive(csp, 'connect-src')).toEqual(["'self'", ...CONNECT_HOSTS]);
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'default-src')).toEqual(["'none'"]);
  });

  it('only relaxes what Vite HMR needs in development', () => {
    const csp = buildCsp('development');
    expect(directive(csp, 'connect-src').filter((h) => !h.startsWith('ws://'))).toEqual(["'self'", ...CONNECT_HOSTS]);
    expect(csp).not.toContain('unsafe-eval');
  });

  it('vercel.json sends the same policy, plus frame-ancestors', () => {
    const header = vercel.headers[0]?.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy');
    expect(header?.value).toBe(buildCsp('production', { includeFrameAncestors: true }));
  });
});

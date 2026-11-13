import { describe, expect, it } from 'vitest';
import { demoBaseUrl } from './sourceOrigin.ts';

describe('demoBaseUrl', () => {
  const here = 'https://console.example';

  it('honours a same-origin base URL on a demo source', () => {
    expect(demoBaseUrl({ isDemo: true }, `${here}/__demo/posthog`, here)).toBe(`${here}/__demo/posthog`);
  });

  it('ignores a base URL on a real source, same-origin or not', () => {
    expect(demoBaseUrl({ isDemo: false }, `${here}/__demo/posthog`, here)).toBeUndefined();
    expect(demoBaseUrl({}, 'https://app.launchdarkly.com', here)).toBeUndefined();
  });

  it('ignores a demo base URL that points off this origin', () => {
    expect(demoBaseUrl({ isDemo: true }, 'https://attacker.example/__demo/posthog', here)).toBeUndefined();
    expect(demoBaseUrl({ isDemo: true }, 'http://console.example/__demo/posthog', here)).toBeUndefined();
  });

  it('ignores a missing or malformed base URL', () => {
    expect(demoBaseUrl({ isDemo: true }, undefined, here)).toBeUndefined();
    expect(demoBaseUrl({ isDemo: true }, 'not a url', here)).toBeUndefined();
  });
});

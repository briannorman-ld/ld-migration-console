import { afterEach, describe, expect, it } from 'vitest';
import { CONSOLE_FLAGS, flagEnabled, isPostHogKind, setFlagOverride, whenFlagsReady } from './flags.ts';

describe('console flags', () => {
  afterEach(() => setFlagOverride('posthogSource', undefined));

  it('serves the safe default without a LaunchDarkly connection (tests never connect)', async () => {
    await whenFlagsReady();
    expect(flagEnabled('posthogSource')).toBe(CONSOLE_FLAGS.posthogSource.default);
    expect(CONSOLE_FLAGS.posthogSource.default).toBe(false);
  });

  it('lets a test pin a flag and lift the pin again', () => {
    setFlagOverride('posthogSource', true);
    expect(flagEnabled('posthogSource')).toBe(true);
    setFlagOverride('posthogSource', undefined);
    expect(flagEnabled('posthogSource')).toBe(false);
  });

  it('knows both PostHog source kinds', () => {
    expect(isPostHogKind('posthog')).toBe(true);
    expect(isPostHogKind('posthog_payload')).toBe(true);
    expect(isPostHogKind('console_api')).toBe(false);
  });
});

describe('console flags SDK options', () => {
  it('opts out of diagnostics and never fetches Experimentation goals', async () => {
    const { sdkOptions } = await import('./flags.ts');
    expect(sdkOptions()).toMatchObject({ diagnosticOptOut: true, fetchGoals: false });
    expect(sdkOptions()).not.toHaveProperty('bootstrap');
    expect(sdkOptions({ 'posthog-source': true }).bootstrap).toEqual({ 'posthog-source': true });
  });
});

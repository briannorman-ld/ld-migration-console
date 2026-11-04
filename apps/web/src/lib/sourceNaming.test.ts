import { describe, expect, it } from 'vitest';
import { deriveAlias, MAX_ALIAS_LENGTH, specSourceLabel } from './sourceNaming.ts';

describe('deriveAlias', () => {
  it('lowercases and keeps only a-z, 0-9 and dashes', () => {
    expect(deriveAlias('Acme Web (Prod)', [])).toBe('acme-web-prod');
    expect(deriveAlias('legacy_storefront', [])).toBe('legacy-storefront');
  });

  it('caps the length without leaving a trailing dash', () => {
    const alias = deriveAlias('a very long statsig project name indeed', []);
    expect(alias.length).toBeLessThanOrEqual(MAX_ALIAS_LENGTH);
    expect(alias).toBe('a-very-long-statsig-proj');
    expect(deriveAlias('abcdefghijklmnopqrstuvw-xyz', [])).toBe('abcdefghijklmnopqrstuvw');
  });

  it('falls back when nothing usable is left', () => {
    expect(deriveAlias('', [])).toBe('src');
    expect(deriveAlias('***', [], 'spec')).toBe('spec');
  });

  it('numbers an alias another source already uses', () => {
    expect(deriveAlias('web', ['web'])).toBe('web-2');
    expect(deriveAlias('web', ['web', 'web-2'])).toBe('web-3');
    expect(deriveAlias('Web', ['mobile'])).toBe('web');
  });

  it('keeps the numbered alias within the cap', () => {
    const long = 'abcdefghijklmnopqrstuvwxyz';
    const first = deriveAlias(long, []);
    const second = deriveAlias(long, [first]);
    expect(second.length).toBeLessThanOrEqual(MAX_ALIAS_LENGTH);
    expect(second.endsWith('-2')).toBe(true);
  });
});

describe('specSourceLabel', () => {
  it('drops the spec file extensions', () => {
    expect(specSourceLabel('download_config_specs.v2.json')).toBe('download_config_specs.v2');
    expect(specSourceLabel('spec.json.gz')).toBe('spec');
    expect(specSourceLabel('.json')).toBe('Config spec');
  });
});

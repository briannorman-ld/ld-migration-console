import { beforeEach, describe, expect, it } from 'vitest';
import { loadEnv, saveEnv } from './envChoice.ts';

describe('environment choice', () => {
  beforeEach(() => localStorage.clear());

  it('survives a reload, per workspace, and an empty choice clears it', () => {
    expect(loadEnv('w1')).toBeUndefined();
    saveEnv('w1', 'staging');
    saveEnv('w2', 'development');
    expect(loadEnv('w1')).toBe('staging');
    expect(loadEnv('w2')).toBe('development');
    saveEnv('w1', '');
    expect(loadEnv('w1')).toBeUndefined();
    expect(localStorage.getItem('ld-migration:env:w1')).toBeNull();
  });
});

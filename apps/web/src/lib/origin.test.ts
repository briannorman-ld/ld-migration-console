import { describe, expect, it } from 'vitest';
import { isFramed, isSharedOrigin } from './origin.ts';

describe('origin', () => {
  it('treats every GitHub Pages host as shared, and nothing else', () => {
    expect(isSharedOrigin('briannorman-ld.github.io')).toBe(true);
    expect(isSharedOrigin('Owner.GitHub.IO')).toBe(true);
    expect(isSharedOrigin('github.io')).toBe(true);
    expect(isSharedOrigin('ld-migration-console.vercel.app')).toBe(false);
    expect(isSharedOrigin('localhost')).toBe(false);
    expect(isSharedOrigin('github.io.example.com')).toBe(false);
    expect(isSharedOrigin('notgithub.io')).toBe(false);
    expect(isSharedOrigin('')).toBe(false);
  });

  it('is framed when top is another window, or cannot be read at all', () => {
    const self = {};
    expect(isFramed({ top: self, self })).toBe(false);
    expect(isFramed({ top: {}, self })).toBe(true);
    expect(isFramed({ top: null, self })).toBe(true);
    const crossOrigin = { self } as { readonly top: unknown; readonly self: unknown };
    Object.defineProperty(crossOrigin, 'top', {
      get() {
        throw new DOMException('Blocked a frame with origin from accessing a cross-origin frame.', 'SecurityError');
      },
    });
    expect(isFramed(crossOrigin)).toBe(true);
    // The test page itself is a top-level window.
    expect(isFramed()).toBe(false);
  });
});

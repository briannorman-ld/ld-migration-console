import { describe, expect, it } from 'vitest';
import { matchesTags, pruneTags, tagOptions, UNTAGGED } from './tags.ts';

describe('tag filter', () => {
  const items = [
    { tags: ['checkout', 'Mobile'] },
    { tags: ['checkout'] },
    { tags: ['checkout', 'checkout'], archived: true },
    { tags: [] },
    { tags: ['mobile'] },
  ];

  it('lists the tags in use, most used first then by name ignoring case, archived items left out, and "no tag" last', () => {
    expect(tagOptions(items)).toEqual([
      { tag: 'checkout', count: 2 },
      { tag: 'Mobile', count: 1 },
      { tag: 'mobile', count: 1 },
      { tag: UNTAGGED, count: 1 },
    ]);
    expect(tagOptions([{ tags: ['a'] }])).toEqual([{ tag: 'a', count: 1 }]);
  });

  it('keeps items carrying any chosen tag; untagged items only for the "no tag" choice; everything when nothing is chosen', () => {
    expect(matchesTags(['x'], new Set())).toBe(true);
    expect(matchesTags(['checkout', 'web'], new Set(['web', 'mobile']))).toBe(true);
    expect(matchesTags(['checkout'], new Set(['web']))).toBe(false);
    expect(matchesTags([], new Set(['web']))).toBe(false);
    expect(matchesTags([], new Set([UNTAGGED]))).toBe(true);
    expect(matchesTags(['web'], new Set([UNTAGGED]))).toBe(false);
  });

  it('forgets a chosen tag that no item carries any more', () => {
    expect([...pruneTags(new Set(['checkout', 'gone', UNTAGGED]), tagOptions(items))]).toEqual(['checkout', UNTAGGED]);
  });
});

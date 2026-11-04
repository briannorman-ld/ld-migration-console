/**
 * Filtering a resource page by tag. Tags come from the source as free strings (StatSig tags, or
 * an LD-source project's flag and segment tags); the filter lists the ones in use with how many
 * live items carry each, and keeps the items that carry any of the chosen tags. `UNTAGGED` is a
 * pseudo-tag for items with no tag at all, so "what has no tag yet" is one click too.
 */

export const UNTAGGED = '\u0000untagged';

export interface TagOption {
  tag: string;
  /** Items carrying the tag, archived ones left out (the page hides them by default). */
  count: number;
}

/**
 * Tags in use across `items`, most used first, then by name (case-insensitive). The untagged
 * pseudo-tag is listed last when at least one item has no tag. Tags are kept as written: StatSig
 * tags are case-sensitive and may differ by case between sources.
 */
export function tagOptions(items: readonly { tags: readonly string[]; archived?: boolean }[]): TagOption[] {
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const it of items) {
    if (it.archived) continue;
    if (it.tags.length === 0) {
      untagged++;
      continue;
    }
    for (const t of new Set(it.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const out = [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
  if (untagged) out.push({ tag: UNTAGGED, count: untagged });
  return out;
}

/** An item passes when no tag is chosen, or it carries one of the chosen tags (untagged items pass for `UNTAGGED`). */
export function matchesTags(tags: readonly string[], chosen: ReadonlySet<string>): boolean {
  if (chosen.size === 0) return true;
  if (tags.length === 0) return chosen.has(UNTAGGED);
  return tags.some((t) => chosen.has(t));
}

/** Drops chosen tags that no item carries any more (after a re-sync, say), so a stale choice never hides everything. */
export function pruneTags(chosen: ReadonlySet<string>, options: readonly TagOption[]): Set<string> {
  const known = new Set(options.map((o) => o.tag));
  return new Set([...chosen].filter((t) => known.has(t)));
}

/** The label shown for a tag option. */
export const tagLabel = (tag: string): string => (tag === UNTAGGED ? 'No tag' : tag);

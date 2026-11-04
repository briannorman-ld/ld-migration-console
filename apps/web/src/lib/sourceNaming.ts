/**
 * Names for a source the user attaches. Nothing here is typed by the user: the label comes from
 * the source itself (the StatSig project name, the LaunchDarkly project, the uploaded file) and
 * the alias is derived from it.
 *
 * The alias matters more than it looks: it is the `migration-src-<alias>` tag on every resource
 * the console creates, the `sourceAlias` in provenance the planner uses to tell one source's
 * flags from another's, and the key prefix when several sources consolidate (PLAN §12). It has
 * to be unique within the workspace and must not change once anything has been migrated, so it
 * is fixed when the source is added.
 */

/** Longest alias; it is embedded in LD tags, which cap at 64 characters with the prefix. */
export const MAX_ALIAS_LENGTH = 24;

/**
 * Turn a project name or key into an alias: lowercase, `a-z0-9-` only, at most 24 characters,
 * and unique against `taken` (`web`, then `web-2`, `web-3`, …). An empty seed falls back to
 * `fallback`.
 */
export function deriveAlias(seed: string, taken: Iterable<string>, fallback = 'src'): string {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_ALIAS_LENGTH)
      .replace(/-+$/g, '') || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_ALIAS_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The label of a config-spec source: the file it was uploaded from, without the extensions. */
export function specSourceLabel(filename: string): string {
  const stem = filename.replace(/\.(json|gz|br)$/gi, '').replace(/\.(json|gz|br)$/gi, '');
  return stem || 'Config spec';
}

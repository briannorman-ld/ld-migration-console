/**
 * A LaunchDarkly listing (segments of one environment, AI Configs) indexed by key, built once per
 * array and kept for its lifetime. The explorers, the guide and the plan look a key up for every
 * row in every environment; scanning the whole listing each time made that quadratic.
 */
const indexes = new WeakMap<object, Map<string, unknown>>();

export function indexByKey<T extends { key: string }>(list: readonly T[]): Map<string, T> {
  let m = indexes.get(list) as Map<string, T> | undefined;
  if (!m) {
    m = new Map();
    for (const x of list) if (!m.has(x.key)) m.set(x.key, x);
    indexes.set(list, m);
  }
  return m;
}

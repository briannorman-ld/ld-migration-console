/**
 * `table[key]` only when `key` is the table's own property. Lookup tables keyed by source data (a
 * condition's `field` or `type`, a unit type, an environment or flag name) must not reach
 * `Object.prototype`: `constructor`, `toString` or `__proto__` would otherwise come back as a
 * Function or an object, pass a truthiness check and sit in the snapshot, where a Function fails
 * structured clone and a legitimate custom field named `constructor` breaks the whole upload.
 */
export function ownValue<V>(table: Readonly<Record<string, V>> | undefined | null, key: string | null | undefined): V | undefined {
  if (!table || key === null || key === undefined) return undefined;
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

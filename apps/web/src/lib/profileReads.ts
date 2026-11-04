/**
 * Which parts of the mapping profile a mapping read (lib/migration.ts memo). The profile is one
 * object that the Mapping, Unit types and People pages and every policy rewrite wholesale, and a
 * mapping reads a handful of its entries: the policy for each decision it raised, its source's
 * unit-type choices, the attribute names of its conditions, its owner's maintainer choice. A new
 * profile that changes none of those leaves the mapping valid, so the memo records what was read
 * and checks only that.
 *
 * Reads are recorded as paths from the profile root. A primitive read keeps the value seen; a read
 * that found an object keeps that fact (the object's own fields are recorded as they are read in
 * turn); an enumeration (`Object.keys`, `Object.values`, spread) keeps the subtree as JSON, since
 * any key added or removed there changes what the mapper saw.
 */

export type ProfileRead = { path: string[]; kind: 'value'; value: unknown } | { path: string[]; kind: 'object' } | { path: string[]; kind: 'json'; json: string };

const SEP = '\u0000';

/**
 * `root` behind a proxy that records every read made through it. `reads()` lists them (each path
 * once). The proxy must not escape into a result: results are kept and cloned, and a Proxy is not
 * cloneable. The mapper reads the profile for strings and never puts a part of it in its output.
 */
export function trackReads<T extends object>(root: T): { value: T; reads: () => ProfileRead[] } {
  const reads = new Map<string, ProfileRead>();
  const proxies = new Map<string, object>();
  const record = (r: ProfileRead) => {
    const k = `${r.kind}${SEP}${r.path.join(SEP)}`;
    if (!reads.has(k)) reads.set(k, r);
  };
  const note = (path: string[], v: unknown) => record(v !== null && typeof v === 'object' ? { path, kind: 'object' } : { path, kind: 'value', value: v });
  const wrap = (target: object, path: string[]): object => {
    const k = path.join(SEP);
    let p = proxies.get(k);
    if (p) return p;
    p = new Proxy(target, {
      get(t, prop, receiver) {
        const v = Reflect.get(t, prop, receiver);
        if (typeof prop !== 'string' || typeof v === 'function') return v;
        const at = [...path, prop];
        note(at, v);
        return v !== null && typeof v === 'object' ? wrap(v, at) : v;
      },
      has(t, prop) {
        if (typeof prop === 'string') note([...path, prop], (t as Record<string, unknown>)[prop]);
        return Reflect.has(t, prop);
      },
      ownKeys(t) {
        record({ path, kind: 'json', json: JSON.stringify(t) });
        return Reflect.ownKeys(t);
      },
    });
    proxies.set(k, p);
    return p;
  };
  return { value: wrap(root, []) as T, reads: () => [...reads.values()] };
}

function resolve(root: unknown, path: string[]): unknown {
  let v = root;
  for (const p of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[p];
  }
  return v;
}

// The JSON of an enumerated subtree, once per (profile object, path): thousands of entries check
// the same few subtrees against the same new profile.
const jsonCache = new WeakMap<object, Map<string, string>>();
function subtreeJson(root: object, path: string[]): string {
  let m = jsonCache.get(root);
  if (!m) jsonCache.set(root, (m = new Map()));
  const k = path.join(SEP);
  let s = m.get(k);
  if (s === undefined) m.set(k, (s = JSON.stringify(resolve(root, path)) ?? 'undefined'));
  return s;
}

/** Whether every recorded read finds the same thing in `root`. */
export function readsHold(reads: readonly ProfileRead[], root: object): boolean {
  for (const r of reads) {
    if (r.kind === 'json') {
      if (subtreeJson(root, r.path) !== r.json) return false;
      continue;
    }
    const v = resolve(root, r.path);
    if (r.kind === 'object' ? v === null || typeof v !== 'object' : v !== r.value) return false;
  }
  return true;
}

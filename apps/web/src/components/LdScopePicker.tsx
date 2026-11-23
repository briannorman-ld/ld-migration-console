import { LD_DEFAULT_RESOURCES, LD_NOT_READ, LD_RESOURCE_GROUP_LABEL, LD_RESOURCE_GROUPS, LD_RESOURCE_INFO, LD_RESOURCE_KINDS, type LdResourceInfo, type LdResourceKind } from '@sslm/canonical';
import { Badge, cx } from './ui.tsx';

/** Kinds a scope must keep for the ones that need them to stay tickable (per-flag routes need the flag list). */
export function withRequirements(kinds: Set<LdResourceKind>): Set<LdResourceKind> {
  const next = new Set(kinds);
  for (const k of next) for (const r of LD_RESOURCE_INFO[k].requires ?? []) next.add(r);
  return next;
}

/** Drop every kind whose requirement is not in the set (after unticking flags, the per-flag kinds go too). */
export function withoutOrphans(kinds: Set<LdResourceKind>): Set<LdResourceKind> {
  return new Set([...kinds].filter((k) => (LD_RESOURCE_INFO[k].requires ?? []).every((r) => kinds.has(r))));
}

const FLAGS_AND_SEGMENTS: LdResourceKind[] = ['flags', 'segments'];

function costHint(info: LdResourceInfo, counts: { flags?: number; environments?: number }): string | undefined {
  const f = counts.flags;
  const e = counts.environments;
  switch (info.requests) {
    case 'per_flag_environment':
      return f != null && e != null ? `${(f * e).toLocaleString()} requests (one per flag per environment)` : 'one request per flag per environment';
    case 'per_flag':
      return f != null ? `${f.toLocaleString()} requests (one per flag)` : 'one request per flag';
    case 'per_environment':
      return e != null ? `${e} request${e === 1 ? '' : 's'} (one per environment)` : 'one request per environment';
    case 'per_item':
      return info.kind === 'flags' ? (f != null ? `${(f + 1).toLocaleString()} requests (one per flag)` : 'one request per flag') : 'one request per item';
    default:
      return undefined;
  }
}

/**
 * The read scope of a LaunchDarkly source (PLAN §20.6): every LD resource type the console can
 * read, grouped, with its read cost and what happens to it after the read. Shared by Add source
 * and the inventory explorer's scope editor. The per-flag-per-environment kinds are off by default
 * because a project of hundreds of flags makes them thousands of requests each.
 */
export function LdScopePicker({
  value,
  onChange,
  idPrefix = 'ld-scope',
  counts = {},
  disabled = false,
}: {
  value: Set<LdResourceKind>;
  onChange: (next: Set<LdResourceKind>) => void;
  idPrefix?: string;
  /** When known (an existing source), sizes the per-flag and per-environment hints. */
  counts?: { flags?: number; environments?: number };
  disabled?: boolean;
}) {
  const toggle = (k: LdResourceKind, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(k);
    else next.delete(k);
    onChange(on ? withRequirements(next) : withoutOrphans(next));
  };
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1.5 text-xs font-semibold tracking-wide text-fg-muted uppercase">Resources to read</legend>
      <p className="mb-2 text-xs text-fg-muted">
        Every resource type of the project and its account that the API lets a reader list. Uncheck what you don’t need; the kinds marked <b>per flag per environment</b> have no
        project-wide listing and are off by default. What each becomes in the target is on the <i>What migrates</i> page.
      </p>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {LD_RESOURCE_GROUPS.map((g) => (
          <div key={g}>
            <div className="mb-1 text-xs font-medium text-fg-muted">{LD_RESOURCE_GROUP_LABEL[g]}</div>
            <ul className="space-y-1">
              {LD_RESOURCE_KINDS.filter((k) => LD_RESOURCE_INFO[k].group === g).map((k) => {
                const info = LD_RESOURCE_INFO[k];
                const blocked = (info.requires ?? []).some((r) => !value.has(r));
                const hint = costHint(info, counts);
                return (
                  <li key={k}>
                    <label className={cx('flex items-start gap-2 text-sm', blocked && 'opacity-60')} title={info.description}>
                      <input id={`${idPrefix}-${k}`} type="checkbox" className="mt-1" checked={value.has(k)} disabled={blocked} onChange={(e) => toggle(k, e.target.checked)} />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {info.label}
                          {info.beta && <Badge tone="slate">beta</Badge>}
                          {info.handling === 'migrates' && <Badge tone="green">migrates</Badge>}
                          {info.handling === 'with_flag' && <Badge tone="blue">with its flag</Badge>}
                          {info.handling === 'people' && <Badge tone="blue">people step</Badge>}
                          {info.handling === 'inventory' && <Badge tone="amber">listed</Badge>}
                        </span>
                        {(hint || blocked) && (
                          <span className="block text-xs text-fg-muted">
                            {blocked ? `needs ${(info.requires ?? []).map((r) => LD_RESOURCE_INFO[r].label.toLowerCase()).join(', ')}` : hint}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <button type="button" className="text-link hover:underline" onClick={() => onChange(new Set(LD_RESOURCE_KINDS))}>
          Everything
        </button>
        <button type="button" className="text-link hover:underline" onClick={() => onChange(new Set(LD_DEFAULT_RESOURCES))}>
          Default (everything but the per-flag reads)
        </button>
        <button type="button" className="text-link hover:underline" onClick={() => onChange(new Set(FLAGS_AND_SEGMENTS))}>
          Flags and segments only
        </button>
      </div>
      {value.size === 0 && <p className="mt-1.5 text-xs text-error">Pick at least one resource kind.</p>}
      <details className="mt-2 text-xs text-fg-muted">
        <summary className="cursor-pointer">Never read, and why</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {LD_NOT_READ.map((n) => (
            <li key={n.label}>
              <b>{n.label}</b>: {n.reason}
            </li>
          ))}
        </ul>
      </details>
    </fieldset>
  );
}

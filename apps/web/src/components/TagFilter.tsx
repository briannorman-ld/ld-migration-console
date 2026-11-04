import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { tagLabel, UNTAGGED, type TagOption } from '../lib/tags.ts';
import { cx } from './ui.tsx';

/**
 * "Tags" filter for the resource pages: a button that says how many tags are chosen, opening a
 * panel of checkboxes (one per tag in use, with its count) that can be narrowed by typing. Items
 * carrying any chosen tag stay visible (lib/tags.ts). Renders nothing when no item has a tag.
 */
export function TagFilter({ options, chosen, onChange, noun = 'items', className }: { options: readonly TagOption[]; chosen: ReadonlySet<string>; onChange: (next: Set<string>) => void; noun?: string; className?: string }) {
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.tag !== UNTAGGED && o.tag.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (options.length === 0) return null;

  const toggle = (tag: string) => {
    const next = new Set(chosen);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange(next);
  };
  const active = chosen.size > 0;

  return (
    <div ref={root} className={cx('relative', className)}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Filter by tag"
        title={active ? `Showing ${noun} tagged ${[...chosen].map(tagLabel).join(', ')}` : `Show only ${noun} with chosen tags`}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm shadow-card transition-[border-color,box-shadow,background-color] duration-150 hover:border-line-strong focus:outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/20',
          active ? 'border-accent/60 bg-accent/10 text-fg' : 'border-line bg-surface text-fg',
        )}
      >
        Tags
        {active && <span className="rounded-full bg-accent px-1.5 text-xs leading-5 font-semibold text-on-accent tabular-nums">{chosen.size}</span>}
        <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 text-fg-muted">
          <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id={panelId} role="dialog" aria-label="Tags" hidden={!open} className="absolute right-0 z-30 mt-1 w-72 rounded-md border border-line bg-surface p-2 text-sm shadow-card">
        <div className="mb-1.5 flex items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a tag"
            aria-label="Find a tag"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/25"
          />
          {active && (
            <button type="button" className="shrink-0 text-xs text-link hover:underline" onClick={() => onChange(new Set())}>
              Clear
            </button>
          )}
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {shown.length === 0 && <li className="px-1.5 py-1 text-fg-muted">No tag matches</li>}
          {shown.map((o) => (
            <li key={o.tag}>
              <label className={cx('flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface-2', o.tag === UNTAGGED && 'mt-1 border-t border-line-soft pt-1.5 text-fg-muted')}>
                <input type="checkbox" aria-label={`${tagLabel(o.tag)} (${o.count.toLocaleString()})`} checked={chosen.has(o.tag)} onChange={() => toggle(o.tag)} />
                <span className={cx('min-w-0 flex-1 truncate', o.tag !== UNTAGGED && 'font-mono text-[13px]')}>{tagLabel(o.tag)}</span>
                <span className="text-xs text-fg-muted tabular-nums">{o.count.toLocaleString()}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 px-1.5 text-xs text-fg-subtle">Items with any chosen tag are shown. Counts leave archived items out.</p>
      </div>
    </div>
  );
}

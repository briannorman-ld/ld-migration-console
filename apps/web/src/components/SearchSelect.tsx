import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from './ui.tsx';

export interface SearchSelectOption {
  /** Stable value, also shown muted after the name (an LD project key, say). */
  key: string;
  name: string;
}

/**
 * A single-select combobox for long lists: type to filter on name or key, arrow keys to move,
 * Enter to pick, Escape to close. Replaces a native `<select>` where an account can have
 * hundreds of entries (LD projects). ARIA 1.2 combobox pattern: the input owns a listbox and
 * points at the active option with `aria-activedescendant`.
 */
export function SearchSelect({
  id,
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  emptyText = 'No matches',
  disabled,
  className,
}: {
  id: string;
  value: string;
  options: SearchSelectOption[];
  onChange: (key: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null); // null: show the selected label
  const [active, setActive] = useState(0);

  const selected = options.find((o) => o.key === value);
  const label = selected ? `${selected.name} (${selected.key})` : '';
  const shown = useMemo(() => filterOptions(options, query ?? ''), [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const close = () => {
    setOpen(false);
    setQuery(null);
    setActive(0);
  };
  const pick = (o: SearchSelectOption) => {
    onChange(o.key);
    close();
  };
  const openWith = (q: string | null) => {
    setQuery(q);
    setActive(0);
    setOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openWith(query);
      else setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && shown[active]) {
        e.preventDefault();
        pick(shown[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      }
    } else if (e.key === 'Tab') {
      close();
    }
  };

  const activeId = open && shown[active] ? `${listId}-${active}` : undefined;

  return (
    <div ref={root} className={cx('relative', className)}>
      <input
        id={id}
        role="combobox"
        type="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        placeholder={placeholder}
        value={query ?? label}
        onChange={(e) => openWith(e.target.value)}
        onFocus={() => openWith(null)}
        onClick={() => !open && openWith(null)}
        onKeyDown={onKeyDown}
        className={cx(
          'w-full rounded-md border border-line bg-surface py-1.5 pr-8 pl-2.5 text-sm text-fg shadow-card transition-[border-color,box-shadow] duration-150 placeholder:text-fg-subtle hover:border-line-strong focus:border-focus focus:outline-none focus:ring-2 focus:ring-focus/25 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle',
        )}
      />
      <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted">
        <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <ul
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label={placeholder}
        hidden={!open}
        className="absolute z-30 mt-1 max-h-72 w-full min-w-[20rem] overflow-y-auto rounded-md border border-line bg-surface py-1 text-sm shadow-card"
      >
        {shown.length === 0 && (
          <li className="px-2.5 py-1.5 text-fg-muted" aria-disabled>
            {emptyText}
          </li>
        )}
        {shown.map((o, i) => (
          <li
            key={o.key}
            id={`${listId}-${i}`}
            data-index={i}
            role="option"
            aria-selected={o.key === value}
            className={cx('flex cursor-pointer items-baseline gap-2 px-2.5 py-1.5', i === active && 'bg-surface-2', o.key === value && 'font-semibold')}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()} // keep focus on the input
            onClick={() => pick(o)}
          >
            <span className="truncate">{o.name}</span>
            <span className="truncate text-xs text-fg-muted">{o.key}</span>
          </li>
        ))}
        {query && shown.length > 0 && shown.length < options.length && (
          <li className="border-t border-line px-2.5 pt-1.5 pb-0.5 text-xs text-fg-subtle" aria-disabled>
            {shown.length} of {options.length}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Every whitespace-separated term must appear in the name or the key, case-insensitively. */
export function filterOptions<T extends SearchSelectOption>(options: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((o) => {
    const hay = `${o.name} ${o.key}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

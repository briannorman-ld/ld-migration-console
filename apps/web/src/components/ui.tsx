import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/*
 * Primitives on the LaunchPad semantic tokens (see index.css). Tones keep their historical names
 * (slate / green / amber / red / blue / violet) so call sites read the same; they now resolve to
 * neutral / success / warning / error / info / purple in both themes.
 */

export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return (
    <button
      type="button"
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-on-accent shadow-card hover:bg-accent-hover disabled:hover:bg-accent',
        variant === 'secondary' && 'border border-line bg-surface text-fg shadow-card hover:border-line-strong hover:bg-surface-hover disabled:hover:bg-surface',
        variant === 'ghost' && 'text-fg-muted hover:bg-surface-hover hover:text-fg',
        variant === 'danger' && 'bg-danger text-white shadow-card hover:bg-danger-hover disabled:hover:bg-danger',
        className,
      )}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-lg border border-line bg-surface shadow-card', className)}>{children}</div>;
}

const TONES = {
  slate: 'bg-surface-2 text-fg-muted ring-line',
  green: 'bg-success-bg text-success ring-success-line/40',
  amber: 'bg-warning-bg text-warning ring-warning-line/40',
  red: 'bg-error-bg text-error ring-error-line/40',
  blue: 'bg-info-bg text-info ring-info-line/40',
  violet: 'bg-purple-bg text-purple ring-purple-line/60',
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ tone = 'slate', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', TONES[tone])}>
      {children}
    </span>
  );
}

/** Small status dot, paired with a label so status never relies on color alone. */
export function Dot({ tone = 'slate', className }: { tone?: Tone; className?: string }) {
  const fill = { slate: 'bg-neutral-fill', green: 'bg-success-fill', amber: 'bg-warning-fill', red: 'bg-error-fill', blue: 'bg-info-fill', violet: 'bg-purple-fill' }[tone];
  return <span aria-hidden className={cx('inline-block h-2 w-2 shrink-0 rounded-full', fill, className)} />;
}

/**
 * Form fields. Focus shows as the focus-colour border with a soft 2px halo, on `focus-visible`
 * only, so a pointer pick on a <select> (which keeps focus) does not leave a glow behind in
 * browsers that distinguish the two; keyboard focus is always shown.
 */
const FIELD =
  'rounded-md border border-line bg-surface text-sm text-fg placeholder:text-fg-subtle shadow-card transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus:outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-subtle';

/**
 * Tailwind orders same-property utilities by value, not by position in the class string, so a
 * caller's `py-1` would lose to a default `py-2`. The defaults therefore step aside whenever the
 * caller sizes the field itself (any `p-`, `px-`, `py-` or `h-` class).
 */
function sizing(defaults: string, className: string | undefined): string {
  const own = className ?? '';
  const has = (re: RegExp) => re.test(own);
  const vertical = has(/(^|\s)(p|py|h)-/) ? '' : defaults.split(' ').filter((c) => c.startsWith('py-')).join(' ');
  const horizontal = has(/(^|\s)(p|px)-/) ? '' : defaults.split(' ').filter((c) => c.startsWith('px-')).join(' ');
  return cx(vertical, horizontal);
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx('w-full', sizing('px-3 py-2', p.className), FIELD, p.className)} />;
}

export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(sizing('px-2.5 py-1.5', p.className), FIELD, p.className)} />;
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold tracking-wide text-fg-muted uppercase">
      {children}
    </label>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label={title}>
      <Card className="w-full max-w-lg p-6 shadow-raised">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
          {onClose && <CloseButton onClick={onClose} />}
        </div>
        {children}
      </Card>
    </div>
  );
}

export function CloseButton({ onClick, disabled, className }: { onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Close"
      className={cx('inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-30', className)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

export function Callout({ tone = 'amber', children }: { tone?: 'amber' | 'red' | 'blue' | 'green'; children: ReactNode }) {
  const t = {
    amber: 'border-warning-line/50 bg-warning-bg text-fg [--callout-bar:var(--app-warning-fill)]',
    red: 'border-error-line/50 bg-error-bg text-fg [--callout-bar:var(--app-error-fill)]',
    blue: 'border-info-line/50 bg-info-bg text-fg [--callout-bar:var(--app-info-fill)]',
    green: 'border-success-line/50 bg-success-bg text-fg [--callout-bar:var(--app-success-fill)]',
  }[tone];
  return (
    <div role={tone === 'red' ? 'alert' : 'note'} className={cx('relative overflow-hidden rounded-md border py-2 pr-3 pl-4 text-sm', t)}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-[var(--callout-bar)]" />
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />;
}

/** Eyebrow + Sora page title, the standard header for every view. */
export function PageTitle({ children, eyebrow, after }: { children: ReactNode; eyebrow?: ReactNode; after?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div>
        {eyebrow && <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">{eyebrow}</div>}
        <h2 className="font-display text-xl font-semibold tracking-tight text-fg">{children}</h2>
      </div>
      {after}
    </div>
  );
}

export { cx };

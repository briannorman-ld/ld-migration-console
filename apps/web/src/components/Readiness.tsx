import type { ReactNode } from 'react';
import { Badge, Button, Card, cx, Spinner } from './ui.tsx';
import { ldConnecting } from '../lib/ld.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

/**
 * "What else must happen before I can migrate?" (PLAN §9). One line above every explorer that
 * lists the preconditions in order, marks the first unmet one, and links to where it is fixed.
 * Blocking decisions are shown but don't gate the button: the plan modal is where they get
 * answered, and it refuses to run until they are.
 */
export interface ReadinessStep {
  key: string;
  label: string;
  done: boolean;
  /** Short explanation shown when the step is not done. */
  detail?: string;
  action?: { label: string; onClick: () => void };
  /** Shown but never blocks the Migrate button. */
  advisory?: boolean;
  /** In progress by itself (a connection being made): a spinner instead of the step number. */
  busy?: boolean;
}

export interface ReadinessInput {
  m: MigrationContext;
  /** StatSig environment the explorer shows. */
  env: string;
  /** LD environments StatSig `env` maps to, across the visible sources. */
  mappedHere: string[];
  /** Whether at least one source has a synced snapshot. */
  hasSnapshot: boolean;
  kindLabel: string;
  selected: number;
  /** Open blocking decisions among the selected items. */
  blockingSelected: number;
  /** Open blocking decisions in the whole list (used when nothing is selected). */
  blockingAll: number;
  nav: { connections: () => void; ld: () => void; mapping: () => void; decisions: () => void };
}

export function readinessSteps(i: ReadinessInput): ReadinessStep[] {
  const blocking = i.selected > 0 ? i.blockingSelected : i.blockingAll;
  return [
    { key: 'source', label: 'Source synced', done: i.hasSnapshot, detail: 'Connect a source project (StatSig, or another LaunchDarkly project) and wait for its first sync.', action: { label: 'Connections', onClick: i.nav.connections } },
    !i.m.connected && ldConnecting(i.m.ld)
      ? { key: 'ld', label: 'Connecting to LaunchDarkly…', done: false, busy: true, detail: `Reconnecting with the saved token${i.m.ld.probing ? `: ${i.m.ld.probing.toLowerCase()}` : ''}…`, action: { label: 'LaunchDarkly', onClick: i.nav.ld } }
      : { key: 'ld', label: 'LaunchDarkly connected', done: i.m.connected, detail: 'Connect LaunchDarkly and choose the target project.', action: { label: 'Connect LaunchDarkly', onClick: i.nav.ld } },
    {
      key: 'mapping',
      label: `${i.env || 'environment'} mapped to LaunchDarkly`,
      done: i.mappedHere.length > 0,
      detail: i.env ? `Map StatSig “${i.env}” to a LaunchDarkly environment.` : 'Pick a StatSig environment in the header.',
      action: { label: 'Mapping', onClick: i.nav.mapping },
    },
    {
      key: 'decisions',
      label: blocking > 0 ? `${blocking.toLocaleString()} blocking decision${blocking === 1 ? '' : 's'}` : 'No blocking decisions',
      done: blocking === 0,
      detail: i.selected > 0 ? 'The plan can still be opened; blocked items wait until their decisions are answered.' : `Across the listed ${i.kindLabel}. Items with blocking decisions are planned but can't run.`,
      action: { label: 'Decisions', onClick: i.nav.decisions },
      advisory: true,
    },
    { key: 'select', label: i.selected > 0 ? `${i.selected.toLocaleString()} selected` : `Select ${i.kindLabel}`, done: i.selected > 0, detail: `Tick the boxes in the first column (or “Select all”), then migrate.` },
  ];
}

/** The first step that stops the button, or null when the plan can be opened. */
export function firstBlocker(steps: ReadinessStep[]): ReadinessStep | null {
  return steps.find((s) => !s.done && !s.advisory) ?? null;
}

export function ReadinessLine({ steps, right }: { steps: ReadinessStep[]; right?: ReactNode }) {
  const blocker = firstBlocker(steps);
  const next = blocker ?? steps.find((s) => !s.done) ?? null;
  return (
    <Card className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 text-xs">
      <span className="font-semibold tracking-wide text-fg-muted uppercase">To migrate</span>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {steps.map((s, n) => {
          const current = s === next;
          return (
            <li key={s.key} className={cx('flex items-center gap-1.5', s.done ? 'text-fg-muted' : current ? 'text-fg' : 'text-fg-subtle')}>
              {s.busy && !s.done ? (
                <span aria-hidden className="flex h-4 w-4 items-center justify-center text-fg-muted">
                  <Spinner />
                </span>
              ) : (
                <span
                  aria-hidden
                  className={cx(
                    'flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold',
                    s.done ? 'bg-success-fill text-on-accent' : s.advisory ? 'bg-warning-fill text-on-accent' : current ? 'bg-accent text-on-accent' : 'border border-line',
                  )}
                >
                  {s.done ? '✓' : n + 1}
                </span>
              )}
              <span className={cx(current && 'font-medium')}>{s.label}</span>
              {!s.done && s.action && (
                <button type="button" className="text-link hover:underline" onClick={s.action.onClick}>
                  {s.action.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {next && !next.done && <span className="basis-full text-fg-muted sm:ml-auto sm:basis-auto">{next.detail}</span>}
      {right}
    </Card>
  );
}

/** The always-visible Migrate button: disabled with the reason, so nobody hunts for it. */
export function MigrateButton({ steps, onClick, label }: { steps: ReadinessStep[]; onClick: () => void; label: string }) {
  const blocker = firstBlocker(steps);
  const advisory = steps.find((s) => !s.done && s.advisory);
  return (
    <span className="flex items-center gap-2" title={blocker ? `First: ${blocker.label.toLowerCase()}. ${blocker.detail ?? ''}` : advisory ? `${advisory.label}: the plan shows them.` : 'Plan the migration of the selected items'}>
      {advisory && !blocker && <Badge tone="amber">{advisory.label}</Badge>}
      <Button disabled={!!blocker} onClick={onClick}>
        {label}
      </Button>
    </span>
  );
}

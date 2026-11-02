import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LD_INSTANCES } from '@sslm/ld-client';
import { Badge, Button, Callout, Card, CloseButton, Input, Spinner } from '../components/ui.tsx';
import type { LdSession } from '../lib/ld.ts';
import { planLdReset, planSize, resetLdProject, type ResetPlan, type ResetProgress, type ResetReport } from '../lib/reset.ts';

/**
 * A preview, then three typed confirmations, before the LD project is wiped (lib/reset.ts). The
 * preview is the exact inventory the reset will act on, read from the chosen project before
 * anything is written. The confirmations are exact phrases; the second one is the project key
 * itself, so the name of what is about to be erased passes through the user's own hands.
 */
function gates(projectKey: string) {
  return [
    {
      phrase: 'yes',
      caseSensitive: false,
      title: 'Reset this LaunchDarkly project?',
      body: 'Everything in the preview you just saw will be deleted or archived, in that project and no other. StatSig is not touched. LaunchDarkly keeps an audit log, but there is no undo for a deleted flag.',
      prompt: 'Type “yes” to continue to the second of three confirmations.',
    },
    {
      phrase: projectKey,
      caseSensitive: true,
      title: 'Which project, exactly?',
      body: 'Type the key of the project to reset. It has to match the project in the preview character for character; the console refuses to run a preview against any other project.',
      prompt: `Type the project key “${projectKey}” to reach the final confirmation.`,
    },
    {
      phrase: 'engage project reset',
      caseSensitive: false,
      title: 'Final confirmation: engage project reset.',
      body: 'Last chance to close this dialog and go for a walk instead. If you proceed, the console works through the preview one request at a time and shows you what LaunchDarkly refused.',
      prompt: 'Type “engage project reset” to begin.',
    },
  ] as const;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/[’‘`]/g, "'");

type Phase =
  | { kind: 'planning' }
  | { kind: 'preview'; plan: ResetPlan }
  | { kind: 'confirm'; plan: ResetPlan; step: number }
  | { kind: 'running'; plan: ResetPlan; progress?: ResetProgress; cancelling?: boolean }
  | { kind: 'done'; plan: ResetPlan; report: ResetReport }
  | { kind: 'error'; message: string };

export function ProjectResetModal({ workspaceId, ld, onClose }: { workspaceId: string; ld: LdSession; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'planning' });
  const [typed, setTyped] = useState('');
  // Cancels the reset in progress: the request in flight finishes, nothing else is deleted.
  const controller = useRef<AbortController>(null);
  const GATES = gates(ld.projectKey ?? '');
  const gate = phase.kind === 'confirm' ? GATES[phase.step]! : undefined;
  const matches = gate ? (gate.caseSensitive ? typed.trim() === gate.phrase : normalize(typed) === normalize(gate.phrase)) : false;

  // Read the inventory on open. Closing the dialog abandons the read; nothing was written.
  useEffect(() => {
    const ctrl = new AbortController();
    planLdReset(workspaceId, ld, ctrl.signal).then(
      (plan) => !ctrl.signal.aborted && setPhase({ kind: 'preview', plan }),
      (e: Error) => !ctrl.signal.aborted && setPhase({ kind: 'error', message: e.message }),
    );
    return () => ctrl.abort();
    // The dialog is mounted for one project; a different project gets a fresh dialog.
  }, [workspaceId, ld.projectKey]);

  const cancel = () => {
    controller.current?.abort(new DOMException('Cancelled by the user.', 'AbortError'));
    setPhase((p) => (p.kind === 'running' ? { ...p, cancelling: true } : p));
  };

  const next = async () => {
    if (phase.kind !== 'confirm' || !matches) return;
    const { plan } = phase;
    if (phase.step < GATES.length - 1) {
      setPhase({ kind: 'confirm', plan, step: phase.step + 1 });
      setTyped('');
      return;
    }
    const ctrl = new AbortController();
    controller.current = ctrl;
    setPhase({ kind: 'running', plan });
    try {
      const report = await resetLdProject(workspaceId, ld, plan, (progress) => setPhase((p) => ({ kind: 'running', plan, progress, ...(p.kind === 'running' && p.cancelling ? { cancelling: true } : {}) })), ctrl.signal);
      setPhase({ kind: 'done', plan, report });
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message });
    } finally {
      controller.current = null;
    }
  };

  const plan = 'plan' in phase ? phase.plan : undefined;
  const instance = ld.instance ? LD_INSTANCES[ld.instance].label : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Reset LaunchDarkly project">
      <Card className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden border-error-line/60 shadow-raised">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Badge tone="red">danger</Badge>
          <h2 className="font-display text-lg font-semibold tracking-tight">Reset LD project “{ld.projectKey}”</h2>
          {phase.kind === 'confirm' && (
            <span className="text-xs text-fg-muted">
              confirmation {phase.step + 1} of {GATES.length}
            </span>
          )}
          <CloseButton onClick={onClose} disabled={phase.kind === 'running'} className="ml-auto" />
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto p-5">
          {plan && phase.kind !== 'done' && <ResetTarget plan={plan} instance={instance} />}
          {phase.kind === 'planning' && (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner /> Reading everything in <code className="font-mono text-fg">{ld.projectKey}</code>… nothing is changed yet.
            </div>
          )}
          {phase.kind === 'preview' && <ResetPreview plan={phase.plan} />}
          {gate && phase.kind === 'confirm' && (
            <>
              <Summary plan={phase.plan} />
              <h3 className="text-base font-semibold">{gate.title}</h3>
              <p className="text-sm text-fg-muted">{gate.body}</p>
              <ol className="flex flex-wrap gap-2 text-xs text-fg-subtle">
                {GATES.map((g, i) => (
                  <li key={i} className={i < phase.step ? 'text-success' : i === phase.step ? 'text-fg' : ''}>
                    {i < phase.step ? '✓' : `${i + 1}.`} “{g.phrase}”
                  </li>
                ))}
              </ol>
              <label className="block text-sm">
                {gate.prompt}
                <Input
                  autoFocus
                  className="mt-2 w-full font-mono"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void next()}
                  aria-label={`Type ${gate.phrase} to confirm`}
                  placeholder={gate.phrase}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            </>
          )}
          {phase.kind === 'running' && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Spinner /> {phase.progress?.phase ?? 'Starting…'}
                {phase.progress && phase.progress.total > 0 && (
                  <span className="text-fg-muted">
                    {phase.progress.done}/{phase.progress.total}
                  </span>
                )}
              </div>
              {phase.progress?.message && <div className="font-mono text-xs text-fg-muted">{phase.progress.message}</div>}
              <div className="h-1.5 overflow-hidden rounded bg-surface-2">
                <div className="h-full bg-error-fill transition-all" style={{ width: `${phase.progress && phase.progress.total ? (phase.progress.done / phase.progress.total) * 100 : 5}%` }} />
              </div>
              <p className="text-xs text-fg-subtle">
                {phase.cancelling ? 'Cancelling: the request in flight finishes, then nothing else is deleted.' : 'Keep this tab open until it finishes. Cancel stops after the current request; what is already deleted stays deleted.'}
              </p>
            </div>
          )}
          {phase.kind === 'done' && (
            <>
              <Callout tone={phase.report.cancelled || phase.report.stopped || phase.report.failures.length ? 'amber' : 'green'}>
                {phase.report.stopped
                  ? `Reset stopped at ${phase.report.stopped.what}: ${phase.report.stopped.reason} Every remaining request would have failed the same way, so nothing else was tried. Give LaunchDarkly a minute, then open Reset again; the new preview shows what is left. Before the stop it deleted`
                  : phase.report.cancelled
                    ? 'Reset cancelled; the project still holds whatever was not reached. Before the stop it deleted'
                    : `Project “${phase.plan.projectKey}” reset. Deleted`}{' '}
                {phase.report.deleted.flags} flags,{' '}
                {phase.report.deleted.segments} segments, {phase.report.deleted.metrics} metrics and {phase.report.deleted.environments} environments; archived {phase.report.archived.experiments} experiments and{' '}
                {phase.report.archived.contextKinds} context kinds.
                {phase.report.failures.length > 0 && ` LaunchDarkly refused ${phase.report.failures.length} operation${phase.report.failures.length === 1 ? '' : 's'}:`}
              </Callout>
              {phase.report.failures.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                  {phase.report.failures.map((f, i) => (
                    <li key={i}>
                      <span className="font-mono">{f.what}</span> <span className="text-fg-muted">· {f.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-fg-muted">Runs recorded in this browser still list what they wrote; their undo will find nothing to restore.</p>
            </>
          )}
          {phase.kind === 'error' && <Callout tone="red">{phase.message}</Callout>}
        </div>
        <footer className="flex items-center gap-3 border-t border-line bg-surface-2 px-5 py-3">
          {(phase.kind === 'planning' || phase.kind === 'preview') && (
            <>
              <Button variant="secondary" onClick={onClose}>
                Keep my project
              </Button>
              {phase.kind === 'preview' && planSize(phase.plan) > 0 && (
                <Button variant="danger" className="ml-auto" onClick={() => setPhase({ kind: 'confirm', plan: phase.plan, step: 0 })}>
                  I’ve reviewed this; continue
                </Button>
              )}
            </>
          )}
          {phase.kind === 'confirm' && (
            <>
              <Button variant="secondary" onClick={onClose}>
                Keep my project
              </Button>
              <Button variant="ghost" onClick={() => setPhase({ kind: 'preview', plan: phase.plan })}>
                Back to preview
              </Button>
              <Button variant="danger" className="ml-auto" disabled={!matches} onClick={() => void next()}>
                {phase.step < GATES.length - 1 ? 'Continue' : 'Engage project reset'}
              </Button>
            </>
          )}
          {phase.kind === 'running' && (
            <Button variant="secondary" className="ml-auto" disabled={phase.cancelling} onClick={cancel}>
              {phase.cancelling ? 'Cancelling…' : 'Cancel reset'}
            </Button>
          )}
          {(phase.kind === 'done' || phase.kind === 'error') && (
            <Button className="ml-auto" onClick={onClose}>
              Close
            </Button>
          )}
        </footer>
      </Card>
    </div>
  );
}

/** The one project this dialog is about, as LD identified it from the key. */
export function ResetTarget({ plan, instance }: { plan: ResetPlan; instance?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-error-line/60 bg-error-bg px-3 py-2 text-sm" data-testid="reset-target">
      <span className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Target</span>
      <span className="font-semibold">{plan.projectName}</span>
      <code className="font-mono text-xs">{plan.projectKey}</code>
      {instance && <span className="text-xs text-fg-muted">on {instance}</span>}
      <span className="ml-auto text-xs text-fg-subtle">read {new Date(plan.plannedAt).toLocaleTimeString()}</span>
    </div>
  );
}

/** One line of counts, kept on screen while the confirmations are typed. */
function Summary({ plan }: { plan: ResetPlan }) {
  const envs = plan.environments.filter((e) => e.action === 'delete').length;
  return (
    <p className="text-sm text-fg-muted">
      Will delete <b className="text-fg">{plan.flags.length}</b> flags, <b className="text-fg">{plan.segments.length}</b> segments, <b className="text-fg">{plan.metrics.length}</b> metrics and{' '}
      <b className="text-fg">{envs}</b> environments; archive <b className="text-fg">{plan.experiments.length}</b> experiments and <b className="text-fg">{plan.contextKinds.length}</b> context kinds.
    </p>
  );
}

/** The full inventory, category by category, every key listed. */
export function ResetPreview({ plan }: { plan: ResetPlan }) {
  const toDelete = plan.environments.filter((e) => e.action === 'delete');
  const kept = plan.environments.filter((e) => e.action === 'keep');
  const size = planSize(plan);
  return (
    <div className="space-y-3">
      {size === 0 ? (
        <Callout tone="green">
          Nothing to do: <code className="font-mono">{plan.projectKey}</code> has no flags, segments, metrics, live experiments or custom context kinds, and no environments this console created.
        </Callout>
      ) : (
        <p className="text-sm">
          This is everything the reset will do to <b>{plan.projectName}</b>. Read it; the confirmations that follow act on this list and nothing else. Anything created in the project after this
          preview was read is left alone.
        </p>
      )}
      <Section title="Flags" verb="delete" items={plan.flags.map((f) => ({ key: f.key, name: f.name }))} note="Every environment’s targeting goes with the flag." />
      <Section title="Segments" verb="delete" items={plan.segments.map((s) => ({ key: `${s.env}/${s.key}`, name: s.name }))} />
      <Section title="Metrics" verb="delete" items={plan.metrics.map((m) => ({ key: m.key, name: m.name }))} />
      <Section
        title="Experiments"
        verb="archive"
        items={plan.experiments.map((x) => ({ key: `${x.env}/${x.key}`, name: x.name, badge: x.running ? 'running: stopped first' : undefined }))}
        note="LaunchDarkly has no delete for experiments; they are archived."
      />
      <Section title="Custom context kinds" verb="archive" items={plan.contextKinds.map((k) => ({ key: k.key, name: k.name }))} note="The built-in user kind stays." />
      <Section title="Environments" verb="delete" items={toDelete.map((e) => ({ key: e.key, name: e.name }))} note={toDelete.length ? 'Only environments tagged as created by this console.' : undefined} />
      {kept.length > 0 && (
        <div className="text-xs text-fg-muted">
          <span className="font-semibold text-success">Kept</span>{' '}
          {kept.map((e, i) => (
            <span key={e.key}>
              {i > 0 && ', '}
              <code className="font-mono">{e.key}</code> <span className="text-fg-subtle">({e.reason})</span>
            </span>
          ))}
        </div>
      )}
      {plan.unreadable.length > 0 && (
        <Callout tone="amber">
          Some listings could not be read, so whatever they hold is not in this preview and will not be touched:
          <ul className="mt-1 list-disc pl-5 text-xs">
            {plan.unreadable.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}

function Section({ title, verb, items, note }: { title: string; verb: 'delete' | 'archive'; items: { key: string; name?: string; badge?: string }[]; note?: ReactNode }) {
  const empty = items.length === 0;
  return (
    <details className="group rounded-md border border-line" open={!empty}>
      <summary className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${empty ? 'text-fg-subtle' : ''}`}>
        <Badge tone={empty ? 'slate' : verb === 'delete' ? 'red' : 'amber'}>{empty ? 'none' : `${verb} ${items.length}`}</Badge>
        <span className="font-semibold">{title}</span>
        {note && !empty && <span className="ml-auto text-xs text-fg-muted">{note}</span>}
      </summary>
      {!empty && (
        <ul className="max-h-56 overflow-y-auto border-t border-line px-3 py-2 text-xs">
          {items.map((it) => (
            <li key={it.key} className="flex items-baseline gap-2 py-0.5">
              <code className="font-mono">{it.key}</code>
              {it.name && it.name !== it.key && <span className="truncate text-fg-muted">{it.name}</span>}
              {it.badge && <Badge tone="amber">{it.badge}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

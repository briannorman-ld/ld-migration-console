import { KIT_KIND_LABEL, KIT_KINDS, KIT_STATE_LABEL, KIT_STATES, type ExperimentKit, type KitItem, type KitItemState } from '@sslm/canonical';
import { Badge, Button, cx, type Tone } from '../components/ui.tsx';

/**
 * The experiment migration kit (PLAN §11): everything that must exist in LaunchDarkly for the
 * experiments ticked on the Layers page, grouped by kind, each with its state as a badge and the
 * reason on hover. A read-only preview computed by `experimentMigrationKit` in @sslm/canonical,
 * which the Markdown export shares; nothing here plans or writes.
 */

export const KIT_STATE_TONE: Record<KitItemState, Tone> = { in_snapshot: 'green', already_in_ld: 'blue', blocked_running: 'amber', missing_from_snapshot: 'red', archived: 'slate' };

export function ExperimentKitPanel({ kit, source, onClear, onExport, onOpenCoverage }: { kit: ExperimentKit; source?: string; onClear: () => void; onExport: () => void; onOpenCoverage?: (focus: string) => void }) {
  const n = kit.selected.length;
  const counts = KIT_STATES.filter((s) => kit.counts[s] > 0);
  return (
    <section aria-label={`Migration kit${source ? ` for ${source}` : ''}`} className="rounded-lg border border-line-strong bg-surface shadow-card">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-lg border-b border-line-soft bg-surface px-3 py-2 text-sm">
        <span className="font-medium">
          {n} selected
          {source && <Badge>{source}</Badge>}
        </span>
        <span className="text-xs text-fg-muted">
          · {kit.items.length} {kit.items.length === 1 ? 'item' : 'items'} to have in LaunchDarkly first
          {counts.length > 0 && <> ({counts.map((s) => `${kit.counts[s]} ${KIT_STATE_LABEL[s]}`).join(', ')})</>}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button variant="secondary" className="py-1 text-xs" onClick={onExport} title="The kit as Markdown: one table per kind with each item’s state, for a runbook">
            Export kit
          </Button>
          <Button variant="ghost" className="py-1 text-xs" onClick={onClear}>
            Clear
          </Button>
        </span>
      </div>
      <div className="space-y-3 px-3 py-3 text-xs">
        <p className="text-fg-muted">
          A preview over the snapshot: nothing is planned or written. Running experiments end in StatSig and launch new in LaunchDarkly; archived items never migrate; items already in LaunchDarkly are reused or raise a key collision when the experiments are planned.{' '}
          {onOpenCoverage && (
            <button type="button" className="text-link hover:underline" onClick={() => onOpenCoverage('experiments.kit')}>
              why?
            </button>
          )}
        </p>
        {kit.notes.map((note) => (
          <p key={note} className="rounded-md bg-warning-bg px-2 py-1 text-warning">
            {note}
          </p>
        ))}
        {kit.excluded.length > 0 && (
          <p className="text-fg-muted">
            Left out: {kit.excluded.map((x) => `${x.id} (${x.reason.replace(/\.$/, '')})`).join('; ')}.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {KIT_KINDS.map((kind) => {
            const items = kit.byKind[kind];
            return (
              <div key={kind} className="rounded-md border border-line-soft">
                <h3 className="border-b border-line-soft bg-surface-2/60 px-2 py-1 font-medium text-fg">
                  {KIT_KIND_LABEL[kind]} <span className="font-normal text-fg-muted">({items.length})</span>
                </h3>
                {items.length === 0 ? (
                  <p className="px-2 py-1.5 text-fg-muted">{kind === 'metric' && kit.notes.some((n) => n.startsWith('Metrics are not in this snapshot')) ? 'Metrics are not in this snapshot.' : 'None needed.'}</p>
                ) : (
                  <ul aria-label={KIT_KIND_LABEL[kind]} className="divide-y divide-line-soft">
                    {items.map((i) => (
                      <KitRow key={i.id} item={i} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function KitRow({ item }: { item: KitItem }) {
  return (
    <li className={cx('flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1', item.state === 'archived' && 'text-fg-muted')} title={item.reason}>
      <span className="font-mono">{item.id}</span>
      {item.ldKey !== item.id && <span className="text-fg-muted">→ {item.ldKey}</span>}
      <span className="text-fg-muted">{item.target}</span>
      <Badge tone={KIT_STATE_TONE[item.state]} title={item.reason}>
        {KIT_STATE_LABEL[item.state]}
      </Badge>
      <span className="basis-full text-[11px] text-fg-muted" title={`Needed by ${item.neededBy.join(', ')}`}>
        needed by {item.neededBy.join(', ')}
      </span>
    </li>
  );
}

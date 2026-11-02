import type { EntityKind } from '@sslm/canonical';
import { describeUids, kindOfUid, type SelectionKind } from '../lib/selection.ts';
import { Badge, Button, Card } from './ui.tsx';

/**
 * What is ticked across every explorer, with the one action that plans all of it (lib/selection.ts).
 * Sits above the main content on every view while anything is selected.
 */
export function SelectionBar({
  selected,
  ldEnvs,
  env,
  onMigrate,
  onClear,
  onOpen,
}: {
  selected: Set<string>;
  /** LD environments the chosen source environment maps to; empty when it is not mapped. */
  ldEnvs: string[];
  env: string;
  onMigrate: () => void;
  onClear: () => void;
  onOpen: (kind: SelectionKind) => void;
}) {
  if (selected.size === 0) return null;
  const kinds = [...new Set([...selected].map(kindOfUid).filter((k): k is SelectionKind => !!k))];
  return (
    <section aria-label="Selected for migration" className="mb-3">
      <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 border-accent/60 px-3 py-2 text-sm">
      <Badge tone="blue">{selected.size.toLocaleString()} selected</Badge>
      <span>
        {describeUids(selected)} across the explorers
        {ldEnvs.length ? (
          <>
            , to LD <b>{ldEnvs.join(', ')}</b>
          </>
        ) : (
          <>
            ; <b>{env || 'the environment'}</b> is not mapped to an LD environment yet
          </>
        )}
        .
      </span>
      <span className="flex flex-wrap gap-1 text-xs">
        {kinds.map((k) => (
          <button key={k} type="button" className="text-link hover:underline" onClick={() => onOpen(k)}>
            {LABEL[k]}
          </button>
        ))}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <button type="button" className="text-sm text-fg-muted hover:text-fg" onClick={onClear}>
          Clear all
        </button>
        <Button className="py-1.5" disabled={ldEnvs.length === 0} onClick={onMigrate} title={ldEnvs.length ? 'Plan everything selected, in one run' : 'Map the environment first (Mapping)'}>
          Migrate {selected.size.toLocaleString()} selected…
        </Button>
      </span>
      </Card>
    </section>
  );
}

const LABEL: Record<SelectionKind, string> = { gate: 'Gates', config: 'Dynamic configs', autotune: 'Autotunes', flag: 'LD flags', segment: 'Segments' };

/** Where a selection kind is viewed: a StatSig resource list, or the LD-source list. */
export function viewFor(kind: SelectionKind): { kind: 'resource'; resource: EntityKind } | { kind: 'ld-source'; resource: 'flag' | 'segment' } {
  if (kind === 'flag') return { kind: 'ld-source', resource: 'flag' };
  if (kind === 'segment') return { kind: 'ld-source', resource: 'segment' };
  return { kind: 'resource', resource: kind };
}

import { useState } from 'react';
import { createKindOption, isValidContextKindKey, optionLabel, type DecisionPoint, type Fidelity, type Resolution, type Severity } from '@sslm/mapper';
import { Badge, cx, Input } from './ui.tsx';

export const SEVERITY_TONE: Record<Severity, 'red' | 'amber' | 'blue'> = { blocking: 'red', choice: 'amber', acknowledge: 'blue' };
export const FIDELITY_TONE: Record<Fidelity, 'green' | 'amber' | 'violet' | 'slate'> = { full: 'green', partial: 'amber', manual: 'violet', skipped: 'slate' };

export const TYPE_LABEL: Record<string, string> = {
  holdout_attached: 'Holdout attached in StatSig',
  value_type: 'Typed values (number vs string)',
  version_format: 'Version is not semver',
  case_insensitive_match: 'Case-insensitive match',
  negated_missing_attribute: 'Missing attribute on a negative operator',
  partial_rollout_rebucket: 'Partial rollout re-bucketing',
  gate_reference: 'Gate reference',
  time_condition: 'Time condition',
  derived_attribute: 'Derived attribute',
  unit_type_kind: 'Unit type → context kind',
  key_collision: 'LD key already exists',
  source_collision: 'Same key in two sources',
  big_segment: 'Big ID list',
  hashed_id_list: 'Hashed ID list',
  id_list_unavailable: 'ID list not loaded',
  missing_reference: 'Missing reference',
  regex_dialect: 'Regex portability',
  null_check: 'Null check',
  client_side_availability: 'Client-side availability',
  unsupported_condition: 'No LD equivalent',
  rule_expansion: 'Rule expansion',
  redundant_rules: 'Rules the default rule makes redundant',
  autotune_running: 'Autotune running in StatSig',
  missing_metric: 'No success event for the bandit',
  duplicate_variant_value: 'Variants with identical values',
  variation_change_affects_migrated_env: 'New variation on a migrated flag',
  copy_custom_properties: 'Copy custom properties',
  prerequisite_unsupported: 'Prerequisites not available',
  maintainer_unknown: 'Owner is not an LD member',
};

/**
 * One decision (or a group sharing a fingerprint): the explanation, the source fragment, and the
 * options as buttons (PLAN §8.2). `current` highlights the answer in force.
 */
export function DecisionCard({
  decision,
  count,
  current,
  stale,
  onChoose,
  onPolicy,
  compact,
}: {
  decision: DecisionPoint;
  count?: number;
  current?: { optionKey: string; via: 'resource' | 'policy' };
  stale?: Resolution;
  onChoose: (optionKey: string) => void;
  onPolicy?: (optionKey: string) => void;
  compact?: boolean;
}) {
  const [showFragment, setShowFragment] = useState(false);
  const d = decision;
  return (
    <div className={cx('rounded-md border bg-surface', d.severity === 'blocking' && !current ? 'border-error-line/60' : 'border-line', compact ? 'p-3' : 'p-4')}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[d.severity]}>{d.severity}</Badge>
        <span className="font-medium">{d.title}</span>
        {count && count > 1 && <Badge>{count} places</Badge>}
        {current && <Badge tone="green">{current.via === 'policy' ? 'workspace policy' : 'decided'}</Badge>}
      </div>
      <p className="mt-1.5 text-sm text-fg-muted">{d.explanation}</p>
      {stale && (
        <p className="mt-1.5 text-sm text-warning">
          Asked again because StatSig changed. Previous answer: <b>{optionLabel(d, stale.optionKey)}</b>.
        </p>
      )}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {d.options.map((o) => {
          const chosen = current?.optionKey === o.key;
          return (
            <div key={o.key} className={cx('flex flex-col rounded-md border p-2.5 text-sm', chosen ? 'border-accent ring-1 ring-accent' : 'border-line')}>
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">
                  {o.label}
                  {d.recommended === o.key && <span className="ml-1.5 text-xs font-normal text-success">recommended</span>}
                </span>
                <Badge tone={FIDELITY_TONE[o.resultingFidelity]}>{o.resultingFidelity}</Badge>
              </div>
              <p className="mt-1 flex-1 text-xs text-fg-muted">{o.explanation}</p>
              <div className="mt-2 flex gap-2">
                <button onClick={() => onChoose(o.key)} disabled={chosen} className="rounded border border-line px-2 py-1 text-xs font-medium hover:bg-surface-hover disabled:opacity-50">
                  {chosen ? 'Chosen' : count && count > 1 ? `Apply to all ${count}` : 'Choose'}
                </button>
                {onPolicy && (
                  <button onClick={() => onPolicy(o.key)} className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover" title="Use this answer for every decision of this type, now and in future snapshots">
                    Save as policy
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {d.type === 'unit_type_kind' && <CustomKindOption decision={d} current={current} count={count} onChoose={onChoose} />}
      </div>
      {!compact && (
        <button className="mt-2 text-xs text-fg-muted hover:text-fg" onClick={() => setShowFragment((x) => !x)}>
          {showFragment ? 'Hide' : 'Show'} StatSig source
        </button>
      )}
      {showFragment && <pre className="mt-1 max-h-48 overflow-auto rounded border border-line bg-surface-2 p-2 font-mono text-xs">{JSON.stringify(d.sourceFragment, null, 2)}</pre>}
    </div>
  );
}


/**
 * The free-text answer to a `unit_type_kind` decision: create a context kind under a key the user
 * names, when neither the proposed key nor an existing kind is what their app will send. Chosen
 * when the answer in force is a `create:` key that is not one of the listed options.
 */
function CustomKindOption({ decision: d, current, count, onChoose }: { decision: DecisionPoint; current?: { optionKey: string }; count?: number; onChoose: (optionKey: string) => void }) {
  const listed = new Set(d.options.map((o) => o.key));
  const chosenKey = current && !listed.has(current.optionKey) && current.optionKey.startsWith('create:') ? current.optionKey.slice('create:'.length) : undefined;
  const [key, setKey] = useState(chosenKey ?? '');
  const trimmed = key.trim();
  const valid = trimmed.length > 0 && isValidContextKindKey(trimmed);
  const duplicate = listed.has(createKindOption(trimmed)) || listed.has(`existing:${trimmed}`);
  const chosen = chosenKey !== undefined && trimmed === chosenKey;
  const unit = d.subject.id;
  return (
    <div className={cx('flex flex-col rounded-md border p-2.5 text-sm', chosenKey ? 'border-accent ring-1 ring-accent' : 'border-line')} data-testid="custom-kind-option">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">Create a context kind with another key</span>
        <Badge tone={FIDELITY_TONE.full}>full</Badge>
      </div>
      <p className="mt-1 flex-1 text-xs text-fg-muted">
        The migration creates the LD context kind you name for {unit}, and your app must send a context of that kind. Letters, digits, <code>.</code>, <code>_</code> and <code>-</code>;{' '}
        <code>kind</code> and <code>multi</code> are reserved.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Input
          aria-label={`Context kind key for ${unit}`}
          className="h-7 w-40 px-2 py-1 font-mono text-xs"
          placeholder="plan"
          value={key}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && !duplicate && !chosen && onChoose(createKindOption(trimmed))}
        />
        <button onClick={() => onChoose(createKindOption(trimmed))} disabled={!valid || duplicate || chosen} className="rounded border border-line px-2 py-1 text-xs font-medium whitespace-nowrap hover:bg-surface-hover disabled:opacity-50">
          {chosen ? 'Chosen' : count && count > 1 ? `Apply to all ${count}` : 'Choose'}
        </button>
        {trimmed && !valid && <span className="text-xs text-error">Not a valid context kind key.</span>}
        {valid && duplicate && <span className="text-xs text-fg-muted">That one is already an option above.</span>}
      </div>
    </div>
  );
}

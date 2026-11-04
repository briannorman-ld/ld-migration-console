import { useState } from 'react';
import { explainMapping, STATUS_LABEL, type CoverageEntry, type ExplainerKey } from '@sslm/coverage';
import { COVERAGE_TONE } from '../screens/coverageTone.ts';
import { Badge, cx } from './ui.tsx';

/**
 * How this page's resource maps to LaunchDarkly, read from the coverage matrix: the headline
 * (`source → target`, what the console does) stays visible; opening the panel lists every
 * caveat (a decision to make, a step for a person, planned, or no equivalent) grouped by area,
 * then what maps cleanly. The same rows drive the "What migrates" page and docs/LIMITATIONS.md.
 */
export function MappingExplainer({ resource, onOpenCoverage, className }: { resource: ExplainerKey; onOpenCoverage?: (focus: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const { headline, caveats, clean } = explainMapping(resource);
  const count = caveats.reduce((n, c) => n + c.rows.length, 0);
  const sourceLabel = resource.startsWith('ld_') ? 'Source' : 'StatSig';
  return (
    <div className={cx('rounded-md border border-line bg-surface text-sm', className)} data-testid="mapping-explainer">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-3 py-2 text-left hover:bg-surface-hover"
      >
        <Badge tone={COVERAGE_TONE[headline.status]} title={STATUS_LABEL[headline.status]}>
          {STATUS_LABEL[headline.status]}
        </Badge>
        <span>
          <span className="font-medium">{headline.statsig}</span> <span aria-hidden="true">→</span>
          <span className="sr-only">becomes</span> <span className="font-medium">{headline.ld}</span>. {headline.how}
        </span>
        <span className="ml-auto whitespace-nowrap text-xs text-fg-muted">
          {open ? 'Hide' : 'Show'} {count} {count === 1 ? 'caveat' : 'caveats'} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {headline.detail && <p className="text-fg-muted">{headline.detail}</p>}
          {(headline.decisions?.length || onOpenCoverage) && (
            <p className="text-xs text-fg-muted">
              {headline.decisions?.length ? (
                <>
                  Decisions this can raise: <span className="font-mono">{headline.decisions.join(', ')}</span>.{' '}
                </>
              ) : null}
              {onOpenCoverage && <CoverageLink id={headline.id} onOpenCoverage={onOpenCoverage} label="Full row on What migrates" />}
            </p>
          )}
          {caveats.map(({ area, rows }) => (
            <section key={area.area}>
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">{area.area === headline.area ? `${area.title}: what does not map cleanly` : area.title}</h4>
              <ul className="divide-y divide-line-soft">
                {rows.map((e) => (
                  <Caveat key={e.id} entry={e} sourceLabel={sourceLabel} onOpenCoverage={onOpenCoverage} />
                ))}
              </ul>
            </section>
          ))}
          {clean.length > 0 && (
            <p className="text-xs text-fg-muted">
              <span className="font-semibold">Maps cleanly:</span>{' '}
              {clean.map((e, i) => (
                <span key={e.id}>
                  {i > 0 && '; '}
                  {e.statsig} <span aria-hidden="true">→</span> {e.ld}
                </span>
              ))}
              .
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Caveat({ entry: e, sourceLabel, onOpenCoverage }: { entry: CoverageEntry; sourceLabel: string; onOpenCoverage?: (focus: string) => void }) {
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <Badge tone={COVERAGE_TONE[e.status]} title={STATUS_LABEL[e.status]}>
          {STATUS_LABEL[e.status]}
        </Badge>
        <span className="font-medium" title={sourceLabel}>
          {e.statsig}
        </span>
        <span aria-hidden="true" className="text-fg-subtle">
          →
        </span>
        <span className="text-fg-muted" title="LaunchDarkly">
          {e.ld}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-fg-muted">
        {e.how}
        {e.detail && <span className="text-fg-subtle"> {e.detail}</span>}
        {onOpenCoverage && (
          <>
            {' '}
            <CoverageLink id={e.id} onOpenCoverage={onOpenCoverage} label="more" />
          </>
        )}
      </p>
    </li>
  );
}

function CoverageLink({ id, onOpenCoverage, label }: { id: string; onOpenCoverage: (focus: string) => void; label: string }) {
  return (
    <button type="button" className="text-link hover:underline" onClick={() => onOpenCoverage(id)}>
      {label}
    </button>
  );
}

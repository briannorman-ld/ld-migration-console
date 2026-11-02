import { useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { type MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import { Badge, Button, Callout, Card, Input, Select, Spinner } from '../components/ui.tsx';
import { SOURCE_BADGE } from '../lib/kinds.ts';
import { acrossSources, choiceError, choiceValue, describeUsage, parseChoice, sharedKinds, unitTypeStanding, unitTypeUsage, type UnitTypeMode, type UnitTypeStanding } from '../lib/unitTypes.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

/**
 * Unit types → LaunchDarkly context kinds (PLAN §10.3, KNOWN-EDGE-CASES §3). One row per unit type
 * a source declares or uses: where it is used, and where its IDs go in LD. The choice is saved in
 * the mapping profile, so the mapper applies it to every item and asks no per-item
 * `unit_type_kind` decision for it.
 */
export function UnitTypesView({ sources, snapshots, m, onConnect, onDecisions }: { sources: SourceRecord[]; snapshots: Record<string, CanonicalSnapshot | undefined>; m: MigrationContext; onConnect: () => void; onDecisions: () => void }) {
  const save = (fn: (p: MappingProfile) => void) => {
    const next: MappingProfile = structuredClone(m.profile);
    fn(next);
    void m.saveProfile(next);
  };
  const set = (sourceId: string, unitType: string, value: string | null) =>
    save((p) => {
      const t = (p.sources[sourceId] ??= { envMapping: {}, unitTypeKinds: {} }).unitTypeKinds;
      // StatSig compares unit types case-insensitively: one entry per unit type, whatever its case.
      for (const k of Object.keys(t)) if (k.toLowerCase() === unitType.toLowerCase()) delete t[k];
      if (value) t[unitType] = value;
    });
  const existing = m.capabilities.existingContextKinds;
  const withSnap = sources.flatMap((s) => (snapshots[s.id] ? [{ source: s, snapshot: snapshots[s.id]! }] : []));
  const across = acrossSources(
    m.profile,
    withSnap.map(({ source, snapshot }) => ({ sourceId: source.id, label: source.label, unitTypes: unitTypeUsage(snapshot).map((u) => u.name) })),
  );
  return (
    <div className="max-w-5xl space-y-5">
      <div>
        <h2 className="font-display text-xl font-semibold tracking-tight">Unit types</h2>
        <p className="mt-1 text-sm text-fg-muted">
          StatSig buckets and targets by unit types; LaunchDarkly by context kinds. Choose once per unit type where its IDs go: the key of a context kind (created by the migration if LD lacks
          it), or an attribute of the <code>user</code> context. A custom unit ID is never the key of the <code>user</code> context. Unit types left on their default ask per item on the{' '}
          <button type="button" className="text-link hover:underline" onClick={onDecisions}>
            Decisions
          </button>{' '}
          page when their kind is missing.
        </p>
      </div>
      {!m.connected && (
        <Callout tone="blue">
          <button className="font-medium underline" onClick={onConnect}>
            Connect LaunchDarkly
          </button>{' '}
          to see which context kinds the project already has. Choices made here are kept either way.
        </Callout>
      )}
      {m.connected && m.ld.probing && (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner /> Refreshing the LD project ({m.ld.probing})…
        </p>
      )}
      {withSnap.map(({ source: s, snapshot }) => {
        const usage = unitTypeUsage(snapshot);
        const shared = sharedKinds(
          m.profile,
          s.id,
          usage.map((u) => u.name),
        );
        const isLd = s.kind === 'launchdarkly';
        return (
          <Card key={s.id} className="p-5">
            <h3 className="mb-3 flex items-center gap-2 font-semibold">
              {s.label} <Badge>{s.alias}</Badge> <Badge tone={SOURCE_BADGE[s.kind].tone}>{SOURCE_BADGE[s.kind].label}</Badge>
            </h3>
            {usage.length === 0 ? (
              <p className="text-sm text-fg-muted">{isLd ? 'This project declares no context kinds beyond user.' : 'This source declares no unit types; userID maps to the user context.'}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
                  <tr>
                    <th className="py-1.5 pr-3 font-semibold">{isLd ? 'Source context kind' : 'Unit type'}</th>
                    <th className="py-1.5 pr-3 font-semibold">In LaunchDarkly</th>
                    <th className="py-1.5 font-semibold">Standing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft align-top">
                  {usage.map((u) => (
                    <UnitTypeRow
                      key={u.name}
                      sourceId={s.id}
                      unitType={u.name}
                      description={u.description}
                      usage={describeUsage(u)}
                      declared={u.declared}
                      allowAttribute={!isLd && !/^userid$/i.test(u.name)}
                      value={Object.entries(m.profile.sources[s.id]?.unitTypeKinds ?? {}).find(([k]) => k.toLowerCase() === u.name.toLowerCase())?.[1]}
                      standing={unitTypeStanding(m.profile, m.resolutionList, s.id, u.name, existing)}
                      existing={existing}
                      canCreate={m.capabilities.contextKinds !== 'not_permitted' && m.capabilities.contextKinds !== 'unavailable'}
                      connected={m.connected}
                      onChange={(v) => set(s.id, u.name, v)}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {[...shared].map(([kind, uts]) => (
              <div key={kind} className="mt-3">
                <Callout tone="amber">
                  {uts.map((x, i) => (
                    <span key={x}>
                      {i > 0 && (i === uts.length - 1 ? ' and ' : ', ')}
                      <code className="font-mono">{x}</code>
                    </span>
                  ))}{' '}
                  all map to the context kind <code className="font-mono">{kind}</code>, so their IDs would share one kind and one bucketing space. Give one of them another kind, or keep it as
                  a user attribute, unless they really are the same identifier.
                </Callout>
              </div>
            ))}
          </Card>
        );
      })}
      {across.length > 0 && (
        <Card className="p-5">
          <h3 className="mb-1 font-semibold">Across sources</h3>
          <p className="mb-3 text-xs text-fg-muted">Unit types that more than one source uses. Sources that mean the same identifier should send it to the same context kind; the kind is created once.</p>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line-soft">
              {across.map((r) => (
                <tr key={r.name}>
                  <td className="py-1.5 pr-3 font-mono">{r.name}</td>
                  <td className="py-1.5 pr-3 text-fg-muted">
                    {r.targets.map((t, i) => (
                      <span key={t.sourceId}>
                        {i > 0 && ' · '}
                        {t.label} → <code className="font-mono text-fg">{t.kind}</code>
                      </span>
                    ))}
                  </td>
                  <td className="py-1.5">{r.differ ? <Badge tone="amber">differ</Badge> : <Badge tone="green">same kind</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <p className="text-xs text-fg-muted">
        Context kinds that LaunchDarkly lacks are created by the guide's “Context kinds” step, or on the first run that needs them. Your application must then send a context of that kind
        (or the user attribute) on every evaluation; the mapper's fidelity notes say which.
      </p>
    </div>
  );
}

const STANDING: Record<UnitTypeStanding['kind'], { tone: 'green' | 'blue' | 'amber' | 'slate'; label: string }> = {
  exists: { tone: 'green', label: 'exists in LD' },
  creates: { tone: 'blue', label: 'will be created' },
  attribute: { tone: 'slate', label: 'user attribute' },
  asks: { tone: 'amber', label: 'asks per item' },
};

function UnitTypeRow({
  sourceId,
  unitType,
  description,
  usage,
  declared,
  allowAttribute,
  value,
  standing,
  existing,
  canCreate,
  connected,
  onChange,
}: {
  sourceId: string;
  unitType: string;
  description?: string;
  usage: string;
  declared: boolean;
  allowAttribute: boolean;
  value?: string;
  standing: UnitTypeStanding;
  existing: string[];
  canCreate: boolean;
  connected: boolean;
  onChange: (value: string | null) => void;
}) {
  const parsed = parseChoice(value, unitType);
  const [mode, setMode] = useState<UnitTypeMode>(parsed.mode);
  const [draft, setDraft] = useState(parsed.configured ? parsed.key : '');
  const shown = draft || (mode === 'attribute' ? unitType : parsed.mode === 'kind' ? parsed.key : '');
  const error = choiceError(mode, shown, unitType);
  const commit = (m: UnitTypeMode, k: string) => {
    if (choiceError(m, k, unitType)) return;
    const v = choiceValue(m, k);
    if (v !== value) onChange(v);
  };
  const changeMode = (m: UnitTypeMode) => {
    setMode(m);
    const k = m === 'attribute' ? unitType : parseChoice(undefined, unitType).key;
    setDraft(k);
    commit(m, k);
  };
  const reset = () => {
    setMode('kind');
    setDraft('');
    if (value) onChange(null);
  };
  const listId = `ld-context-kinds-${sourceId}`;
  const badge = STANDING[standing.kind];
  return (
    <tr>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <span className="font-mono">{unitType}</span>
          {!declared && (
            <Badge tone="amber" title="Used by items but not declared by the source">
              undeclared
            </Badge>
          )}
        </div>
        {description && <div className="text-xs text-fg-muted">{description}</div>}
        <div className="text-xs text-fg-subtle">{usage}</div>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap items-center gap-2">
          {allowAttribute ? (
            <Select aria-label={`Where ${unitType} goes`} className="py-1 text-xs" value={mode} onChange={(e) => changeMode(e.target.value as UnitTypeMode)}>
              <option value="kind">Key of context kind</option>
              <option value="attribute">Attribute of user</option>
            </Select>
          ) : (
            <span className="text-xs text-fg-muted">Key of context kind</span>
          )}
          <Input
            aria-label={mode === 'attribute' ? `User attribute for ${unitType}` : `Context kind for ${unitType}`}
            className="w-40 py-1 font-mono text-xs"
            placeholder={mode === 'attribute' ? unitType : parseChoice(undefined, unitType).key}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            list={mode === 'kind' ? listId : undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commit(mode, shown)}
            onKeyDown={(e) => e.key === 'Enter' && commit(mode, shown)}
          />
          {mode === 'kind' && (
            <datalist id={listId}>
              {existing.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          )}
          {value && (
            <Button variant="ghost" className="py-1 text-xs" onClick={reset} title="Back to the default: the mapper proposes a kind and asks per item if LD lacks it">
              Reset
            </Button>
          )}
        </div>
        {error && <div className="mt-1 text-xs text-error">{error}</div>}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span className="text-xs text-fg-muted">
            {standing.kind === 'attribute' && (
              <>
                user attribute <code className="font-mono">{standing.target.attribute}</code>
              </>
            )}
            {standing.kind === 'exists' && (
              <>
                kind <code className="font-mono">{standing.target.contextKind}</code>
                {!connected && standing.target.contextKind !== 'user' ? ' (LD not connected)' : ''}
              </>
            )}
            {standing.kind === 'creates' && (
              <>
                kind <code className="font-mono">{standing.target.contextKind}</code>
                {!canCreate ? ' — this token cannot create kinds; an admin must' : connected ? '' : ' (LD not connected)'}
              </>
            )}
            {standing.kind === 'asks' &&
              (standing.decided ? (
                <>
                  answered on items so far: <code className="font-mono">{standing.decided}</code>. Set it here to apply to every item.
                </>
              ) : (
                <>
                  default <code className="font-mono">{standing.target.contextKind}</code>, missing in LD: each item asks. Set it here to answer once.
                </>
              ))}
          </span>
        </div>
      </td>
    </tr>
  );
}

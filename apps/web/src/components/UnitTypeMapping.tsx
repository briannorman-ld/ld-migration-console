import { useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { attributeTarget, configuredValue, defaultKindFor, type MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import { SOURCE_BADGE } from '../lib/kinds.ts';
import { acrossSources, availableForExperiments, choiceError, choiceValue, describeUsage, isUserId, knownKinds, parseChoice, sharedKinds, unitTypeStanding, unitTypeUsage, type UnitTypeMode, type UnitTypeStanding } from '../lib/unitTypes.ts';
import type { MigrationContext } from '../lib/useMigration.ts';
import { Badge, Button, Callout, Input, Select } from './ui.tsx';

/**
 * Unit types → LaunchDarkly context kinds (PLAN §10.3, KNOWN-EDGE-CASES §3): the table on the
 * guide's Context kinds step. One row per unit type a source declares or uses: where it is used,
 * and where its IDs go in LaunchDarkly. Every unit type but userID needs a choice: an existing
 * context kind, a kind another unit type already creates, a new kind under a typed key, or (less
 * prominent) an attribute of a context kind. Per kind, whether it is available for experiments.
 * Choices are saved in the mapping profile, so the mapper applies them to every item and asks no
 * per-item `unit_type_kind` decision.
 */
export function UnitTypeMapping({ sources, snapshots, m, onConnect }: { sources: SourceRecord[]; snapshots: Record<string, CanonicalSnapshot | undefined>; m: MigrationContext; onConnect?: () => void }) {
  const save = (fn: (p: MappingProfile) => void) => {
    const next: MappingProfile = structuredClone(m.profile);
    fn(next);
    void m.saveProfile(next);
  };
  const setUnit = (p: MappingProfile, sourceId: string, unitType: string, value: string | null) => {
    const t = (p.sources[sourceId] ??= { envMapping: {}, unitTypeKinds: {} }).unitTypeKinds;
    // StatSig compares unit types case-insensitively: one entry per unit type, whatever its case.
    for (const k of Object.keys(t)) if (k.toLowerCase() === unitType.toLowerCase()) delete t[k];
    if (value) t[unitType] = value;
  };
  const setExperiments = (kind: string, on: boolean) =>
    save((p) => {
      p.contextKinds ??= {};
      p.contextKinds[kind] = { ...p.contextKinds[kind], availableForExperiments: on };
    });
  const existing = m.capabilities.existingContextKinds;
  const ldUnits = m.ld.randomizationUnits;
  const withSnap = sources.flatMap((s) => (snapshots[s.id] ? [{ source: s, snapshot: snapshots[s.id]! }] : []));
  const perSource = withSnap.map(({ source, snapshot }) => ({ sourceId: source.id, label: source.label, unitTypes: unitTypeUsage(snapshot).map((u) => u.name) }));
  const across = acrossSources(m.profile, perSource);
  const kinds = knownKinds(m.profile, perSource, existing);
  // Which rows contribute each planned kind, so a row's own new kind is not offered back to it as "created for another unit type".
  const contributors = new Map<string, Set<string>>();
  for (const s of perSource) {
    for (const ut of s.unitTypes) {
      const v = configuredValue(m.profile, s.sourceId, ut);
      const kind = v ? (attributeTarget(v)?.contextKind ?? v) : undefined;
      if (!kind) continue;
      const set = contributors.get(kind) ?? new Set<string>();
      set.add(`${s.sourceId}|${ut.toLowerCase()}`);
      contributors.set(kind, set);
    }
  }
  const plannedFor = (sourceId: string, unitType: string) =>
    kinds.filter((k) => {
      if (k === 'user' || existing.includes(k)) return false;
      const by = contributors.get(k);
      return !!by && !(by.size === 1 && by.has(`${sourceId}|${unitType.toLowerCase()}`));
    });
  const canCreate = m.capabilities.contextKinds !== 'not_permitted' && m.capabilities.contextKinds !== 'unavailable';
  const standings = withSnap.map(({ source, snapshot }) => ({ source, snapshot, usage: unitTypeUsage(snapshot).map((u) => ({ u, standing: unitTypeStanding(m.profile, m.resolutionList, source.id, u.name, existing) })) }));
  const unmapped = standings.flatMap((s) => s.usage.filter((x) => x.standing.kind === 'unmapped').map((x) => ({ sourceId: s.source.id, unitType: x.u.name, standing: x.standing })));
  const acceptSuggested = () =>
    save((p) => {
      for (const r of unmapped) if (r.standing.kind === 'unmapped') setUnit(p, r.sourceId, r.unitType, r.standing.decided ?? r.standing.target.contextKind);
    });
  return (
    <div className="space-y-4">
      {!m.connected && onConnect && (
        <Callout tone="blue">
          <button className="font-medium underline" onClick={onConnect}>
            Connect LaunchDarkly
          </button>{' '}
          to see which context kinds the project already has. Choices made here are kept either way.
        </Callout>
      )}
      {unmapped.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
          <span>
            {unmapped.length} unit type{unmapped.length === 1 ? ' needs' : 's need'} a context kind. Each row suggests one; accept them all or choose row by row.
          </span>
          <Button variant="secondary" className="py-1 text-xs" onClick={acceptSuggested}>
            Accept {unmapped.length} suggested
          </Button>
        </div>
      )}
      {standings.map(({ source: s, usage }) => {
        const shared = sharedKinds(
          m.profile,
          s.id,
          usage.map((x) => x.u.name),
        );
        const isLd = s.kind === 'launchdarkly';
        return (
          <div key={s.id} className="space-y-3">
            {withSnap.length > 1 && (
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                {s.label} <Badge>{s.alias}</Badge> <Badge tone={SOURCE_BADGE[s.kind].tone}>{SOURCE_BADGE[s.kind].label}</Badge>
              </h4>
            )}
            {usage.length === 0 ? (
              <p className="text-sm text-fg-muted">{isLd ? 'This project declares no context kinds beyond user.' : 'This source declares no unit types; userID maps to the user context.'}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs font-semibold tracking-wide text-fg-muted uppercase">
                  <tr>
                    <th className="py-1.5 pr-3 font-semibold">{isLd ? 'Source context kind' : 'Unit type'}</th>
                    <th className="py-1.5 pr-3 font-semibold">LaunchDarkly context kind</th>
                    <th className="py-1.5 pr-3 font-semibold">Experiments</th>
                    <th className="py-1.5 font-semibold">Standing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft align-top">
                  {usage.map(({ u, standing }) => {
                    const value = configuredValue(m.profile, s.id, u.name);
                    return (
                      <UnitTypeRow
                        key={`${u.name}:${value ?? ''}`}
                        sourceId={s.id}
                        unitType={u.name}
                        description={u.description}
                        usage={describeUsage(u)}
                        declared={u.declared}
                        allowAttribute={!isLd && !isUserId(u.name)}
                        value={value}
                        standing={standing}
                        existing={existing}
                        planned={plannedFor(s.id, u.name)}
                        experiments={(kind) => availableForExperiments(m.profile, kind, ldUnits)}
                        ldUnits={ldUnits}
                        canCreate={canCreate}
                        connected={m.connected}
                        onChange={(v) => save((p) => setUnit(p, s.id, u.name, v))}
                        onExperiments={setExperiments}
                      />
                    );
                  })}
                </tbody>
              </table>
            )}
            {[...shared].map(([kind, uts]) => (
              <Callout key={kind} tone="amber">
                {uts.map((x, i) => (
                  <span key={x}>
                    {i > 0 && (i === uts.length - 1 ? ' and ' : ', ')}
                    <code className="font-mono">{x}</code>
                  </span>
                ))}{' '}
                all map to the context kind <code className="font-mono">{kind}</code>, so their IDs would share one kind and one bucketing space. Give one of them another kind, or keep it as a
                user attribute, unless they really are the same identifier.
              </Callout>
            ))}
          </div>
        );
      })}
      {across.length > 0 && (
        <div className="space-y-2 rounded-md border border-line p-3">
          <div className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Across sources</div>
          <p className="text-xs text-fg-muted">Unit types that more than one source uses. Sources that mean the same identifier should send it to the same context kind; the kind is created once.</p>
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
        </div>
      )}
    </div>
  );
}

const STANDING: Record<UnitTypeStanding['kind'], { tone: 'green' | 'blue' | 'amber' | 'slate'; label: string }> = {
  exists: { tone: 'green', label: 'exists in LaunchDarkly' },
  creates: { tone: 'blue', label: 'will be created' },
  attribute: { tone: 'slate', label: 'attribute' },
  unmapped: { tone: 'amber', label: 'needs a context kind' },
};

/** The select's special values; every other value is a context kind key. */
const NEW = '__new';
const ATTRIBUTE = '__attribute';

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
  planned,
  experiments,
  ldUnits,
  canCreate,
  connected,
  onChange,
  onExperiments,
}: {
  sourceId: string;
  unitType: string;
  description?: string;
  usage: string;
  declared: boolean;
  allowAttribute: boolean;
  /** The profile's entry, if any. The row is re-mounted when it changes. */
  value?: string;
  standing: UnitTypeStanding;
  /** Context kinds LD already has. */
  existing: readonly string[];
  /** Kinds other unit types create (offered as "Created by this migration"). */
  planned: readonly string[];
  /** Whether a kind is to be available for experiments (profile, else LD's settings). */
  experiments: (kind: string) => boolean;
  /** LD's randomization units, when readable: a kind among them is already enabled. */
  ldUnits: readonly string[] | undefined;
  canCreate: boolean;
  connected: boolean;
  onChange: (value: string | null) => void;
  onExperiments: (kind: string, on: boolean) => void;
}) {
  const parsed = parseChoice(value, unitType);
  const fixedUser = isUserId(unitType);
  const suggestion = standing.kind === 'unmapped' ? (standing.decided ?? standing.target.contextKind) : undefined;
  const suggestedKind = suggestion && !suggestion.startsWith('attribute:') ? suggestion : undefined;
  // What the select shows: a kind key, NEW (a key only this row creates), ATTRIBUTE, or nothing chosen.
  const fromProfile = !parsed.configured ? '' : parsed.mode === 'attribute' ? ATTRIBUTE : existing.includes(parsed.key) || planned.includes(parsed.key) ? parsed.key : NEW;
  const [pick, setPick] = useState<string>(fromProfile);
  const [draft, setDraft] = useState(parsed.configured && parsed.mode === 'kind' ? parsed.key : '');
  const [attrDraft, setAttrDraft] = useState(parsed.mode === 'attribute' ? parsed.key : unitType);
  const [kindDraft, setKindDraft] = useState(parsed.mode === 'attribute' ? parsed.contextKind : 'user');
  const shownKind = kindDraft.trim() || 'user';
  const newKey = draft || (suggestedKind && !existing.includes(suggestedKind) ? suggestedKind : '');
  const error = pick === NEW ? choiceError('kind', newKey, unitType) : pick === ATTRIBUTE ? choiceError('attribute', attrDraft || unitType, unitType, shownKind) : undefined;
  const commit = (mode: UnitTypeMode, k: string, ck = 'user') => {
    if (choiceError(mode, k, unitType, ck)) return;
    const v = choiceValue(mode, k, ck);
    if (v !== value) onChange(v);
  };
  const choose = (v: string) => {
    setPick(v);
    if (v === '') {
      if (value) onChange(null);
    } else if (v === NEW) {
      const k = suggestedKind && !existing.includes(suggestedKind) ? suggestedKind : '';
      setDraft(k);
      // A suggested key is saved at once; a blank one waits for typing.
      if (k) commit('kind', k);
    } else if (v === ATTRIBUTE) {
      setAttrDraft(unitType);
      setKindDraft('user');
      commit('attribute', unitType, 'user');
    } else {
      commit('kind', v);
    }
  };
  const listId = `ld-context-kinds-${sourceId}-${unitType}`;
  const badge = STANDING[standing.kind];
  const chosenKind = fixedUser ? 'user' : pick === NEW ? (parsed.configured && parsed.mode === 'kind' ? parsed.key : undefined) : pick && pick !== ATTRIBUTE ? pick : undefined;
  const existingOptions = existing.filter((k) => k !== 'user');
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
        {fixedUser ? (
          <span className="text-xs text-fg-muted">
            the key of the <code className="font-mono">user</code> context
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label={`Context kind for ${unitType}`} className="py-1 text-xs" value={pick} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose a context kind…</option>
              {existingOptions.length > 0 && (
                <optgroup label="Existing in LaunchDarkly">
                  {existingOptions.map((k) => (
                    <option key={k} value={k}>
                      {k}
                      {k === suggestedKind ? ' (suggested)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {planned.length > 0 && (
                <optgroup label="Created by this migration">
                  {planned.map((k) => (
                    <option key={k} value={k}>
                      {k}
                      {k === suggestedKind ? ' (suggested)' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value={NEW}>New context kind…{suggestedKind && !existing.includes(suggestedKind) && !planned.includes(suggestedKind) ? ` (suggested: ${suggestedKind})` : ''}</option>
              {allowAttribute && <option value={ATTRIBUTE}>Attribute of a context kind…</option>}
            </Select>
            {pick === NEW && (
              <Input
                aria-label={`Key of the new context kind for ${unitType}`}
                className="w-40 py-1 font-mono text-xs"
                placeholder={suggestedKind ?? defaultKindFor(unitType)}
                value={draft}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit('kind', newKey)}
                onKeyDown={(e) => e.key === 'Enter' && commit('kind', newKey)}
              />
            )}
            {pick === ATTRIBUTE && (
              <>
                <Input
                  aria-label={`Context kind carrying ${unitType}`}
                  className="w-32 py-1 font-mono text-xs"
                  placeholder="user"
                  value={kindDraft}
                  spellCheck={false}
                  autoComplete="off"
                  list={listId}
                  onChange={(e) => setKindDraft(e.target.value)}
                  onBlur={() => commit('attribute', attrDraft || unitType, shownKind)}
                  onKeyDown={(e) => e.key === 'Enter' && commit('attribute', attrDraft || unitType, shownKind)}
                />
                <span className="font-mono text-xs text-fg-muted">.</span>
                <Input
                  aria-label={`Attribute for ${unitType}`}
                  className="w-40 py-1 font-mono text-xs"
                  placeholder={unitType}
                  value={attrDraft}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setAttrDraft(e.target.value)}
                  onBlur={() => commit('attribute', attrDraft || unitType, shownKind)}
                  onKeyDown={(e) => e.key === 'Enter' && commit('attribute', attrDraft || unitType, shownKind)}
                />
                <datalist id={listId}>
                  {['user', ...existingOptions, ...planned].map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </>
            )}
          </div>
        )}
        {error && <div className="mt-1 text-xs text-error">{error}</div>}
      </td>
      <td className="py-2 pr-3">
        {chosenKind && chosenKind !== 'user' ? (
          <label className="flex items-center gap-1.5 text-xs" title={ldUnits?.includes(chosenKind) ? 'Already a randomization unit of this project' : 'Enable the kind as a randomization unit of the project’s experimentation settings, so experiments can randomize by it'}>
            <input
              type="checkbox"
              aria-label={`${unitType}: available for experiments`}
              checked={experiments(chosenKind)}
              disabled={ldUnits?.includes(chosenKind)}
              onChange={(e) => onExperiments(chosenKind, e.target.checked)}
            />
            <span className="text-fg-muted">{ldUnits?.includes(chosenKind) ? 'enabled in LaunchDarkly' : 'available for experiments'}</span>
          </label>
        ) : chosenKind === 'user' ? (
          <span className="text-xs text-fg-muted">always</span>
        ) : (
          <span className="text-xs text-fg-subtle">—</span>
        )}
      </td>
      <td className="py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span className="text-xs text-fg-muted">
            {standing.kind === 'attribute' && (
              <>
                attribute <code className="font-mono">{standing.target.attribute}</code> of kind <code className="font-mono">{standing.target.contextKind}</code>
                {standing.kindExists ? (connected || standing.target.contextKind === 'user' ? '' : ' (LaunchDarkly not connected)') : !canCreate ? ' — the kind is missing and this token cannot create kinds; an admin must' : connected ? ' — the kind will be created' : ' — the kind will be created (LaunchDarkly not connected)'}
              </>
            )}
            {standing.kind === 'exists' && (
              <>
                kind <code className="font-mono">{standing.target.contextKind}</code>
                {!connected && standing.target.contextKind !== 'user' ? ' (LaunchDarkly not connected)' : ''}
              </>
            )}
            {standing.kind === 'creates' && (
              <>
                kind <code className="font-mono">{standing.target.contextKind}</code>
                {!canCreate ? ' — this token cannot create kinds; an admin must' : connected ? '' : ' (LaunchDarkly not connected)'}
              </>
            )}
            {standing.kind === 'unmapped' &&
              (standing.decided ? (
                <>
                  answered on items so far: <code className="font-mono">{standing.decided}</code>
                </>
              ) : (
                <>
                  suggested: <code className="font-mono">{standing.target.contextKind}</code>
                  {existing.includes(standing.target.contextKind) ? ' (exists)' : ' (new)'}
                </>
              ))}
          </span>
        </div>
      </td>
    </tr>
  );
}

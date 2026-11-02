import { useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { defaultKindFor, sanitizeKey, type MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import { Badge, Button, Callout, Card, Input, Select, Spinner } from '../components/ui.tsx';
import { createLdEnvironment } from '../lib/ld.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

/**
 * Mapping profile (PLAN §7, §12): per source, which LD environment each StatSig environment
 * migrates to, and which LD context kind each unit type becomes.
 */
export function MappingView({ workspaceId, sources, snapshots, m, onConnect }: { workspaceId: string; sources: SourceRecord[]; snapshots: Record<string, CanonicalSnapshot | undefined>; m: MigrationContext; onConnect: () => void }) {
  const save = (fn: (p: MappingProfile) => void) => {
    const next: MappingProfile = structuredClone(m.profile);
    fn(next);
    void m.saveProfile(next);
  };
  // "Create in LD": one in flight at a time, with the outcome shown next to the row.
  const [creating, setCreating] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const createEnv = async (sourceId: string, statsigEnv: string, isProduction: boolean) => {
    const key = sanitizeKey(statsigEnv).toLowerCase();
    setCreating(`${sourceId}|${statsigEnv}`);
    setCreateError(undefined);
    try {
      await createLdEnvironment(workspaceId, { key, name: statsigEnv, critical: isProduction });
      save((p) => void ((p.sources[sourceId] ??= { envMapping: {}, unitTypeKinds: {} }).envMapping[statsigEnv] = key));
    } catch (e) {
      setCreateError(`Could not create LD environment “${key}”: ${(e as Error).message}`);
    } finally {
      setCreating(undefined);
    }
  };
  return (
    <div className="max-w-4xl space-y-5">
      <h2 className="font-display text-xl font-semibold tracking-tight">Mapping</h2>
      {!m.connected && (
        <Callout tone="blue">
          <button className="font-medium underline" onClick={onConnect}>
            Connect LaunchDarkly
          </button>{' '}
          to map StatSig environments to the LD project's environments.
        </Callout>
      )}
      {m.connected && m.ld.probing && (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner /> Refreshing the LD project ({m.ld.probing})…
        </p>
      )}
      {sources.map((s) => {
        const snap = snapshots[s.id];
        if (!snap) return null;
        const sp = m.profile.sources[s.id] ?? { envMapping: {}, unitTypeKinds: {} };
        const used = Object.values(sp.envMapping).filter(Boolean) as string[];
        const dup = used.filter((v, i) => used.indexOf(v) !== i);
        return (
          <Card key={s.id} className="p-5">
            <h3 className="mb-3 font-semibold">
              {s.label} <Badge>{s.alias}</Badge>
            </h3>
            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">Environments</div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-line-soft">
                    {snap.environments.map((e) => (
                      <tr key={e.name}>
                        <td className="py-1.5 pr-3">
                          <span className="font-mono">{e.name}</span>
                          {e.isProduction && (
                            <Badge tone="red" title="Production environment in the source">
                              prod
                            </Badge>
                          )}
                          {e.inferred && <Badge tone="amber">inferred</Badge>}
                        </td>
                        <td className="py-1.5 text-fg-subtle">→</td>
                        <td className="py-1.5">
                          <Select
                            aria-label={`LD environment for ${e.name}`}
                            disabled={!m.connected}
                            value={sp.envMapping[e.name] ?? ''}
                            onChange={(ev) => save((p) => void ((p.sources[s.id] ??= { envMapping: {}, unitTypeKinds: {} }).envMapping[e.name] = ev.target.value || null))}
                          >
                            <option value="">not migrated</option>
                            {m.ldEnvs.map((l) => (
                              <option key={l.key} value={l.key}>
                                {l.key}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="py-1.5 pl-2 text-xs">
                          {m.connected && !sp.envMapping[e.name] && !m.ldEnvs.some((l) => l.key === sanitizeKey(e.name).toLowerCase()) && (
                            <Button
                              variant="ghost"
                              className="py-1 text-xs"
                              disabled={!!creating}
                              title={`Create LD environment “${sanitizeKey(e.name).toLowerCase()}” in project ${m.ld.projectKey} through the LD API, then map ${e.name} to it`}
                              onClick={() => void createEnv(s.id, e.name, !!e.isProduction)}
                            >
                              {creating === `${s.id}|${e.name}` ? <Spinner /> : null} Create “{sanitizeKey(e.name).toLowerCase()}” in LD
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {dup.length > 0 && (
                  <div className="mt-2">
                    <Callout tone="red">Two StatSig environments map to LD “{dup[0]}”. Within one source, map at most one environment to each LD environment.</Callout>
                  </div>
                )}
                {createError && (
                  <div className="mt-2">
                    <Callout tone="red">{createError}</Callout>
                  </div>
                )}
                <p className="mt-2 text-xs text-fg-muted">
                  Environments marked “not migrated” keep LD's default (off, serving false) and keep calling StatSig. A StatSig environment with no LD counterpart can be created in the LD project from here
                  (POST /environments; production tiers are created as critical).
                </p>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">Unit types → context kinds</div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-line-soft">
                    {snap.unitTypes.map((u) => (
                      <UnitTypeRow
                        key={u.name}
                        unitType={u.name}
                        value={sp.unitTypeKinds[u.name]}
                        existing={m.capabilities.existingContextKinds}
                        onChange={(kind) =>
                          save((p) => {
                            const t = (p.sources[s.id] ??= { envMapping: {}, unitTypeKinds: {} }).unitTypeKinds;
                            if (kind) t[u.name] = kind;
                            else delete t[u.name];
                          })
                        }
                      />
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-fg-muted">Custom unit IDs get their own context kind; they are never folded into “user”. Kinds that don't exist in LD are created during the migration.</p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function UnitTypeRow({ unitType, value, existing, onChange }: { unitType: string; value?: string; existing: string[]; onChange: (kind: string | null) => void }) {
  const proposed = defaultKindFor(unitType);
  const [draft, setDraft] = useState(value ?? '');
  return (
    <tr>
      <td className="py-1.5 pr-3 font-mono">{unitType}</td>
      <td className="py-1.5 text-fg-subtle">→</td>
      <td className="py-1.5">
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Context kind for ${unitType}`}
            className="w-36 py-1 font-mono"
            placeholder={proposed}
            value={draft}
            list="ld-context-kinds"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onChange(draft.trim() || null)}
          />
          <datalist id="ld-context-kinds">
            {existing.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          {!value && <span className="text-xs text-fg-subtle">default “{proposed}”{proposed !== 'user' && !existing.includes(proposed) ? ' (asks first)' : ''}</span>}
          {value && !existing.includes(value) && <Badge tone="blue">will be created</Badge>}
        </div>
      </td>
    </tr>
  );
}

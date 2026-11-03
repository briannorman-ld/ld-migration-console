import { useState } from 'react';
import type { CanonicalSnapshot } from '@sslm/canonical';
import { configuredUnit, defaultKindFor, sanitizeKey, type MappingProfile } from '@sslm/mapper';
import type { SourceRecord } from '@sslm/store';
import { Badge, Button, Callout, Card, Select, Spinner } from '../components/ui.tsx';
import { createLdEnvironment } from '../lib/ld.ts';
import type { MigrationContext } from '../lib/useMigration.ts';

/**
 * Mapping profile (PLAN §7, §12): per source, which LD environment each StatSig environment
 * migrates to, and which LD context kind each unit type becomes.
 */
export function MappingView({ workspaceId, sources, snapshots, m, onConnect, onUnitTypes }: { workspaceId: string; sources: SourceRecord[]; snapshots: Record<string, CanonicalSnapshot | undefined>; m: MigrationContext; onConnect: () => void; onUnitTypes: () => void }) {
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
      setCreateError(`Could not create LaunchDarkly environment “${key}”: ${(e as Error).message}`);
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
          to map StatSig environments to the LaunchDarkly project's environments.
        </Callout>
      )}
      {m.connected && m.ld.probing && (
        <p className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner /> Refreshing the LaunchDarkly project ({m.ld.probing})…
        </p>
      )}
      <Card className="p-5">
        <h3 className="mb-1 font-semibold">Flag names</h3>
        <p className="mb-3 text-xs text-fg-muted">
          LaunchDarkly flags take the StatSig display name. Most StatSig items are created with an ID-like name (“ds_paint_props_shaders”), so the display name is the ID; the
          readable option derives a name from it instead (“Ds paint props shaders”). The ID stays on the flag key and in the migration.id property. Changing this marks migrated
          flags as changed; the next sync renames them.
        </p>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          Name flags
          <Select
            aria-label="Flag names"
            value={m.profile.flagNames ?? 'source'}
            onChange={(e) =>
              save((p) => {
                if (e.target.value === 'readable') p.flagNames = 'readable';
                else delete p.flagNames;
              })
            }
          >
            <option value="source">as in StatSig (display name, else the ID)</option>
            <option value="readable">readable, derived from the ID when the display name is the ID</option>
          </Select>
        </label>
      </Card>
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
                            aria-label={`LaunchDarkly environment for ${e.name}`}
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
                              title={`Create LaunchDarkly environment “${sanitizeKey(e.name).toLowerCase()}” in project ${m.ld.projectKey} through the LaunchDarkly API, then map ${e.name} to it`}
                              onClick={() => void createEnv(s.id, e.name, !!e.isProduction)}
                            >
                              {creating === `${s.id}|${e.name}` ? <Spinner /> : null} Create “{sanitizeKey(e.name).toLowerCase()}” in LaunchDarkly
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {dup.length > 0 && (
                  <div className="mt-2">
                    <Callout tone="red">Two StatSig environments map to LaunchDarkly “{dup[0]}”. Within one source, map at most one environment to each LaunchDarkly environment.</Callout>
                  </div>
                )}
                {createError && (
                  <div className="mt-2">
                    <Callout tone="red">{createError}</Callout>
                  </div>
                )}
                <p className="mt-2 text-xs text-fg-muted">
                  Environments marked “not migrated” keep LaunchDarkly's default (off, serving false) and keep calling StatSig. A StatSig environment with no LaunchDarkly counterpart can be created in the LaunchDarkly project from here
                  (POST /environments; production tiers are created as critical).
                </p>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">Unit types → context kinds</div>
                <ul className="space-y-1 text-sm">
                  {snap.unitTypes.map((u) => {
                    const v = Object.entries(sp.unitTypeKinds).find(([k]) => k.toLowerCase() === u.name.toLowerCase())?.[1];
                    const t = configuredUnit(m.profile, s.id, u.name);
                    const target = t ? (t.attribute === 'key' ? t.contextKind : `${t.contextKind} attribute ${t.attribute}`) : defaultKindFor(u.name);
                    return (
                      <li key={u.name} className="flex items-center gap-2">
                        <span className="font-mono">{u.name}</span>
                        <span className="text-fg-subtle">→</span>
                        <span className="font-mono">{target}</span>
                        {!v && <span className="text-xs text-fg-subtle">default</span>}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-fg-muted">
                  Where each unit type's IDs go in LaunchDarkly is chosen on the{' '}
                  <button type="button" className="text-link hover:underline" onClick={onUnitTypes}>
                    Unit types
                  </button>{' '}
                  page: the key of a context kind (created during the migration if LaunchDarkly lacks it) or an attribute of a context kind. Custom unit IDs are never folded into “user”.
                </p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}


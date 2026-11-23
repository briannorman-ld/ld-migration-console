/**
 * LaunchDarkly source adapter, inventory side (PLAN §20.6): every resource type of the source
 * beyond flags, segments and experimentation → `NeutralInventoryItem`s with the facts the
 * explorer shows, plus the two kinds that feed existing paths: pending scheduled changes become
 * the `scheduled_changes` caveat on their flag (the mapper carries them as LD scheduled changes),
 * teams and members become `snapshot.teams` / `snapshot.users` for the guide's Teams and People
 * steps. Pure. Nothing is dropped silently: an instruction the console cannot translate is kept
 * as the change's operation name and the mapper notes it.
 */
import { neutralUid, type CanonicalSnapshot, type NeutralFact, type NeutralInventoryItem, type NeutralMaintainer, type NeutralProject, type NeutralRule, type NeutralScheduledChange, type SnapshotWarning, type StatsigTeam } from '@sslm/canonical';
import type { LdFlag, LdMember, LdScheduledChange } from '@sslm/ld-client';
import type { RawLdSnapshot } from './read.ts';

type Warn = (w: SnapshotWarning) => void;

export function normalizeInventory(raw: RawLdSnapshot, sourceId: string, neutral: NeutralProject, snap: CanonicalSnapshot, warn: Warn): void {
  neutral.readScope = [...raw.scope];
  const items: NeutralInventoryItem[] = [];
  const envKeys = raw.environments.map((e) => e.key);
  const flagsByKey = new Map(raw.flags.map((f) => [f.key, f]));
  const memberById = new Map<string, LdMember>(Object.entries(raw.members));
  const maintainerOf = (id: string | null | undefined, email?: string | null): NeutralMaintainer | undefined => {
    const m = id ? memberById.get(id) : undefined;
    const e = email ?? m?.email;
    if (!id && !e) return undefined;
    return { ...(id ? { id } : {}), ...(e ? { email: e } : {}) };
  };
  const item = (resourceKind: string, key: string, x: Omit<Partial<NeutralInventoryItem>, 'kind' | 'uid' | 'resourceKind' | 'key'> & { name?: string; raw: unknown }): NeutralInventoryItem => {
    const scoped = [x.env, x.flagKey, key].filter((s): s is string => !!s).join('/');
    return {
      kind: 'inventory',
      uid: neutralUid(sourceId, resourceKind as never, scoped),
      resourceKind,
      key,
      name: x.name ?? key,
      description: x.description ?? '',
      tags: x.tags ?? [],
      archived: x.archived ?? false,
      ...(x.env ? { env: x.env } : {}),
      ...(x.flagKey ? { flagKey: x.flagKey } : {}),
      facts: (x.facts ?? []).filter((f) => f.value !== ''),
      ...(x.maintainer ? { maintainer: x.maintainer } : {}),
      raw: x.raw,
      ...(x.createdAt != null ? { createdAt: x.createdAt } : {}),
      ...(x.lastModified != null ? { lastModified: x.lastModified } : {}),
    };
  };
  const fact = (label: string, value: unknown): NeutralFact => ({ label, value: value == null ? '' : Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value) });
  const count = (n: number | null | undefined, word: string) => (n == null ? '' : `${n} ${word}${n === 1 ? '' : 's'}`);
  const statements = (p: { effect?: string | null; resources?: string[] | null; notResources?: string[] | null; actions?: string[] | null; notActions?: string[] | null }[] | null | undefined) =>
    (p ?? []).map((s) => `${s.effect ?? 'allow'} ${(s.actions ?? s.notActions ?? ['*']).join(',')} on ${(s.resources ?? s.notResources ?? ['*']).join(', ')}`);

  // --- Experimentation settings ---
  if (raw.experimentationSettings) {
    const units = raw.experimentationSettings.randomizationUnits ?? [];
    items.push(
      item('experimentation_settings', 'randomization-units', {
        name: 'Randomization units',
        facts: [fact('Units', units.map((u) => u.randomizationUnit)), fact('Default', units.find((u) => u.default)?.randomizationUnit)],
        raw: raw.experimentationSettings,
      }),
    );
  }

  // --- AI Configs and model configs ---
  for (const c of raw.aiConfigs) {
    const variations = c.variations ?? [];
    items.push(
      item('ai_configs', c.key, {
        name: c.name,
        description: c.description ?? '',
        tags: c.tags ?? [],
        maintainer: maintainerOf(c._maintainer?.member?._id, c._maintainer?.member?.email),
        facts: [
          fact('Mode', c.mode),
          fact('Variations', variations.map((v) => `${v.name ?? v.key}${v.modelConfigKey ? ` (${v.modelConfigKey})` : v.model && typeof v.model === 'object' && 'name' in v.model ? ` (${String((v.model as { name?: unknown }).name)})` : ''}`)),
          fact('Evaluation metric', c.evaluationMetricKey ?? c.evaluationMetricKeys),
          fact('Version', c.version),
        ],
        raw: c,
        createdAt: c.createdAt ?? undefined,
        lastModified: c.updatedAt ?? undefined,
      }),
    );
  }
  for (const mc of raw.modelConfigs) {
    items.push(
      item('model_configs', mc.key, {
        name: mc.name ?? mc.key,
        tags: mc.tags ?? [],
        maintainer: maintainerOf(mc._maintainer?.member?._id, mc._maintainer?.member?.email),
        facts: [fact('Provider', mc.provider), fact('Global', mc.global), fact('Parameters', Object.keys(mc.params ?? {})), fact('Custom parameters', Object.keys(mc.customParams ?? {})), fact('Used by', count(mc.usedInCount, 'variation'))],
        raw: mc,
      }),
    );
  }

  // --- Releases ---
  for (const p of raw.releasePipelines) {
    const phases = p.phases ?? [];
    items.push(
      item('release_pipelines', p.key, {
        name: p.name ?? p.key,
        description: p.description ?? '',
        tags: p.tags ?? [],
        facts: [
          fact('Phases', phases.map((ph) => `${ph.name ?? ph.id ?? '?'} → ${(ph.audiences ?? []).map((a) => a.environment?.key ?? a.name ?? '?').join(', ')}`)),
          fact('Requires approval', phases.some((ph) => (ph.audiences ?? []).some((a) => a.configuration?.requireApproval))),
          fact('Project default', p.isProjectDefault),
        ],
        raw: p,
        createdAt: p.createdAt ? Date.parse(p.createdAt) || undefined : undefined,
      }),
    );
  }
  for (const r of raw.releasePolicies) {
    items.push(
      item('release_policies', r.key, {
        name: r.name ?? r.key,
        facts: [fact('Rank', r.rank), fact('Environments', r.scope?.environmentKeys), fact('Flag tags', r.scope?.flagTagKeys), fact('Release method', typeof r.releaseMethod === 'string' ? r.releaseMethod : r.guardedReleaseConfig ? 'guarded' : r.progressiveReleaseConfig ? 'progressive' : '')],
        raw: r,
      }),
    );
  }

  // --- Views ---
  for (const v of raw.views) {
    if (v.deleted) continue;
    items.push(
      item('views', v.key, {
        name: v.name ?? v.key,
        description: v.description ?? '',
        tags: v.tags ?? [],
        maintainer: maintainerOf(v.maintainer?.member?._id, v.maintainer?.member?.email),
        facts: [fact('Flags', v.flagsSummary?.count), fact('Segments', v.segmentsSummary?.count), fact('Metrics', v.metricsSummary?.count), fact('AI Configs', v.aiConfigsSummary?.count), fact('Generates SDK keys', v.generateSdkKeys)],
        raw: v,
        createdAt: v.createdAt ?? undefined,
        lastModified: v.updatedAt ?? undefined,
      }),
    );
  }

  // --- Environment settings: approvals, destinations, adaptive triggers ---
  if (raw.scope.includes('approval_settings')) {
    for (const e of raw.environments) {
      const a = e.approvalSettings;
      const perResource = Object.entries(e.resourceApprovalSettings ?? {}).filter(([, s]) => s.required);
      if (!a?.required && perResource.length === 0) continue;
      items.push(
        item('approval_settings', e.key, {
          name: `Approvals in ${e.name}`,
          env: e.key,
          facts: [
            fact('Required', a?.required),
            fact('Minimum approvals', a?.minNumApprovals),
            fact('Service', a?.serviceKind),
            fact('Required for tags', a?.requiredApprovalTags),
            fact('Per resource', perResource.map(([k, s]) => `${k}${s.minNumApprovals ? ` (${s.minNumApprovals})` : ''}`)),
            fact('Comments required', e.requireComments),
            fact('Confirm changes', e.confirmChanges),
          ],
          raw: { key: e.key, approvalSettings: a, resourceApprovalSettings: e.resourceApprovalSettings, requireComments: e.requireComments, confirmChanges: e.confirmChanges },
        }),
      );
    }
  }
  for (const env of envKeys) {
    for (const d of raw.destinations[env] ?? []) {
      items.push(item('destinations', d._id, { name: d.name ?? d._id, env, maintainer: maintainerOf(d.maintainerId), facts: [fact('Kind', d.kind), fact('On', d.on), fact('Version', d.version)], raw: d, createdAt: d.createdAt ?? undefined }));
    }
    for (const t of raw.adaptiveTriggers[env] ?? []) {
      items.push(
        item('adaptive_triggers', t.id, {
          name: t.name ?? t.id,
          env,
          ...(t.resourceKind === 'flag' && t.resourceKey ? { flagKey: t.resourceKey } : {}),
          facts: [fact('Resource', t.resourceKind && t.resourceKey ? `${t.resourceKind} ${t.resourceKey}` : ''), fact('Enabled', t.enabled), fact('Source', (t.triggerSource as { kind?: unknown } | null)?.kind), fact('Action', (t.task as { kind?: unknown } | null)?.kind)],
          raw: t,
          createdAt: t.createdAt ?? undefined,
          lastModified: t.updatedAt ?? undefined,
        }),
      );
    }
  }

  // --- Per flag: scheduled changes (also a caveat on the flag), triggers, workflows, links ---
  const caveatsByFlag = new Map<string, NeutralScheduledChange[]>();
  for (const env of envKeys) {
    for (const [flagKey, changes] of Object.entries(raw.scheduledChanges[env] ?? {})) {
      const flag = flagsByKey.get(flagKey);
      for (const sc of changes) {
        const translated = translateScheduledChange(sc, env, flag, warn, `scheduled-changes/${env}/${flagKey}/${sc._id}`);
        (caveatsByFlag.get(flagKey) ?? caveatsByFlag.set(flagKey, []).get(flagKey)!).push(translated);
        items.push(
          item('scheduled_changes', sc._id, {
            name: `${translated.operation} on ${flagKey}`,
            env,
            flagKey,
            maintainer: maintainerOf(sc._maintainerId),
            facts: [fact('Runs at', translated.at), fact('Instructions', (sc.instructions ?? []).map((i) => kindOf(i))), fact('Translated', translated.on !== undefined || !!translated.rules?.length ? 'yes' : 'no (noted on the flag)')],
            raw: sc,
            createdAt: sc._creationDate ?? undefined,
          }),
        );
      }
    }
    for (const [flagKey, triggers] of Object.entries(raw.flagTriggers[env] ?? {})) {
      for (const t of triggers) {
        items.push(
          item('flag_triggers', t._id, {
            name: `${t._integrationKey ?? 'generic'} trigger on ${flagKey}`,
            env,
            flagKey,
            maintainer: maintainerOf(t._maintainerId, t._maintainer?.email),
            facts: [fact('Integration', t._integrationKey), fact('Enabled', t.enabled), fact('Status', t._status), fact('Does', (t.instructions ?? []).map((i) => kindOf(i))), fact('Fired', count(t._triggerCount, 'time')), fact('Trigger URL', 'not read (it is the credential)')],
            raw: t,
            createdAt: t._creationDate ?? undefined,
          }),
        );
      }
    }
    for (const [flagKey, wfs] of Object.entries(raw.workflows[env] ?? {})) {
      for (const w of wfs) {
        items.push(
          item('workflows', w._id, {
            name: w.name ?? `${w.kind ?? 'workflow'} on ${flagKey}`,
            description: w.description ?? '',
            env,
            flagKey,
            maintainer: maintainerOf(w._maintainerId),
            facts: [fact('Kind', w.kind), fact('Stages', (w.stages ?? []).map((s) => s.name ?? '?')), fact('Status', w._execution?.status), fact('Template', w.templateKey)],
            raw: w,
            createdAt: w._creationDate ?? undefined,
          }),
        );
      }
    }
  }
  for (const [flagKey, links] of Object.entries(raw.flagLinks)) {
    for (const l of links) {
      const key = l._id ?? l._key ?? l._deepLink ?? `${flagKey}-link`;
      items.push(
        item('flag_links', key, {
          name: l.title ?? l._deepLink ?? key,
          description: l.description ?? '',
          flagKey,
          maintainer: maintainerOf(l._member?._id, l._member?.email),
          facts: [fact('Integration', l._integrationKey), fact('Link', l._deepLink)],
          raw: l,
          createdAt: l._createdAt ?? undefined,
        }),
      );
    }
  }
  for (const flag of neutral.flags) {
    const changes = caveatsByFlag.get(flag.key);
    if (changes?.length) (flag.caveats ??= []).push({ kind: 'scheduled_changes', detail: { changes } });
  }

  // --- Account: teams, members, roles, webhooks, relay, code refs, templates, applications ---
  if (raw.teams.length) {
    const teams: StatsigTeam[] = [];
    for (const t of raw.teams) {
      const memberEmails = raw.accountMembers.filter((m) => (m.teams ?? []).some((x) => x.key === t.key)).map((m) => m.email.trim().toLowerCase());
      teams.push({ id: t.key, name: t.name ?? t.key, ...(t.description ? { description: t.description } : {}), ...(raw.accountMembers.length ? { memberEmails } : {}) });
      items.push(
        item('teams', t.key, {
          name: t.name ?? t.key,
          description: t.description ?? '',
          facts: [fact('Members', count(t.members?.totalCount ?? (raw.accountMembers.length ? memberEmails.length : undefined), 'member')), fact('Projects', count((t as { projects?: { totalCount?: number | null } | null }).projects?.totalCount, 'project')), fact('Roles', count((t as { roles?: { totalCount?: number | null } | null }).roles?.totalCount, 'role')), fact('Synced from IdP', (t as { _idpSynced?: boolean | null })._idpSynced)],
          raw: t,
          createdAt: (t as { _creationDate?: number | null })._creationDate ?? undefined,
          lastModified: (t as { _lastModified?: number | null })._lastModified ?? undefined,
        }),
      );
    }
    snap.teams = teams;
  }
  for (const m of raw.accountMembers) {
    items.push(
      item('members', m.email, {
        name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
        facts: [fact('Role', m.role), fact('Custom roles', (m as { customRoles?: string[] | null }).customRoles), fact('Teams', (m.teams ?? []).map((t) => t.name ?? t.key)), fact('Pending invite', m._pendingInvite)],
        maintainer: { id: m._id, email: m.email },
        raw: m,
        createdAt: (m as { creationDate?: number | null }).creationDate ?? undefined,
      }),
    );
  }
  for (const r of raw.customRoles) {
    items.push(
      item('custom_roles', r.key, {
        name: r.name ?? r.key,
        description: r.description ?? '',
        facts: [fact('Base permissions', r.basePermissions), fact('Category', r.resourceCategory), fact('Statements', statements(r.policy)), fact('Assigned to', [count(r.assignedTo?.membersCount, 'member'), count(r.assignedTo?.teamsCount, 'team')].filter(Boolean))],
        raw: r,
      }),
    );
  }
  for (const w of raw.webhooks) {
    items.push(item('webhooks', w._id, { name: w.name ?? w.url ?? w._id, tags: w.tags ?? [], facts: [fact('URL', w.url), fact('On', w.on), fact('Statements', statements(w.statements)), fact('Signing secret', 'not read')], raw: w }));
  }
  for (const r of raw.relayProxyConfigs) {
    items.push(item('relay_proxy_configs', r._id, { name: r.name ?? r.displayKey ?? r._id, maintainer: maintainerOf(r._creator?._id, r._creator?.email), facts: [fact('Key', r.displayKey ? `…${r.displayKey}` : 'not read'), fact('Policy', statements(r.policy))], raw: r, createdAt: r.creationDate ?? undefined, lastModified: r.lastModified ?? undefined }));
  }
  for (const r of raw.repositories) {
    items.push(item('code_references', r.name, { name: r.name, facts: [fact('Type', r.type), fact('Source', r.sourceLink), fact('Default branch', r.defaultBranch), fact('Enabled', r.enabled), fact('Branches', count(r.branches?.length, 'branch'))], raw: r }));
  }
  for (const t of raw.workflowTemplates) {
    items.push(item('workflow_templates', t._key ?? t._id, { name: t.name ?? t._key ?? t._id, description: t.description ?? '', maintainer: maintainerOf(t._maintainerId ?? t._ownerId), facts: [fact('Stages', (t.stages ?? []).map((s) => s.name ?? '?'))], raw: t, createdAt: t._creationDate ?? undefined }));
  }
  for (const a of raw.applications) {
    items.push(item('applications', a.key, { name: a.name ?? a.key, description: a.description ?? '', maintainer: maintainerOf(a._maintainer?._id, a._maintainer?.email), facts: [fact('Kind', a.kind), fact('Added by SDKs', a.autoAdded), fact('Flags', count(a.flags?.totalCount, 'flag'))], raw: a, createdAt: a.creationDate ?? undefined }));
  }

  items.sort((a, b) => a.resourceKind.localeCompare(b.resourceKind) || (a.env ?? '').localeCompare(b.env ?? '') || (a.flagKey ?? '').localeCompare(b.flagKey ?? '') || a.key.localeCompare(b.key));
  neutral.inventory = items;
}

/** `{ kind: 'turnFlagOn' }` → `turnFlagOn`; anything else → its JSON. */
function kindOf(i: unknown): string {
  if (i && typeof i === 'object' && 'kind' in i) return String((i as { kind: unknown }).kind);
  return JSON.stringify(i);
}

/**
 * An LD scheduled change (semantic-patch instructions with an `executionDate`) → the neutral
 * change the mapper knows (PLAN §22.3 shape, PLAN §20.6): `turnFlagOn` / `turnFlagOff` → `on`;
 * `addRule` → rules (variation ids resolved to indexes against the source flag); any other
 * instruction stays as its name in `operation`, which the mapper treats as "could not be
 * translated" and notes. An `addRule` whose variation id is not on the flag is a warning and the
 * rule is left out, so the change is noted rather than written wrong.
 */
export function translateScheduledChange(sc: LdScheduledChange, env: string, flag: LdFlag | undefined, warn: Warn, path: string): NeutralScheduledChange {
  const instructions = (sc.instructions ?? []).filter((i): i is Record<string, unknown> => !!i && typeof i === 'object');
  const kinds = instructions.map(kindOf);
  const variationIndex = (id: unknown): number | undefined => {
    const idx = (flag?.variations ?? []).findIndex((v) => v._id === id);
    return idx >= 0 ? idx : undefined;
  };
  let on: boolean | undefined;
  const rules: NeutralRule[] = [];
  let untranslated = false;
  for (const i of instructions) {
    switch (i.kind) {
      case 'turnFlagOn':
        on = true;
        break;
      case 'turnFlagOff':
        on = false;
        break;
      case 'addRule': {
        const clauses = (Array.isArray(i.clauses) ? i.clauses : []).filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
        const rule: NeutralRule = {
          ...(typeof i.ruleId === 'string' ? { id: i.ruleId } : {}),
          description: typeof i.description === 'string' ? i.description : '',
          clauses: clauses.map((c) => ({ contextKind: typeof c.contextKind === 'string' ? c.contextKind : 'user', attribute: String(c.attribute ?? ''), op: String(c.op ?? 'in'), values: Array.isArray(c.values) ? c.values : [], negate: !!c.negate })),
        };
        if (i.rolloutWeights && typeof i.rolloutWeights === 'object') {
          const variations: { variation: number; weight: number }[] = [];
          for (const [vid, w] of Object.entries(i.rolloutWeights as Record<string, unknown>)) {
            const idx = variationIndex(vid);
            if (idx === undefined) {
              warn({ code: 'unresolved_reference', path, message: `addRule rollout names variation “${vid}”, which is not on flag “${flag?.key ?? '?'}”; the change is noted, not carried.` });
              untranslated = true;
              break;
            }
            variations.push({ variation: idx, weight: Number(w) });
          }
          rule.rollout = { contextKind: typeof i.rolloutContextKind === 'string' ? i.rolloutContextKind : 'user', ...(typeof i.rolloutBucketBy === 'string' ? { bucketBy: i.rolloutBucketBy } : {}), variations };
        } else {
          const idx = variationIndex(i.variationId);
          if (idx === undefined) {
            warn({ code: 'unresolved_reference', path, message: `addRule serves variation “${String(i.variationId)}”, which is not on flag “${flag?.key ?? '?'}”; the change is noted, not carried.` });
            untranslated = true;
            break;
          }
          rule.variation = idx;
        }
        if (!untranslated) rules.push(rule);
        break;
      }
      default:
        untranslated = true;
    }
  }
  const at = typeof sc.executionDate === 'number' ? new Date(sc.executionDate).toISOString() : '';
  const out: NeutralScheduledChange = { at, operation: kinds.join(', ') || 'unknown', recurring: false, env, id: sc._id };
  // A change the console can only partly translate is not carried: half a change would leave the target in a state the source never has.
  if (untranslated) return out;
  if (on !== undefined) out.on = on;
  if (rules.length) out.rules = rules;
  return out;
}



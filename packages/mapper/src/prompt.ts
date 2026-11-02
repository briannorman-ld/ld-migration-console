/**
 * StatSig prompt (AI Config) → LD AI Config shell (PLAN §6; coverage row `operations.ai`).
 *
 * The Console API (20240601) lists prompts with their name, description, tags, owner, team and a
 * version counter, but has no endpoint that reads the versions themselves (messages, model,
 * parameters). So the mapper produces the AI Config shell, tagged and attributed like a flag, and
 * reports `manual` fidelity: the variations are added in LD by hand. Pure and deterministic.
 */
import { fingerprint, type Prompt } from '@sslm/canonical';
import { unique } from './conditions.ts';
import { DecisionCollector } from './decisions.ts';
import { report, sourceTag, TAG_MIGRATED, type MapArgs, type MapOutcome } from './gate.ts';
import { chooseMaintainer } from './maintainer.ts';
import { sanitizeKey, sanitizeTag } from './profile.ts';
import type { DesiredAiConfig, FidelityNote } from './types.ts';

export interface PromptMapResult extends MapOutcome {
  key: string;
  desired: DesiredAiConfig;
}

export function mapPrompt(args: MapArgs<Prompt>): PromptMapResult {
  const { entity: p, canonical, profile } = args;
  const alias = canonical.snapshot.source.alias;
  const sourceId = p.source.sourceId;
  const decisions = new DecisionCollector(args.resolutions, profile);
  const fidelity: FidelityNote[] = [];
  const subject = { sourceId, kind: 'prompt' as const, uid: p.uid, id: p.id };
  const key = sanitizeKey(p.id);
  if (key !== p.id) fidelity.push({ fidelity: 'full', message: `AI Config key “${key}” differs from the StatSig name “${p.id}” (LD keys allow letters, digits, . _ -).` });
  const tags = unique([TAG_MIGRATED, sourceTag(alias), ...p.tags.map(sanitizeTag)].filter(Boolean));
  const renamed = p.tags.filter((t) => sanitizeTag(t) !== t);
  if (renamed.length) fidelity.push({ fidelity: 'full', message: `Tag${renamed.length === 1 ? '' : 's'} ${renamed.map((t) => `“${t}”`).join(', ')} renamed to fit LD's tag format.` });
  const maintainer = chooseMaintainer({ profile, ...(args.directory ? { directory: args.directory } : {}), decisions, subject, fidelity }, p);
  fidelity.push({
    fidelity: 'manual',
    message: `StatSig's Console API does not expose prompt versions (messages, model, parameters)${p.version !== undefined ? `; this prompt is at version ${p.version}` : ''}. The AI Config is created with its name, description, tags and maintainer: add the variations in LD and choose the default one.`,
    location: 'variations',
  });
  if (p.holdoutIds.length) fidelity.push({ fidelity: 'partial', message: `In ${p.holdoutIds.length} StatSig holdout${p.holdoutIds.length === 1 ? '' : 's'} (${p.holdoutIds.join(', ')}); LD holdouts are recreated separately (PLAN §11).`, location: 'holdouts' });

  const desired: DesiredAiConfig = { key, name: p.name || p.id, description: p.description ?? '', tags, mode: 'completion', ...maintainer };
  return {
    uid: p.uid,
    entityId: p.id,
    sourceId,
    key,
    desired,
    fidelity: report(fidelity, p.archived ? 'archived in StatSig' : undefined),
    unresolved: decisions.unresolved,
    applied: decisions.applied,
    stale: decisions.stale,
    dependencies: [],
    statsigFingerprint: fingerprint({ id: p.id, name: p.name, description: p.description ?? '', tags: [...p.tags].sort(), owner: p.owner?.email ?? null, team: p.team ?? null, version: p.version ?? null }),
    decisionSetHash: decisions.setHash(),
    ...(p.archived ? { skipped: 'archived in StatSig' } : {}),
  };
}

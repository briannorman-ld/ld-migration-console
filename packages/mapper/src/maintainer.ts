/**
 * Owner → maintainer (PLAN §8.3 `maintainer_unknown`; edge case 1.5). An LD maintainer must be an
 * account member, so a StatSig owner is matched by email against the LD member directory. The
 * People step of the guide decides the rest once per owner (profile.maintainers): invite them,
 * pick a member, assign the team, or leave the item without a maintainer. An owner nobody has
 * decided on, and who matches no member, raises the decision on each of their items.
 */
import type { Owner } from '@sslm/canonical';
import type { DecisionCollector } from './decisions.ts';
import { sanitizeKey } from './profile.ts';
import type { DecisionOption, DecisionSubject, FidelityNote, LdDirectory, MappingProfile } from './types.ts';

export interface MaintainerAssignment {
  maintainerId?: string;
  maintainerTeamKey?: string;
}

/** What `chooseMaintainer` needs from a mapping context. */
export interface MaintainerContext {
  profile: MappingProfile;
  directory?: LdDirectory;
  decisions: DecisionCollector;
  subject: DecisionSubject;
  fidelity: FidelityNote[];
}

/** An LD team key for a StatSig team name: lower-cased, LD key characters only. */
export const teamKeyFor = (name: string): string => sanitizeKey(name).toLowerCase();

/** `member:<id>` / `team:<key>`: free-form answers a `maintainer_unknown` decision accepts. */
export const memberOption = (id: string): string => `member:${id}`;
export const teamOption = (key: string): string => `team:${key}`;

/** The LD team for a source team name: the profile's mapping first, then a directory team of the same key or name. */
export function teamKeyForName(profile: MappingProfile, directory: LdDirectory | undefined, name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const mapped = profile.teams?.[name];
  if (mapped !== undefined) return mapped ?? undefined;
  const key = teamKeyFor(name);
  const t = directory?.teams.find((x) => x.key === key || (x.name ?? '').toLowerCase() === name.toLowerCase());
  return t?.key;
}

/** The LD member for an owner email: the profile's choice first, then the directory. */
export function memberIdForEmail(profile: MappingProfile, directory: LdDirectory | undefined, email: string): string | undefined {
  const choice = profile.maintainers?.[email];
  if (choice && typeof choice === 'object' && 'memberId' in choice) return choice.memberId;
  return directory?.members.find((m) => m.email.toLowerCase() === email)?.id;
}

export function chooseMaintainer(ctx: MaintainerContext, entity: { owner?: Owner; team?: string | null }): MaintainerAssignment {
  const picked = pickMaintainer(ctx, entity);
  // The assignment goes into the decision-set hash: an owner provisioned or invited after the
  // flag migrated turns from "no maintainer" into a member match, and the next sync applies it.
  if (picked.maintainerId) ctx.decisions.note('maintainer', `member:${picked.maintainerId}`);
  else if (picked.maintainerTeamKey) ctx.decisions.note('maintainer', `team:${picked.maintainerTeamKey}`);
  return picked;
}

function pickMaintainer(ctx: MaintainerContext, entity: { owner?: Owner; team?: string | null }): MaintainerAssignment {
  const email = entity.owner?.email?.trim().toLowerCase() || undefined;
  const teamKey = teamKeyForName(ctx.profile, ctx.directory, entity.team);
  const loc = 'flag settings';
  const unassigned = (why: string): MaintainerAssignment => {
    if (teamKey) {
      ctx.fidelity.push({ fidelity: 'full', message: `${why}; the team “${teamKey}” is the maintainer.`, location: loc });
      return { maintainerTeamKey: teamKey };
    }
    ctx.fidelity.push({ fidelity: 'partial', message: `${why}: no maintainer in LD (the owner stays in the migration.owner custom property).`, location: loc });
    return {};
  };

  if (!email) {
    if (teamKey) return { maintainerTeamKey: teamKey };
    if (entity.team) ctx.fidelity.push({ fidelity: 'full', message: `Team “${entity.team}” has no LD team yet; create it on the People step to make it the maintainer.`, location: loc });
    return {};
  }

  const choice = ctx.profile.maintainers?.[email];
  if (choice === 'unassigned') return unassigned(`Owner ${email} left without an LD member (People step)`);
  if (choice && 'memberId' in choice) return { maintainerId: choice.memberId };
  if (choice && 'teamKey' in choice) return { maintainerTeamKey: choice.teamKey };

  const member = ctx.directory?.members.find((m) => m.email.toLowerCase() === email);
  if (member) return { maintainerId: member.id };

  const readable = ctx.directory?.membersReadable ?? false;
  const options: DecisionOption[] = [
    { key: 'unassigned', label: 'No maintainer', explanation: 'The flag is created without a maintainer. The owner email stays in the migration.owner custom property, so it can be assigned later.', resultingFidelity: 'partial' },
    ...(teamKey ? [{ key: teamOption(teamKey), label: `Assign the team “${teamKey}”`, explanation: `${entity.team} exists in LD as a team; the team becomes the maintainer.`, resultingFidelity: 'full' as const }] : []),
  ];
  const picked = ctx.decisions.choose(
    {
      type: 'maintainer_unknown',
      severity: 'choice',
      subject: { ...ctx.subject, location: loc },
      path: 'maintainer',
      title: `Owner ${email} is not a LaunchDarkly member`,
      explanation: readable
        ? `No member of the LD account has this email, so the flag cannot carry its owner as maintainer. Invite them on the People step of the guide (they become the maintainer on the next sync), assign the team, pick another member, or leave it unassigned.`
        : `This token cannot list the LD account's members, so owners cannot be matched. Connect with a token that may read members, invite the owner, or leave the flag without a maintainer.`,
      sourceFragment: entity.owner,
      fingerprintOf: { email, team: teamKey ?? null },
      options,
      recommended: teamKey ? teamOption(teamKey) : 'unassigned',
    },
    'unassigned',
  );
  if (picked.startsWith('team:')) return { maintainerTeamKey: picked.slice('team:'.length) };
  if (picked.startsWith('member:')) return { maintainerId: picked.slice('member:'.length) };
  ctx.fidelity.push({ fidelity: 'partial', message: `Owner ${email} is not an LD member: no maintainer (kept in migration.owner).`, location: loc });
  return {};
}

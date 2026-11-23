/**
 * Every resource type a LaunchDarkly project (or the account around it) exposes to a reader, and
 * how the console treats each when that project is attached as a *source* (PLAN §20.6). This is
 * the read scope a user picks when adding an LD source: every kind here can be read; the
 * `migrates` column says what happens next (copied by the mapper, carried with its flag, or
 * inventoried for the cut-over checklist). The kinds LD has but the console never reads are in
 * `LD_NOT_READ`, with the reason, so the picker can say so.
 *
 * Route names follow reference/launchdarkly/openapi.json. `requests` is the read cost, so the
 * picker can warn: one request, one per environment, one per flag, or one per flag *and*
 * environment (scheduled changes, triggers, workflows have no project-wide listing).
 */
export type LdResourceKind =
  // Flags and targeting
  | 'flags'
  | 'segments'
  | 'scheduled_changes'
  | 'flag_triggers'
  | 'workflows'
  | 'flag_links'
  // Experimentation
  | 'metrics'
  | 'metric_groups'
  | 'experiments'
  | 'holdouts'
  | 'layers'
  | 'experimentation_settings'
  // AI
  | 'ai_configs'
  | 'model_configs'
  // Releases
  | 'release_pipelines'
  | 'release_policies'
  // Project and environment settings
  | 'views'
  | 'approval_settings'
  | 'destinations'
  | 'adaptive_triggers'
  // Account-level (shared by every project of the source account)
  | 'teams'
  | 'members'
  | 'custom_roles'
  | 'webhooks'
  | 'relay_proxy_configs'
  | 'code_references'
  | 'workflow_templates'
  | 'applications';

export type LdResourceGroup = 'flags' | 'experimentation' | 'ai' | 'releases' | 'settings' | 'account';

/** What the console does with a kind once read. */
export type LdResourceHandling =
  /** The mapper writes it into the target (its own explorer, decisions, sync). */
  | 'migrates'
  /** Carried on its flag's migration (a decision on the flag), not an item of its own. */
  | 'with_flag'
  /** Feeds the guide's Teams / People steps. */
  | 'people'
  /** Listed with its facts for the cut-over checklist; no write path yet (coverage row says why). */
  | 'inventory';

export interface LdResourceInfo {
  kind: LdResourceKind;
  /** Plural label as the UI shows it. */
  label: string;
  group: LdResourceGroup;
  /** Where the resource lives in LD. */
  scope: 'project' | 'environment' | 'flag' | 'account';
  /** Read cost, for the picker's hint. */
  requests: 'one' | 'per_environment' | 'per_flag' | 'per_flag_environment' | 'per_item';
  /** Ticked when a source is added without choosing. The per-flag-per-environment reads are off: a project of 500 flags and 5 environments is 2,500 requests per kind. */
  defaultOn: boolean;
  handling: LdResourceHandling;
  /** Needs the `LD-API-Version: beta` header. */
  beta?: boolean;
  /** Kinds this one cannot be read without (per-flag routes need the flag list). */
  requires?: LdResourceKind[];
  /** One sentence for the picker. */
  description: string;
  /** Coverage matrix row (`packages/coverage/src/matrix.ts`) describing the kind. */
  coverageId: string;
}

export const LD_RESOURCE_INFO: Record<LdResourceKind, LdResourceInfo> = {
  flags: { kind: 'flags', label: 'Flags', group: 'flags', scope: 'project', requests: 'per_item', defaultOn: true, handling: 'migrates', description: 'Every flag with each environment’s targeting (one request per flag); archived flags are listed apart.', coverageId: 'ld_source.flags' },
  segments: { kind: 'segments', label: 'Segments', group: 'flags', scope: 'environment', requests: 'per_environment', defaultOn: true, handling: 'migrates', description: 'Segments per environment, rules and lists; big segments without their membership.', coverageId: 'ld_source.segments' },
  scheduled_changes: { kind: 'scheduled_changes', label: 'Scheduled changes', group: 'flags', scope: 'flag', requests: 'per_flag_environment', defaultOn: false, handling: 'with_flag', requires: ['flags'], description: 'Pending scheduled changes on each flag, carried as a decision on the flag (turn on/off and added rules become LaunchDarkly scheduled changes in the target).', coverageId: 'ld_source.scheduled_changes' },
  flag_triggers: { kind: 'flag_triggers', label: 'Flag triggers', group: 'flags', scope: 'flag', requests: 'per_flag_environment', defaultOn: false, handling: 'inventory', requires: ['flags'], description: 'Trigger URLs that flip a flag from a monitoring tool; the URL itself is a secret and is not read.', coverageId: 'ld_source.flag_triggers' },
  workflows: { kind: 'workflows', label: 'Workflows', group: 'flags', scope: 'flag', requests: 'per_flag_environment', defaultOn: false, handling: 'inventory', requires: ['flags'], description: 'Custom workflows (staged rollouts with approvals and waits) running on each flag.', coverageId: 'ld_source.workflows' },
  flag_links: { kind: 'flag_links', label: 'Flag links', group: 'flags', scope: 'flag', requests: 'per_flag', defaultOn: false, handling: 'inventory', beta: true, requires: ['flags'], description: 'Links from a flag to Jira issues, Slack threads and other URLs.', coverageId: 'ld_source.flag_links' },
  metrics: { kind: 'metrics', label: 'Metrics', group: 'experimentation', scope: 'project', requests: 'one', defaultOn: true, handling: 'migrates', description: 'Metric definitions; the events behind them are re-sent by the SDK.', coverageId: 'ld_source.metrics' },
  metric_groups: { kind: 'metric_groups', label: 'Metric groups', group: 'experimentation', scope: 'project', requests: 'one', defaultOn: true, handling: 'migrates', beta: true, description: 'Funnels and standard metric groups.', coverageId: 'ld_source.metric_groups' },
  experiments: { kind: 'experiments', label: 'Experiments', group: 'experimentation', scope: 'environment', requests: 'per_environment', defaultOn: true, handling: 'migrates', description: 'Experiment designs per environment, copied as not-started drafts; results stay in the source.', coverageId: 'ld_source.experiments' },
  holdouts: { kind: 'holdouts', label: 'Holdouts', group: 'experimentation', scope: 'environment', requests: 'per_item', defaultOn: true, handling: 'migrates', description: 'Holdouts per environment (one request each for the design).', coverageId: 'ld_source.holdouts' },
  layers: { kind: 'layers', label: 'Layers', group: 'experimentation', scope: 'project', requests: 'one', defaultOn: true, handling: 'migrates', description: 'Layers and their per-environment reservations.', coverageId: 'ld_source.layers' },
  experimentation_settings: { kind: 'experimentation_settings', label: 'Randomization units', group: 'experimentation', scope: 'project', requests: 'one', defaultOn: true, handling: 'inventory', description: 'The project’s randomization units and which is the default; units in use are created in the target as metrics and experiments need them.', coverageId: 'ld_source.experimentation_settings' },
  ai_configs: { kind: 'ai_configs', label: 'AI Configs', group: 'ai', scope: 'project', requests: 'one', defaultOn: true, handling: 'inventory', description: 'AI Configs with their variations (model, messages, tools); targeting is read per config.', coverageId: 'ld_source.ai_configs' },
  model_configs: { kind: 'model_configs', label: 'Model configs', group: 'ai', scope: 'project', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Custom model configurations AI Config variations reference (global ones are LaunchDarkly’s and exist everywhere).', coverageId: 'ld_source.ai_configs' },
  release_pipelines: { kind: 'release_pipelines', label: 'Release pipelines', group: 'releases', scope: 'project', requests: 'one', defaultOn: true, handling: 'inventory', beta: true, description: 'Release pipelines: phases, their environments and audiences, approvals. Releases in progress are live and stay in the source.', coverageId: 'ld_source.release_pipelines' },
  release_policies: { kind: 'release_policies', label: 'Release policies', group: 'releases', scope: 'project', requests: 'one', defaultOn: true, handling: 'inventory', beta: true, description: 'Release policies: which flags release how (guarded, progressive) in which environments.', coverageId: 'ld_source.release_policies' },
  views: { kind: 'views', label: 'Views', group: 'settings', scope: 'project', requests: 'one', defaultOn: true, handling: 'inventory', beta: true, description: 'Views and what they group (flags, segments, metrics, AI Configs).', coverageId: 'ld_source.views' },
  approval_settings: { kind: 'approval_settings', label: 'Approval settings', group: 'settings', scope: 'environment', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Per-environment approval requirements (read from the environments, no extra request).', coverageId: 'ld_source.approval_settings' },
  destinations: { kind: 'destinations', label: 'Data Export destinations', group: 'settings', scope: 'environment', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Data Export destinations per environment; their credentials are not read.', coverageId: 'ld_source.destinations' },
  adaptive_triggers: { kind: 'adaptive_triggers', label: 'Adaptive triggers', group: 'settings', scope: 'environment', requests: 'per_environment', defaultOn: true, handling: 'inventory', description: 'Observability alerts wired to flag actions, per environment.', coverageId: 'ld_source.adaptive_triggers' },
  teams: { kind: 'teams', label: 'Teams', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'people', description: 'The account’s teams; the guide’s Teams step offers to create the missing ones in the target.', coverageId: 'ld_source.teams' },
  members: { kind: 'members', label: 'Members', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'people', description: 'The account’s members, so maintainers match by email and the People step can invite who is missing.', coverageId: 'ld_source.members' },
  custom_roles: { kind: 'custom_roles', label: 'Custom roles', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Custom roles and their policy statements (they name the source project’s resources).', coverageId: 'ld_source.custom_roles' },
  webhooks: { kind: 'webhooks', label: 'Webhooks', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Webhooks and the policy statements that scope them; the signing secret is not read.', coverageId: 'ld_source.webhooks' },
  relay_proxy_configs: { kind: 'relay_proxy_configs', label: 'Relay Proxy configurations', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Relay Proxy automatic configurations and their policies; the key is not read.', coverageId: 'ld_source.relay_proxy_configs' },
  code_references: { kind: 'code_references', label: 'Code reference repositories', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Repositories connected for code references, with their branches.', coverageId: 'ld_source.code_references' },
  workflow_templates: { kind: 'workflow_templates', label: 'Workflow templates', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'inventory', description: 'Saved workflow templates (stages, approvals, waits).', coverageId: 'ld_source.workflow_templates' },
  applications: { kind: 'applications', label: 'Applications', group: 'account', scope: 'account', requests: 'one', defaultOn: true, handling: 'inventory', beta: true, description: 'Applications and versions SDKs reported, for mobile and desktop targeting.', coverageId: 'ld_source.applications' },
};

export const LD_RESOURCE_KINDS = Object.keys(LD_RESOURCE_INFO) as LdResourceKind[];

export const LD_RESOURCE_GROUP_LABEL: Record<LdResourceGroup, string> = {
  flags: 'Flags and targeting',
  experimentation: 'Experimentation',
  ai: 'AI Configs',
  releases: 'Releases',
  settings: 'Project and environment settings',
  account: 'Account (shared across the source account’s projects)',
};

export const LD_RESOURCE_GROUPS = Object.keys(LD_RESOURCE_GROUP_LABEL) as LdResourceGroup[];

/** The kinds a source reads when the user picked none (everything but the per-flag-per-environment reads). */
export const LD_DEFAULT_RESOURCES: LdResourceKind[] = LD_RESOURCE_KINDS.filter((k) => LD_RESOURCE_INFO[k].defaultOn);

export function isLdResourceKind(x: unknown): x is LdResourceKind {
  return typeof x === 'string' && x in LD_RESOURCE_INFO;
}

/**
 * The scope an LD source reads: what it stored, else the default. Unknown kinds (from a newer
 * workspace file) are dropped; kinds whose prerequisite is missing are dropped too, since their
 * routes cannot be reached without it.
 */
export function ldReadScope(resources: readonly string[] | undefined): LdResourceKind[] {
  const picked = resources ? resources.filter(isLdResourceKind) : LD_DEFAULT_RESOURCES;
  const set = new Set(picked);
  return LD_RESOURCE_KINDS.filter((k) => set.has(k) && (LD_RESOURCE_INFO[k].requires ?? []).every((r) => set.has(r)));
}

/** Human list of a scope, in registry order: "Flags, Segments, Metrics, …". */
export function describeLdScope(resources: readonly string[] | undefined): string {
  return ldReadScope(resources).map((k) => LD_RESOURCE_INFO[k].label).join(', ');
}

/** Resource types LD has and the console never reads from a source, and why. Shown under the picker so nobody looks for them. */
export const LD_NOT_READ: { label: string; reason: string }[] = [
  { label: 'SDK keys, mobile keys, access tokens, service tokens, OAuth clients', reason: 'Credentials of the source account; the target issues its own.' },
  { label: 'Metric data sources, integration configurations, persistent store integrations', reason: 'Hold warehouse and third-party credentials; set up per project in the LaunchDarkly UI.' },
  { label: 'Big-segment membership, context instances and attributes', reason: 'Data, not configuration: membership is readable only per key and contexts are what the SDKs reported.' },
  { label: 'Flag evaluations, experiment results, insights, audit log, account usage', reason: 'History and analytics cannot be written into another project.' },
  { label: 'Approval requests, releases in progress, guarded rollouts', reason: 'Live processes; they finish in the source (PLAN §11).' },
  { label: 'Flag import configurations, IP allowlist, announcements, follow settings, user settings', reason: 'Account or personal settings with no counterpart to copy.' },
];

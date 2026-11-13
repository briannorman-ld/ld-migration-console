import type { EntityKind, SourceDescriptor, SourceKind } from '@sslm/canonical';
import type { Tone } from '../components/ui.tsx';

export const KIND_LABEL: Record<EntityKind, string> = {
  gate: 'Gates',
  config: 'Dynamic configs',
  segment: 'Segments',
  experiment: 'Experiments',
  layer: 'Layers',
  holdout: 'Holdouts',
  autotune: 'Autotunes',
  metric: 'Metrics',
  param_store: 'Param stores',
  prompt: 'AI Configs',
};

/** Badge label and tone per source kind (sidebar, Connections, Snapshots). */
export const SOURCE_BADGE: Record<SourceKind, { label: string; tone: Tone }> = {
  console_api: { label: 'Console API', tone: 'green' },
  config_spec: { label: 'Spec', tone: 'amber' },
  launchdarkly: { label: 'LaunchDarkly', tone: 'blue' },
  posthog: { label: 'PostHog', tone: 'violet' },
  posthog_payload: { label: 'PostHog payload', tone: 'violet' },
};

/** Sources that read live (not an uploaded file) and so have a refresh action. */
export const refreshable = (s: Pick<SourceDescriptor, 'kind'>): boolean => s.kind === 'console_api' || s.kind === 'launchdarkly' || s.kind === 'posthog';

/** `secrets` kind holding this source's credential, when it has one. */
export const secretKindOf = (s: Pick<SourceDescriptor, 'kind'>): 'statsig' | 'ld_source' | 'ph_source' | null =>
  s.kind === 'console_api' ? 'statsig' : s.kind === 'launchdarkly' ? 'ld_source' : s.kind === 'posthog' ? 'ph_source' : null;

/** Human list of a source's crawl scope, e.g. "Gates, Segments"; empty when it reads everything. */
export function describeScope(resources: EntityKind[] | undefined): string {
  return resources ? resources.map((k) => KIND_LABEL[k]).join(', ') : '';
}

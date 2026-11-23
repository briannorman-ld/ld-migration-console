/** LaunchDarkly instances the app can connect to (PLAN §3.1, §3.5). */
export type LdInstanceId = 'us' | 'eu' | 'federal' | 'staging';

export interface LdInstance {
  id: LdInstanceId;
  label: string;
  /** Origin of the REST API; paths are under /api/v2. Must match CSP connect-src. */
  origin: string;
  /** Acknowledgement text shown before connecting (PLAN §3.5); stored in the workspace. */
  disclaimer?: { title: string; body: string[] };
}

export const LD_INSTANCES: Record<LdInstanceId, LdInstance> = {
  us: { id: 'us', label: 'LaunchDarkly (commercial, US)', origin: 'https://app.launchdarkly.com' },
  eu: {
    id: 'eu',
    label: 'LaunchDarkly EU',
    origin: 'https://app.eu.launchdarkly.com',
    disclaimer: {
      title: 'EU instance',
      body: [
        'The static app is served from a US CDN.',
        'Your configuration data is processed only in your browser and sent only to StatSig and your LaunchDarkly instance.',
      ],
    },
  },
  federal: {
    id: 'federal',
    label: 'LaunchDarkly Federal',
    origin: 'https://app.launchdarkly.us',
    disclaimer: {
      title: 'Federal instance',
      body: [
        'This tool is not FedRAMP-authorized. Confirm that connecting it to your Federal instance is permitted.',
        'Warehouse-native experimentation is unavailable on Federal.',
      ],
    },
  },
  // LaunchDarkly's own staging instance (added 2026-11-23): lets LaunchDarkly staff read a staging
  // project as a source, or write into one. Same REST API and paths as production.
  staging: {
    id: 'staging',
    label: 'LaunchDarkly staging (internal)',
    origin: 'https://ld-stg.launchdarkly.com',
    disclaimer: {
      title: 'Staging instance',
      body: [
        "This is LaunchDarkly's internal staging instance, for LaunchDarkly staff only.",
        'Projects there hold test data and may be reset at any time; a token for app.launchdarkly.com does not work here.',
      ],
    },
  },
};

export const LD_API_VERSION = '20240415';
